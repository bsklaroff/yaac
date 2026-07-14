import crypto from 'node:crypto'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { serve, type ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { buildApp } from '#server'
import { authAgentHub } from '#auth-agent'
import { createTokenStore, loadTokens, saveTokens } from '#token-store'
import { closeDb, getDb } from '#lib/db/client'
import { importLegacyJsonStores } from '#lib/db/legacy-import'
import { EventHub } from '#events'
import { bridge, killViewSession, newViewName, parsePtySize, parsePtyTarget, spawnAttachPty, type SocketLike } from '#pty-bridge'
import { coalesceCalls, notifySessionListChanged, onSessionListChanged } from '#sessions-changed'
import { resolveSessionContainer } from '#session-resolve'
import { StatusWatcherManager } from '#status-watcher'
import { PodWatcher, setActivePodWatcher } from '#lib/k8s/pod-watch'
import { onSessionStatusChanged } from '#lib/session/status-store'
import { readBuildId } from '@yaac/shared/build-id'
import {
  acquireLock,
  serverLockPath,
  readLock,
  removeLock,
} from '@yaac/shared/lock'
import { isLockLive, isLockReady, type ServerLock } from '@yaac/shared/server-lock-file'
import { resolveServerPort, bindWithAutoIncrement } from '@yaac/shared/server-port'
import { resolveServerTarget, type ServerTarget } from '@yaac/shared/server-api'
import { ensureAuthDaemonSpawned } from '@yaac/shared/auth-daemon'
import { ensureDataDir } from '@yaac/shared/project-paths'
import { serverLogPath } from '@yaac/shared/paths'
import { startBackgroundLoop } from '#background-loop'
import { gcOrphanEphemeralModuleDirs } from '#lib/session/cleanup'
import { gcOrphanProjectRegistries } from '#lib/k8s/project-registry'
import { ensureNamespace } from '#lib/k8s/bootstrap'
import { ensureLocalRegistry } from '#lib/k8s/registry'
import { proxyClient } from '#lib/container/proxy-client'
import { restoreAllSessionForwarders } from '#lib/session/restore-forwarders'
import { stopAllSessionForwarders } from '#lib/session/port-forwarders'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'

export interface ServerRunOptions {
  port?: number
}

/**
 * Minimal shape of the `ws` WebSocket exposed as WSContext.raw. The `ws`
 * package's own types aren't in our resolvable set (transitive dep), so
 * we pin just what the PTY bridge uses.
 */
interface RawWebSocket {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  on(event: 'message', cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): void
  on(event: 'close', cb: () => void): void
}

// When YAAC_USE_TOR is set, the server routes its own git fetch/clone
// through a host-machine Tor SOCKS endpoint (default 127.0.0.1:9050).
// Fail loud at startup if it's unreachable rather than letting the first
// git operation fail with an opaque connection-refused.
async function preflightHostTor(): Promise<void> {
  if (!env.useTor) return
  const url = new URL(env.torSocksUrl)
  const host = url.hostname
  const port = parseInt(url.port || '9050', 10)
  await new Promise<void>((resolve, reject) => {
    const sock = net.connect({ host, port })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`timeout connecting to ${host}:${port}`))
    }, 2000)
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve() })
    sock.once('error', (err) => { clearTimeout(timer); reject(err) })
  }).catch((err: Error) => {
    throw new Error(
      `YAAC_USE_TOR is set but host Tor at ${url.href} is not reachable `
      + `(${err.message}). Start Tor ('sudo systemctl start tor' on Linux, `
      + `'brew services start tor' on macOS) or unset YAAC_USE_TOR.`,
    )
  })
}

// `FetchCallback` isn't re-exported from the package entry, so derive the
// fetch handler's type straight from serve()'s options.
type ServeFetch = Parameters<typeof serve>[0]['fetch']

/**
 * Bind the server's HTTP server on 127.0.0.1, preferring `startPort` and
 * auto-incrementing past any in-use port to the next free one. The actual
 * bound port is returned (and recorded in the lock file), so `yaac open` and
 * the dev-server proxy follow the server wherever it lands. `startPort` 0
 * asks the OS for an ephemeral port.
 */
function bindServer(
  fetch: ServeFetch,
  startPort: number,
): Promise<{ server: ServerType; port: number }> {
  return bindWithAutoIncrement(startPort, (port) =>
    new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
      const s = serve({ fetch, port, hostname: '127.0.0.1' }, (info) => {
        resolve({ server: s, port: info.port })
      })
      s.once('error', reject)
    }),
  )
}

/**
 * Entry point for `yaac server run` — the foreground HTTP server.
 *
 * - If another server is already live, print its handshake and exit 0
 *   (idempotent).
 * - Otherwise bind 127.0.0.1:<port> (resolveServerPort: `--port`, else
 *   YAAC_SERVER_PORT, else DEFAULT_SERVER_PORT), write the lock, serve until
 *   SIGTERM / SIGINT, then unlink the lock and exit. If the preferred port is
 *   already in use it auto-increments to the next free one; the actual bound
 *   port is recorded in the lock.
 */
export async function runServer(opts: ServerRunOptions): Promise<void> {
  await preflightHostTor()
  await ensureDataDir()

  // Read build-id up front so a broken install fails loudly before we
  // bind a port or write a lock file.
  const buildId = await readBuildId()

  // Fast path: if a live server already holds the lock, exit idempotently
  // without binding a port. This is only a best-effort check — the
  // acquireLock call below is the authoritative race-safe guard for two
  // `server run` invocations starting concurrently.
  const preExisting = await readLock()
  if (preExisting && await isLockLive(preExisting)) {
    serverLog(`[server] already running pid=${preExisting.pid} port=${preExisting.port}`)
    return
  }

  const secret = crypto.randomBytes(32).toString('hex')
  // Tokens survive restarts by design: durable ones are what remote CLIs
  // hold instead of the per-boot lock secret, and persisted web sessions
  // mean a restart (e.g. a rebuild) doesn't log every browser out. The
  // store starts empty here and is restored from the DB post-acquireLock —
  // the DB must not be opened before the single-writer lock is held.
  const tokens = createTokenStore({
    onChanged: (entries) => {
      saveTokens(entries).catch((err: unknown) =>
        serverLog(`[server] failed to persist tokens: ${String(err)}`))
    },
  })
  const hub = new EventHub()
  // Flipped true once the post-lock DB init below finishes. Surfaced on
  // `/health` as `ready` so `yaac server start` waits for genuine readiness
  // instead of the pre-init responsive window (see waitForReadyLock).
  let ready = false
  // Push a fresh snapshot the moment session state changes — a create /
  // restart from a route handler, a pod-watch event, or a watcher-fed
  // status flip. The first notification publishes immediately; bursts
  // (server start seeding N pods) coalesce into one trailing rebuild.
  onSessionListChanged(coalesceCalls(() => { void hub.publishSnapshot() }, 150))
  const app = buildApp({ secret, buildId, tokens, isReady: () => ready })

  // WebSocket event stream. Registered here (not in buildApp) so buildApp's
  // return type stays the plain Hono app the CLI's typed RPC client infers
  // from. Auth runs as normal middleware on the upgrade — the cookie
  // travels with it, no token in the URL.
  // Keep the object rather than destructuring: injectWebSocket is a
  // method that relies on `this`, so calling a detached reference later
  // would break it (and trips eslint's unbound-method rule).
  const nodeWs = createNodeWebSocket({ app })
  app.get('/events', nodeWs.upgradeWebSocket(() => ({
    onOpen: (_evt, ws) => {
      hub.add(ws)
      void hub.sendSnapshotTo(ws).catch(
        (err: unknown) => serverLog(`[server] events: initial snapshot failed: ${String(err)}`),
      )
    },
    onClose: (_evt, ws) => hub.remove(ws),
    onError: (_err, ws) => hub.remove(ws),
  })))

  // Auth-daemon relay: the login broker on the user's machine holds one
  // outbound socket here; sign-in routes forward ops over it and serve
  // the views it pushes back. Auth rides the upgrade like every WS.
  app.get('/agent/auth', nodeWs.upgradeWebSocket(() => ({
    onOpen: (_evt, ws) => {
      const raw = ws.raw as RawWebSocket | undefined
      if (!raw) {
        ws.close(1011, 'no raw socket')
        return
      }
      const sock = {
        send: (data: string) => raw.send(data),
        close: (code?: number, reason?: string) => raw.close(code, reason),
      }
      authAgentHub.setSocket(sock)
      raw.on('message', (data) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
        authAgentHub.ingest(text)
      })
      raw.on('close', () => authAgentHub.handleDisconnect(sock))
    },
  })))

  // PTY bridge: one embedded terminal per connection, attached to the
  // session's tmux. Path is /pty/attach (not /session/...) to avoid
  // colliding with the GET /session/:id route. Auth rides the upgrade.
  app.get('/pty/attach', nodeWs.upgradeWebSocket((c) => {
    const id = c.req.query('id') ?? ''
    // Spawn the PTY at the browser's reported size so the tmux window and the
    // client grid match from the first frame — no cold-start resize, no
    // reflow garble. Falls back to 80x24 when the params are missing/invalid.
    const size = parsePtySize(c.req.query('cols'), c.req.query('rows'))
    // Which tmux session to attach: the agent (default) or the scratch shell.
    const target = parsePtyTarget(c.req.query('target'))
    return {
      onOpen: (_evt, ws) => {
        void (async () => {
          let jobName: string
          try {
            const resolved = await resolveSessionContainer(id, { requireRunning: true })
            jobName = resolved.jobName
          } catch {
            try {
              ws.send(JSON.stringify({ type: 'error', message: 'session not found or not running' }))
            } catch { /* socket already gone */ }
            ws.close(1011, 'resolve failed')
            return
          }
          // ws.raw is the underlying `ws` WebSocket, but its types aren't in
          // our resolvable set (transitive dep), so pin a minimal shape.
          const raw = ws.raw as RawWebSocket | undefined
          if (!raw) {
            ws.close(1011, 'no raw socket')
            return
          }
          const viewName = newViewName()
          const ptyProc = spawnAttachPty(jobName, size, target, viewName)
          const sock: SocketLike = {
            send: (data) => raw.send(data),
            close: (code, reason) => raw.close(code, reason),
            onMessage: (cb) => raw.on('message', (data, isBinary) =>
              cb(Array.isArray(data) ? Buffer.concat(data) : data, isBinary)),
            onClose: (cb) => raw.on('close', () => cb()),
          }
          // 'shell' is a raw zsh exec — no view session exists to clean up.
          const detach = target === 'shell'
            ? undefined
            : (): void => void killViewSession(jobName, viewName)
          bridge(ptyProc, sock, { detach })
          serverLog(`[server] pty attach: session=${id} job=${jobName}`)
        })()
      },
    }
  }))

  const startPort = resolveServerPort(opts.port)
  const { server, port } = await bindServer(app.fetch, startPort)
  if (startPort !== 0 && port !== startPort) {
    serverLog(`[server] preferred port ${startPort} in use; bound ${port} instead`)
  }
  nodeWs.injectWebSocket(server)

  // Race-safe acquire via O_EXCL. Another server may have slipped past
  // the pre-bind fast-path check above; atomic create ensures exactly one
  // winner. Loser closes its server and exits 0 so the existing server
  // stays the source of truth.
  const outcome = await acquireLock({ pid: process.pid, port, secret, startedAt: Date.now(), buildId })
  if (!outcome.acquired) {
    serverLog(`[server] already running pid=${outcome.existing.pid} port=${outcome.existing.port}`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return
  }
  // Open the DB only now that the lock is held (it is the single-writer
  // guard for PGlite), sweep any legacy JSON stores into it, and restore
  // the persisted tokens into the store built empty above — all before the
  // start banner below mints its exchange token, whose onChanged persist
  // rewrites the full token table from the in-memory set. A failure here
  // means preferences/titles/tokens would silently not persist, so fail
  // the start rather than run half-alive.
  try {
    await getDb()
    await importLegacyJsonStores()
    tokens.restoreTokens(await loadTokens())
  } catch (err) {
    serverLog(`[server] db init failed: ${String(err)}`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeLock(process.pid)
    process.exit(1)
  }
  // DB is open and migrated: the server can now serve real requests, not
  // just answer /health. Set synchronously here so the flag is true before
  // control returns to the event loop and any queued request is processed.
  ready = true

  const torPrefix = env.useTor ? '(using tor) ' : ''
  serverLog(`[server] ${torPrefix}listening on 127.0.0.1:${port} lock=${serverLockPath()}`)
  // Start banner for the webapp: a ready-to-open URL carrying a one-time
  // exchange token (single-use, time-bounded; `yaac open` mints fresh ones).
  serverLog(`[server] open http://127.0.0.1:${port}/?token=${tokens.mintExchangeToken().token}`)

  // Register signal handlers BEFORE the async startup steps below. Node's
  // default SIGTERM/SIGINT action is to terminate immediately, bypassing
  // removeLock(); a test or supervisor that signals while restore/GC is
  // still running would otherwise leak the lock file.
  const abortCtrl = new AbortController()
  let loopDone: Promise<void> | null = null
  let podWatcher: PodWatcher | null = null
  let statusWatchers: StatusWatcherManager | null = null
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    serverLog(`[server] ${signal} — shutting down`)
    abortCtrl.abort()
    // Stop the push-fed state layer first: the pod watch child and every
    // per-session control-mode exec are long-lived kubectl processes
    // that would otherwise outlive the server (orphaned to PID 1).
    setActivePodWatcher(null)
    podWatcher?.stop()
    statusWatchers?.stopAll()
    if (loopDone) {
      // Bound the loop drain the same way we bound server.close() below.
      // Under parallel-test cluster pressure, an in-flight reap tick can
      // stack retries for many seconds — long enough to blow `yaac
      // server stop`'s observation window and make the CLI fall back to
      // "force-removed stale lock".
      await Promise.race([
        loopDone.catch((err) => serverLog(`[server] loop exit error: ${String(err)}`)),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
    }
    // Tear down every active port-forwarder before closing the server.
    // Each forwarder owns a listener server and a set of long-lived
    // `kubectl exec nc` relay children; without this they survive the
    // server (orphaned to PID 1) and the next server stacks new ones on
    // top via restoreAllSessionForwarders.
    stopAllSessionForwarders()

    // Same for the proxy control tunnel (`kubectl port-forward` child) —
    // the deployed proxy itself stays up for the next server to adopt.
    proxyClient.disconnect()

    // @hono/node-server wraps a Node http.Server; close() refuses new
    // connections, drains in-flight requests, then fires the callback.
    // Bound to 3s so a wedged long-poll can't block lock removal; the
    // server is going away either way, and the lock file is the thing
    // the CLI watches to decide whether to restart.
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
    // Checkpoint the DB so PGlite reopens clean across dev-watch restarts.
    // Bounded like server.close(): a wedged close must not block lock
    // removal (WAL replay bounds any damage).
    await Promise.race([
      closeDb().catch((err: unknown) => serverLog(`[server] db close failed: ${String(err)}`)),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
    // Pass our pid so a shutdown that dragged past stopServer's 3s
    // force-remove window (e.g. wedged background loop) can't unlink a
    // successor server's lock.
    await removeLock(process.pid)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Best-effort cluster bootstrap: the local registry and the yaac
  // namespace are cheap to ensure and needed by the first session.
  // Failures are logged, not fatal — the server can serve project/auth
  // RPCs without a cluster, and session creation surfaces its own
  // RUNTIME_UNAVAILABLE with a pointer to `yaac cluster check`.
  void (async () => {
    await ensureLocalRegistry()
    await ensureNamespace()
  })().catch((err) => serverLog(`[server] cluster bootstrap failed: ${String(err)}`))

  // A server restart loses the in-memory forwarder registry while
  // running containers keep their tmux `status-right` advertising
  // ports that aren't actually forwarded anymore. Rebuild forwarders
  // for every live session container before we process RPCs so the
  // displayed port mapping matches reality.
  try {
    await restoreAllSessionForwarders()
  } catch (err) {
    serverLog(`[server] restore forwarders failed: ${String(err)}`)
  }

  // Push-fed session state: one kubectl pod watch keeps the display
  // path's pod cache current and drives the per-session status watchers
  // (tmux control-mode streams feeding the status store). Both fire
  // sessions-changed, so snapshots push the moment state changes
  // instead of at the next reconcile tick. The 5s loop below stays as
  // the convergence/backstop path and is unaffected.
  podWatcher = new PodWatcher()
  statusWatchers = new StatusWatcherManager()
  const watcher = podWatcher
  const manager = statusWatchers
  podWatcher.onChange(() => {
    manager.sync(watcher.getPods())
    notifySessionListChanged()
  })
  onSessionStatusChanged(() => notifySessionListChanged())
  podWatcher.start()
  setActivePodWatcher(podWatcher)

  // Start the background loop before running orphan GC. The GC pass
  // hits the cluster API, and during a freeze cluster (saturated VM,
  // user restarting repeatedly) it can take minutes — blocking the
  // first reconcile tick that whole time. Running it concurrently with
  // the loop lets the server serve the reconcile path right away while
  // the GC drains in the background.
  loopDone = startBackgroundLoop({
    signal: abortCtrl.signal,
    // After each reconciliation tick, push a fresh snapshot to any
    // connected webapp clients (no-op when none are connected, and only
    // broadcasts when the state actually changed).
    onTick: () => hub.publishSnapshot(),
  })

  // Remove per-session `.cached-packages/modules/<sid>` dirs whose
  // session container is gone — catches leftovers from crashes and host
  // reboots.
  void gcOrphanEphemeralModuleDirs()
    .catch((err) => serverLog(`[server] orphan modules GC failed: ${String(err)}`))

  // Remove per-project push registries whose project dir is gone —
  // catches `project remove` runs that raced an unavailable cluster.
  void gcOrphanProjectRegistries()
    .catch((err) => serverLog(`[server] orphan registry GC failed: ${String(err)}`))
}

/**
 * Entry point for `yaac server start`.
 *
 * - If a server is already running with the matching buildId, no-op.
 * - If running with a different buildId, throw — the user should
 *   `yaac server restart`.
 * - Otherwise clean any stale lock, spawn `yaac server run` detached,
 *   and wait up to 5s for the new lock to appear.
 */
export async function startServer(): Promise<void> {
  await preflightHostTor()
  await ensureDataDir()
  const cliBuildId = await readBuildId()

  const existing = await readLock()
  if (existing && await isLockLive(existing)) {
    if (existing.buildId === cliBuildId) {
      console.error(`[yaac] server already running pid=${existing.pid} port=${existing.port}`)
      return
    }
    throw new Error(
      'yaac server is running an outdated version '
      + `(server buildId ${existing.buildId}, CLI buildId ${cliBuildId}). `
      + 'Restart it with: yaac server restart',
    )
  }

  // Lock file present but not live (pid dead or /health unresponsive) —
  // the next spawn's idempotency check would overwrite it anyway, but
  // clearing first keeps the "wait for new lock" poll simple.
  if (existing) await removeLock()

  await spawnServerDetached()
  // Wait for readiness, not bare liveness: the server writes its lock and
  // answers /health before it opens the DB and runs first-boot migrations,
  // which block the event loop for seconds. Returning on the pre-init
  // /health would print "server started" while the next command's liveness
  // probe times out against the frozen loop. 30s comfortably covers a
  // cold-start migration (a few seconds) plus headroom on a loaded host.
  const fresh = await waitForReadyLock(30_000)
  if (fresh.buildId !== cliBuildId) {
    throw new Error(
      `server buildId ${fresh.buildId} does not match CLI buildId ${cliBuildId}`,
    )
  }
  const torPrefix = env.useTor ? '(using tor) ' : ''
  console.error(`[yaac] ${torPrefix}server started pid=${fresh.pid} port=${fresh.port}`)
}

/**
 * Entry point for `yaac server stop`. SIGTERMs the running server and
 * waits for its shutdown handler to unlink the lock. Force-removes the
 * lock if the server doesn't exit within 3s.
 */
export async function stopServer(): Promise<void> {
  const existing = await readLock()
  if (!existing) {
    console.error('[yaac] server is not running')
    return
  }
  if (!await isLockLive(existing)) {
    await removeLock()
    console.error(`[yaac] removed stale lock (pid ${existing.pid})`)
    return
  }

  try {
    process.kill(existing.pid, 'SIGTERM')
  } catch {
    // Process already gone — still need to clear the lock below.
  }

  // The server's shutdown path is bounded to ~6s worst case (3s loop
  // drain + 3s server close) under heavy parallel load. Poll with
  // headroom so a healthy SIGTERM-driven exit isn't misreported as a
  // "force-removed stale lock".
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const cur = await readLock()
    if (!cur || cur.pid !== existing.pid) {
      console.error(`[yaac] server stopped (pid ${existing.pid})`)
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  // Server didn't clean up in time. Remove the lock ourselves — the old
  // process is either gone or wedged, either way it's no longer the
  // source of truth.
  const cur = await readLock()
  if (cur && cur.pid === existing.pid) await removeLock()
  console.error(`[yaac] force-removed stale lock (pid ${existing.pid})`)
}

/**
 * Entry point for `yaac server restart`. Stops any running server, then
 * starts a fresh one.
 */
export async function restartServer(): Promise<void> {
  await stopServer()
  await startServer()
}

export function buildWebappUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/?token=${token}`
}

export interface OpenWebappOptions {
  /** Print the URL instead of launching a browser. */
  noBrowser?: boolean
  // Injected for tests; default to the real implementations.
  ensureServer?: () => Promise<void>
  resolveTarget?: () => Promise<ServerTarget>
  fetchImpl?: typeof fetch
  launch?: (url: string) => void
}

/**
 * Entry point for `yaac open`. Resolves the server target, mints a
 * one-time exchange token over the authenticated /tokens API (the same
 * endpoint every client registers through), and launches the browser
 * straight into the authenticated webapp — no log-scraping or
 * token-pasting. The URL is always printed (stdout) so it's scriptable.
 *
 * The local server is auto-started only when resolution fails on the
 * local-lock path; a configured remote (or the test hatch) resolves
 * up front and must never trigger a local server spawn.
 */
export async function openWebapp(opts: OpenWebappOptions = {}): Promise<void> {
  const ensureServer = opts.ensureServer ?? startServer
  const resolveTarget = opts.resolveTarget ?? resolveServerTarget
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  const launch = opts.launch ?? openBrowser

  let target: ServerTarget
  try {
    target = await resolveTarget()
  } catch {
    // Only the local-lock branch throws (server down / build mismatch).
    // Start it and re-resolve; a second failure surfaces to the user.
    await ensureServer()
    target = await resolveTarget()
  }

  // Best-effort: the webapp's sign-in cards need the login broker on
  // this machine. Never block or fail `yaac open` on it.
  try {
    await ensureAuthDaemonSpawned()
  } catch {
    // resolution/spawn hiccup — sign-in cards will say what to run
  }

  const res = await fetchImpl(`${target.baseUrl}/tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ kind: 'one-time' }),
  })
  if (!res.ok) throw new Error(`failed to mint a one-time token (HTTP ${res.status})`)
  const { token } = await res.json() as { token: string }

  const url = buildWebappUrl(target.baseUrl, token)
  console.log(url)
  if (opts.noBrowser) return
  launch(url)
}

function openBrowser(url: string): void {
  const { cmd, args } = process.platform === 'darwin'
    ? { cmd: 'open', args: [url] }
    : process.platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
      : { cmd: 'xdg-open', args: [url] }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      console.error(`[yaac] couldn't launch a browser — open this URL manually:\n  ${url}`)
    })
    child.unref()
  } catch {
    console.error(`[yaac] couldn't launch a browser — open this URL manually:\n  ${url}`)
  }
}

async function spawnServerDetached(): Promise<void> {
  const { bin, args } = resolveServerInvocation()
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    // eslint-disable-next-line no-process-env -- forward the full host env to the detached server subprocess
    env: process.env,
  })
  child.unref()
  // If the spawn itself fails immediately (e.g. ENOENT), surface it.
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    // A spawned detached process won't emit a useful signal here, so
    // give it a tick and assume success — the lock poll will catch
    // the actual failure mode (e.g. "server never wrote the lock").
    setTimeout(resolve, 50)
  })
}

/**
 * Figure out how to relaunch ourselves as `yaac server run`.
 *
 * - Production build (`dist/cli.js`): `process.execPath` is node and
 *   `argv[1]` is the bundled entry — just reuse both.
 * - Dev (source `.ts` files): we're running under tsx. tsx strips its
 *   own CLI script from argv before running the target, so `argv[1]`
 *   is the source entry (`src/cli.ts`). Respawn via tsx's CLI so the
 *   loader is set up again in the child.
 */
function resolveServerInvocation(): { bin: string; args: string[] } {
  const entry = process.argv[1] ?? ''
  if (entry.endsWith('.ts')) {
    const tsxCli = findTsxCli()
    if (tsxCli) return { bin: process.execPath, args: [tsxCli, entry, 'server', 'run'] }
    // Fallback: launch via node and hope NODE_OPTIONS carries the loader.
    return { bin: process.execPath, args: [entry, 'server', 'run'] }
  }
  return { bin: process.execPath, args: [entry, 'server', 'run'] }
}

function findTsxCli(): string | null {
  try {
    return createRequire(import.meta.url).resolve('tsx/cli')
  } catch {
    return null // tsx not installed (production build) — caller falls back
  }
}

async function waitForReadyLock(timeoutMs: number): Promise<ServerLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock()
    if (lock && await isLockReady(lock)) return lock
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server did not become ready within ${Math.round(timeoutMs / 1000)}s`)
}

export interface ServerLogsOptions {
  /** Keep printing as new lines are appended to the log file. */
  follow?: boolean
  /** Print only the last N lines (before following, if combined with follow). */
  lines?: number
}

/**
 * Entry point for `yaac server logs`. Prints ~/.yaac/server.log to stdout
 * by spawning stock `tail` (flags limited to those shared by BSD and GNU
 * tail — macOS and Linux are the only supported platforms).
 *
 * - No options: prints the whole file (`tail -n +1`).
 * - `--lines N`: prints only the last N lines (`tail -n N`).
 * - `--follow`: keeps printing as content is appended (`tail -F`, which
 *   also handles the file appearing later and truncation/replacement).
 */
export async function serverLogs(opts: ServerLogsOptions = {}): Promise<void> {
  const logPath = serverLogPath()

  if (!existsSync(logPath)) {
    if (!opts.follow) {
      console.error(`[yaac] no server log at ${logPath}`)
      return
    }
    console.error(`[yaac] no server log at ${logPath} yet — waiting for it`)
  }

  const args = opts.follow ? ['-F'] : []
  // `-n +1` = from the first line (whole file); `-n N` = last N lines.
  // Negative N would flip tail into last-|N|-lines mode — clamp to 0,
  // matching the old "print nothing" behavior.
  args.push('-n', opts.lines !== undefined ? String(Math.max(0, opts.lines)) : '+1')
  args.push(logPath)

  // stderr is dropped: the missing-file case is reported above, and in
  // follow mode `tail -F` narrates retries/rotation we don't want shown.
  const child = spawn('tail', args, { stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.pipe(process.stdout, { end: false })

  await new Promise<void>((resolve, reject) => {
    // Forward Ctrl-C so tail dies with us instead of being orphaned.
    const onSigint = (): void => { child.kill('SIGINT') }
    process.on('SIGINT', onSigint)
    child.on('error', (err) => {
      process.off('SIGINT', onSigint)
      reject(err)
    })
    child.on('close', (code, signal) => {
      process.off('SIGINT', onSigint)
      if (code === 0 || signal === 'SIGINT') resolve()
      else reject(new Error(`tail exited with ${signal ?? `code ${code}`}`))
    })
  })
}

import crypto from 'node:crypto'
import net from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { buildApp } from '#main/server'
import { authAgentHub } from '#features/auth/agent'
import { createTokenStore, loadTokens, saveTokens } from '#http/token-store'
import { closeDb, getDb } from '#platform/db/client'
import { importLegacyJsonStores } from '#platform/db/legacy-import'
import { EventHub } from '#main/events'
import { bridge, killViewSession, makeWindowResizer, newViewName, parsePtySize, parsePtyTarget, spawnAttachPty, sweepGhostViews, type SocketLike } from '#features/terminals/pty-bridge'
import { containerExec } from '#platform/k8s/exec'
import { coalesceCalls, notifySessionListChanged, onSessionListChanged } from '#features/sessions/notify'
import { resolveSessionContainer } from '#features/sessions/resolve'
import { StatusWatcherManager } from '#features/sessions/status-watcher'
import { PodWatcher, setActivePodWatcher } from '#platform/k8s/pod-watch'
import { refreshClaudeBundledSkills } from '#features/skills/claude-bundled'
import { onSessionStatusChanged } from '#features/sessions/status-store'
import { readBuildId } from '@yaac/shared/build-id'
import {
  acquireLock,
  serverLockPath,
  readLock,
  removeLock,
} from '@yaac/shared/lock'
import { isLockLive } from '@yaac/shared/server-lock-file'
import { resolveServerPort, bindWithAutoIncrement } from '@yaac/shared/server-port'
import { ensureDataDir } from '@yaac/shared/project-paths'
import { startBackgroundLoop } from '#main/background-loop'
import { gcOrphanEphemeralModuleDirs, isTmuxSessionAlive } from '#features/sessions/cleanup'
import { gcOrphanProjectRegistries } from '#features/cluster/project-registry'
import { ensureNamespace } from '#features/cluster/proxy-apply'
import { ensureLocalRegistry } from '#features/cluster/registry'
import { proxyClient } from '#features/sessions/egress/proxy-client'
import { hasSessionForwarders, provisionSessionForwarders, stopAllSessionForwarders } from '#features/sessions/forwarders/port-forwarders'
import { listSessionPods } from '#platform/k8s/pods'
import { resolveProjectConfig } from '#features/projects/config'
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
export async function preflightHostTor(): Promise<void> {
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

  // Live tmux view sessions per job, for the ghost sweep on attach: every
  // view-* session in a pod that isn't in here belongs to a dead connection
  // (crashed server, killed kubectl, sleep-dropped exec) and gets reaped.
  const liveViews = new Map<string, Set<string>>()

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
          // Register this view as live, then reap any ghosts in the pod —
          // view-* sessions no connection owns (see sweepGhostViews). The
          // registry add precedes the sweep's listing, so a concurrent
          // attach can never reap this view.
          if (target !== 'shell') {
            const views = liveViews.get(jobName) ?? new Set<string>()
            views.add(viewName)
            liveViews.set(jobName, views)
            void sweepGhostViews(jobName, views, (j, cmd) =>
              containerExec(j, cmd, { maxAttempts: 1 }))
          }
          const ptyProc = spawnAttachPty(jobName, size, target, viewName)
          const sock: SocketLike = {
            send: (data) => raw.send(data),
            close: (code, reason) => raw.close(code, reason),
            onMessage: (cb) => raw.on('message', (data, isBinary) =>
              cb(Array.isArray(data) ? Buffer.concat(data) : data, isBinary)),
            onClose: (cb) => raw.on('close', () => cb()),
          }
          // Webapp views (agent / window:@) pin their tmux window to the
          // client via `window-size manual` + resize-window (see attachArgs),
          // so their resizes must drive resize-window; the resizer serializes
          // those execs. 'native' keeps default `latest` sizing and 'shell'
          // has no tmux view, so neither needs one.
          const resizer = target === 'shell' || target === 'native'
            ? null
            : makeWindowResizer(viewName, (cmd) =>
                containerExec(jobName, cmd, { maxAttempts: 1 }).catch(() => {
                  // view gone / pod race — the next resize (or none) is fine
                }))
          // 'shell' is a raw zsh exec — no view session exists to clean up.
          const detach = target === 'shell'
            ? undefined
            : (): void => {
                resizer?.dispose()
                const views = liveViews.get(jobName)
                views?.delete(viewName)
                if (views?.size === 0) liveViews.delete(jobName)
                void killViewSession(jobName, viewName)
              }
          bridge(ptyProc, sock, { detach, resizeWindow: resizer?.resize })
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

  // Populate the Claude bundled-skills cache (name + description from the
  // official commands reference) for the skills viewer. Fire-and-forget: it's
  // an in-memory best-effort fetch, so it never blocks startup or fails it.
  void refreshClaudeBundledSkills()

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

interface RestoreCandidate {
  jobName: string
  projectSlug: string
  sessionId: string
}

/**
 * Server-startup pass that rebuilds port forwarders for every live yaac
 * session pod. A server restart loses the in-memory forwarder registry
 * while session pods keep running with stale `status-right` info, so
 * without this pass the tmux bars lie about which ports are
 * actually forwarded.
 */
export async function restoreAllSessionForwarders(): Promise<void> {
  let pods
  try {
    pods = await listSessionPods()
  } catch (err) {
    console.error('[server] restore forwarders: list session pods failed:', err)
    return
  }

  const candidates: RestoreCandidate[] = []
  for (const p of pods) {
    if (!p.running) continue
    if (!p.sessionId || !p.projectSlug || !p.jobName) continue
    if (hasSessionForwarders(p.sessionId)) continue
    if (!(await isTmuxSessionAlive(p.projectSlug, p.sessionId))) continue
    candidates.push({ jobName: p.jobName, projectSlug: p.projectSlug, sessionId: p.sessionId })
  }

  await Promise.allSettled(candidates.map(async ({ jobName, projectSlug, sessionId }) => {
    try {
      const config = await resolveProjectConfig(projectSlug) ?? {}
      await provisionSessionForwarders(projectSlug, sessionId, jobName, config.portForward)
    } catch (err) {
      console.error(
        `[server] restore forwarders for ${sessionId.slice(0, 8)}: `
        + (err instanceof Error ? err.message : String(err)),
      )
    }
  }))
}

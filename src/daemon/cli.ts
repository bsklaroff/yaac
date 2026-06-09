import crypto from 'node:crypto'
import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { buildApp } from '@/daemon/server'
import { createWebAuthStore } from '@/daemon/web-auth'
import { EventHub } from '@/daemon/events'
import { bridge, parsePtySize, parsePtyTarget, spawnAttachPty, type SocketLike } from '@/daemon/pty-bridge'
import { onSessionListChanged } from '@/daemon/sessions-changed'
import { resolveSessionContainer } from '@/daemon/session-resolve'
import { readBuildId } from '@/shared/build-id'
import {
  acquireLock,
  daemonLockPath,
  isLockLive,
  readLock,
  removeLock,
  type DaemonLock,
} from '@/shared/lock'
import { ensureDataDir } from '@/lib/project/paths'
import { daemonLogPath, webSessionsPath } from '@/shared/paths'
import { startBackgroundLoop } from '@/daemon/background-loop'
import { gcOrphanSessionVolumes } from '@/lib/container/image-promoter'
import { gcOrphanEphemeralModuleDirs } from '@/lib/session/cleanup'
import { restoreAllSessionForwarders } from '@/lib/session/restore-forwarders'
import { stopAllSessionForwarders } from '@/lib/session/port-forwarders'
import { daemonLog } from '@/daemon/log'
import { isTorEnabled } from '@/lib/git'

const __filename = fileURLToPath(import.meta.url)

export interface DaemonRunOptions {
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

// When YAAC_USE_TOR is set, the daemon routes its own git fetch/clone
// through a host-machine Tor SOCKS endpoint (default 127.0.0.1:9050).
// Fail loud at startup if it's unreachable rather than letting the first
// git operation fail with an opaque connection-refused.
async function preflightHostTor(): Promise<void> {
  if (!isTorEnabled()) return
  const url = new URL(process.env.YAAC_HOST_TOR_SOCKS_URL ?? 'socks5h://127.0.0.1:9050')
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

/**
 * Entry point for `yaac daemon run` — the foreground HTTP server.
 *
 * - If another daemon is already live, print its handshake and exit 0
 *   (idempotent).
 * - Otherwise bind 127.0.0.1:<port-or-ephemeral>, write the lock, serve
 *   until SIGTERM / SIGINT, then unlink the lock and exit.
 */
export async function runDaemon(opts: DaemonRunOptions): Promise<void> {
  await preflightHostTor()
  await ensureDataDir()

  // Read build-id up front so a broken install fails loudly before we
  // bind a port or write a lock file.
  const buildId = await readBuildId()

  // Fast path: if a live daemon already holds the lock, exit idempotently
  // without binding a port. This is only a best-effort check — the
  // acquireLock call below is the authoritative race-safe guard for two
  // `daemon run` invocations starting concurrently.
  const preExisting = await readLock()
  if (preExisting && await isLockLive(preExisting)) {
    daemonLog(`[daemon] already running pid=${preExisting.pid} port=${preExisting.port}`)
    return
  }

  const secret = crypto.randomBytes(32).toString('hex')
  // Port isn't known until serve() binds, but the Host-header middleware
  // (built into the app now) needs it. Bind it late through a ref the
  // getter closes over; requests only arrive after we set it below.
  const portRef = { current: 0 }
  // Restore webapp sessions persisted by a prior daemon so a restart
  // (e.g. a rebuild) doesn't force every browser to re-bootstrap.
  const store = createWebAuthStore({
    initialSessions: await loadWebSessions(),
    onSessionsChanged: (sessions) => void saveWebSessions(sessions),
  })
  const hub = new EventHub()
  // Push a fresh snapshot the moment a session is created/restarted, so the
  // webapp's sidebar + terminal update immediately instead of waiting for the
  // next periodic tick.
  onSessionListChanged(() => { void hub.publishSnapshot() })
  const app = buildApp({ secret, buildId, store, getPort: () => portRef.current })

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
        (err: unknown) => daemonLog(`[daemon] events: initial snapshot failed: ${String(err)}`),
      )
    },
    onClose: (_evt, ws) => hub.remove(ws),
    onError: (_err, ws) => hub.remove(ws),
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
          let containerName: string
          try {
            const resolved = await resolveSessionContainer(id, { requireRunning: true })
            containerName = resolved.containerName
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
          const ptyProc = spawnAttachPty(containerName, size, target)
          const sock: SocketLike = {
            send: (data) => raw.send(data),
            close: (code, reason) => raw.close(code, reason),
            onMessage: (cb) => raw.on('message', (data, isBinary) =>
              cb(Array.isArray(data) ? Buffer.concat(data) : data, isBinary)),
            onClose: (cb) => raw.on('close', () => cb()),
          }
          bridge(ptyProc, sock)
          daemonLog(`[daemon] pty attach: session=${id} container=${containerName}`)
        })()
      },
    }
  }))

  const { server, port } = await new Promise<{ server: ServerType; port: number }>(
    (resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: '127.0.0.1' }, (info) => {
        resolve({ server: s, port: info.port })
      })
      s.once('error', reject)
    },
  )
  portRef.current = port
  nodeWs.injectWebSocket(server)

  // Race-safe acquire via O_EXCL. Another daemon may have slipped past
  // the pre-bind fast-path check above; atomic create ensures exactly one
  // winner. Loser closes its server and exits 0 so the existing daemon
  // stays the source of truth.
  const outcome = await acquireLock({ pid: process.pid, port, secret, startedAt: Date.now(), buildId })
  if (!outcome.acquired) {
    daemonLog(`[daemon] already running pid=${outcome.existing.pid} port=${outcome.existing.port}`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return
  }
  const torPrefix = isTorEnabled() ? '(using tor) ' : ''
  daemonLog(`[daemon] ${torPrefix}listening on 127.0.0.1:${port} lock=${daemonLockPath()}`)
  // Start banner for the webapp: a one-time, time-bounded bootstrap URL.
  // The code is single-use; reopen with a fresh one after `daemon restart`.
  daemonLog(`[daemon] open http://127.0.0.1:${port}/?bootstrap=${store.currentCode()}`)

  // Register signal handlers BEFORE the async startup steps below. Node's
  // default SIGTERM/SIGINT action is to terminate immediately, bypassing
  // removeLock(); a test or supervisor that signals while restore/GC is
  // still running would otherwise leak the lock file.
  const abortCtrl = new AbortController()
  let loopDone: Promise<void> | null = null
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    daemonLog(`[daemon] ${signal} — shutting down`)
    abortCtrl.abort()
    if (loopDone) {
      // Bound the loop drain the same way we bound server.close() below.
      // Under parallel-test podman pressure, an in-flight prewarm or
      // reap tick can stack retries for many seconds — long enough to
      // blow `yaac daemon stop`'s observation window and make the CLI
      // fall back to "force-removed stale lock".
      await Promise.race([
        loopDone.catch((err) => daemonLog(`[daemon] loop exit error: ${String(err)}`)),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
    }
    // Tear down every active port-forwarder before closing the server.
    // Each forwarder owns a listener server and a set of long-lived
    // `podman exec nc` relay children; without this they survive the
    // daemon (orphaned to PID 1) and the next daemon stacks new ones on
    // top via restoreAllSessionForwarders.
    stopAllSessionForwarders()

    // @hono/node-server wraps a Node http.Server; close() refuses new
    // connections, drains in-flight requests, then fires the callback.
    // Bound to 3s so a wedged long-poll can't block lock removal; the
    // daemon is going away either way, and the lock file is the thing
    // the CLI watches to decide whether to restart.
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
    // Pass our pid so a shutdown that dragged past stopDaemon's 3s
    // force-remove window (e.g. wedged background loop) can't unlink a
    // successor daemon's lock.
    await removeLock(process.pid)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // A daemon restart loses the in-memory forwarder registry while
  // running containers keep their tmux `status-right` advertising
  // ports that aren't actually forwarded anymore. Rebuild forwarders
  // for every live session container before we process RPCs so the
  // displayed port mapping matches reality.
  try {
    await restoreAllSessionForwarders()
  } catch (err) {
    daemonLog(`[daemon] restore forwarders failed: ${String(err)}`)
  }

  // Start the background loop before running orphan GC. Both GC passes
  // hit the podman socket, and during a freeze cluster (saturated VM,
  // user restarting repeatedly) they can take minutes — blocking the
  // first prewarm tick that whole time. Running them concurrently with
  // the loop lets the daemon serve the prewarm/reconcile path right
  // away while the GC drains in the background.
  loopDone = startBackgroundLoop({
    signal: abortCtrl.signal,
    // After each reconciliation tick, push a fresh snapshot to any
    // connected webapp clients (no-op when none are connected, and only
    // broadcasts when the state actually changed).
    onTick: () => hub.publishSnapshot(),
  })

  // Remove per-session podman graphroot volumes whose session container
  // is gone (crashed session, killed daemon, host reboot). No layer
  // salvage — cache missed at crash time is forfeit.
  void gcOrphanSessionVolumes()
    .catch((err) => daemonLog(`[daemon] orphan volume GC failed: ${String(err)}`))

  // Remove per-session `.cached-packages/modules/<sid>` dirs whose
  // session container is gone. Same rationale as graphroot GC above —
  // catches leftovers from crashes and host reboots.
  void gcOrphanEphemeralModuleDirs()
    .catch((err) => daemonLog(`[daemon] orphan modules GC failed: ${String(err)}`))
}

/**
 * Entry point for `yaac daemon start`.
 *
 * - If a daemon is already running with the matching buildId, no-op.
 * - If running with a different buildId, throw — the user should
 *   `yaac daemon restart`.
 * - Otherwise clean any stale lock, spawn `yaac daemon run` detached,
 *   and wait up to 5s for the new lock to appear.
 */
export async function startDaemon(): Promise<void> {
  await preflightHostTor()
  await ensureDataDir()
  const cliBuildId = await readBuildId()

  const existing = await readLock()
  if (existing && await isLockLive(existing)) {
    if (existing.buildId === cliBuildId) {
      console.error(`[yaac] daemon already running pid=${existing.pid} port=${existing.port}`)
      return
    }
    throw new Error(
      'yaac daemon is running an outdated version '
      + `(daemon buildId ${existing.buildId}, CLI buildId ${cliBuildId}). `
      + 'Restart it with: yaac daemon restart',
    )
  }

  // Lock file present but not live (pid dead or /health unresponsive) —
  // the next spawn's idempotency check would overwrite it anyway, but
  // clearing first keeps the "wait for new lock" poll simple.
  if (existing) await removeLock()

  await spawnDaemonDetached()
  const fresh = await waitForLiveLock(5000)
  if (fresh.buildId !== cliBuildId) {
    throw new Error(
      `daemon buildId ${fresh.buildId} does not match CLI buildId ${cliBuildId}`,
    )
  }
  const torPrefix = isTorEnabled() ? '(using tor) ' : ''
  console.error(`[yaac] ${torPrefix}daemon started pid=${fresh.pid} port=${fresh.port}`)
}

/**
 * Entry point for `yaac daemon stop`. SIGTERMs the running daemon and
 * waits for its shutdown handler to unlink the lock. Force-removes the
 * lock if the daemon doesn't exit within 3s.
 */
export async function stopDaemon(): Promise<void> {
  const existing = await readLock()
  if (!existing) {
    console.error('[yaac] daemon is not running')
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

  // The daemon's shutdown path is bounded to ~6s worst case (3s loop
  // drain + 3s server close) under heavy parallel load. Poll with
  // headroom so a healthy SIGTERM-driven exit isn't misreported as a
  // "force-removed stale lock".
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const cur = await readLock()
    if (!cur || cur.pid !== existing.pid) {
      console.error(`[yaac] daemon stopped (pid ${existing.pid})`)
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  // Daemon didn't clean up in time. Remove the lock ourselves — the old
  // process is either gone or wedged, either way it's no longer the
  // source of truth.
  const cur = await readLock()
  if (cur && cur.pid === existing.pid) await removeLock()
  console.error(`[yaac] force-removed stale lock (pid ${existing.pid})`)
}

/**
 * Entry point for `yaac daemon restart`. Stops any running daemon, then
 * starts a fresh one.
 */
export async function restartDaemon(): Promise<void> {
  await stopDaemon()
  await startDaemon()
}

export function buildWebappUrl(port: number, code: string): string {
  return `http://127.0.0.1:${port}/?bootstrap=${code}`
}

export interface OpenWebappOptions {
  /** Print the URL instead of launching a browser. */
  noBrowser?: boolean
  // Injected for tests; default to the real implementations.
  ensureDaemon?: () => Promise<void>
  loadLock?: () => Promise<DaemonLock | null>
  fetchImpl?: typeof fetch
  launch?: (url: string) => void
}

/**
 * Entry point for `yaac open`. Ensures the daemon is running, fetches a
 * fresh bootstrap code over the authenticated API, and launches the
 * browser straight into the authenticated webapp — no log-scraping or
 * code-pasting. The URL is always printed (stdout) so it's scriptable.
 */
export async function openWebapp(opts: OpenWebappOptions = {}): Promise<void> {
  const ensureDaemon = opts.ensureDaemon ?? startDaemon
  const loadLock = opts.loadLock ?? readLock
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  const launch = opts.launch ?? openBrowser

  // Idempotent: no-ops if a matching daemon is already running.
  await ensureDaemon()
  const lock = await loadLock()
  if (!lock) throw new Error('daemon is not running')

  const res = await fetchImpl(`http://127.0.0.1:${lock.port}/auth/bootstrap-code`, {
    headers: { authorization: `Bearer ${lock.secret}` },
  })
  if (!res.ok) throw new Error(`failed to fetch bootstrap code (HTTP ${res.status})`)
  const { code } = await res.json() as { code: string }

  const url = buildWebappUrl(lock.port, code)
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

async function spawnDaemonDetached(): Promise<void> {
  const { bin, args } = resolveDaemonInvocation()
  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  // If the spawn itself fails immediately (e.g. ENOENT), surface it.
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    // A spawned detached process won't emit a useful signal here, so
    // give it a tick and assume success — the lock poll will catch
    // the actual failure mode (e.g. "daemon never wrote the lock").
    setTimeout(resolve, 50)
  })
}

/**
 * Figure out how to relaunch ourselves as `yaac daemon run`.
 *
 * - Production build (`dist/cli.js`): `process.execPath` is node and
 *   `argv[1]` is the bundled entry — just reuse both.
 * - Dev (source `.ts` files): we're running under tsx. tsx strips its
 *   own CLI script from argv before running the target, so `argv[1]`
 *   is the source entry (`src/cli.ts`). Respawn via tsx's CLI so the
 *   loader is set up again in the child.
 */
function resolveDaemonInvocation(): { bin: string; args: string[] } {
  const entry = process.argv[1] ?? ''
  if (entry.endsWith('.ts')) {
    const tsxCli = findTsxCli()
    if (tsxCli) return { bin: process.execPath, args: [tsxCli, entry, 'daemon', 'run'] }
    // Fallback: launch via node and hope NODE_OPTIONS carries the loader.
    return { bin: process.execPath, args: [entry, 'daemon', 'run'] }
  }
  return { bin: process.execPath, args: [entry, 'daemon', 'run'] }
}

function findTsxCli(): string | null {
  const here = path.dirname(__filename)
  // Walk up from src/daemon/ looking for node_modules/tsx/dist/cli.mjs (or
  // the pnpm-flattened equivalent).
  let dir = here
  for (let i = 0; i < 10; i++) {
    const direct = path.join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    if (existsSync(direct)) return direct
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function loadWebSessions(): Promise<string[]> {
  try {
    const raw = await fs.readFile(webSessionsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return [] // no file yet, or unreadable — start fresh
  }
}

async function saveWebSessions(sessions: string[]): Promise<void> {
  try {
    await fs.writeFile(webSessionsPath(), JSON.stringify(sessions), { mode: 0o600 })
  } catch (err) {
    daemonLog(`[daemon] failed to persist web sessions: ${String(err)}`)
  }
}

async function waitForLiveLock(timeoutMs: number): Promise<DaemonLock> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock()
    if (lock && await isLockLive(lock)) return lock
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('daemon did not start within 5s')
}

export interface DaemonLogsOptions {
  /** Keep printing as new lines are appended to the log file. */
  follow?: boolean
  /** Print only the last N lines (before following, if combined with follow). */
  lines?: number
}

/**
 * Entry point for `yaac daemon logs`. Prints ~/.yaac/daemon.log to stdout.
 *
 * - No options: prints the whole file.
 * - `--lines N`: prints only the last N lines.
 * - `--follow`: after the initial print, keeps printing new content as it
 *   is appended. Polls at 200ms since fs.watch is flaky across platforms
 *   and log throughput is tiny — polling is simpler and plenty fast.
 */
export async function daemonLogs(opts: DaemonLogsOptions = {}): Promise<void> {
  const logPath = daemonLogPath()

  let position = 0
  if (existsSync(logPath)) {
    position = opts.lines !== undefined
      ? await lastNLinesOffset(logPath, opts.lines)
      : 0
    await writeRangeToStdout(logPath, position)
    position = (await fs.stat(logPath)).size
  } else if (!opts.follow) {
    console.error(`[yaac] no daemon log at ${logPath}`)
    return
  } else {
    console.error(`[yaac] no daemon log at ${logPath} yet — waiting for it`)
  }

  if (!opts.follow) return
  await followLog(logPath, position)
}

/**
 * Return the byte offset that begins the last `n` lines of `logPath`.
 * Assumes lines end in '\n'. For n=0 returns the end of the file.
 */
async function lastNLinesOffset(logPath: string, n: number): Promise<number> {
  if (n <= 0) return (await fs.stat(logPath)).size
  const content = await fs.readFile(logPath, 'utf8')
  if (content.length === 0) return 0
  // Strip a single trailing newline so splitting doesn't create a bogus
  // empty last element.
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = trimmed.split('\n')
  if (lines.length <= n) return 0
  const skipped = lines.slice(0, lines.length - n).join('\n') + '\n'
  return Buffer.byteLength(skipped, 'utf8')
}

async function writeRangeToStdout(logPath: string, start: number): Promise<void> {
  const stat = await fs.stat(logPath)
  if (start >= stat.size) return
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(logPath, { start, end: stat.size - 1 })
    stream.on('data', (chunk) => process.stdout.write(chunk as Buffer))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
}

async function followLog(logPath: string, fromPosition: number): Promise<void> {
  let position = fromPosition
  await new Promise<void>((resolve) => {
    const onSigint = (): void => {
      clearInterval(timer)
      process.off('SIGINT', onSigint)
      resolve()
    }
    process.on('SIGINT', onSigint)
    const timer = setInterval(() => {
      void (async () => {
        try {
          if (!existsSync(logPath)) return
          const stat = await fs.stat(logPath)
          if (stat.size > position) {
            await writeRangeToStdout(logPath, position)
            position = stat.size
          } else if (stat.size < position) {
            // File was truncated or replaced — resync from the top.
            position = 0
          }
        } catch {
          // Ignore transient FS errors; the next tick will retry.
        }
      })()
    }, 200)
  })
}

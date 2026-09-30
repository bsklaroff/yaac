import net from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { MiddlewareHandler } from 'hono'
import { buildApp } from '#main/server'
import {
  authAgentHub,
  pushCredentialsToRuntime,
  refreshPlanUsage,
  runtimeMediatesEgress,
  syncToolCredentialsThrottled,
} from '#domain/auth'
import { closeDb, listProjectRows, openDb } from '#db'
import { clearGitScratch, startGitSshAgent, stopGitSshAgent } from '#domain/git'
import { EventHub, type WsLike } from '#api/events'
import { convertLinkedCheckouts, resolveWorkspaceContainer } from '#domain/workspaces'
import { attachConvergence, releaseConvergence, stopConvergence } from '#main/convergence'
import { coalesceCalls, onWorkspaceListChanged } from '#notify'
import { refreshClaudeBundledSkills } from '#domain/skills'
import { attachPty, type SocketLike } from '#runtime/terminals'
import { TUNNEL_DIAL_FAILED, attachPortTunnel } from '#runtime/ports'
import { attachAcp } from '#runtime/agents'
import { readBuildId } from '@yaac/shared/build-id'
import {
  acquireLock,
  newLeaseFields,
  renewLease,
  serverLockPath,
  readLock,
  removeLock,
} from '@yaac/shared/lock'
import { LEASE_HEARTBEAT_MS, isLockLive } from '@yaac/shared/server-lock-file'
import { resolveServerPort, bindWithAutoIncrement } from '@yaac/shared/server-port'
import { ensureDataDir } from '@yaac/shared/project-paths'
import { startReconciler } from '#main/reconciler'
import { setWorkspaceDriver, workspaceDriver } from '#drivers/driver'
import { moveLegacyWorkspacesDirs, resolveProjectEnv } from '#domain/projects'
import { createK8sDriver } from '#drivers/k8s'
import { createContainerlessDriver } from '#drivers/containerless'
import { assertHostServerAllowed, resolveDriverKind } from '#main/driver-choice'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import { agentSessionIdSchema, type DriverKind } from '@yaac/shared/types'
import { ServerError } from '@yaac/shared/errors'

export interface ServerRunOptions {
  port?: number
}

/**
 * The subset of the `ws` WebSocket (WSContext.raw) we use. `ws` is a
 * transitive dependency, so its types are not importable here.
 */
interface RawWebSocket {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  ping(): void
  terminate(): void
  readonly readyState: number
  on(event: 'message', cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'pong', cb: () => void): void
}

/** `WebSocket.OPEN` (the `ws` class constant is not importable here). */
const WS_OPEN = 1

/**
 * Heartbeat interval for the auth-agent socket. We ping the daemon and drop
 * the socket if a ping goes unanswered, so a dead daemon (host asleep,
 * network down) shows as disconnected instead of hanging sign-in ops.
 */
const AGENT_HEARTBEAT_MS = 15_000

// With YAAC_USE_TOR, the server's own git goes through a host Tor SOCKS
// endpoint (default 127.0.0.1:9050). Fail at startup if it is unreachable
// rather than on the first git operation.
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

/**
 * What `YAAC_USE_TOR` does not cover under the given driver, or undefined
 * when it covers everything.
 *
 * The server's own git is routed through Tor under either driver. Under
 * `k8s`, all workspace traffic is redirected into the egress proxy, which
 * dials through Tor. Containerless workspaces are plain host processes with
 * no proxy, and advisory env (`ALL_PROXY`, ssh ProxyCommand) fails open
 * (undici ignores it, raw sockets and DNS bypass it), so we warn instead.
 */
export function torCoverageWarning(driver: DriverKind): string | undefined {
  if (!env.useTor || driver !== 'containerless') return undefined
  return 'YAAC_USE_TOR is set, but the containerless driver runs workspaces '
    + 'directly on the host with no egress proxy, so agent traffic and '
    + 'anything a workspace does itself will NOT go through Tor. Only the '
    + "server's own git operations are routed through it. A cluster install "
    + '(`yaac cluster install`) is what gives Tor-covered workspaces.'
}

// `FetchCallback` is not exported from the package entry, so derive it.
type ServeFetch = Parameters<typeof serve>[0]['fetch']

/**
 * Bind the HTTP server on `env.bindAddr` (loopback by default), starting
 * at `startPort` and moving up past ports in use. The bound port is
 * returned and recorded in the lock file. `startPort` 0 asks the OS for an
 * ephemeral port.
 */
function bindServer(
  fetch: ServeFetch,
  startPort: number,
): Promise<{ server: ServerType; port: number }> {
  const hostname = env.bindAddr
  return bindWithAutoIncrement(startPort, (port) =>
    new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
      const s = serve({ fetch, port, hostname }, (info) => {
        resolve({ server: s, port: info.port })
      })
      s.once('error', reject)
    }),
  )
}

/**
 * Refuse two setups the identity model cannot protect
 * (docs/remote-hosting.md), before anything is bound.
 *
 * A loopback request that did not come through `tailscale serve` is
 * treated as the machine's owner. A non-loopback bind would let anyone who
 * reaches it send `Host: 127.0.0.1`, so it is refused, except in the pod,
 * whose ingress policy admits only the node and the fronting.
 *
 * `YAAC_REQUIRE_AUTH` asked for a credential gate on a shared loopback,
 * which no longer exists; starting anyway would silently serve other OS
 * users, so it is refused (docs/legacy-compat-shims.md).
 */
function refuseUnsupportedExposure(): void {
  const bind = env.bindAddr
  if (!env.inCluster && bind !== '127.0.0.1' && bind !== 'localhost') {
    throw new Error(
      `YAAC_BIND_ADDR=${bind} would expose the server beyond this machine's loopback, `
      + 'where anything that reaches it is taken for this machine\'s owner. '
      + 'Bind loopback and reach it from elsewhere through `tailscale serve` '
      + '(docs/remote-hosting.md).',
    )
  }
  if (env.requireAuthSet) {
    throw new Error(
      'YAAC_REQUIRE_AUTH is set, and yaac no longer has a credential gate to '
      + 'require: a request at this machine\'s loopback is its owner. A host '
      + 'shared with other OS users is not a supported shared deployment — '
      + 'serve it over the tailnet with `tailscale serve` and let each person '
      + 'reach it by its ts.net name (docs/remote-hosting.md). Unset '
      + 'YAAC_REQUIRE_AUTH to start.',
    )
  }
}

/**
 * Entry point for `yaac server run`, the foreground HTTP server.
 *
 * - If another server is live, log it and return.
 * - Otherwise bind <env.bindAddr>:<port> (`--port`, else YAAC_SERVER_PORT,
 *   else DEFAULT_SERVER_PORT, moving up past ports in use), write the lock,
 *   and serve until SIGTERM / SIGINT, then remove the lock and exit.
 */
export async function runServer(opts: ServerRunOptions): Promise<void> {
  refuseUnsupportedExposure()
  await preflightHostTor()
  await ensureDataDir()

  // The driver follows placement (`#main/driver-choice`). It is registered
  // before anything can ask for it, so a missing driver is a startup-order
  // bug. This is the only place in `src/` that names a concrete driver.
  await assertHostServerAllowed()
  const driverKind = resolveDriverKind()
  setWorkspaceDriver(
    driverKind === 'containerless' ? createContainerlessDriver() : createK8sDriver(),
  )
  serverLog(`[server] runtime driver: ${driverKind}`)
  // What Tor covers depends on the driver.
  const torGap = torCoverageWarning(driverKind)
  if (torGap !== undefined) serverLog(`[server] WARNING: ${torGap}`)

  // Read the build id first so a broken install fails before binding.
  const buildId = await readBuildId()

  // Best-effort early exit if a live server holds the lock; acquireLock
  // below is the race-safe check.
  const preExisting = await readLock()
  if (preExisting && await isLockLive(preExisting)) {
    serverLog(`[server] already running pid=${preExisting.pid} port=${preExisting.port}`)
    return
  }

  const hub = new EventHub()
  // Set once DB init finishes; `/health` reports it as `ready` so
  // `yaac server start` waits for real readiness.
  let ready = false
  // Rebuild, diff and push the snapshot on every store notification
  // (see #notify). Bursts coalesce into one trailing rebuild.
  onWorkspaceListChanged(coalesceCalls(() => { void hub.publishSnapshot() }, 150))
  // Plan usage has no push source upstream, so poll it, but only while a
  // client is connected. A landed result notifies on its own.
  const planUsageTimer = setInterval(() => {
    if (hub.size === 0) return
    void refreshPlanUsage().catch(
      (err: unknown) => serverLog(`[server] plan-usage refresh failed: ${String(err)}`),
    )
  }, 5 * 60_000)
  const app = buildApp({ buildId, isReady: () => ready })

  // WebSocket routes are registered here, not in buildApp, so buildApp's
  // return type stays the plain Hono app the CLI's RPC client infers from.
  // Keep `nodeWs` whole: injectWebSocket relies on `this`.
  const nodeWs = createNodeWebSocket({ app })
  // Compress WebSockets: terminal repaints and snapshot/ACP JSON deflate
  // well, which matters over a slow tailnet link.
  //
  // Set after construction because @hono/node-ws passes no options to its
  // WebSocketServer; `ws` reads this per upgrade, and it must be an object.
  // An api test asserts the extension is negotiated.
  //
  // Context takeover stays on (ws's default): about 300KB of zlib state per
  // socket, but successive repaints share history and compress far better.
  // To cap memory, set `zlibDeflateOptions: { memLevel, windowBits }` or
  // `serverNoContextTakeover: true`.
  nodeWs.wss.options.perMessageDeflate = {
    // Small frames (keystrokes, echoes, control) are not worth compressing.
    // This only affects our side; browsers still deflate their own tiny
    // frames.
    threshold: 512,
    zlibDeflateOptions: { level: 6 },
  }
  app.get('/api/events', nodeWs.upgradeWebSocket(() => {
    // Send through the raw `ws` socket: WSContext.send passes
    // `compress: undefined`, which overrides ws's `compress: true` default
    // and would leave snapshots uncompressed.
    let conn: WsLike | null = null
    return {
      onOpen: (_evt, ws) => {
        const raw = ws.raw as RawWebSocket | undefined
        if (!raw) {
          ws.close(1011, 'no raw socket')
          return
        }
        // `ws` ignores sends on a closed socket, so removal relies on
        // onClose/onError; the guard just skips sends while closing.
        conn = {
          send: (data: string) => { if (raw.readyState === WS_OPEN) raw.send(data) },
        }
        hub.add(conn)
        void hub.sendSnapshotTo(conn).catch(
          (err: unknown) => serverLog(`[server] events: initial snapshot failed: ${String(err)}`),
        )
      },
      onClose: () => { if (conn) hub.remove(conn) },
      onError: () => { if (conn) hub.remove(conn) },
    }
  }))

  // Auth-daemon relay: the login broker on the user's machine keeps one
  // outbound socket here; sign-in routes forward ops over it.
  app.get('/api/agent/auth', nodeWs.upgradeWebSocket(() => ({
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
      // Terminate if the previous ping got no pong. Starts true so a new
      // socket survives the first tick; terminate() leads to handleDisconnect.
      let alive = true
      raw.on('pong', () => { alive = true })
      const heartbeat = setInterval(() => {
        if (!alive) {
          raw.terminate()
          return
        }
        alive = false
        try {
          raw.ping()
        } catch { /* socket tore down between tick and ping */ }
      }, AGENT_HEARTBEAT_MS)
      heartbeat.unref?.()
      raw.on('close', () => {
        clearInterval(heartbeat)
        authAgentHub.handleDisconnect(sock)
      })
    },
  })))

  // Attaches name a workspace by exact id, so a missing id is refused
  // before any lookup. The conversation id is validated because it is
  // joined into a path downstream.
  const attachQuery = (opts: { session?: boolean } = {}): MiddlewareHandler => async (c, next) => {
    if (!c.req.query('id')) throw new ServerError('VALIDATION', 'a workspace id is required')
    if (opts.session && !agentSessionIdSchema.safeParse(c.req.query('session')).success) {
      throw new ServerError('VALIDATION', 'a valid conversation id is required')
    }
    await next()
  }

  // PTY bridge: one terminal per connection, attached to the workspace's
  // tmux. Not under /workspace/ to avoid colliding with GET /workspace/:id.
  app.get('/api/pty/attach', attachQuery(), nodeWs.upgradeWebSocket((c) => {
    const id = c.req.query('id') ?? ''
    // attachPty validates these and spawns the PTY at the browser's size, so
    // tmux and the client grid match from the first frame.
    const query = {
      target: c.req.query('target'),
      cols: c.req.query('cols'),
      rows: c.req.query('rows'),
    }
    return {
      onOpen: (_evt, ws) => {
        void (async () => {
          let jobName: string
          try {
            const resolved = await resolveWorkspaceContainer(id, { requireRunning: true, exact: true })
            jobName = resolved.jobName
          } catch {
            try {
              ws.send(JSON.stringify({ type: 'error', message: 'session not found or not running' }))
            } catch { /* socket already gone */ }
            ws.close(1011, 'resolve failed')
            return
          }
          const raw = ws.raw as RawWebSocket | undefined
          if (!raw) {
            ws.close(1011, 'no raw socket')
            return
          }
          const sock: SocketLike = {
            send: (data) => raw.send(data),
            close: (code, reason) => raw.close(code, reason),
            onMessage: (cb) => raw.on('message', (data, isBinary) =>
              cb(Array.isArray(data) ? Buffer.concat(data) : data, isBinary)),
            onClose: (cb) => raw.on('close', () => cb()),
          }
          attachPty(jobName, sock, query)
          serverLog(`[server] pty attach: session=${id} job=${jobName}`)
        })()
      },
    }
  }))

  // Port-forward tunnel: one WebSocket per forwarded TCP connection. The
  // server binds no host port on either driver; `yaac forward` or the
  // desktop app listens on the user's machine and opens one of these per
  // connection (docs/port-forward-tunnel.md).
  app.get('/api/forward/attach', attachQuery(), nodeWs.upgradeWebSocket((c) => {
    const id = c.req.query('id') ?? ''
    const port = Number(c.req.query('port'))
    return {
      onOpen: (_evt, ws) => {
        void (async () => {
          const fail = (message: string): void => {
            ws.close(TUNNEL_DIAL_FAILED, message)
          }
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            fail('bad port')
            return
          }
          let workspaceId: string
          try {
            workspaceId = (await resolveWorkspaceContainer(id, { requireRunning: true, exact: true })).workspaceId
          } catch (err) {
            serverLog(`[server] forward tunnel to ${id.slice(0, 8)}:${String(port)} refused: `
              + (err instanceof Error ? err.message : String(err)))
            fail('session not found or not running')
            return
          }
          const raw = ws.raw as RawWebSocket | undefined
          if (!raw) {
            ws.close(1011, 'no raw socket')
            return
          }
          attachPortTunnel(workspaceId, port, {
            // Binary only, in both directions: this carries bytes.
            send: (data) => raw.send(data),
            close: (code, reason) => raw.close(code, reason),
            onMessage: (cb) => raw.on('message', (data, isBinary) =>
              cb(Array.isArray(data) ? Buffer.concat(data) : data, isBinary)),
            onClose: (cb) => raw.on('close', () => cb()),
          })
        })()
      },
    }
  }))

  // ACP bridge: one chat pane per connection, attached to the live
  // `AcpConversation` held by the status watcher's driver. Frames are JSON
  // events.
  app.get('/api/acp/attach', attachQuery({ session: true }), nodeWs.upgradeWebSocket((c) => {
    const id = c.req.query('id') ?? ''
    const agentSessionId = c.req.query('session') ?? ''
    return {
      onOpen: (_evt, ws) => {
        void (async () => {
          const fail = (message: string): void => {
            try {
              ws.send(JSON.stringify({ type: 'health', connected: false }))
              ws.send(JSON.stringify({ type: 'error', message }))
            } catch { /* socket already gone */ }
            ws.close(1011, message)
          }
          let projectSlug: string
          try {
            projectSlug = (await resolveWorkspaceContainer(id, { requireRunning: true, exact: true })).projectSlug
          } catch {
            fail('session not found or not running')
            return
          }
          const raw = ws.raw as RawWebSocket | undefined
          if (!raw) {
            ws.close(1011, 'no raw socket')
            return
          }
          attachAcp(projectSlug, id, agentSessionId, {
            send: (data) => raw.send(data),
            close: (code, reason) => raw.close(code, reason),
            onMessage: (cb) => raw.on('message', (data, isBinary) =>
              cb(Array.isArray(data) ? Buffer.concat(data) : data, isBinary)),
            onClose: (cb) => raw.on('close', () => cb()),
          })
          serverLog(`[server] acp attach: session=${id} conversation=${agentSessionId}`)
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

  // Race-safe acquire (O_EXCL). A loser closes its server and returns,
  // leaving the existing server in charge.
  const lease = newLeaseFields()
  const outcome = await acquireLock({
    pid: process.pid, port, startedAt: Date.now(), buildId, ...lease,
  })
  if (!outcome.acquired) {
    serverLog(`[server] already running pid=${outcome.existing.pid} port=${outcome.existing.port}`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return
  }
  // Renew the lease while we hold it. Readers in another container judge
  // the lock by this heartbeat, since our pid and port mean nothing there.
  // On kind the data dir is a hostPath with no attach exclusivity, so the
  // lease is PGlite's only single-writer guard: losing it means exiting.
  const leaseTimer = setInterval(() => {
    void renewLease(lease.instance).then((held) => {
      if (held) return
      serverLog('[server] lost the lock lease to another server — exiting')
      process.exit(1)
    }).catch((err: unknown) => {
      // A failed renewal is not a lost lease; the next tick retries.
      serverLog(`[server] lease renewal failed: ${String(err)}`)
    })
  }, LEASE_HEARTBEAT_MS)
  leaseTimer.unref?.()
  // Open the DB only under the lock (PGlite's single-writer guard), and
  // fail the start if it cannot open.
  try {
    await openDb()
  } catch (err) {
    serverLog(`[server] db init failed: ${String(err)}`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeLock(lease.instance)
    process.exit(1)
  }
  // Before anything resolves a checkout path (docs/legacy-compat-shims.md).
  await moveLegacyWorkspacesDirs()
  // Clear git scratch left by a killed predecessor, before any git runs.
  await clearGitScratch()
  // The ssh agent the server's git signs with (docs/git-credentials.md);
  // needs the DB.
  await startGitSshAgent()

  // Set synchronously so it is true before any queued request runs.
  ready = true

  const torPrefix = env.useTor ? '(using tor) ' : ''
  serverLog(`[server] ${torPrefix}listening on ${env.bindAddr}:${port} lock=${serverLockPath()}`)
  serverLog(`[server] open http://127.0.0.1:${port}/`)

  // Register signal handlers before the async startup below; Node's
  // default action would exit without removing the lock.
  const abortCtrl = new AbortController()
  let loopDone: Promise<void> | null = null
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    serverLog(`[server] ${signal} — shutting down`)
    abortCtrl.abort()
    clearInterval(planUsageTimer)
    clearInterval(leaseTimer)
    // Stop pushing snapshots; clients are about to disconnect.
    onWorkspaceListChanged(() => {})
    // Stop watches before the loop drain so their connections and
    // per-workspace processes do not outlive the server. Caught so the
    // drain, release and lock removal below always run.
    try {
      stopConvergence()
    } catch (err) {
      serverLog(`[server] stop convergence failed: ${String(err)}`)
    }
    if (loopDone) {
      // Bounded like server.close(): a reap tick retrying under load could
      // otherwise outlast `yaac server stop`'s wait.
      await Promise.race([
        loopDone.catch((err) => serverLog(`[server] loop exit error: ${String(err)}`)),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
    }
    // Release port forwarders and the proxy control tunnel, after the drain
    // since a reap still tears its workspace's forwards down.
    try {
      releaseConvergence()
    } catch (err) {
      serverLog(`[server] release convergence failed: ${String(err)}`)
    }

    // close() drains in-flight requests. Bounded to 3s so a wedged request
    // cannot delay lock removal, which the CLI waits on.
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
    await stopGitSshAgent().catch((err: unknown) => serverLog(`[server] ssh-agent stop failed: ${String(err)}`))
    // Checkpoint so PGlite reopens cleanly. Bounded; WAL replay covers a
    // wedged close.
    await Promise.race([
      closeDb().catch((err: unknown) => serverLog(`[server] db close failed: ${String(err)}`)),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
    // Pass our lease so a slow shutdown cannot remove a successor's lock.
    await removeLock(lease.instance)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Best-effort fetch of Claude's bundled-skills list for the skills viewer.
  void refreshClaudeBundledSkills()

  // Attach to the substrate (informers, status watchers, port detector).
  // The reconcile loop starts from `onAttached`, since a driver may defer
  // attaching until first use.
  await attachConvergence({
    onAttached: () => {
      loopDone = startReconciler({ signal: abortCtrl.signal })
      // Convert an older install's stopped workspaces onto clones
      // (docs/server-git.md). After attach, since only stopped workspaces
      // are converted.
      void convertLinkedCheckouts()
        .catch((err: unknown) => serverLog(`[server] linked checkout conversion failed: ${String(err)}`))
      // Adopt credentials the last server's workspaces refreshed before
      // anything reads the host store. Throttled like the reconcile step, so
      // this is its first run rather than an extra one. Only for drivers
      // that do not mediate egress.
      if (!runtimeMediatesEgress()) {
        void syncToolCredentialsThrottled()
          .catch((err: unknown) => serverLog(`[server] credential sync failed: ${String(err)}`))
      } else {
        // Egress-mediating drivers get the full credential set and every
        // project's secrets once per start.
        void convergeRuntimeCredentials()
          .catch((err: unknown) => serverLog(`[server] credential push failed: ${String(err)}`))
      }
    },
  })
}

/** Push the credential set and each project's secret values to the runtime.
 *  Best-effort per project, so one failure does not block the rest. */
async function convergeRuntimeCredentials(): Promise<void> {
  await pushCredentialsToRuntime()
  for (const { slug } of await listProjectRows()) {
    try {
      const { secrets } = await resolveProjectEnv(slug)
      await workspaceDriver().syncProjectSecrets(
        slug,
        Object.fromEntries(Object.entries(secrets).map(([name, { value }]) => [name, value])),
      )
    } catch (err) {
      serverLog(`[server] secret push for project "${slug}" failed: ${String(err)}`)
    }
  }
}

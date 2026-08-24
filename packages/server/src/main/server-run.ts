import crypto from 'node:crypto'
import net from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { buildApp } from '#main/server'
import {
  authAgentHub,
  refreshPlanUsage,
  runtimeMediatesEgress,
  syncToolCredentialsThrottled,
} from '#domain/auth'
import { createTokenStore, isCredentialOptional, loadTokens, saveTokens } from '#http'
import { closeDb, openDb } from '#db'
import { EventHub, type WsLike } from '#api/events'
import { resolveWorktreeContainer } from '#domain/worktrees'
import { attachConvergence, releaseConvergence, stopConvergence } from '#main/convergence'
import { coalesceCalls, onWorktreeListChanged } from '#notify'
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
import { setWorktreeDriver } from '#drivers/driver'
import { listSshEntries } from '#domain/projects'
import { createK8sDriver } from '#drivers/k8s'
import { createContainerlessDriver } from '#drivers/containerless'
import { assertHostServerAllowed, resolveDriverKind } from '#main/driver-choice'
import { serverLog } from '#log'
import { env } from '@yaac/shared/env'
import type { DriverKind } from '@yaac/shared/types'

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
  ping(): void
  terminate(): void
  readonly readyState: number
  on(event: 'message', cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'pong', cb: () => void): void
}

/** `WebSocket.OPEN`. Spelled out because the `ws` types aren't in our
 *  resolvable set, so the class constant isn't reachable from here. */
const WS_OPEN = 1

/**
 * Server-side heartbeat cadence for the auth-agent socket. The daemon pings
 * us; we ping it back on this interval and drop the socket if a ping goes
 * unanswered, so a silently-dead daemon (its host slept, network partitioned)
 * stops looking connected and sign-in routes surface "disconnected" at once
 * rather than forwarding ops that hang.
 */
const AGENT_HEARTBEAT_MS = 15_000

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

/**
 * What `YAAC_USE_TOR` does NOT cover under the running driver, or undefined
 * when it covers everything.
 *
 * Two halves are torified independently. The server's own git is one, and it
 * is host-side and driver-independent, so it is routed under either
 * substrate. Workspace traffic is the other, and under `k8s` it is total:
 * a pod's network namespace redirects every connection into the egress
 * proxy, which carries `USE_TOR` and dials upstream through Tor, and a pod
 * has no other way out.
 *
 * A containerless workspace is plain host processes with no namespace and no
 * proxy, so there is nothing to redirect them into. The only lever left is
 * advisory environment (`ALL_PROXY`, an ssh ProxyCommand), which fails OPEN
 * — undici ignores it, raw sockets bypass it, DNS can leak past it, and the
 * agent's own shell can unset it. For someone who asked for Tor, a mechanism
 * that silently misses traffic is worse than knowing which half is covered,
 * so the setting keeps doing the half it can and this says what it cannot.
 */
export function torCoverageWarning(driver: DriverKind): string | undefined {
  if (!env.useTor || driver !== 'containerless') return undefined
  return 'YAAC_USE_TOR is set, but the containerless driver runs workspaces '
    + 'directly on the host with no egress proxy, so agent traffic and '
    + 'anything a worktree does itself will NOT go through Tor. Only the '
    + "server's own git operations are routed through it. A cluster install "
    + '(`yaac cluster install`) is what gives Tor-covered workspaces.'
}

// `FetchCallback` isn't re-exported from the package entry, so derive the
// fetch handler's type straight from serve()'s options.
type ServeFetch = Parameters<typeof serve>[0]['fetch']

/**
 * Bind the server's HTTP server on `env.bindAddr` (loopback unless the
 * deployment says otherwise), preferring `startPort` and auto-incrementing
 * past any in-use port to the next free one. The actual bound port is
 * returned (and recorded in the lock file), so `yaac open` and the
 * dev-server proxy follow the server wherever it lands. `startPort` 0 asks
 * the OS for an ephemeral port.
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
 * Entry point for `yaac server run` — the foreground HTTP server.
 *
 * - If another server is already live, print its handshake and exit 0
 *   (idempotent).
 * - Otherwise bind <env.bindAddr>:<port> (resolveServerPort: `--port`, else
 *   YAAC_SERVER_PORT, else DEFAULT_SERVER_PORT), write the lock, serve until
 *   SIGTERM / SIGINT, then unlink the lock and exit. If the preferred port is
 *   already in use it auto-increments to the next free one; the actual bound
 *   port is recorded in the lock.
 */
export async function runServer(opts: ServerRunOptions): Promise<void> {
  // Which runtime this process runs is the composition root's one call to
  // make, and it is made before anything can ask for one: every mediator
  // reaches the substrate through the registered driver, so an unregistered
  // one is a startup-order bug rather than a null branch downstream.
  //
  // The choice comes from the environment because it has to be made here,
  // long before the database this server would otherwise remember it in is
  // open. This is also the only place in `src/` that names a concrete
  // driver — everything else reaches one through `#drivers/driver`.
  await preflightHostTor()
  await ensureDataDir()

  // Placement is the driver (see `#main/driver-choice`): a pod runs k8s, a
  // host process runs containerless, and a host process against a k8s
  // install is refused rather than allowed to become a second writer of the
  // same data dir. After the data dir, because both the record and the
  // refusal read beside the lock; before anything can ask for a runtime,
  // which is what makes an unregistered one a startup-order bug rather than
  // a null branch downstream.
  await assertHostServerAllowed()
  const driverKind = await resolveDriverKind()
  setWorktreeDriver(
    driverKind === 'containerless' ? createContainerlessDriver() : createK8sDriver(),
  )
  serverLog(`[server] runtime driver: ${driverKind}`)
  // Only now can the Tor question be answered: what the setting reaches
  // depends on which substrate carries the workspaces.
  const torGap = torCoverageWarning(driverKind)
  if (torGap !== undefined) serverLog(`[server] WARNING: ${torGap}`)

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
  // The one path by which server state reaches a browser. Every store the
  // snapshot reads notifies at its own mutation site (docs/layered-server.md),
  // and this is the sole consumer of that channel: rebuild, diff, push. The
  // first notification publishes immediately; bursts (server start seeding N
  // pods) coalesce into one trailing rebuild.
  onWorktreeListChanged(coalesceCalls(() => { void hub.publishSnapshot() }, 150))
  // The plan-usage readouts are the one thing here with no edge to ride:
  // the upstream usage endpoints have no push, so freshness can only come
  // from asking. Gated on a connected client, which is what keeps a closed
  // webapp from generating upstream traffic. A landed result notifies, so
  // this needs no publish of its own.
  const planUsageTimer = setInterval(() => {
    if (hub.size === 0) return
    void refreshPlanUsage().catch(
      (err: unknown) => serverLog(`[server] plan-usage refresh failed: ${String(err)}`),
    )
  }, 5 * 60_000)
  const app = buildApp({ secret, buildId, tokens, isReady: () => ready })

  // WebSocket event stream. Registered here (not in buildApp) so buildApp's
  // return type stays the plain Hono app the CLI's typed RPC client infers
  // from. Auth runs as normal middleware on the upgrade — the cookie
  // travels with it, no token in the URL.
  // Keep the object rather than destructuring: injectWebSocket is a
  // method that relies on `this`, so calling a detached reference later
  // would break it (and trips eslint's unbound-method rule).
  const nodeWs = createNodeWebSocket({ app })
  // Compress the WebSockets. What rides them is exactly what deflate is good
  // at — ANSI-heavy terminal repaints and the snapshot/ACP JSON — and over a
  // slow link (a tailnet from far away is the whole WAN path here) that is
  // the cheapest bandwidth there is to get back.
  //
  // Set on the server *after* construction because @hono/node-ws builds its
  // WebSocketServer itself with no options pass-through. `ws` reads this at
  // upgrade time, once per connection, so assigning it here is honored — and
  // it must be an object, since only ws's constructor normalizes `true` to
  // one. The api test asserting the extension is negotiated is the tripwire
  // if a future ws moves that read into the constructor.
  //
  // Everything else is ws's default, which is a deliberate choice with a
  // price: context takeover stays ON in both directions, so a socket that
  // has compressed one frame keeps its zlib contexts for the life of the
  // connection — roughly 300KB per socket at the default memLevel 8 /
  // windowBits 15, or a few MB for a user holding a dozen panes open plus
  // /events and the ACP sockets. That is the right trade here precisely
  // because successive ANSI repaints on one pane share so much history:
  // context takeover is most of why they compress at all. If it ever needs
  // capping, the knobs are `zlibDeflateOptions: { memLevel, windowBits }`
  // and `serverNoContextTakeover: true`.
  nodeWs.wss.options.perMessageDeflate = {
    // Below this, framing and the deflate block header cost more than the
    // compression saves — and the frames under it are the latency-critical
    // ones (a keystroke, its echo, a control frame). Note this exempts our
    // half only: the extension is negotiated in both directions and browsers
    // apply no threshold of their own, so a browser still deflates its own
    // tiny keystroke frames. That is client CPU and nothing else, but it is
    // the one part of the interactive path this cannot exempt.
    threshold: 512,
    zlibDeflateOptions: { level: 6 },
  }
  app.get('/events', nodeWs.upgradeWebSocket(() => {
    // Hold the raw `ws` socket, not Hono's WSContext: the context's send
    // forwards `{ compress: opts?.compress }`, and that explicit `undefined`
    // overrides ws's own `compress: true` default — which would silently
    // leave the largest, most compressible payload on the server uncompressed.
    // The factory runs per connection, so this closure is this client's.
    let conn: WsLike | null = null
    return {
      onOpen: (_evt, ws) => {
        const raw = ws.raw as RawWebSocket | undefined
        if (!raw) {
          ws.close(1011, 'no raw socket')
          return
        }
        // The OPEN guard is not load-bearing — `ws` answers a send on a
        // closed socket by accounting the bytes rather than throwing, so the
        // hub's try/catch could never drop a dead connection anyway and
        // removal rides on onClose/onError below. It states that lifecycle
        // assumption here instead of inheriting it from ws internals, and
        // skips the sends in the closing window for free.
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
      // Liveness: ping the daemon each interval, terminating if the previous
      // ping wasn't ponged. Seeded true so the first tick doesn't fault a
      // just-opened socket. terminate() forces 'close' → handleDisconnect.
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

  // PTY bridge: one embedded terminal per connection, attached to the
  // worktree's tmux. Path is /pty/attach (not /worktree/...) to avoid
  // colliding with the GET /worktree/:id route. Auth rides the upgrade.
  app.get('/pty/attach', nodeWs.upgradeWebSocket((c) => {
    const id = c.req.query('id') ?? ''
    // Which window to attach and the browser's reported grid — validated by
    // attachPty, which spawns the PTY at that size so the tmux window and the
    // client grid match from the first frame (no cold-start reflow garble).
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
            const resolved = await resolveWorktreeContainer(id, { requireRunning: true })
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

  // Port-forward tunnel: one WebSocket per forwarded TCP connection, the
  // far end of a listener the CLIENT holds. The server binds no host port
  // on either substrate — it is a pod under k8s, and under containerless
  // the workspace binds its own — so `yaac forward` and the desktop app
  // accept connections on the user's machine and open one of these for
  // each. Auth rides the upgrade like every WS.
  app.get('/forward/attach', nodeWs.upgradeWebSocket((c) => {
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
            workspaceId = (await resolveWorktreeContainer(id, { requireRunning: true })).worktreeId
          } catch {
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

  // ACP conversation bridge: one chat pane per connection, attached to the
  // live `AcpConversation` the status watcher's driver holds. The PTY route's
  // twin — same auth-on-upgrade, same per-client disposability — but the
  // frames are JSON events rather than terminal bytes.
  app.get('/acp/attach', nodeWs.upgradeWebSocket((c) => {
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
          if (agentSessionId === '') {
            fail('missing session')
            return
          }
          let projectSlug: string
          try {
            projectSlug = (await resolveWorktreeContainer(id, { requireRunning: true })).projectSlug
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

  // Race-safe acquire via O_EXCL. Another server may have slipped past
  // the pre-bind fast-path check above; atomic create ensures exactly one
  // winner. Loser closes its server and exits 0 so the existing server
  // stays the source of truth.
  const lease = newLeaseFields()
  const outcome = await acquireLock({
    pid: process.pid, port, secret, startedAt: Date.now(), buildId, ...lease,
  })
  if (!outcome.acquired) {
    serverLog(`[server] already running pid=${outcome.existing.pid} port=${outcome.existing.port}`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return
  }
  // Renew the lease for as long as we hold it. This is what makes the lock
  // readable across a container boundary, where the pid and the loopback
  // `/health` port it used to be judged by mean nothing: a reader on the
  // other side asks whether the heartbeat is still moving.
  //
  // On the local kind backend the data dir is a hostPath with no attach
  // exclusivity, so this lease is the ONLY single-writer guard PGlite gets
  // — losing it is losing the right to be the install's server, and the
  // process exits rather than keep writing a database another server now
  // owns. Unref'd so it never holds the loop open by itself.
  const leaseTimer = setInterval(() => {
    void renewLease(lease.instance ?? '').then((held) => {
      if (held) return
      serverLog('[server] lost the lock lease to another server — exiting')
      process.exit(1)
    }).catch((err: unknown) => {
      // A failed renewal is not a lost lease: the next tick retries, and
      // the staleness bound is four of them.
      serverLog(`[server] lease renewal failed: ${String(err)}`)
    })
  }, LEASE_HEARTBEAT_MS)
  leaseTimer.unref?.()
  // Open the DB only now that the lock is held (it is the single-writer
  // guard for PGlite), and restore the persisted tokens into the store built
  // empty above — both before the start banner below mints its exchange
  // token, whose onChanged persist rewrites the full token table from the
  // in-memory set. A failure here means tokens would silently not persist,
  // so fail the start rather than run half-alive.
  try {
    await openDb()
    tokens.restoreTokens(await loadTokens())
  } catch (err) {
    serverLog(`[server] db init failed: ${String(err)}`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeLock({ pid: process.pid, instance: lease.instance })
    process.exit(1)
  }
  // DB is open and migrated: the server can now serve real requests, not
  // just answer /health. Set synchronously here so the flag is true before
  // control returns to the event loop and any queued request is processed.
  ready = true

  const torPrefix = env.useTor ? '(using tor) ' : ''
  serverLog(`[server] ${torPrefix}listening on ${env.bindAddr}:${port} lock=${serverLockPath()}`)
  // Start banner for the webapp. A loopback-only / nested server needs no
  // credential, so print a bare URL; otherwise carry a one-time exchange
  // token (single-use, time-bounded; `yaac open` mints fresh ones).
  const openQuery = isCredentialOptional() ? '' : `?token=${tokens.mintExchangeToken().token}`
  serverLog(`[server] open http://127.0.0.1:${port}/${openQuery}`)

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
    serverLog(`[server] ${signal} — shutting down`)
    abortCtrl.abort()
    clearInterval(planUsageTimer)
    clearInterval(leaseTimer)
    // Stop pushing. Teardown mutates plenty that clients can see — every
    // forwarder goes, reap ticks land — and rebuilding a snapshot against a
    // substrate we are in the middle of letting go of buys nothing: the
    // clients are about to be disconnected, and reconnect to a full one.
    onWorktreeListChanged(() => {})
    // Stop the push-fed state layer first, before the loop drain below:
    // its watches hold open substrate connections and a long-lived
    // process per worktree, which would otherwise outlive the server.
    //
    // Caught rather than awaited bare: everything below this line — the
    // drain, the release of the host's ports and tunnels, and the lock
    // removal the CLI watches to decide whether a restart is safe — has to
    // happen even if a driver's own stop throws. A shutdown that skipped
    // them would strand exactly the resources shutdown exists to free.
    try {
      stopConvergence()
    } catch (err) {
      serverLog(`[server] stop convergence failed: ${String(err)}`)
    }
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
    // Then let go of what was borrowed from the host — port forwarders,
    // the proxy control tunnel, the relay's port-forward child. After the
    // drain, because a reap tick still tears its worktree's forwards down.
    try {
      releaseConvergence()
    } catch (err) {
      serverLog(`[server] release convergence failed: ${String(err)}`)
    }

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
    // force-remove window (e.g. wedged reconciler) can't unlink a
    // successor server's lock.
    await removeLock({ pid: process.pid, instance: lease.instance })
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Populate the Claude bundled-skills cache (name + description from the
  // official commands reference) for the skills viewer. Fire-and-forget: it's
  // an in-memory best-effort fetch, so it never blocks startup or fails it.
  void refreshClaudeBundledSkills()

  // Attach to the substrate. Everything convergence-owning starts there —
  // informer caches, status watchers, the port detector — and the
  // reconcile loop starts from `onAttached` rather than from the return,
  // because a driver may defer the whole attach until first use and a
  // loop's first pass would defeat that.
  await attachConvergence({
    onAttached: () => {
      // Started before the startup GCs drain (they run detached), so the
      // server serves the reconcile path right away.
      loopDone = startReconciler({ signal: abortCtrl.signal })
      // Adopt whatever the last server's worktrees refreshed before anything
      // reads the host store — the mirror of the k8s driver's placeholder
      // re-seed, which repairs the same split from the other side. Detached:
      // it is a repair, not a precondition.
      //
      // Throttled and driver-gated to match the reconcile step exactly. The
      // throttle is what makes this the FIRST sweep rather than an extra one:
      // it runs immediately (nothing has stamped the clock yet) and the pass
      // that follows within the minute then correctly skips, instead of
      // repeating the identical sweep. The gate keeps a mediated server —
      // including one running in-cluster — from doing credential work the
      // reconcile pass deliberately has no vocabulary for.
      if (!runtimeMediatesEgress()) {
        void syncToolCredentialsThrottled()
          .catch((err: unknown) => serverLog(`[server] credential sync failed: ${String(err)}`))
      }
    },
    // Where a driver's egress path reads credential material from. SSH
    // identities live in the credentials store above the runtime but are
    // re-read on the DRIVER's schedule — an attach to a replaced proxy pod,
    // a reconnect heal — so no caller can hand the answer in, only the
    // reader. Handed down rather than reached for: a driver imports nothing
    // above its contract, and an entrypoint that composes one without being
    // this process (the api tests build the Hono app in-process) supplies
    // none and gets "no ssh injection", which is what they want.
    sshIdentities: listSshEntries,
  })
}

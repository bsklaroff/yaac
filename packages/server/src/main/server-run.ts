import { serve, type ServerType } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { buildApp, buildMamaRelayApp } from '#main/server'
import { pushCredentialsToRuntime, refreshPlanUsage } from '#domain/auth'
import { closeDb, listProjectRows, MigrationRefusal, openDb, pingDb } from '#db'
import { startGitSshAgent, stopGitSshAgent } from '#domain/git'
import { EventHub } from '#api/events'
import { registerWebSocketRoutes } from '#api/ws-routes'
import { attachConvergence, releaseConvergence, stopConvergence } from '#main/convergence'
import { coalesceCalls, onWorkspaceListChanged } from '#lib/notify'
import { refreshClaudeBundledSkills } from '#domain/skills'
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
import { setWorkspaceDriver, workspaceDriver, workspacesSandboxed } from '#drivers/driver'
import { pushProjectSecrets } from '#domain/projects'
import { createK8sDriver } from '#drivers/k8s'
import { createContainerlessDriver } from '#drivers/containerless'
import { assertHostServerAllowed, resolveDriverKind } from '#main/driver-choice'
import { AccessModeRefusal, settleAccessMode } from '#main/access-mode'
import { errorText, serverLog } from '#lib/log'
import { env } from '@yaac/shared/env'
import type { AccessMode } from '@yaac/shared/types'
import { preflightHostTor, torCoverageWarning } from '@yaac/shared/host-tor'

export interface ServerRunOptions {
  port?: number
}

// `FetchCallback` is not exported from the package entry, so derive it.
type ServeFetch = Parameters<typeof serve>[0]['fetch']

/**
 * No cap on how long a request may take: a push to a hosted remote
 * (docs/hosted-projects.md) can upload for longer than Node's five-minute
 * default. `headersTimeout` still bounds a request that never finishes its
 * headers.
 */
const LONG_UPLOADS = { requestTimeout: 0 }

/**
 * Bind the HTTP server on `env.bindAddr` (loopback by default), starting
 * at `startPort` and moving up past ports in use. The bound port is
 * returned and recorded in the lock file. `startPort` 0 asks the OS for an
 * ephemeral port.
 *
 * Each attempt gets its own WebSocketServer, because node-server closes it
 * along with the HTTP server it was given to.
 *
 * WebSockets are compressed: terminal repaints and snapshot/ACP JSON
 * deflate well, which matters over a slow tailnet link. Frames under 512
 * bytes (keystrokes, echoes, control) are not worth compressing; this only
 * affects our side, as browsers still deflate their own tiny frames.
 * Context takeover stays on (ws's default): about 300KB of zlib state per
 * socket, but successive repaints share history and compress far better.
 * To cap memory, set `zlibDeflateOptions: { memLevel, windowBits }` or
 * `serverNoContextTakeover: true`.
 */
function bindServer(
  fetch: ServeFetch,
  startPort: number,
): Promise<{ server: ServerType; port: number }> {
  const hostname = env.bindAddr
  return bindWithAutoIncrement(startPort, (port) =>
    new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
      const wss = new WebSocketServer({
        noServer: true,
        perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 6 } },
      })
      const s = serve({ fetch, port, hostname, websocket: { server: wss }, serverOptions: LONG_UPLOADS }, (info) => {
        resolve({ server: s, port: info.port })
      })
      s.once('error', reject)
    }),
  )
}

/**
 * Refuse a bind the identity model cannot protect (docs/remote-hosting.md),
 * before anything is bound.
 *
 * A loopback request that did not come through `tailscale serve` is
 * treated as the machine's owner. A non-loopback bind would let anyone who
 * reaches it send `Host: 127.0.0.1`, so it is refused, except in the pod,
 * whose ingress policy admits only the node and the fronting.
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

  // Exit early if a live server holds the lock, before anything below starts
  // timers that would keep this process alive. acquireLock below is the
  // race-safe check.
  const preExisting = await readLock()
  if (preExisting && await isLockLive(preExisting)) {
    serverLog(`[server] already running pid=${preExisting.pid} port=${preExisting.port}`)
    return
  }

  const hub = new EventHub()
  // Set once DB init finishes; `/health` reports it as `ready` so
  // `yaac server start` waits for real readiness.
  let ready = false
  // The settled access mode, or why this start was refused.
  let access: AccessMode | { refused: string } | undefined
  // Rebuild, diff and push the snapshot on every store notification
  // (see #lib/notify). Bursts coalesce into one trailing rebuild.
  onWorkspaceListChanged(coalesceCalls(() => { void hub.publishSnapshot() }, 150))
  // Plan usage has no push source upstream, so poll it, but only while a
  // client is connected. A landed result notifies on its own.
  const planUsageTimer = setInterval(() => {
    if (hub.size === 0) return
    void refreshPlanUsage().catch(
      (err: unknown) => serverLog(`[server] plan-usage refresh failed: ${errorText(err)}`),
    )
  }, 5 * 60_000)
  const app = buildApp({ buildId, isReady: () => ready, access: () => access })

  registerWebSocketRoutes(app, hub)

  const startPort = resolveServerPort(opts.port)
  const { server, port } = await bindServer(app.fetch, startPort)
  if (startPort !== 0 && port !== startPort) {
    serverLog(`[server] preferred port ${startPort} in use; bound ${port} instead`)
  }

  // Race-safe acquire (O_EXCL). A loser closes its server and returns,
  // leaving the existing server in charge.
  const lease = newLeaseFields()
  const outcome = await acquireLock({
    pid: process.pid, port, startedAt: Date.now(), buildId, ...lease,
  })
  if (!outcome.acquired) {
    serverLog(`[server] already running pid=${outcome.existing.pid} port=${outcome.existing.port}`)
    clearInterval(planUsageTimer)
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
      serverLog(`[server] lease renewal failed: ${errorText(err)}`)
    })
  }, LEASE_HEARTBEAT_MS)
  leaseTimer.unref?.()
  // A refused start stays up answering `/health` with the reason, which
  // `yaac server start` and `yaac cluster install` print, and serves
  // nothing else.
  const refuse = (reason: string): void => {
    access = { refused: reason }
    serverLog(`[server] start refused: ${reason}`)
    const quit = (): void => { void removeLock(lease.instance).finally(() => process.exit(1)) }
    process.once('SIGTERM', quit)
    process.once('SIGINT', quit)
  }
  // Open the DB only under the lock (PGlite's single-writer guard). A
  // database recording a migration this build lacks is refused; any other
  // open failure fails the start.
  try {
    await openDb()
  } catch (err) {
    if (err instanceof MigrationRefusal) {
      refuse(err.message)
      return
    }
    serverLog(`[server] db init failed: ${errorText(err)}`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await removeLock(lease.instance)
    process.exit(1)
  }
  try {
    access = await settleAccessMode()
  } catch (err) {
    if (!(err instanceof AccessModeRefusal)) throw err
    refuse(err.message)
    return
  }
  serverLog(`[server] access mode: ${access}`)
  // The ssh agent the server's git signs with (docs/git-credentials.md);
  // needs the DB.
  await startGitSshAgent()

  // Set synchronously so it is true before any queued request runs.
  ready = true

  // Sandboxed workspaces' yaac-mama calls, relayed by the egress proxy to a
  // listener that serves nothing else (`WorkspaceDriver.mamaRelay`).
  const relay = workspaceDriver().mamaRelay
  const relayServer = relay && serve({
    fetch: buildMamaRelayApp(relay.authenticate).fetch,
    port: relay.port,
    hostname: env.bindAddr,
    serverOptions: LONG_UPLOADS,
  })
  relayServer?.on('error', (err: Error) => serverLog(`[server] yaac-mama relay listener failed: ${errorText(err)}`))

  const torPrefix = env.useTor ? '(using tor) ' : ''
  serverLog(`[server] ${torPrefix}listening on ${env.bindAddr}:${port} lock=${serverLockPath()}`)
  serverLog(`[server] open http://127.0.0.1:${port}/`)

  // Register signal handlers before the async startup below; Node's
  // default action would exit without removing the lock.
  const abortCtrl = new AbortController()
  let loopDone: Promise<void> | null = null
  let shuttingDown = false
  // A database that fails `SELECT 1`, or leaves it unanswered for a minute,
  // will not answer again, and the server would fail every request until
  // restarted. Exit instead: under k8s the Deployment restarts the pod; a
  // host server stays down until `yaac server start`.
  const exitOnDeadDb = async (err: unknown): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    serverLog(`[server] the database stopped answering — exiting: ${errorText(err)}`)
    await removeLock(lease.instance)
    process.exit(1)
  }
  let pinging = false
  const dbWatch = setInterval(() => {
    if (pinging) {
      void exitOnDeadDb(new Error('SELECT 1 got no answer within a minute'))
      return
    }
    pinging = true
    pingDb().then(() => { pinging = false }, exitOnDeadDb)
  }, 60_000)
  dbWatch.unref()
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    serverLog(`[server] ${signal} — shutting down`)
    abortCtrl.abort()
    clearInterval(dbWatch)
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
      serverLog(`[server] stop convergence failed: ${errorText(err)}`)
    }
    if (loopDone) {
      // Bounded like server.close(): a reap tick retrying under load could
      // otherwise outlast `yaac server stop`'s wait.
      await Promise.race([
        loopDone.catch((err) => serverLog(`[server] loop exit error: ${errorText(err)}`)),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
    }
    // Release port forwarders and the proxy control tunnel, after the drain
    // since a reap still tears its workspace's forwards down.
    try {
      releaseConvergence()
    } catch (err) {
      serverLog(`[server] release convergence failed: ${errorText(err)}`)
    }

    // close() drains in-flight requests. Bounded to 3s so a wedged request
    // cannot delay lock removal, which the CLI waits on.
    await Promise.race([
      Promise.all([server, relayServer].map((s) => new Promise<void>((resolve) => {
        if (s) s.close(() => resolve())
        else resolve()
      }))),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
    await stopGitSshAgent().catch((err: unknown) => serverLog(`[server] ssh-agent stop failed: ${errorText(err)}`))
    // Checkpoint so PGlite reopens cleanly. Bounded; WAL replay covers a
    // wedged close.
    await Promise.race([
      closeDb().catch((err: unknown) => serverLog(`[server] db close failed: ${errorText(err)}`)),
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
      // Egress-mediating drivers get the full credential set and every
      // project's secrets once per start. Without mediation the reconciler's
      // first pass runs the credential sync.
      if (workspacesSandboxed()) {
        void convergeRuntimeCredentials()
          .catch((err: unknown) => serverLog(`[server] credential push failed: ${errorText(err)}`))
      }
    },
  })
}

/** Push the credential set and each project's secret values to the runtime.
 *  Best-effort per project, so one failure does not block the rest. */
async function convergeRuntimeCredentials(): Promise<void> {
  await pushCredentialsToRuntime()
  for (const { id: projectId } of await listProjectRows()) {
    try {
      await pushProjectSecrets(projectId)
    } catch (err) {
      serverLog(`[server] secret push for project "${projectId}" failed: ${errorText(err)}`)
    }
  }
}

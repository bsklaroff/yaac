import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

/**
 * A `kubectl port-forward` the TEST HARNESS holds, on a local port it picks
 * itself.
 *
 * The suites drive cluster-side things from the host: a server that is a
 * Deployment, a proxy whose control API answers only on a ClusterIP.
 * Production has neither problem — the server IS in the cluster, and reaches
 * both by Service DNS — so this reachability belongs to the harness and
 * nowhere in `src/`. That is the whole reason it exists here.
 *
 * Two properties the callers depend on:
 *
 *  - **The port outlives the child.** A rollout, a scale to zero, a
 *    `ProxyClient.stop()` — each kills the forward attached to the pod that
 *    went away, while the origin the tests (and `server.json`) hold is
 *    already written. So the port is chosen once and the child is respawned
 *    onto it until the caller stops it.
 *  - **It survives a target that does not exist yet.** A forward can be
 *    started before its Deployment is applied; the retries land it once
 *    something is there to attach to.
 */
export interface KubectlForward {
  /** Local port, fixed for the life of this forward. */
  port: number
  /** `http://127.0.0.1:<port>`. */
  origin: string
  stop: () => Promise<void>
}

/** Local port range the harness draws forwards from — clear of the real
 *  server's default and of the suite's own `YAAC_SERVER_PORT` block. */
const FORWARD_PORT_MIN = 21000
const FORWARD_PORT_MAX = 21999

/** How long a caller may wait for a specific port to come free. */
const PORT_FREE_TIMEOUT_MS = 30_000

const live = new Set<ChildProcess>()
let exitHookInstalled = false

/**
 * Kill every forward this worker holds when it ends. `exit` alone leaks:
 * vitest terminates its fork workers with a signal, and an orphaned
 * `kubectl port-forward` has no timeout — it squats its port until
 * something dials it and the write to its dead stdout finally kills it, so
 * the dial that finds the orphan is also the one that fails.
 */
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const killAll = (): void => { for (const child of live) child.kill('SIGKILL') }
  process.on('exit', killAll)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      killAll()
      if (process.listenerCount(signal) === 1) {
        process.removeAllListeners(signal)
        process.kill(process.pid, signal)
      }
    })
  }
}

export interface KubectlForwardSpec {
  namespace: string
  /** kubectl target, e.g. `deployment/yaac-server`. */
  target: string
  /** Port inside the pod. */
  remotePort: number
  /** Bind this local port rather than an arbitrary free one. */
  localPort?: number
}

/** Start (and keep) a forward. Resolves as soon as the port is claimed —
 *  readiness is the caller's to probe on the thing behind it. */
export async function startKubectlForward(spec: KubectlForwardSpec): Promise<KubectlForward> {
  installExitHook()
  const port = spec.localPort === undefined
    ? await pickLocalPort()
    : await waitForPortFree(spec.localPort)
  let stopped = false
  let child: ChildProcess | null = null

  const spawnOnce = (): void => {
    if (stopped) return
    const c = spawn('kubectl', [
      'port-forward', '-n', spec.namespace, spec.target,
      `${String(port)}:${String(spec.remotePort)}`, '--address', '127.0.0.1',
    ], { stdio: ['ignore', 'ignore', 'ignore'] })
    child = c
    live.add(c)
    c.once('exit', () => {
      live.delete(c)
      if (stopped || child !== c) return
      // The pod went away (a rollout, a scale to zero, a redeploy), or is
      // not there yet. Retry: the same origin has to answer once something
      // is behind it, and nothing outside knows the forward ever broke.
      setTimeout(spawnOnce, 500)
    })
  }
  spawnOnce()

  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    stop: async (): Promise<void> => {
      stopped = true
      const c = child
      child = null
      if (!c || c.exitCode !== null) return
      c.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { c.kill('SIGKILL'); resolve() }, 5_000)
        c.once('exit', () => { clearTimeout(t); resolve() })
      })
    },
  }
}

/**
 * Wait for a named port to be free, and say so plainly when it never is —
 * a leaked forward from an interrupted run is the usual cause, and "the
 * server never answered" is a terrible way to learn that.
 */
async function waitForPortFree(port: number): Promise<number> {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS
  for (;;) {
    if (await portFree(port)) return port
    if (Date.now() > deadline) {
      throw new Error(
        `127.0.0.1:${String(port)} is still held, so this file's forward cannot `
        + 'bind it. Look for a leaked `kubectl port-forward` from an interrupted run.',
      )
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * An arbitrary free loopback port. Bound and released to prove it is free —
 * the race with another process claiming it in between is the one every
 * ephemeral-port helper runs, and losing it surfaces as the forward failing
 * to bind, which the caller's readiness probe reports.
 */
async function pickLocalPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = FORWARD_PORT_MIN
      + Math.floor(Math.random() * (FORWARD_PORT_MAX - FORWARD_PORT_MIN))
    if (await portFree(candidate)) return candidate
  }
  throw new Error('no free local port for a test kubectl forward')
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

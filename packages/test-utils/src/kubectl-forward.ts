import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

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

/** Local port range the harness draws every host port it binds from —
 *  forwards, each test env's `YAAC_SERVER_PORT`, the forward ports a suite
 *  configures. Clear of the real server's default (8787) and below the
 *  kernel's ephemeral range, so an outgoing connection never lands on a
 *  port in the gap between a pick and its bind. */
const FORWARD_PORT_MIN = 21000
const FORWARD_PORT_MAX = 21999

/** Where {@link freeLocalPort} records its picks: one file per port, holding
 *  the drawing process's pid. HOST-wide on purpose — a pick is only proven
 *  free, not held, and it can sit unbound for minutes (a suite's forward
 *  ports wait out a whole worktree create), so every process that draws
 *  from the range, in any worker and any test rig, has to see it. */
const PORT_CLAIM_DIR = path.join(os.tmpdir(), 'yaac-test-ports')

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
    ? await freeLocalPort()
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
        + 'bind it. Either another worker or test rig drew this port, or a '
        + '`kubectl port-forward` leaked from an interrupted run.',
      )
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * An arbitrary free loopback port. Bound and released to prove it is free —
 * the race with another process claiming it in between is the one every
 * ephemeral-port helper runs, and losing it surfaces as the bind failing,
 * which the caller's readiness probe reports.
 *
 * Random rather than a fixed per-worker block because a fixed number is
 * the same number in every test rig on the host: two rigs' runs would
 * bind it at once. Claimed (see {@link claimPort}) so that no other draw,
 * in this process or another, answers it while it waits to be bound.
 */
export async function freeLocalPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = FORWARD_PORT_MIN
      + Math.floor(Math.random() * (FORWARD_PORT_MAX - FORWARD_PORT_MIN))
    if (await portFree(candidate) && await claimPort(candidate)) return candidate
  }
  throw new Error('no free local port for the test harness')
}

/**
 * Claim a port for this process, host-wide, until the process exits. A claim
 * whose process is gone is stale and taken over; this process's own claim
 * counts as taken, so no two draws here share a number either. The same
 * pid-file pattern as the server mutex in cli.ts.
 */
async function claimPort(port: number): Promise<boolean> {
  await fs.mkdir(PORT_CLAIM_DIR, { recursive: true })
  const file = path.join(PORT_CLAIM_DIR, String(port))
  for (;;) {
    try {
      await fs.writeFile(file, String(process.pid), { flag: 'wx' })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const holder = Number.parseInt(await fs.readFile(file, 'utf8').catch(() => ''), 10)
    // No pid yet is a claim still being written: taken.
    if (Number.isNaN(holder) || holder === process.pid || pidAlive(holder)) return false
    await fs.unlink(file).catch(() => { /* another process took it over first */ })
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

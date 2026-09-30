import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * A `kubectl port-forward` held by the test harness, so host-side tests can
 * reach in-cluster things (the server Deployment, the proxy's ClusterIP
 * API). Production code reaches them by Service DNS instead.
 *
 * The local port is chosen once and kubectl is respawned onto it whenever
 * the pod goes away (rollout, scale to zero), so the origin stays valid. It
 * can also be started before its target exists.
 */
export interface KubectlForward {
  /** Local port, fixed for the life of this forward. */
  port: number
  /** `http://127.0.0.1:<port>`. */
  origin: string
  stop: () => Promise<void>
}

/** Range for every host port the harness binds. Clear of the server's
 *  default (8787) and below the kernel's ephemeral range, so an outgoing
 *  connection can't take a picked port before it is bound. */
const FORWARD_PORT_MIN = 21000
const FORWARD_PORT_MAX = 21999

/** Where {@link freeLocalPort} records its picks: one file per port, holding
 *  the pid. Host-wide, because a pick can stay unbound for minutes and every
 *  worker and test rig must see it. */
const PORT_CLAIM_DIR = path.join(os.tmpdir(), 'yaac-test-ports')

/** How long a caller may wait for a specific port to come free. */
const PORT_FREE_TIMEOUT_MS = 30_000

const live = new Set<ChildProcess>()
let exitHookInstalled = false

/**
 * Kill every forward this worker holds when it ends. `exit` alone is not
 * enough: vitest stops workers with a signal, and an orphaned forward holds
 * its port indefinitely.
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

/** Start (and keep) a forward. Resolves once the port is claimed; the
 *  caller probes readiness. */
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
      // The pod went away or isn't there yet; retry on the same port.
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
 * Wait for a named port to be free, failing with a clear message if it
 * never is (usually a leaked forward from an interrupted run).
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
 * A random free loopback port, bound and released to prove it is free, then
 * claimed (see {@link claimPort}) so no other draw returns it. Random rather
 * than a per-worker block, which would collide across test rigs.
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
 * Claim a port host-wide until this process exits. A claim whose process is
 * gone is taken over; this process's own claims count as taken.
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
    // No pid yet: a claim still being written.
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

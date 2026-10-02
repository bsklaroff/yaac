import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Long-lived `kubectl port-forward` children, keyed by purpose: one child
 * per key per process, shared by all callers and respawned after it dies.
 * It reaches an in-cluster port using only apiserver access. The host-side
 * main registry client (container/registry.ts) uses it. The local port is
 * always ephemeral, so installs on one machine never collide.
 */

interface ForwardAddr {
  host: string
  port: number
}

interface PortForwardSpec {
  namespace: string
  /** kubectl port-forward target, e.g. `deploy/yaac-proxy`. */
  target: string
  /** Port inside the pod. */
  remotePort: number
  /** How long to wait for kubectl's "Forwarding from" line. */
  readyTimeoutMs?: number
}

const DEFAULT_READY_TIMEOUT_MS = 15_000

const children = new Map<string, ChildProcess>()
const addrs = new Map<string, ForwardAddr>()
/** In-progress starts, so concurrent callers share one child per key. */
const inflight = new Map<string, Promise<ForwardAddr>>()

let exitHookInstalled = false

/** Catchable signals that terminate a process by default. */
const TERMINATING_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

function killAllForwards(): void {
  for (const child of children.values()) child.kill()
}

/**
 * Kill every forward when this process ends, on `exit` and on terminating
 * signals (`exit` does not fire when a signal kills the process, e.g. a
 * vitest worker). Children are unref'd so short-lived processes such as
 * the CLI can exit; without this hook they would leave orphaned kubectl
 * processes that hold their port until dialed.
 *
 * Adding a signal listener disables Node's default termination, so the
 * signal is re-raised when this is the only handler. When the app has its
 * own handler (the server's graceful shutdown), that handler decides when
 * to exit.
 */
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', killAllForwards)
  for (const signal of TERMINATING_SIGNALS) {
    process.on(signal, () => {
      killAllForwards()
      if (process.listenerCount(signal) === 1) {
        process.removeAllListeners(signal)
        process.kill(process.pid, signal)
      }
    })
  }
}

/**
 * Drop a key's forward: kill the child (if any) and forget its address, so
 * the next resolve spawns a fresh one. Called when the transport looks dead
 * or when the target pod has been replaced under it.
 */
export function invalidatePortForward(key: string): void {
  children.get(key)?.kill()
  children.delete(key)
  addrs.delete(key)
}

/** Test-only: tear down every forward this process holds. */
export function _resetPortForwardsForTests(): void {
  for (const key of [...children.keys(), ...addrs.keys()]) invalidatePortForward(key)
  inflight.clear()
}

/**
 * The local address of `key`'s forward, spawning it on first use. Resolves
 * once kubectl reports its listener; rejects (leaving nothing cached) when
 * the child dies during startup or never becomes ready.
 */
export async function resolvePortForward(
  key: string,
  spec: PortForwardSpec,
): Promise<ForwardAddr> {
  const cached = addrs.get(key)
  if (cached) return cached
  const pending = inflight.get(key)
  if (pending) return pending

  const started = startPortForward(key, spec)
    .then((addr) => {
      addrs.set(key, addr)
      return addr
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, started)
  return started
}

function startPortForward(key: string, spec: PortForwardSpec): Promise<ForwardAddr> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', [
      'port-forward', '-n', spec.namespace, spec.target, `0:${spec.remotePort}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.set(key, child)
    installExitHook()
    // See installExitHook. The pipes are Sockets at runtime, which the
    // `Readable` type does not show.
    child.unref()
    for (const pipe of [child.stdout, child.stderr]) {
      (pipe as unknown as { unref?: () => void } | null)?.unref?.()
    }
    const readyTimeoutMs = spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    let out = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(
        `port-forward ${spec.target} did not become ready within ${readyTimeoutMs}ms`,
      ))
    }, readyTimeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out)
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ host: '127.0.0.1', port: Number(m[1]) })
      }
    })
    child.stderr?.on('data', () => { /* surfaced via exit/timeout */ })
    child.on('exit', () => {
      // Forget the address so the next resolve respawns. Only if this is
      // still the current child: a killed child's `exit` arrives late, and a
      // successor may already be cached under the key.
      if (children.get(key) === child) {
        children.delete(key)
        addrs.delete(key)
      }
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`port-forward ${spec.target} exited during startup`))
      }
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

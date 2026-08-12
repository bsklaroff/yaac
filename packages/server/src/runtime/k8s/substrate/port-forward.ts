import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Long-lived `kubectl port-forward` children, keyed by purpose.
 *
 * This is the server's generic way to reach a TCP port inside the cluster
 * without assuming any host↔cluster network topology: the only thing it
 * needs is the apiserver access every other call already has. Two callers
 * use it — the stream relay (into the proxy's relay listener) and the main
 * image registry (into the registry Deployment) — and both want the same
 * shape: ONE child per purpose per server run, shared by every caller,
 * respawned after it dies.
 *
 * The local port is always ephemeral (`0:<remotePort>`), so nothing here
 * reserves a fixed host port and two yaac installs on one machine never
 * collide.
 */

export interface ForwardAddr {
  host: string
  port: number
}

export interface PortForwardSpec {
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
/** Single-flight per key so concurrent callers never race two children
 *  into existence. */
const inflight = new Map<string, Promise<ForwardAddr>>()

let exitHookInstalled = false

/**
 * Signals that terminate a process by default and can be caught. SIGKILL is
 * absent because it cannot be handled: a `kill -9`'d process still orphans
 * its forwards and nothing in-process can prevent that.
 */
const TERMINATING_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

function killAllForwards(): void {
  for (const child of children.values()) child.kill()
}

/**
 * Kill every forward when this process ends. Paired with the `unref()`
 * below, which is what makes it fire at all: a ref'd child (and its stdio
 * pipes) keeps the event loop alive, so a SHORT-lived process that touched
 * a forward — the CLI, vitest's global setup — would hang instead of
 * exiting. Unref'd, it exits; this hook is then what stops it leaving an
 * orphaned kubectl behind. The server holds its own loop open regardless.
 *
 * `exit` alone leaks, and the gap is the common case rather than an exotic
 * one: it fires on NO signal, so a process terminated by one reparents its
 * kubectl to PID 1. A vitest worker is the worked example — vitest installs
 * a SIGTERM handler in its fork workers only under profiling flags, so a
 * normal run's `child.kill()` kills the worker with no hook run — and one
 * full e2e run left ten such orphans.
 *
 * They do not clean themselves up. An orphaned `kubectl port-forward` has
 * no timeout: it squats its ephemeral port until something dials it, at
 * which point the write to its dead stdout pipe finally kills it — so the
 * dial that discovers the orphan is also the one that fails.
 *
 * Re-raising is conditional on ours being the ONLY handler, and both halves
 * matter. Registering any listener suppresses Node's default termination,
 * so a process whose sole handler is this one would otherwise ignore
 * SIGTERM outright. But when the app has its own handler — the server's
 * graceful shutdown — that handler owns when the process ends, and
 * re-raising here would cut it short. The count is read when the signal
 * lands, not at install time, so registration order does not matter.
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
    // See installExitHook: the child and its pipes must not be what keeps a
    // short-lived process alive. The pipes are Sockets at runtime, which the
    // `Readable` type on ChildProcess does not admit.
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
      // Forget the address so the next resolve respawns; a caller mid-dial
      // sees the connection fail and re-resolves.
      //
      // BOTH deletes are identity-guarded, because a killed child's `exit`
      // lands asynchronously: invalidate → re-resolve can have a live
      // successor cached by the time the dead one's event fires. Wiping the
      // successor's address there would strand it — the next resolve
      // overwrites the map's only reference to it, leaving an unref'd
      // kubectl that neither `invalidatePortForward` nor the exit hook can
      // reach.
      // The reject below is NOT guarded — it settles this child's own
      // startup promise, which no successor can do for it.
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

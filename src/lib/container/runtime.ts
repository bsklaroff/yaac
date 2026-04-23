import Docker from 'dockerode'
import { exec, execFile, spawn } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'

export const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

/**
 * Stderr patterns that indicate a transient podman failure worth retrying.
 * These are NOT "the container is actually gone" — they're podman/OCI runtime
 * state races that usually resolve on their own (e.g. container transitioning,
 * conmon still wiring up, OCI exit file not yet written).
 */
const TRANSIENT_EXEC_PATTERNS = [
  'container state improper',
  'no such container', // appears briefly during container state transitions
  'timed out waiting for file', // OCI runtime exit file race
  'conmon exited prematurely', // conmon lost, retry may pick up a fresh one
  'OCI runtime error',
  'error getting exit code',
  'connection refused', // podman socket briefly unavailable during renumber etc.
  'econnrefused', // dockerode / node net surfaces refusal as ECONNREFUSED
  'econnreset', // podman service reset a live connection (load / busy)
  'socket hang up', // podman service closed the connection before responding
  'resource temporarily unavailable', // EAGAIN under PID/resource pressure
  'exec died event', // "exec died event for session ... not found" — conmon/event log race
  'unable to find event', // sibling of "exec died event" — podman event retrieval race
]

export function isTransientPodmanError(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return TRANSIENT_EXEC_PATTERNS.some((p) => lower.includes(p.toLowerCase()))
}

function isConnectionRefused(msg: string): boolean {
  const lower = msg.toLowerCase()
  return lower.includes('connection refused') || lower.includes('econnrefused')
}

/**
 * If the retry-worthy error is "podman socket is refusing connections," the
 * service is dead and plain exponential backoff won't help — nothing
 * supervises `podman system service` in rootless container envs. Try to
 * revive it in-band so the next attempt lands on a live service. Swallows
 * revive errors; the outer retry loop still decides whether to keep going.
 */
async function reviveSocketIfRefused(stderr: string): Promise<void> {
  if (!isConnectionRefused(stderr)) return
  const socketPath = getSocketPath()
  if (!socketPath) return
  try {
    await ensurePodmanSocket(socketPath, { timeoutMs: 3_000 })
  } catch { /* next attempt will surface the failure */ }
}

export interface PodmanExecOptions {
  timeout?: number
  maxAttempts?: number
  /** Base delay in ms; each attempt doubles up to 3200ms. */
  baseDelay?: number
}

/**
 * Run `podman` with retries on transient errors (container state improper,
 * OCI runtime races, conmon death, etc.).  Non-transient failures throw
 * immediately, preserving the original error.
 */
export async function podmanExecWithRetry(
  args: string[],
  opts: PodmanExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const maxAttempts = opts.maxAttempts ?? 8
  const baseDelay = opts.baseDelay ?? 200
  const execOpts: { timeout?: number } = opts.timeout ? { timeout: opts.timeout } : {}

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await execFileAsync('podman', args, execOpts)
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string })?.stderr ?? ''
      if (attempt < maxAttempts && isTransientPodmanError(stderr)) {
        await reviveSocketIfRefused(stderr)
        const delay = Math.min(baseDelay * 2 ** (attempt - 1), 3200)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw new Error('podmanExecWithRetry: unexpected fall-through')
}

/**
 * Async podman exec with retries, matching `podmanExecWithRetry`'s retry
 * behavior but accepting a full shell command string so callers that rely
 * on shell features (sh -c "...", single-quoted args, redirection) don't
 * have to split args manually. Runs in the Node event loop — does not
 * block, so it's safe to call from the daemon process while its HTTP
 * server is serving /health.
 */
export async function shellPodmanWithRetry(
  command: string,
  opts: PodmanExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const maxAttempts = opts.maxAttempts ?? 8
  const baseDelay = opts.baseDelay ?? 200
  const execOpts: { timeout?: number } = opts.timeout ? { timeout: opts.timeout } : {}

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await execAsync(command, execOpts)
      return { stdout: res.stdout.toString(), stderr: res.stderr.toString() }
    } catch (err: unknown) {
      const stderr = ((err as { stderr?: Buffer | string })?.stderr ?? '').toString()
        + ((err as Error)?.message ?? '')
      if (attempt < maxAttempts && isTransientPodmanError(stderr)) {
        await reviveSocketIfRefused(stderr)
        const delay = Math.min(baseDelay * 2 ** (attempt - 1), 3200)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw new Error('shellPodmanWithRetry: unexpected fall-through')
}

export function getSocketPath(): string | undefined {
  if (process.platform === 'darwin') return undefined // podman-mac-helper symlinks to /var/run/docker.sock
  const uid = process.getuid?.()
  return `/run/user/${uid}/podman/podman.sock`
}

const socketPath = getSocketPath()
export const podman = socketPath ? new Docker({ socketPath }) : new Docker()

/**
 * Wrap `podman.modem.dial` so every dockerode HTTP call auto-retries on
 * transient podman socket errors. Dockerode routes listContainers /
 * getContainer / inspect / remove etc. through `modem.dial`, so hooking
 * this one function covers the whole surface without touching 40+ call
 * sites.
 *
 * Two distinct failure shapes are folded in here:
 *   - ECONNREFUSED: podman service is dead. Try to revive the socket
 *     before the next attempt.
 *   - ECONNRESET / "socket hang up": service is alive but busy/overloaded
 *     (common under heavy parallel test load). Just retry — reviving
 *     would spawn a second `podman system service` racing the live one.
 *
 * Up to 3 attempts with no backoff; the cheapest retry is one that lands
 * on a service that's already recovered.
 */
type DialCallback = (err: Error | null, data: unknown) => void
type DialFn = (options: unknown, callback: DialCallback) => void
{
  const modem = (podman as unknown as { modem?: { dial?: DialFn } }).modem
  if (modem && typeof modem.dial === 'function') {
    const originalDial: DialFn = modem.dial.bind(modem)
    const maxAttempts = 3
    modem.dial = function dialWithRetry(options, callback): void {
      let attempt = 0
      const tryOnce = (): void => {
        attempt += 1
        originalDial(options, (err, data) => {
          if (!err || attempt >= maxAttempts) { callback(err, data); return }
          const msg = err.message ?? String(err)
          if (!isTransientPodmanError(msg)) { callback(err, data); return }
          const prelude = isConnectionRefused(msg)
            ? reviveSocketIfRefused(msg)
            : Promise.resolve()
          void prelude.finally(tryOnce)
        })
      }
      tryOnce()
    }
  }
}

/**
 * Create and start a container with retries on transient OCI/podman errors
 * (e.g. `crun: mount devpts: Invalid argument`).  The dockerode path sidesteps
 * `podmanExecWithRetry`, so callers that go through the API get no retries by
 * default.  Any partially-created container is removed before each retry so
 * name conflicts don't mask the real failure.
 */
export async function createAndStartContainerWithRetry(
  opts: Docker.ContainerCreateOptions,
  retryOpts: { maxAttempts?: number; baseDelay?: number } = {},
): Promise<Docker.Container> {
  const maxAttempts = retryOpts.maxAttempts ?? 5
  const baseDelay = retryOpts.baseDelay ?? 300

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let container: Docker.Container | undefined
    try {
      container = await podman.createContainer(opts)
      await container.start()
      return container
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (container) {
        try { await container.remove({ force: true }) } catch { /* ok */ }
      } else if (opts.name) {
        try { await podman.getContainer(opts.name).remove({ force: true }) } catch { /* ok */ }
      }
      if (attempt >= maxAttempts || !isTransientPodmanError(msg)) throw err
      await reviveSocketIfRefused(msg)
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), 3200)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error('createAndStartContainerWithRetry: unexpected fall-through')
}

export async function ensureContainerRuntime(): Promise<void> {
  if (process.platform === 'darwin') {
    await ensurePodmanMachine()
  } else {
    await ensurePodmanLinux()
  }
}

async function ensurePodmanMachine(): Promise<void> {
  let stdout: string
  try {
    const result = await execFileAsync('podman', ['machine', 'list', '--format', 'json'])
    stdout = result.stdout
  } catch {
    console.error(
      '\nPodman is not installed. Install it with:\n\n'
      + '  brew install podman\n'
      + '  sudo /opt/homebrew/Cellar/podman/$(podman --version | cut -d" " -f3)/bin/podman-mac-helper install\n'
      + '  podman machine init\n'
      + '  podman machine start\n',
    )
    process.exit(1)
  }

  const machines = JSON.parse(stdout) as Array<{ Running: boolean }>
  const running = machines.some((m) => m.Running)
  if (!running) {
    console.error(
      '\nPodman machine is not running. Start it with:\n\n'
      + '  podman machine start\n'
      + '\nIf you haven\'t initialized a machine yet:\n\n'
      + '  sudo /opt/homebrew/Cellar/podman/$(podman --version | cut -d" " -f3)/bin/podman-mac-helper install\n'
      + '  podman machine init\n'
      + '  podman machine start\n',
    )
    process.exit(1)
  }
}

async function ensurePodmanLinux(): Promise<void> {
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
    return
  } catch { /* fall through — maybe the socket died and we can revive it */ }

  const socketPath = getSocketPath()
  if (socketPath) {
    try {
      await ensurePodmanSocket(socketPath)
      await execFileAsync('podman', ['info', '--format', 'json'])
      return
    } catch { /* revive failed — fall through to install-instructions error */ }
  }

  console.error(
    '\nPodman is not installed or not running. Install it with your package manager:\n\n'
    + '  sudo apt install podman    # Debian/Ubuntu\n'
    + '  sudo dnf install podman    # Fedora/RHEL\n',
  )
  process.exit(1)
}

async function socketAccepts(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath)
    sock.once('connect', () => { sock.end(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

/**
 * Ensure the podman socket at `socketPath` is accepting connections.
 * If it isn't, spawn a detached `podman system service` and poll until
 * the socket comes up, or throw on timeout.
 *
 * In rootless container environments with no systemd socket activation
 * and no supervisor, nothing restarts `podman system service` if it
 * crashes — so one flaky run leaves every subsequent run hitting
 * ECONNREFUSED. This helper is the supervisor of last resort.
 */
export async function ensurePodmanSocket(
  socketPath: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  if (await socketAccepts(socketPath)) return

  const child = spawn(
    'podman',
    ['system', 'service', '--time=0', `unix://${socketPath}`],
    { detached: true, stdio: 'ignore' },
  )
  // Swallow spawn errors (e.g. ENOENT if podman isn't installed); the poll
  // below will fail with a clearer timeout message than an uncaught 'error'.
  child.on('error', () => { /* ok */ })
  child.unref()

  const timeoutMs = opts.timeoutMs ?? 10_000
  const pollMs = opts.pollMs ?? 100
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await socketAccepts(socketPath)) return
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(
    `Podman socket ${socketPath} did not become ready within ${timeoutMs}ms`,
  )
}

/**
 * Create a podman network if it doesn't already exist.
 */
export async function ensureNetwork(name: string): Promise<void> {
  try {
    await execFileAsync('podman', ['network', 'create', '--internal', '--disable-dns', name])
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) { /* ok */ }
    else throw err
  }
}

/**
 * Check whether a container image exists locally.
 */
export async function imageExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('podman', ['image', 'inspect', name])
    return true
  } catch {
    return false
  }
}

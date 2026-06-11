import { execFile, spawn } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { ensureKubernetes } from '@/lib/k8s/kubectl'

export const execFileAsync = promisify(execFile)

/**
 * Verify both halves of the split runtime:
 *   - podman — the image build engine (`podman build` / `podman push`).
 *     Sessions never run on it; it only produces images for the registry.
 *   - kubernetes — the session runtime (one Job per session).
 */
export async function ensureContainerRuntime(): Promise<void> {
  if (process.platform === 'darwin') {
    await ensurePodmanMachine()
  } else {
    await ensurePodmanLinux()
  }
  await ensureKubernetes()
}

async function ensurePodmanMachine(): Promise<void> {
  let stdout: string
  try {
    const result = await execFileAsync('podman', ['machine', 'list', '--format', 'json'])
    stdout = result.stdout
  } catch {
    console.error(
      '\nPodman is not installed (yaac uses it to build session images). Install it with:\n\n'
      + '  brew install podman\n'
      + '  podman machine init --rootful\n'
      + '  podman machine start\n\n'
      + 'See "Install" in the yaac README — macOS needs the libkrun machine\n'
      + 'provider so session pods can run in user namespaces.\n',
    )
    process.exit(1)
  }

  const machines = JSON.parse(stdout) as Array<{ Running: boolean }>
  const running = machines.some((m) => m.Running)
  if (!running) {
    console.error(
      '\nPodman machine is not running. Start it with:\n\n'
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
    '\nPodman is not installed or not running (yaac uses it to build session '
    + 'images). Install it with your package manager:\n\n'
    + '  sudo apt install podman    # Debian/Ubuntu\n'
    + '  sudo dnf install podman    # Fedora/RHEL\n',
  )
  process.exit(1)
}

export function getSocketPath(): string | undefined {
  if (process.platform === 'darwin') return undefined // podman-mac-helper symlinks to /var/run/docker.sock
  const uid = process.getuid?.()
  return `/run/user/${uid}/podman/podman.sock`
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
 * crashes — this helper is the supervisor of last resort for the build
 * engine.
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
 * Check whether a container image exists in the local podman store.
 */
export async function imageExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('podman', ['image', 'inspect', name])
    return true
  } catch {
    return false
  }
}

/**
 * Remove a container image by tag. No-ops when the image is absent or in
 * use — used by `yaac project rebuild` to clear stale downstream layers
 * before re-running their builds.
 */
export async function removeImage(name: string): Promise<void> {
  try {
    await execFileAsync('podman', ['rmi', '-f', name])
  } catch {
    // not present / in use — best-effort cleanup
  }
}

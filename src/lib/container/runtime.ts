import { execFile, spawn } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { ensureKubernetes } from '@/lib/k8s/kubectl'
import { env } from '@/shared/env'

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
  ensureRootfulPodmanHost()
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
    return
  } catch { /* fall through — maybe the socket died and we can revive it */ }

  const socketPath = getSocketPath()
  // Only the rootless per-uid socket is self-supervised: nothing else restarts
  // `podman system service`, so revive it. The rootful system socket is
  // root-owned and socket-activated by systemd — yaac runs unprivileged and
  // can't start it, so fall straight through to the enable/access instructions.
  if (socketPath && !usesRootfulPodman()) {
    try {
      await ensurePodmanSocket(socketPath)
      await execFileAsync('podman', ['info', '--format', 'json'])
      return
    } catch { /* revive failed — fall through to install-instructions error */ }
  }

  if (usesRootfulPodman()) {
    console.error(
      '\nRootful podman is not reachable (yaac builds session images on the '
      + 'rootful podman engine on Linux — the kind node needs the cgroup2 root '
      + 'and BPF filesystem that rootless podman does not delegate, so the '
      + 'cilium agent DaemonSet hangs under rootless). Install podman if needed, '
      + 'then enable the socket and grant your user access:\n\n'
      + '  sudo apt install podman            # Debian/Ubuntu (or dnf on Fedora)\n'
      + '  sudo systemctl enable --now podman.socket\n'
      + '  sudo setfacl -m u:$USER:x /run/podman\n'
      + `  sudo setfacl -m u:$USER:rw ${ROOTFUL_PODMAN_SOCKET}\n`,
    )
    process.exit(1)
  }

  console.error(
    '\nPodman is not installed or not running (yaac uses it to build session '
    + 'images). Install it with your package manager:\n\n'
    + '  sudo apt install podman    # Debian/Ubuntu\n'
    + '  sudo dnf install podman    # Fedora/RHEL\n',
  )
  process.exit(1)
}

/** The rootful podman system socket, managed by systemd's `podman.socket`. */
export const ROOTFUL_PODMAN_SOCKET = '/run/podman/podman.sock'

/**
 * Whether yaac drives the *rootful* podman engine. True on Linux hosts,
 * mirroring the rootful podman machine we require on macOS: kind's node runs as
 * a container on this engine, and only a rootful engine delegates the full
 * cgroup2 root + BPF filesystem the cilium agent DaemonSet needs to attach its
 * programs — under rootless podman that DaemonSet never goes Ready and
 * `yaac cluster setup` hangs. Nested (in-pod) sessions keep their own rootless
 * podman (`YAAC_NESTED`), reached over the per-uid socket below.
 */
export function usesRootfulPodman(): boolean {
  return process.platform !== 'darwin' && !env.nested
}

export function getSocketPath(): string | undefined {
  if (process.platform === 'darwin') return undefined // podman-mac-helper symlinks to /var/run/docker.sock
  if (usesRootfulPodman()) return ROOTFUL_PODMAN_SOCKET
  const uid = process.getuid?.()
  return `/run/user/${uid}/podman/podman.sock`
}

/**
 * Point the podman CLI — and kind's podman provider, which inherits our env —
 * at the rootful system socket via `CONTAINER_HOST`, so both the image build
 * engine and the kind node land on the same rootful podman. Idempotent and
 * safe to call from every entrypoint; honours a `CONTAINER_HOST` the user set
 * themselves. No-op on macOS (podman machine) and in nested sessions (the
 * in-pod podman is rootless).
 */
export function ensureRootfulPodmanHost(): void {
  if (!usesRootfulPodman()) return
  // eslint-disable-next-line no-process-env -- one global lever so kind + every podman call target the rootful engine
  if (!process.env.CONTAINER_HOST) process.env.CONTAINER_HOST = `unix://${ROOTFUL_PODMAN_SOCKET}`
}

/** process.env without the remote-mode vars, so a spawned podman runs locally. */
function localPodmanEnv(): NodeJS.ProcessEnv {
  // eslint-disable-next-line no-process-env -- strip remote-mode vars for a local `podman system service`
  const clone = { ...process.env }
  delete clone.CONTAINER_HOST
  delete clone.CONTAINER_CONNECTION
  return clone
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

  if (socketPath === ROOTFUL_PODMAN_SOCKET) {
    // Root-owned and socket-activated by systemd; an unprivileged
    // `podman system service` can't bind it. Point the operator at the fix
    // instead of spawning a service that will only fail with permission denied.
    throw new Error(
      `Rootful podman socket ${socketPath} is not reachable. Enable it and `
      + 'grant your user access:\n'
      + '  sudo systemctl enable --now podman.socket\n'
      + `  sudo setfacl -m u:$USER:x /run/podman && sudo setfacl -m u:$USER:rw ${socketPath}`,
    )
  }

  const child = spawn(
    'podman',
    ['system', 'service', '--time=0', `unix://${socketPath}`],
    // A service binds locally — strip CONTAINER_HOST/CONTAINER_CONNECTION so an
    // ambient rootful-remote setting doesn't push the CLI into remote mode,
    // which rejects `system service`.
    { detached: true, stdio: 'ignore', env: localPodmanEnv() },
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

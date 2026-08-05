import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const execFileAsync = promisify(execFile)

let runtimeVerified = false

/**
 * Verify both halves of the split runtime:
 *   - podman — the image build engine (`podman build` / `podman push`).
 *     Sessions never run on it; it only produces images for the registry.
 *   - kubernetes — the session runtime (one Job per session).
 *
 * Verified once per process: both halves are ~hundreds of ms of child
 * processes on every session create, and a runtime that disappears mid-run
 * surfaces immediately in whichever podman/kubectl call needs it — this
 * check only exists to print install instructions on first contact.
 */
export async function ensureContainerRuntime(): Promise<void> {
  if (runtimeVerified) return
  if (process.platform === 'darwin') {
    await ensurePodmanMachine()
  } else {
    await ensurePodmanLinux()
  }
  // Imported here, not at module scope: `@kubernetes/client-node` is 967 ESM
  // files behind a single barrel, ~2.2s to load, and this module's other
  // exports are what the CLI reaches for on every invocation — including
  // `ensureRootfulPodmanHost`, two lines that set an env var. Only the
  // runtime check needs a cluster, and it is already async.
  // eslint-disable-next-line no-restricted-syntax -- deferring this import is the point; see above
  const { ensureKubernetes } = await import('#platform/k8s')
  await ensureKubernetes()
  runtimeVerified = true
}

/** Test-only: forget the process-wide runtime verification. */
export function _resetContainerRuntimeForTests(): void {
  runtimeVerified = false
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
      + 'provider (its virtiofs reports real file ownership, which gVisor\n'
      + 'session pods need to write hostPath mounts).\n',
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
  } catch { /* fall through to the instructions */ }

  // No self-revive anywhere: the host rootful socket is root-owned and
  // socket-activated by systemd (yaac runs unprivileged), and a nested
  // session's in-pod engine is started once by session-create — if it
  // died, the session is degraded and the operator restarts it.
  console.error(
    '\nRootful podman is not reachable (yaac builds session images on the '
    + 'rootful podman engine on Linux — the kind node needs the cgroup2 root '
    + 'and BPF filesystem that rootless podman does not delegate, so the '
    + 'calico-node DaemonSet hangs under rootless). Install podman if needed, '
    + 'then enable the socket and grant your user access:\n\n'
    + '  sudo apt install podman            # Debian/Ubuntu (or dnf on Fedora)\n'
    + '  sudo systemctl enable --now podman.socket\n'
    + '  sudo setfacl -m u:$USER:x /run/podman\n'
    + `  sudo setfacl -m u:$USER:rw ${ROOTFUL_PODMAN_SOCKET}\n`,
  )
  process.exit(1)
}

/**
 * The rootful podman system socket. On a Linux host it is managed by
 * systemd's `podman.socket`; inside a nested session pod the SAME path is
 * served by the sudo-started in-pod engine (`podman system service` —
 * podman's rootful default), opened to the yaac user at session setup.
 */
export const ROOTFUL_PODMAN_SOCKET = '/run/podman/podman.sock'

/**
 * Whether yaac drives the *rootful* podman engine. True everywhere but
 * macOS (where the rootful podman machine fills the role): on a Linux
 * host, kind's node runs as a container on this engine, and only a
 * rootful engine delegates the full cgroup2 root + BPF filesystem the
 * calico-node DaemonSet needs to program the node's netfilter — under rootless
 * podman that DaemonSet never goes Ready and `yaac cluster setup` hangs.
 * A nested (in-pod, `YAAC_NESTED`) yaac drives the session's rootful
 * in-sandbox engine remotely — the image's CONTAINER_HOST points every
 * podman call at ROOTFUL_PODMAN_SOCKET.
 */
export function usesRootfulPodman(): boolean {
  return process.platform !== 'darwin'
}

/**
 * Point the podman CLI — and kind's podman provider, which inherits our env —
 * at the rootful system socket via `CONTAINER_HOST`, so both the image build
 * engine and the kind node land on the same rootful podman. Idempotent and
 * safe to call from every entrypoint; honours a `CONTAINER_HOST` the user set
 * themselves — including the session image's baked ENV (same socket path).
 * No-op on macOS (podman machine).
 */
export function ensureRootfulPodmanHost(): void {
  if (!usesRootfulPodman()) return
  // eslint-disable-next-line no-process-env -- one global lever so kind + every podman call target the rootful engine
  if (!process.env.CONTAINER_HOST) process.env.CONTAINER_HOST = `unix://${ROOTFUL_PODMAN_SOCKET}`
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

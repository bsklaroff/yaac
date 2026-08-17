import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * The host container engine, which on this side of the seam is the image
 * BUILD engine only: `yaac cluster install` runs `podman build`/`podman
 * push` through here, and the server never does — it resolves every image
 * from the in-cluster registry (docs/trust-split-builds.md). Worktrees run
 * as Jobs, so nothing here addresses a workload.
 */
export const execFileAsync = promisify(execFile)

/**
 * The rootful podman system socket. On a Linux host it is managed by
 * systemd's `podman.socket`; inside a nested worktree pod the SAME path is
 * served by the sudo-started in-pod engine (`podman system service` —
 * podman's rootful default), opened to the yaac user at worktree setup.
 */
export const ROOTFUL_PODMAN_SOCKET = '/run/podman/podman.sock'

/**
 * Whether yaac drives the *rootful* podman engine. True everywhere but
 * macOS (where the rootful podman machine fills the role): on a Linux
 * host, kind's node runs as a container on this engine, and only a
 * rootful engine delegates the full cgroup2 root + BPF filesystem the
 * calico-node DaemonSet needs to program the node's netfilter — under rootless
 * podman that DaemonSet never goes Ready and `yaac cluster install` hangs.
 */
export function usesRootfulPodman(): boolean {
  return process.platform !== 'darwin'
}

/**
 * Point the podman CLI — and kind's podman provider, which inherits our env —
 * at the rootful system socket via `CONTAINER_HOST`, so both the image build
 * engine and the kind node land on the same rootful podman. Idempotent and
 * safe to call from every entrypoint; honours a `CONTAINER_HOST` the user set
 * themselves — including the worktree image's baked ENV (same socket path).
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


/**
 * Which host podman engine yaac drives. Kept free of imports, so the test
 * setup and scripts can call `ensureRootfulPodmanHost` without loading the
 * kubernetes client.
 */

/**
 * The rootful podman socket: systemd's `podman.socket` on a Linux host, or
 * the in-pod engine in a nested workspace (same path).
 */
export const ROOTFUL_PODMAN_SOCKET = '/run/podman/podman.sock'

/**
 * Whether yaac uses rootful podman (everywhere but macOS, where the podman
 * machine serves). kind's node runs on this engine, and calico-node needs
 * the cgroup2 and BPF access only a rootful engine delegates.
 */
export function usesRootfulPodman(): boolean {
  return process.platform !== 'darwin'
}

/**
 * Set `CONTAINER_HOST` to the rootful socket, so podman and kind (which
 * inherits our env) use the same engine. Keeps a user-set value. Idempotent;
 * no-op on macOS.
 */
export function ensureRootfulPodmanHost(): void {
  if (!usesRootfulPodman()) return
  // eslint-disable-next-line no-process-env -- one global lever so kind + every podman call target the rootful engine
  if (!process.env.CONTAINER_HOST) process.env.CONTAINER_HOST = `unix://${ROOTFUL_PODMAN_SOCKET}`
}

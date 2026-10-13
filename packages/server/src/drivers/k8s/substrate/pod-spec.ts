/** ConfigMap (cluster-scoped to the yaac namespace) holding the proxy CA. */
export const CA_CONFIGMAP_NAME = 'yaac-proxy-ca'
/** Key inside the CA ConfigMap / filename inside the mount dir. */
export const CA_CONFIGMAP_KEY = 'proxy-ca.pem'
/**
 * Second key in the CA ConfigMap: public roots plus the proxy CA. Tools in
 * nested containers that use their own bundle (curl, requests, cargo, git)
 * point `CURL_CA_BUNDLE` and similar at it, so they trust both intercepted
 * and tunnelled hosts (docs/nested-containers.md).
 */
export const CA_BUNDLE_KEY = 'ca-bundle.pem'
/**
 * Pod-local directory (an emptyDir) holding the forwarded ssh-agent socket
 * that `SSH_AUTH_SOCK` names. The agent itself is in the proxy pod, reached
 * over TCP (SSH_AGENT_PORT).
 */
export const SSH_AGENT_MOUNT = '/ssh-agent'
export const SSH_AGENT_SOCKET_PATH = `${SSH_AGENT_MOUNT}/socket`

/**
 * In-container directory of the nested rootful podman graphroot. It is a
 * sentry-internal tmpfs (NESTED_GRAPHROOT_ANNOTATIONS) because gVisor's
 * gofer filesystem rejects `security.*` xattr writes, so `setcap` in a
 * `docker build` step would fail on a hostPath or plain emptyDir. The tmpfs
 * is paged to a file in the emptyDir on node disk, so layers do not count
 * against pod memory.
 */
export const NESTED_GRAPHROOT_PATH = '/var/lib/containers'

/** Graphroot volume name; the gVisor mount annotations key on it. */
export const NESTED_GRAPHROOT_VOLUME = 'podman-graphroot'

/**
 * Pod annotations that turn emptyDir `volume` into a sentry-internal tmpfs
 * of at most `sizeBytes`, paged to a file in the emptyDir on node disk.
 * `type: bind` gives the disk-backed variant; `type: tmpfs` would pin
 * pages in pod memory (gVisor's pkg/shim/v1/utils/volumes.go). containerd
 * passes `dev.gvisor.*` annotations through (gvisorContainerdRuntimesToml).
 *
 * The hint applies only to a mount of the whole volume, never a `subPath`,
 * so each mount point needs its own volume.
 */
export function sentryTmpfsAnnotations(volume: string, sizeBytes: number): Record<string, string> {
  return {
    [`dev.gvisor.spec.mount.${volume}.type`]: 'bind',
    [`dev.gvisor.spec.mount.${volume}.share`]: 'container',
    [`dev.gvisor.spec.mount.${volume}.options`]: `rw,size=${sizeBytes}`,
  }
}

/**
 * In-sandbox capabilities the rootful nested engine needs. Under gVisor they
 * grant no host authority:
 *  - SYS_ADMIN, SYS_CHROOT: mounts and pivot_root for container rootfs.
 *  - MKNOD: device nodes in containers.
 *  - SETFCAP: `setcap` in `docker build` steps.
 *  - NET_RAW, NET_ADMIN: raw sockets and route/iptables config.
 *  - SYS_PTRACE, SYS_RESOURCE: debuggers and rlimit raises.
 */
export const NESTED_ENGINE_CAPS = [
  'SYS_ADMIN', 'SYS_CHROOT', 'MKNOD', 'SETFCAP',
  'NET_RAW', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_RESOURCE',
]

/**
 * hostPath `type` check. Defaults to 'Directory'. Use 'File' for
 * single-file binds, and `''` (kubernetes' "no check" type) for
 * user-supplied paths that may be either.
 */
type HostPathType = 'Directory' | 'DirectoryOrCreate' | 'File' | 'FileOrCreate' | ''

/**
 * Where a workspace mount's bytes come from. `resolveMountSource` picks it
 * from the path's storage tier (packages/shared/src/paths.ts); the
 * container path does not change.
 *
 *  - `hostPath`: a node-local path on the node's disk.
 *  - `pvc`: a subPath of a claim on the global tier: `yaac-global`, or
 *    `yaac-checkouts` for a checkout.
 *  - `emptyDir`: pod-local scratch, e.g. the tmux socket dir
 *    (CONTAINER_TMUX_DIR).
 *
 * Caution for UNIX sockets on an emptyDir: with `host-uds=all` the socket
 * is bound at the node path
 * `/var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~empty-dir/<name>/…`,
 * and `sun_path` allows 107 bytes. tmux's `ed-<i>/server` uses 102, so a
 * longer volume name or index can overflow it.
 */
export type MountSource =
  | { kind: 'hostPath'; path: string; type?: HostPathType }
  | { kind: 'pvc'; claimName: string; subPath?: string }
  | { kind: 'emptyDir'; sizeLimit?: number }

/** One volume mounted into the workspace container, plus where it comes from. */
export interface PodMount {
  source: MountSource
  mountPath: string
  readOnly?: boolean
}

/** The uid and gid an install's pods run as (docs/server-in-cluster.md). */
export interface InstallIdentity {
  uid: number
  gid: number
}

/**
 * This process's uid and gid. Inside the server pod this is the install
 * identity, since install sets it on the Deployment. Throws on non-POSIX
 * platforms rather than inventing a uid.
 */
export function processIdentity(): InstallIdentity {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined) {
    throw new Error(
      'processIdentity: process.getuid/getgid unavailable — '
      + 'the yaac server requires a POSIX host',
    )
  }
  return { uid, gid }
}

/**
 * securityContext for yaac pods that run as the install's identity (server,
 * proxy, workspace pods, install probe pods).
 *
 * The uid and gid are the install's (docs/server-in-cluster.md). gVisor
 * has no user namespace, so uids on shared storage pass through unchanged.
 * Inside the cluster the default (this process's identity) is the
 * install's; host-side callers such as `cluster check` pass the one the
 * live Deployment records.
 *
 * Supplementary group 0 lets the pod write the image's group-0-writable
 * files, so one image serves every install (docs/arbitrary-uid-images.md).
 * It is supplementary so files created on a claim keep the install's group.
 *
 * No `fsGroup`: it does not apply to hostPath. The proxy adds one itself
 * for its emptyDir HOME.
 */
export function installSecurityContext(identity: InstallIdentity = processIdentity()): {
  runAsUser: number
  runAsGroup: number
  supplementalGroups: number[]
} {
  return { runAsUser: identity.uid, runAsGroup: identity.gid, supplementalGroups: [0] }
}

/**
 * RuntimeClass names. Every untrusted pod sets one; infra pods set none and
 * get runc.
 *  - `gvisor`: the default sandbox (runsc with systrap).
 *  - `gvisor-nested`: also allows raw sockets, for the container engine
 *    that nested workspaces run.
 */
export const RUNTIME_CLASS_GVISOR = 'gvisor'
export const RUNTIME_CLASS_GVISOR_NESTED = 'gvisor-nested'

/**
 * Pod-spec fragment choosing the RuntimeClass for a pod that runs untrusted
 * code (workspace pods and the check probes that mimic them): `gvisor`, or
 * `gvisor-nested` when the pod runs a container engine.
 */
export function runtimeClassSpec(
  opts: { nested?: boolean } = {},
): { runtimeClassName?: string } {
  return {
    runtimeClassName: opts.nested ? RUNTIME_CLASS_GVISOR_NESTED : RUNTIME_CLASS_GVISOR,
  }
}

import path from 'node:path'
import { runtimeClassSpec } from './gvisor'
import { priorityClassSpec } from './priority-classes'

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
/** Directory inside workspace pods where the CA ConfigMap is mounted. */
export const CA_MOUNT_DIR = '/etc/yaac/certs'

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
 * Size cap of the graphroot tmpfs, enforced by the sentry, so an oversized
 * build fails with ENOSPC instead of filling node disk. It is ephemeral
 * storage, not pod memory.
 *
 * Sized to hold the yaac image chain (~6.5GiB unique) plus upstream
 * mirrors, with room to build on top; 8GiB was too small for the e2e image
 * builds. It is added to the ephemeral-storage limit but not the request,
 * so it does not reduce scheduling density.
 */
export const NESTED_GRAPHROOT_TMPFS_BYTES = 12 * 1024 ** 3

/**
 * emptyDir sizeLimit for the graphroot: the tmpfs cap plus 1GiB slack. The
 * backing file can exceed the cap slightly, and hitting the sizeLimit
 * evicts the whole workspace, whereas the tmpfs cap only fails the write.
 */
export const NESTED_GRAPHROOT_SIZELIMIT_BYTES = NESTED_GRAPHROOT_TMPFS_BYTES + 1024 ** 3

/**
 * Every workspace pod's annotations: a workspace keeps live state in its
 * sandbox, so a cluster autoscaler must never evict one to drain a node it
 * thinks is underused. The node stays until the workspace stops.
 */
export const WORKSPACE_POD_ANNOTATIONS: Record<string, string> = {
  'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
}

/** Pod annotations making the graphroot a disk-backed sentry tmpfs. */
export const NESTED_GRAPHROOT_ANNOTATIONS: Record<string, string> =
  sentryTmpfsAnnotations(NESTED_GRAPHROOT_VOLUME, NESTED_GRAPHROOT_TMPFS_BYTES)

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
 * Volume-name prefix of a workspace's module dirs (`PodJobParams.moduleDirs`),
 * one volume per dir: `pnpm-modules-0` for the first, and so on.
 */
const MODULES_VOLUME_PREFIX = 'pnpm-modules'

/**
 * Tmpfs cap of each module-dir volume, sized for a large monorepo's root
 * `node_modules` including the pnpm store (this repo's is ~1.5GiB).
 * Disk-backed like the graphroot.
 */
export const MODULES_TMPFS_BYTES = 8 * 1024 ** 3

/** emptyDir sizeLimit of each module-dir volume (see
 *  NESTED_GRAPHROOT_SIZELIMIT_BYTES). */
export const MODULES_SIZELIMIT_BYTES = MODULES_TMPFS_BYTES + 1024 ** 3

/** What module dirs add to the ephemeral-storage request: one typical install. */
export const MODULES_REQUEST_BYTES = 2 * 1024 ** 3

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
 *  - `pvc`: a subPath of the RWX `yaac-global` claim (the global tier).
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

/** Volume-name prefix per source kind; the suffix is the mount's index. */
const VOLUME_NAME_PREFIX: Record<MountSource['kind'], string> = {
  hostPath: 'hp',
  pvc: 'pv',
  emptyDir: 'ed',
}

/** The volume body (everything but `name`) for one mount source. */
function volumeSourceSpec(source: MountSource): Record<string, unknown> {
  switch (source.kind) {
    case 'hostPath':
      return { hostPath: { path: source.path, type: source.type ?? 'Directory' } }
    case 'pvc':
      // subPath goes on the volumeMount.
      return { persistentVolumeClaim: { claimName: source.claimName } }
    case 'emptyDir':
      return {
        emptyDir: source.sizeLimit === undefined ? {} : { sizeLimit: String(source.sizeLimit) },
      }
  }
}

export interface PodJobParams {
  jobName: string
  namespace: string
  /** Applied to the Job and its pod template (project, workspace-id, …). */
  labels: Record<string, string>
  image: string
  /** `NAME=VALUE` entries. */
  env: string[]
  /** Workspace mounts in render order, each declaring its own source. */
  mounts: PodMount[]
  /**
   * Scheduler reservation. Kept well below memoryLimitBytes so idle
   * workspaces can overcommit a node. Without it Kubernetes would reserve
   * the full limit per workspace.
   */
  memoryRequestBytes: number
  /** Hard cgroup cap; exceeding it OOM-kills the container. */
  memoryLimitBytes: number
  /**
   * CPU request in millicores, so the scheduler accounts for the pod. Also
   * the pod's share of a busy node.
   */
  cpuRequestMillis: number
  /**
   * CPU limit in millicores. runsc sizes the sandbox's virtual CPU count
   * from the cpu quota (`-cpu-num-from-quota`). With no limit it uses the
   * host's core count and spawns one systrap stub per core, so one
   * syscall-heavy workspace can saturate the node. Keep it well above the
   * request, so CFS throttling only hits large parallel bursts.
   */
  cpuLimitMillis: number
  /**
   * Ephemeral-storage request: the writable layer, logs and emptyDir
   * volumes (hostPath and PVC mounts do not count). Far below the limit,
   * like memory.
   */
  ephemeralStorageRequestBytes: number
  /**
   * Ephemeral-storage limit; kubelet evicts the pod past it, which protects
   * other pods on the node. The graphroot and module-dir sizeLimits are
   * added on top when present.
   */
  ephemeralStorageLimitBytes: number
  /** Pinned proxy Service ClusterIP, used as the pod's DNS resolver. */
  proxyHost: string
  /** Run the in-pod rootful podman: adds its graphroot, caps and gVisor handler. */
  nested?: boolean
  /**
   * Container paths of the workspace's module dirs, each its own disk-backed
   * sentry tmpfs, so pnpm's file traffic stays inside the sandbox instead of
   * crossing the gofer, and a store inside the root dir can hardlink. Lost
   * with the pod; init commands reinstall.
   */
  moduleDirs?: string[]
  /**
   * postStart hook argv (`yaac-workspace-init`). The pod is not Ready until
   * it exits, so Ready means in-pod setup is done. A nonzero exit fails the
   * Job.
   */
  postStartExec?: string[]
  /**
   * preStop hook argv, bounded by the grace period. Workspace pods
   * checkpoint opencode's state here.
   */
  preStopExec?: string[]
  /**
   * Node-local directories (node paths under `nodeLocalRoot`) for the
   * `node-dirs` init container to create and chown to the pod's identity.
   * hostPath ignores `fsGroup` and `DirectoryOrCreate` creates root-owned
   * dirs, so the pod must do it itself.
   */
  nodeLocalDirs?: string[]
  /** The node root the init container mounts to create `nodeLocalDirs`
   *  under; required when they are given. */
  nodeLocalRoot?: string
  /** Defaults to 5 seconds. */
  terminationGracePeriodSeconds?: number
}

/** Split a `NAME=VALUE` env entry at the first `=`. */
function parseEnvEntry(entry: string): { name: string; value: string } {
  const idx = entry.indexOf('=')
  if (idx < 0) return { name: entry, value: '' }
  return { name: entry.slice(0, idx), value: entry.slice(idx + 1) }
}

/**
 * Build the Job manifest for one workspace: a single-pod Job
 * (`backoffLimit: 0`, `restartPolicy: Never`) with the caller's mounts and
 * the proxy CA. Pure, so the whole spec is unit-testable.
 */
export function buildPodJobManifest(p: PodJobParams): Record<string, unknown> {
  const volumes: Array<Record<string, unknown>> = []
  const volumeMounts: Array<Record<string, unknown>> = []

  p.mounts.forEach((m, i) => {
    const name = `${VOLUME_NAME_PREFIX[m.source.kind]}-${i}`
    volumes.push({ name, ...volumeSourceSpec(m.source) })
    volumeMounts.push({
      name,
      mountPath: m.mountPath,
      ...(m.source.kind === 'pvc' && m.source.subPath ? { subPath: m.source.subPath } : {}),
      ...(m.readOnly ? { readOnly: true } : {}),
    })
  })

  volumes.push({
    name: 'proxy-ca',
    configMap: { name: CA_CONFIGMAP_NAME },
  })
  volumeMounts.push({ name: 'proxy-ca', mountPath: CA_MOUNT_DIR, readOnly: true })

  // Always mounted, so the forwarder never needs root to create it.
  volumes.push({ name: 'ssh-agent', emptyDir: {} })
  volumeMounts.push({ name: 'ssh-agent', mountPath: SSH_AGENT_MOUNT })

  const initContainers: Array<Record<string, unknown>> = []
  if (p.nodeLocalDirs && p.nodeLocalDirs.length > 0) {
    if (!p.nodeLocalRoot) throw new Error('nodeLocalDirs given without nodeLocalRoot')
    volumes.push({
      name: 'node-root',
      hostPath: { path: p.nodeLocalRoot, type: 'DirectoryOrCreate' },
    })
    initContainers.push(nodeDirsInitContainer(p.image, p.nodeLocalRoot, p.nodeLocalDirs))
  }

  if (p.nested) {
    // See NESTED_GRAPHROOT_PATH. Root-owned; the engine runs as root.
    volumes.push({
      name: NESTED_GRAPHROOT_VOLUME,
      emptyDir: { sizeLimit: String(NESTED_GRAPHROOT_SIZELIMIT_BYTES) },
    })
    volumeMounts.push({ name: NESTED_GRAPHROOT_VOLUME, mountPath: NESTED_GRAPHROOT_PATH })
  }

  // One volume per dir (see sentryTmpfsAnnotations). A tmpfs root is
  // world-writable, so the workspace user can install into it.
  const moduleDirs = p.moduleDirs ?? []
  let annotations: Record<string, string> = {
    ...WORKSPACE_POD_ANNOTATIONS,
    ...(p.nested ? NESTED_GRAPHROOT_ANNOTATIONS : {}),
  }
  moduleDirs.forEach((dir, i) => {
    const name = `${MODULES_VOLUME_PREFIX}-${i}`
    volumes.push({ name, emptyDir: { sizeLimit: String(MODULES_SIZELIMIT_BYTES) } })
    volumeMounts.push({ name, mountPath: dir })
    annotations = { ...annotations, ...sentryTmpfsAnnotations(name, MODULES_TMPFS_BYTES) }
  })
  // The limit adds ONE module dir's sizeLimit however many dirs there are:
  // in a pnpm workspace the nested dirs hold only symlinks. Several
  // independent installs could still reach the limit together.
  const modulesLimit = moduleDirs.length > 0 ? MODULES_SIZELIMIT_BYTES : 0
  const modulesRequest = moduleDirs.length > 0 ? MODULES_REQUEST_BYTES : 0

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: p.jobName,
      namespace: p.namespace,
      labels: p.labels,
    },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: p.labels, annotations },
        spec: {
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: p.terminationGracePeriodSeconds ?? 5,
          ...priorityClassSpec(),
          // Untrusted workloads: no API credentials or service env vars.
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          // Kubernetes leaves pods unconfined without this (runsc ignores
          // it and applies its own).
          securityContext: {
            seccompProfile: { type: 'RuntimeDefault' },
            // The image bakes no uid; run as the install uid that owns the
            // checkout.
            ...installSecurityContext(),
          },
          // gVisor contains in-container root (the image has passwordless
          // sudo).
          ...runtimeClassSpec({ nested: !!p.nested }),
          // The proxy's DNS stub is the only resolver. It forwards cluster
          // names to CoreDNS and answers external names with a sinkhole IP,
          // since netd redirects egress and the proxy routes by SNI/Host.
          dnsPolicy: 'None',
          dnsConfig: { nameservers: [p.proxyHost] },
          ...(initContainers.length > 0 ? { initContainers } : {}),
          containers: [
            {
              name: 'workspace',
              image: p.image,
              // Tags are content hashes, so a cached tag is always correct.
              imagePullPolicy: 'IfNotPresent',
              workingDir: '/workspace',
              env: p.env.map(parseEnvEntry),
              volumeMounts,
              ...(p.postStartExec || p.preStopExec ? {
                lifecycle: {
                  ...(p.postStartExec ? { postStart: { exec: { command: p.postStartExec } } } : {}),
                  ...(p.preStopExec ? { preStop: { exec: { command: p.preStopExec } } } : {}),
                },
              } : {}),
              // No allowPrivilegeEscalation: it is implied by CAP_SYS_ADMIN,
              // and false would be rejected.
              ...(p.nested ? {
                securityContext: {
                  capabilities: { add: NESTED_ENGINE_CAPS },
                },
              } : {}),
              resources: {
                requests: {
                  cpu: `${p.cpuRequestMillis}m`,
                  memory: String(p.memoryRequestBytes),
                  'ephemeral-storage': String(p.ephemeralStorageRequestBytes + modulesRequest),
                },
                limits: {
                  // Also sets runsc's virtual CPU count (see cpuLimitMillis).
                  cpu: `${p.cpuLimitMillis}m`,
                  memory: String(p.memoryLimitBytes),
                  // kubelet counts emptyDir volumes against this limit, so
                  // add their sizeLimits or a big build evicts the workspace.
                  'ephemeral-storage': String(
                    p.ephemeralStorageLimitBytes
                    + (p.nested ? NESTED_GRAPHROOT_SIZELIMIT_BYTES : 0)
                    + modulesLimit,
                  ),
                },
              },
            },
          ],
          volumes,
        },
      },
    },
  }
}

/** Where the init container sees the node root. */
const NODE_ROOT_MOUNT = '/node'

/**
 * Grace period (seconds) for a pod with a preStop hook, long enough for an
 * opencode checkpoint. Teardown waits longer than this before removing the
 * pod's file-mount sources (workspaces/teardown.ts).
 */
export const PRE_STOP_GRACE_SECONDS = 60

/**
 * The `node-dirs` init container: the pod's own image, run as root. For
 * each node-local directory it walks the path one component at a time,
 * creating missing ones and chowning each (not recursively) to the pod's
 * identity. The chown is unconditional because kubelet has already created
 * `DirectoryOrCreate` leaves as root. Symlinks are replaced with
 * directories, since other pods of the project can write this tree and
 * could plant one.
 */
function nodeDirsInitContainer(
  image: string,
  nodeRoot: string,
  dirs: string[],
): Record<string, unknown> {
  const { runAsUser, runAsGroup } = installSecurityContext()
  const script = [
    'set -e',
    'for d in "$@"; do',
    `  case "$d" in ${NODE_ROOT_MOUNT}/*) ;; *) echo "not under ${NODE_ROOT_MOUNT}: $d" >&2; exit 1;; esac`,
    `  p=${NODE_ROOT_MOUNT}`,
    `  rel=\${d#${NODE_ROOT_MOUNT}/}`,
    '  oldifs=$IFS; IFS=/',
    '  for seg in $rel; do',
    '    IFS=$oldifs',
    '    p="$p/$seg"',
    '    if [ -L "$p" ]; then rm -f "$p"; fi',
    '    [ -d "$p" ] || mkdir "$p"',
    `    chown ${String(runAsUser)}:${String(runAsGroup)} "$p"`,
    '    IFS=/',
    '  done',
    '  IFS=$oldifs',
    'done',
  ].join('\n')
  return {
    name: 'node-dirs',
    image,
    imagePullPolicy: 'IfNotPresent',
    securityContext: { runAsUser: 0, runAsGroup: 0 },
    command: [
      'sh', '-c', `${script}
`, '--',
      ...dirs.map((d) => `${NODE_ROOT_MOUNT}/${path.posix.relative(nodeRoot, d)}`),
    ],
    volumeMounts: [{ name: 'node-root', mountPath: NODE_ROOT_MOUNT }],
  }
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

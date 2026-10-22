import path from 'node:path'
import { mergeEnvEntries } from '#lib/env-entries'
import {
  CA_CONFIGMAP_NAME,
  LABEL_INSTALL_ID,
  NESTED_ENGINE_CAPS,
  NESTED_GRAPHROOT_PATH,
  NESTED_GRAPHROOT_VOLUME,
  PRIORITY_CLASS_WORKSPACE,
  SSH_AGENT_MOUNT,
  installSecurityContext,
  runtimeClassSpec,
  sentryTmpfsAnnotations,
  type MountSource,
  type PodMount,
} from '#drivers/k8s/substrate'

/**
 * The Job a workspace runs as: its pod's volumes, resources, sandbox and
 * hooks. Pure, so the whole spec is unit-testable; `launchWorkspace`
 * assembles the parameters.
 */

/** Directory inside workspace pods where the CA ConfigMap is mounted. */
export const CA_MOUNT_DIR = '/etc/yaac/certs'

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
  /** `NAME=VALUE` entries. A name repeated with the same value is
   *  rendered once; with a different value, the build throws. */
  env: string[]
  /** Workspace mounts in render order, each declaring its own source. */
  mounts: PodMount[]
  /**
   * Scheduler reservation. Kept well below memoryLimitBytes so idle
   * workspaces can overcommit a node. Without it Kubernetes would reserve
   * the full limit per workspace.
   */
  memoryRequestBytes: number
  /**
   * The pod cgroup's memory cap, which is also the sandbox's `MemTotal`.
   * Past it, and past the swap netd allows the pod, the workspace is
   * OOM-killed alone.
   */
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

/**
 * Spread this install's workspaces evenly across the nodes that can run
 * them. Requests sit well under real use (see docs/cluster-setup.md "What a
 * workspace reserves"), so without this the scheduler's image-locality score
 * piles every workspace of a project onto the node that already caches its
 * image, until that node runs out of memory while another sits idle.
 * `ScheduleAnyway` makes it a preference: a workspace never waits Pending,
 * nor makes the autoscaler add a node, just to even out the count.
 */
function workspaceSpreadSpec(labels: Record<string, string>): Record<string, unknown> {
  return {
    topologySpreadConstraints: [{
      maxSkew: 1,
      topologyKey: 'kubernetes.io/hostname',
      whenUnsatisfiable: 'ScheduleAnyway',
      labelSelector: { matchLabels: { [LABEL_INSTALL_ID]: labels[LABEL_INSTALL_ID] } },
    }],
  }
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
          priorityClassName: PRIORITY_CLASS_WORKSPACE,
          ...workspaceSpreadSpec(p.labels),
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
              env: mergeEnvEntries(p.env),
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
 *
 * It declares limits like every container in the pod: kubelet sets the pod
 * cgroup's memory cap only when all of them do, and gVisor enforces no
 * other (docs/cluster-setup.md "Memory pressure").
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
    resources: {
      requests: { cpu: '10m', memory: '16Mi' },
      limits: { cpu: '100m', memory: '64Mi' },
    },
    command: [
      'sh', '-c', `${script}
`, '--',
      ...dirs.map((d) => `${NODE_ROOT_MOUNT}/${path.posix.relative(nodeRoot, d)}`),
    ],
    volumeMounts: [{ name: 'node-root', mountPath: NODE_ROOT_MOUNT }],
  }
}

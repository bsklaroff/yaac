import path from 'node:path'
import { CONTAINER_TMUX_DIR } from '@yaac/shared/paths'
import {
  CA_CONFIGMAP_NAME,
  GLOBAL_CLAIM_NAME,
  LABEL_INSTALL_ID,
  PRIORITY_CLASS_WORKSPACE,
  RUNTIME_CLASS_GVISOR,
  SANDBOX_DNS,
  installSecurityContext,
  k8sWorkspacePaths,
  netshimContainer,
  nodeMountsNodePath,
  sentryTmpfsAnnotations,
  socketVolume,
} from '#drivers/k8s/substrate'

/**
 * The Job a workspace runs as (docs/generic-workspace-pods.md "The pod").
 * Every workspace pod has this one shape, whose spec holds nothing a
 * project owns: what makes a pod one workspace's is mounted into its
 * node-mounts directory and bound inside its sandbox at the claim. What
 * stays in the spec, for the few pods made on demand that need it: a byo
 * volume's claim, a site release's priority class and node, and a run's
 * secret variables. Pure, so the whole spec is unit-testable.
 */

/** Directory inside workspace pods where the CA ConfigMap is mounted. */
export const CA_MOUNT_DIR = '/etc/yaac/certs'

/**
 * Every workspace pod's annotations: a workspace keeps live state in its
 * sandbox, so a cluster autoscaler must never evict one to drain a node it
 * thinks is underused. The node stays until the workspace stops.
 */
export const WORKSPACE_POD_ANNOTATIONS: Record<string, string> = {
  'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
}

/** Where both containers see the pod's node-mounts directory. */
export const NODE_MOUNTS_DIR = '/node-mounts'
/** Where both containers see this server build's helper commands and
 *  bundled skills (`helpersSubPath`). */
export const HELPERS_DIR = '/opt/yaac/helpers'
/** The pod's scratch volume, divided among the workspace's scratch dirs at
 *  the claim (docs/generic-workspace-pods.md "Scratch dirs"). */
export const SCRATCH_ROOT = '/yaac-scratch'
/** Pod-local folders the claim binds where a workspace asks for an
 *  `emptyDir` (codex's `tmp`). */
export const LOCAL_ROOT = '/yaac-local'
/** The annotation recording a pod's scratch size, which its pool is for. */
export const SCRATCH_BYTES_ANNOTATION = 'yaac.scratch-bytes'

/**
 * How far the scratch volume's emptyDir sizeLimit sits above its tmpfs cap.
 * The backing file can exceed the cap slightly, and hitting the sizeLimit
 * evicts the whole workspace, whereas the tmpfs cap only fails the write.
 */
export const SCRATCH_SIZELIMIT_SLACK_BYTES = 1024 ** 3

/** What the scratch volume adds to the ephemeral-storage request: one
 *  typical install. */
export const SCRATCH_REQUEST_BYTES = 2 * 1024 ** 3

/** The shared tier's folder holding one server build's helpers, mounted
 *  read-only into every pod that build makes. */
export function helpersSubPath(build: string): string {
  return path.posix.join('run', 'helpers', build)
}

/** One extra volume a pod made on demand mounts at a path of its own: a
 *  byo volume's claim, which kubelet has to attach. */
export interface ClaimMount {
  claimName: string
  mountPath: string
}

export interface PodJobParams {
  jobName: string
  namespace: string
  /** Applied to the Job and its pod template (project, workspace-id, …). */
  labels: Record<string, string>
  image: string
  /** `NAME=VALUE` entries; only what any workspace of this id gets. */
  env: string[]
  /** Variables read from a Secret's key of the same name: a project's run
   *  secrets, on a pod made on demand. */
  secretEnv?: { secretName: string; names: string[] }
  /** The pod's node-mounts directory, under this install's root. Its socket
   *  directory has the same name under the socket root. */
  nodeMountsDir: string
  /** This server build's helpers folder on the shared tier. */
  helpers: string
  /** The scratch volume's tmpfs cap. */
  scratchBytes: number
  /** Byo volume claims (pods made on demand only). */
  claimMounts?: ClaimMount[]
  /** The pinned utility image, which the `volume-root` init container
   *  runs; required with `claimMounts`. */
  utilityImage?: string
  /**
   * Scheduler reservation. Kept well below memoryLimitBytes so idle
   * workspaces can overcommit a node. Without it Kubernetes would reserve
   * the full limit per workspace. A memory request cannot be raised in
   * place on a node with swap, so a spare reserves a workspace's from
   * creation.
   */
  memoryRequestBytes: number
  /**
   * The pod cgroup's memory cap, which is also the sandbox's `MemTotal`.
   * Past it, and past the swap netd allows the pod, the workspace is
   * OOM-killed alone.
   */
  memoryLimitBytes: number
  /** CPU request in millicores: the pod's share of a busy node. */
  cpuRequestMillis: number
  /**
   * CPU limit in millicores. runsc sizes the sandbox's virtual CPU count
   * from the cpu quota (`-cpu-num-from-quota`). With no limit it uses the
   * host's core count and spawns one systrap stub per core, so one
   * syscall-heavy workspace can saturate the node.
   */
  cpuLimitMillis: number
  /** Ephemeral-storage request: the writable layer, logs and emptyDirs. */
  ephemeralStorageRequestBytes: number
  /** Ephemeral-storage limit; kubelet evicts the pod past it. The scratch
   *  volume's sizeLimit is added on top. */
  ephemeralStorageLimitBytes: number
  /** netshim's image (the mountd image), which carries the pod's traffic. */
  netshimImage: string
  /** The tree container's image, for a pod whose workspace keeps its files
   *  on its node (every pod but a site release's). */
  treeImage?: string
  /** Defaults to the workspace tier. */
  priorityClassName?: string
  /** The nodes the pod may run on: those whose mountd is ready, and for a
   *  site release beside a volume's holder, that one. */
  nodeNames: string[]
}

/**
 * Spread this install's workspaces evenly across the nodes that can run
 * them. Requests sit well under real use (see docs/cluster-setup.md "What a
 * workspace reserves"), so without this the scheduler's image-locality score
 * piles every workspace of a project onto the node that already caches its
 * image, until that node runs out of memory while another sits idle.
 * `ScheduleAnyway` makes it a preference.
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

/** Where both containers see the tree container's trigger file. */
export const TREE_TRIGGER_FILE = k8sWorkspacePaths().treeTrigger as string
export const TREE_TRIGGER_DIR = path.posix.dirname(TREE_TRIGGER_FILE)

/** The tree container's marker that a life's files are ready, on the
 *  trigger volume both containers mount. */
export function treeStartedMarker(life: string): string {
  return path.posix.join(TREE_TRIGGER_DIR, `started.${life}`)
}

/** What the tree container, and a salvage or import pod doing its work,
 *  may use. Limits on every container are what give the pod a memory cap. */
export const TREE_RESOURCES = {
  requests: { cpu: '50m', memory: '128Mi' },
  limits: { cpu: '1', memory: '1Gi' },
}

/**
 * The tree container (docs/generic-workspace-pods.md "A claim"). It runs
 * yaac's base image as root, never a project's. At the claim it binds its
 * entries from the list in the node-mounts directory, which needs
 * CAP_SYS_ADMIN, and gives that up for good before it reads anything an
 * agent wrote; after that it has no more privilege than an agent's `sudo`.
 * It then fills the life's tree from the arborist's index, or
 * restores a checkpoint onto it, and checkpoints it.
 */
function treeContainer(image: string, volumeMounts: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    name: 'tree',
    image,
    imagePullPolicy: 'IfNotPresent',
    restartPolicy: 'Always',
    command: ['node', `${HELPERS_DIR}/bin/yaac-tree`, 'start', '--trigger', TREE_TRIGGER_FILE],
    securityContext: {
      runAsUser: 0,
      runAsGroup: 0,
      // SYS_ADMIN binds, and SETPCAP drops both for good once it has.
      capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'SYS_ADMIN', 'SETPCAP'] },
    },
    resources: TREE_RESOURCES,
    volumeMounts,
  }
}

/**
 * Build the Job manifest for one workspace pod: a single-pod Job
 * (`backoffLimit: 0`, `restartPolicy: Never`).
 */
export function buildPodJobManifest(p: PodJobParams): Record<string, unknown> {
  const nodeMounts = { name: 'node-mounts', mountPath: NODE_MOUNTS_DIR, readOnly: true, mountPropagation: 'HostToContainer' }
  const helpers = { name: 'helpers', mountPath: HELPERS_DIR, readOnly: true }
  const trigger = { name: 'tree-trigger', mountPath: TREE_TRIGGER_DIR }
  const volumes: Array<Record<string, unknown>> = [
    { name: 'node-mounts', hostPath: { path: path.posix.join(nodeMountsNodePath(), p.nodeMountsDir), type: 'DirectoryOrCreate' } },
    { name: 'helpers', persistentVolumeClaim: { claimName: GLOBAL_CLAIM_NAME } },
    { name: 'proxy-ca', configMap: { name: CA_CONFIGMAP_NAME } },
    { name: 'tmux', emptyDir: {} },
    { name: 'local', emptyDir: {} },
    { name: 'tree-trigger', emptyDir: { sizeLimit: '1Mi' } },
    // A tmpfs in the sentry (sentryTmpfsAnnotations), so pnpm's file
    // traffic stays inside the sandbox and a store inside one scratch dir
    // can hardlink into the others, which share it.
    { name: 'scratch', emptyDir: { sizeLimit: String(p.scratchBytes + SCRATCH_SIZELIMIT_SLACK_BYTES) } },
    ...(p.claimMounts ?? []).map((m, i) => ({ name: `pv-${String(i)}`, persistentVolumeClaim: { claimName: m.claimName } })),
    socketVolume(p.nodeMountsDir),
  ]
  const volumeMounts: Array<Record<string, unknown>> = [
    nodeMounts,
    { ...helpers, subPath: p.helpers },
    { name: 'proxy-ca', mountPath: CA_MOUNT_DIR, readOnly: true },
    { name: 'tmux', mountPath: CONTAINER_TMUX_DIR },
    { name: 'local', mountPath: LOCAL_ROOT },
    trigger,
    { name: 'scratch', mountPath: SCRATCH_ROOT },
    ...(p.claimMounts ?? []).map((m, i) => ({ name: `pv-${String(i)}`, mountPath: m.mountPath })),
  ]
  const annotations = {
    ...WORKSPACE_POD_ANNOTATIONS,
    ...sentryTmpfsAnnotations('scratch', p.scratchBytes),
    [SCRATCH_BYTES_ANNOTATION]: String(p.scratchBytes),
  }

  const initContainers: Array<Record<string, unknown>> = [netshimContainer(p.netshimImage)]
  // A byo volume's claim is a fresh filesystem whose root belongs to root.
  const volumeRoots = (p.claimMounts ?? []).map((_, i) => `pv-${String(i)}`)
  if (volumeRoots.length > 0) {
    if (!p.utilityImage) throw new Error('a volume claim mounted without utilityImage')
    initContainers.push(volumeRootInitContainer(p.utilityImage, volumeRoots))
  }
  if (p.treeImage !== undefined) {
    initContainers.push(treeContainer(p.treeImage, [nodeMounts, { ...helpers, subPath: p.helpers }, trigger]))
  }

  const env: Array<Record<string, unknown>> = p.env.map((e) => {
    const eq = e.indexOf('=')
    return { name: e.slice(0, eq), value: e.slice(eq + 1) }
  })
  for (const name of p.secretEnv?.names ?? []) {
    if (env.some((e) => e.name === name)) throw new Error(`run secret ${name} shares its name with another variable`)
    env.push({ name, valueFrom: { secretKeyRef: { name: p.secretEnv?.secretName, key: name } } })
  }

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
          // preStop runs within the grace period, so it is sized for the
          // hook, and the tree container's final pass, which spends the
          // same budget.
          terminationGracePeriodSeconds: PRE_STOP_GRACE_SECONDS + (p.treeImage !== undefined ? TREE_FINAL_PASS_SECONDS : 0),
          priorityClassName: p.priorityClassName ?? PRIORITY_CLASS_WORKSPACE,
          ...workspaceSpreadSpec(p.labels),
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                // The apiserver takes one value per node-name field
                // selector, so each node is a term of its own (terms are ORed).
                nodeSelectorTerms: p.nodeNames.map((n) => ({
                  matchFields: [{ key: 'metadata.name', operator: 'In', values: [n] }],
                })),
              },
            },
          },
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
          runtimeClassName: RUNTIME_CLASS_GVISOR,
          // netshim's stub is the only resolver, and answers every name with
          // the sinkhole: every dial lands on netshim whatever it names, and
          // the proxy routes by SNI or Host (docs/workspace-egress.md).
          ...SANDBOX_DNS,
          initContainers,
          containers: [
            {
              name: 'workspace',
              image: p.image,
              // Tags are content hashes, so a cached tag is always correct.
              imagePullPolicy: 'IfNotPresent',
              workingDir: '/',
              env,
              // The sandbox keeps whatever raw-socket grant a spec makes,
              // since netshim needs one; the workspace gets none.
              securityContext: { capabilities: { drop: ['NET_RAW'] } },
              volumeMounts,
              lifecycle: {
                // The generic half of in-pod setup; kubelet holds Ready
                // until it exits.
                postStart: { exec: { command: [`${HELPERS_DIR}/bin/yaac-workspace-init`] } },
                // Checkpoints opencode's working copy, if the workspace
                // runs opencode.
                preStop: { exec: { command: [`${HELPERS_DIR}/bin/yaac-opencode-checkpoint`, 'stop'] } },
              },
              resources: {
                requests: {
                  cpu: `${String(p.cpuRequestMillis)}m`,
                  memory: String(p.memoryRequestBytes),
                  'ephemeral-storage': String(p.ephemeralStorageRequestBytes + SCRATCH_REQUEST_BYTES),
                },
                limits: {
                  cpu: `${String(p.cpuLimitMillis)}m`,
                  memory: String(p.memoryLimitBytes),
                  // kubelet counts emptyDir volumes against this limit, so
                  // add the scratch volume's or a big build evicts the
                  // workspace.
                  'ephemeral-storage': String(p.ephemeralStorageLimitBytes + p.scratchBytes + SCRATCH_SIZELIMIT_SLACK_BYTES),
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

/**
 * Grace period (seconds) for the preStop hook, long enough for an opencode
 * checkpoint. Teardown waits longer than this before removing the pod's
 * mount sources (workspaces/teardown.ts).
 */
export const PRE_STOP_GRACE_SECONDS = 60

/**
 * Grace period (seconds) the tree container's final pass adds: Kubernetes
 * counts one budget from the deletion, so the preStop hook, the workspace
 * container's exit and the final pass all spend it. On kind an ordinary
 * final pass and the tree's removal took 3 to 5 seconds; one cut off leaves
 * its tree for salvage (docs/node-local-workspaces.md "Stop").
 */
export const TREE_FINAL_PASS_SECONDS = 30

/**
 * The `volume-root` init container, run as root: hands each byo volume's
 * root to the pod's identity, once (docs/workspace-volumes.md). Not
 * recursive, and not `fsGroup`, which kubelet would apply to every volume
 * in the pod, the shared tier included. It runs the digest-pinned utility
 * image, never the workspace's own, which comes from an agent-editable
 * Dockerfile whose `sh` would run here as root. It declares limits like
 * every container in the pod: kubelet sets the pod cgroup's memory cap only
 * when all of them do, and gVisor enforces no other (docs/cluster-setup.md
 * "Memory pressure").
 */
function volumeRootInitContainer(image: string, volumes: string[]): Record<string, unknown> {
  const { runAsUser, runAsGroup } = installSecurityContext()
  const owner = `${String(runAsUser)}:${String(runAsGroup)}`
  return {
    name: 'volume-root',
    image,
    imagePullPolicy: 'IfNotPresent',
    securityContext: { runAsUser: 0, runAsGroup: 0 },
    resources: {
      requests: { cpu: '10m', memory: '16Mi' },
      limits: { cpu: '100m', memory: '64Mi' },
    },
    command: [
      'sh', '-c',
      `for d in "$@"; do [ "$(stat -c %u:%g "$d")" = ${owner} ] || chown ${owner} "$d"; done`,
      '--', ...volumes.map((v) => `/volumes/${v}`),
    ],
    volumeMounts: volumes.map((v) => ({ name: v, mountPath: `/volumes/${v}` })),
  }
}

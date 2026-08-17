import {
  GVISOR_INSTALLER_READY_FILE,
  buildRuntimeClassManifests,
  execFileAsync,
  gvisorInstallScript,
  gvisorInstallerHostMounts,
  k8sNamespace,
  kubectlApply,
  kubectlWithRetry,
} from '#drivers/k8s/substrate'
import type { PodToleration } from '#drivers/k8s/substrate'
import { imageExists, pushImageToRegistry, registryHasTag, registryRef } from '#drivers/k8s/container'
import { missingPrebuiltImage } from '#drivers/k8s/image-engine'
import { assertMirrorArch } from './netd'

/**
 * `yaac-gvisor-install` — the privileged DaemonSet that puts the gVisor
 * runtime on every node yaac schedules sandboxed pods onto, and the
 * RuntimeClasses that then point at it.
 *
 * This is the ONE install mechanism (the GPU-driver pattern): on each node
 * it lands on it drops the pinned runsc + containerd-shim-runsc-v1,
 * registers the two runsc handlers in that node's containerd config,
 * restarts containerd, and labels the node — after which the RuntimeClasses'
 * `scheduling.nodeSelector` lets sandboxed pods land there. The script it
 * runs, the node paths it writes and the label it stamps all live in
 * `#drivers/k8s/substrate` (gvisor.ts); this module owns the Kubernetes objects.
 *
 * Two properties fall out of it being a DaemonSet rather than a loop over
 * `podman exec <node>`:
 *  - it reaches nodes yaac has no shell on, which is the whole reason it
 *    exists (a remote control plane, a managed node pool);
 *  - node recycling is handled for free. A pool upgrade replaces nodes; the
 *    DaemonSet schedules onto each new one and installs before the
 *    RuntimeClass selector lets any worktree pod near it. Nothing has to
 *    notice a node was replaced.
 *
 * Blast radius is bounded by where the DaemonSet runs: `nodeSelector` is
 * plumbed through so a cluster with a dedicated worktrees pool can install
 * the runtime there only, leaving infra nodes' containerd untouched. Every
 * infra pod yaac runs (proxy, registries, node-write pods
 * planes, this installer) stamps no RuntimeClass and so keeps running on
 * runc wherever it lands.
 */

/** DaemonSet / ServiceAccount name, and the `app` label on every object. */
export const GVISOR_INSTALLER_APP_NAME = 'yaac-gvisor-install'

/**
 * The installer's container image: upstream `curl`, digest-pinned by its
 * multi-arch INDEX digest and mirrored into the local registry like Envoy
 * and registry:2 (a child-platform digest would mirror one architecture's
 * bytes onto every node — hence the `assertMirrorArch` re-check).
 *
 * Deliberately NOT a yaac-built image. Everything the installer needs is a
 * shell, an HTTP client that can verify TLS and speak PATCH (fetching the
 * pinned release, labelling the node through the apiserver), sha512sum, and
 * nsenter — which is exactly a busybox userland plus curl, at ~5 MB. A yaac
 * image would tie the runtime install to the build engine and the registry
 * being up, and this has to work on a cluster where neither yaac-built
 * images nor a host podman exist yet.
 */
const CURL_VERSION = '8.18.0'
const CURL_PIN = 'sha256:d94d07ba9e7d6de898b6d96c1a072f6f8266c687af78a74f380087a0addf5d17'
export const GVISOR_INSTALLER_UPSTREAM_IMAGE = `docker.io/curlimages/curl@${CURL_PIN}`
/** Mirror tag carries the pin, so re-pinning re-mirrors (see netd's). */
export const GVISOR_INSTALLER_MIRROR_TAG =
  `curlimages/curl:${CURL_VERSION}-${CURL_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** The mirrored installer image's in-cluster ref. Lookup-only (see netd's). */
export async function ensureGvisorInstallerImage(): Promise<string> {
  if (await registryHasTag(GVISOR_INSTALLER_MIRROR_TAG)) {
    return registryRef(GVISOR_INSTALLER_MIRROR_TAG)
  }
  throw missingPrebuiltImage('gVisor installer', GVISOR_INSTALLER_MIRROR_TAG)
}

/** Mirror the pinned installer image into the local registry. Install-time only. */
export async function mirrorGvisorInstallerImage(): Promise<string> {
  if (await registryHasTag(GVISOR_INSTALLER_MIRROR_TAG)) {
    return registryRef(GVISOR_INSTALLER_MIRROR_TAG)
  }
  if (!await imageExists(GVISOR_INSTALLER_MIRROR_TAG)) {
    await execFileAsync('podman', ['pull', GVISOR_INSTALLER_UPSTREAM_IMAGE], { timeout: 300_000 })
    const { stdout: arch } = await execFileAsync('podman', [
      'image', 'inspect', '--format', '{{.Architecture}}', GVISOR_INSTALLER_UPSTREAM_IMAGE,
    ]).catch(() => ({ stdout: '' }))
    assertMirrorArch(GVISOR_INSTALLER_UPSTREAM_IMAGE, arch)
    await execFileAsync('podman', ['tag', GVISOR_INSTALLER_UPSTREAM_IMAGE, GVISOR_INSTALLER_MIRROR_TAG])
  }
  return pushImageToRegistry(GVISOR_INSTALLER_MIRROR_TAG)
}

export function buildGvisorInstallerServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      name: GVISOR_INSTALLER_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: GVISOR_INSTALLER_APP_NAME },
    },
  }
}

/**
 * ClusterRole/Binding names are global, so they carry the install namespace
 * — the real `yaac` install and any ephemeral e2e `yaac-test-<run-id>` one
 * coexist on a cluster, each with its own installer bound to its own SA
 * (both converge on the same node state, which is idempotent by
 * construction). The label lets a sweep find an interrupted run's
 * leftovers without matching the real install's, since cluster-scoped
 * objects do not cascade when their namespace is deleted.
 */
export function gvisorInstallerClusterScopedName(): string {
  return `${GVISOR_INSTALLER_APP_NAME}-${k8sNamespace()}`
}

export function gvisorInstallerClusterScopedLabels(): Record<string, string> {
  return { app: GVISOR_INSTALLER_APP_NAME, 'yaac.install-namespace': k8sNamespace() }
}

/**
 * Exactly the authority to stamp the runtime label on nodes: read a node,
 * patch a node. No create/delete, no other resource, nothing namespaced —
 * the installer's real power is on the node's filesystem, and there is no
 * reason for that to come with an API-level lever too.
 *
 * `patch` on nodes is necessarily cluster-wide (RBAC cannot name nodes that
 * do not exist yet), so a compromised installer could label or taint any
 * node. That costs availability, not isolation: the label only steers where
 * sandboxed pods go, and a pod steered to a runsc-less node fails at sandbox
 * create — the runtime handler comes from the RuntimeClass, never from a
 * node label. The pod is node-root regardless.
 */
export function buildGvisorInstallerClusterRoleManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: gvisorInstallerClusterScopedName(),
      labels: gvisorInstallerClusterScopedLabels(),
    },
    rules: [{ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'patch'] }],
  }
}

export function buildGvisorInstallerClusterRoleBindingManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: {
      name: gvisorInstallerClusterScopedName(),
      labels: gvisorInstallerClusterScopedLabels(),
    },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: gvisorInstallerClusterScopedName(),
    },
    subjects: [{
      kind: 'ServiceAccount',
      name: GVISOR_INSTALLER_APP_NAME,
      namespace: k8sNamespace(),
    }],
  }
}

export interface GvisorInstallerOptions {
  image: string
  /**
   * Where the runtime gets installed. Empty (the default) means every node,
   * which is what a single-node local cluster wants. A cluster with a
   * dedicated worktrees pool sets its pool label here and the runtime — plus
   * the containerd restart that installing it costs — never touches an
   * infra node; the RuntimeClasses follow automatically, since they select
   * on the label this DaemonSet stamps, not on the pool.
   */
  nodeSelector?: Record<string, string>
}

/**
 * The DaemonSet. Notable choices:
 *
 * - `privileged` + `hostPID`. It writes node binaries and containerd's
 *   config, and it restarts containerd by entering PID 1's mount namespace
 *   to run the node's own systemctl — there is no unprivileged spelling of
 *   "install a container runtime". This is the plan's accepted portability
 *   cost, and the reason a dedicated worktrees pool is worth having.
 * - runc, like every other yaac infra pod: it stamps no RuntimeClass, which
 *   it could not anyway — it is what makes the sandbox tier exist.
 * - `hostNetwork` with the NODE's DNS. The pod must work on a node whose
 *   CNI or CoreDNS is not up yet (a fresh node in a recycled pool installs
 *   before anything else lands on it), and it needs plain egress to the
 *   gVisor release bucket. The apiserver is still reachable for the label
 *   patch: kubelet injects its service IP into every pod, so no cluster DNS
 *   is involved.
 * - Blanket toleration, `system-node-critical`, like netd: this is node
 *   infrastructure, and a node the installer was evicted from is a node
 *   whose sandboxed pods stop being schedulable. It is also why a tainted
 *   worktrees pool costs this DaemonSet nothing — `Exists` already covers the
 *   pool taint; only the *workload's* toleration has to be declared, and
 *   that goes on the RuntimeClasses.
 * - `maxUnavailable: 1` on the rolling update. A version bump changes the
 *   template (the script carries the pin), and rolling it restarts
 *   containerd on each node it touches; doing that fleet-wide at once would
 *   disrupt every node's CRI simultaneously for no gain. It paces UPDATES
 *   only — the first apply on a multi-node cluster still starts every pod at
 *   once, which is a thing to revisit when a real pool exists.
 * - Readiness is the marker the script writes after a pass that left the
 *   runtime live — the same "ready means the datapath works, not the
 *   process started" rule netd follows, and what `ensureGvisorRuntime`'s
 *   rollout gate waits on before applying the RuntimeClasses.
 */
export function buildGvisorInstallerDaemonSetManifest(
  opts: GvisorInstallerOptions,
): Record<string, unknown> {
  const { volumes, volumeMounts } = gvisorInstallerHostMounts()
  const nodeSelector = opts.nodeSelector ?? {}
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: GVISOR_INSTALLER_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: GVISOR_INSTALLER_APP_NAME },
    },
    spec: {
      selector: { matchLabels: { app: GVISOR_INSTALLER_APP_NAME } },
      updateStrategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1 } },
      template: {
        metadata: { labels: { app: GVISOR_INSTALLER_APP_NAME } },
        spec: {
          hostNetwork: true,
          hostPID: true,
          // The node's resolver, not CoreDNS: the release download must not
          // depend on cluster DNS being up on a brand-new node.
          dnsPolicy: 'Default',
          ...(Object.keys(nodeSelector).length > 0 ? { nodeSelector } : {}),
          serviceAccountName: GVISOR_INSTALLER_APP_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          tolerations: [{ operator: 'Exists' }],
          priorityClassName: 'system-node-critical',
          containers: [
            {
              name: 'install',
              image: opts.image,
              imagePullPolicy: 'IfNotPresent',
              securityContext: { privileged: true, runAsUser: 0 },
              command: ['sh', '-c', gvisorInstallScript()],
              env: [
                { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
              ],
              readinessProbe: {
                exec: { command: ['test', '-f', GVISOR_INSTALLER_READY_FILE] },
                periodSeconds: 5,
                failureThreshold: 3,
              },
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  }
}

/**
 * The whole gVisor runtime setup for a cluster: the installer DaemonSet on
 * every (selected) node, then the RuntimeClasses.
 *
 * The two pool knobs are deliberately asymmetric, because they answer
 * different questions. `nodeSelector` bounds where the runtime is INSTALLED
 * (and where a containerd restart is spent), so it lands on the DaemonSet;
 * the DaemonSet needs no toleration plumbing at all, since it already
 * tolerates everything the way node infrastructure must. `tolerations`
 * bounds nothing — it is what lets sandboxed pods onto a tainted worktrees
 * pool — so it lands on the RuntimeClasses, whose admission merge is what
 * puts it on every pod that names them (see buildRuntimeClassManifests).
 *
 * Order matters and the rollout gate is not decoration. The RuntimeClasses
 * carry a nodeSelector on the label the installer stamps, so applying them
 * first on a cluster with no installed node would leave every sandboxed pod
 * Pending until the DaemonSet caught up. Waiting for the rollout means that
 * by the time the classes exist, the nodes they select do too.
 *
 * Idempotent, and the way an existing cluster picks up a runsc version bump:
 * `yaac cluster install` calls it on every run, the DaemonSet rolls
 * node by node, and each node's script restarts containerd only if the bump
 * actually changed something on it.
 */
export async function ensureGvisorRuntime(
  opts: { nodeSelector?: Record<string, string>; tolerations?: PodToleration[] } = {},
): Promise<void> {
  const image = await ensureGvisorInstallerImage()
  await kubectlApply(buildGvisorInstallerServiceAccountManifest())
  await kubectlApply(buildGvisorInstallerClusterRoleManifest())
  await kubectlApply(buildGvisorInstallerClusterRoleBindingManifest())
  await kubectlApply(buildGvisorInstallerDaemonSetManifest({
    image, nodeSelector: opts.nodeSelector,
  }))
  await kubectlWithRetry([
    'rollout', 'status', `daemonset/${GVISOR_INSTALLER_APP_NAME}`,
    '-n', k8sNamespace(), '--timeout=300s',
  ], { timeout: 310_000, maxAttempts: 2 })
  for (const manifest of buildRuntimeClassManifests({ tolerations: opts.tolerations })) {
    await kubectlApply(manifest)
  }
}

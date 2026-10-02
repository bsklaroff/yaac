import {
  GVISOR_INSTALLER_READY_FILE,
  buildRuntimeClassManifests,
  gvisorInstallScript,
  gvisorInstallerHostMounts,
  k8sNamespace,
  kubectlApply,
  LABEL_INSTALL_NAMESPACE,
  waitForRollout,
} from '#drivers/k8s/substrate'
import { invalidateRegistryEndpoint } from '#drivers/k8s/container'
import { prebuiltRef } from '#drivers/k8s/image-engine'

/**
 * `yaac-gvisor-install`: the privileged DaemonSet that installs the gVisor
 * runtime on nodes, plus the RuntimeClasses that use it.
 *
 * On each node it installs the pinned runsc and shim, registers the two
 * runsc handlers in containerd's config, restarts containerd, and labels
 * the node so the RuntimeClasses' `nodeSelector` lets sandboxed pods land
 * there. The script, node paths and label are defined in
 * `#drivers/k8s/substrate` (gvisor.ts); this module owns the Kubernetes
 * objects.
 *
 * As a DaemonSet it reaches nodes yaac has no shell on (managed pools) and
 * covers new or replaced nodes automatically. It also applies node tuning
 * (substrate/node-tuning.ts), so a restarted node gets its settings back.
 * Infra pods use no RuntimeClass and run on runc.
 */

/** DaemonSet / ServiceAccount name, and the `app` label on every object. */
export const GVISOR_INSTALLER_APP_NAME = 'yaac-gvisor-install'

/**
 * The installer's image: upstream `curl`, pinned by its multi-arch index
 * digest and mirrored into the local registry. It provides everything the
 * script needs (a shell, curl, sha512sum, nsenter) in ~5 MB, and does not
 * depend on any yaac-built image.
 */
const CURL_VERSION = '8.18.0'
const CURL_PIN = 'sha256:d94d07ba9e7d6de898b6d96c1a072f6f8266c687af78a74f380087a0addf5d17'
export const GVISOR_INSTALLER_UPSTREAM_IMAGE = `docker.io/curlimages/curl@${CURL_PIN}`
/** The mirror tag includes the pin, so re-pinning re-mirrors. */
export const GVISOR_INSTALLER_MIRROR_TAG =
  `curlimages/curl:${CURL_VERSION}-${CURL_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** The mirrored installer image's ref; throws if it was never mirrored. */
async function ensureGvisorInstallerImage(): Promise<string> {
  return prebuiltRef('gVisor installer', GVISOR_INSTALLER_MIRROR_TAG)
}

function buildGvisorInstallerServiceAccountManifest(): Record<string, unknown> {
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
 * ClusterRole/Binding names are cluster-wide, so they include the install
 * namespace; several installs (e.g. e2e runs) can share a cluster. The
 * label lets a sweep find an interrupted run's leftovers, since
 * cluster-scoped objects are not deleted with their namespace.
 */
function gvisorInstallerClusterScopedName(): string {
  return `${GVISOR_INSTALLER_APP_NAME}-${k8sNamespace()}`
}

function gvisorInstallerClusterScopedLabels(): Record<string, string> {
  return { app: GVISOR_INSTALLER_APP_NAME, [LABEL_INSTALL_NAMESPACE]: k8sNamespace() }
}

/**
 * Only enough RBAC to label nodes: get and patch nodes. Node patch must be
 * cluster-wide, so a compromised installer could mislabel nodes, but that
 * affects only scheduling: a pod sent to a node without runsc fails to
 * start rather than running unsandboxed.
 */
function buildGvisorInstallerClusterRoleManifest(): Record<string, unknown> {
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

function buildGvisorInstallerClusterRoleBindingManifest(): Record<string, unknown> {
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

/**
 * The installer DaemonSet:
 *
 * - `privileged` + `hostPID`: it writes node binaries and containerd's
 *   config, and restarts containerd via the node's systemctl.
 * - `hostNetwork` with the node's DNS, so it works before the CNI or
 *   CoreDNS is up on a new node.
 * - Tolerates every taint and runs `system-node-critical`, like netd.
 * - `maxUnavailable: 1`, so a version bump restarts containerd one node at
 *   a time. This paces updates only: the first apply on a multi-node
 *   cluster still restarts every node's containerd at once.
 * - Ready only once the script has made the runtime live, which the
 *   rollout wait in `ensureGvisorRuntime` depends on.
 */
function buildGvisorInstallerDaemonSetManifest(image: string): Record<string, unknown> {
  const { volumes, volumeMounts } = gvisorInstallerHostMounts()
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
          dnsPolicy: 'Default',
          serviceAccountName: GVISOR_INSTALLER_APP_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          tolerations: [{ operator: 'Exists' }],
          priorityClassName: 'system-node-critical',
          containers: [
            {
              name: 'install',
              image,
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
 * Set up gVisor on the cluster: the installer DaemonSet on every node, then
 * (after its rollout, so labeled nodes exist) the RuntimeClasses.
 *
 * `yaac cluster install` runs this every time; a runsc version bump rolls
 * node by node.
 */
export async function ensureGvisorRuntime(): Promise<void> {
  const image = await ensureGvisorInstallerImage()
  await kubectlApply(buildGvisorInstallerServiceAccountManifest())
  await kubectlApply(buildGvisorInstallerClusterRoleManifest())
  await kubectlApply(buildGvisorInstallerClusterRoleBindingManifest())
  await kubectlApply(buildGvisorInstallerDaemonSetManifest(image))
  await waitForRollout({
    workload: `daemonset/${GVISOR_INSTALLER_APP_NAME}`, namespace: k8sNamespace(), timeoutMs: 300_000,
  })
  // A containerd restart kills port-forwards into the node, including the
  // cached registry forward. Drop it, or `registryHasTag` would read the
  // dead forward as a missing image.
  invalidateRegistryEndpoint()
  for (const manifest of buildRuntimeClassManifests()) {
    await kubectlApply(manifest)
  }
}

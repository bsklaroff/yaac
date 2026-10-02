import {
  DNS_STUB_PORT,
  NETD_APP_NAME,
  NETD_LISTENER_PORT_BASE,
  NETD_LISTENER_SLOTS,
  NETD_SA_NAME,
  SSH_TUNNEL_SENTINEL,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_TUNNEL_PORT,
  TUNNEL_INGRESS_PORT,
  k8sNamespace,
  kubectlApply,
  kubectlWithRetry,
  LABEL_INSTALL_NAMESPACE,
} from '#drivers/k8s/substrate'
import {
  contextHash,
  missingPrebuiltImage,
} from '#drivers/k8s/image-engine'
import { registryHasTag, registryRef } from '#drivers/k8s/container'
import { NETD_DIR } from '@yaac/shared/project-paths'
import { env, testEnv } from '@yaac/shared/env'
import { clusterPodCidrs } from './cluster-cidrs'

/**
 * `yaac-netd`: the per-node DaemonSet that redirects workspace egress into
 * the proxy. Two host-network containers:
 *
 *  - **netd** maps each pod to its veth and programs a nat DNAT chain
 *    sending its 443/80/ssh-sentinel egress to a node-local Envoy listener,
 *    and writes Envoy's config files.
 *  - **envoy** (stock) recovers each connection's original destination and
 *    forwards it to the proxy with a PROXY-protocol-v2 header carrying the
 *    source pod IP.
 *
 * netd only redirects; all allow/deny is NetworkPolicy. So a broken netd
 * cuts workspace egress off rather than opening it.
 */

/**
 * Envoy, digest-pinned and mirrored into the local registry so nodes pull
 * it without upstream access. The pin must be the multi-arch index digest:
 * a single-platform digest crashloops on other architectures, which shows
 * only as netd never going ready. `ensureEnvoyImage` checks the mirrored
 * architecture.
 */
const ENVOY_VERSION = 'v1.34.0'
const ENVOY_PIN = 'sha256:45d37d848802f98a5647cb7522b4c1c42e0e0e775913d8e253ef3a5856bef986'
export const ENVOY_UPSTREAM_IMAGE = `docker.io/envoyproxy/envoy@${ENVOY_PIN}`
/** The mirror tag includes the pin, so re-pinning re-mirrors
 *  (`ensureEnvoyImage` skips tags already present). */
export const ENVOY_MIRROR_TAG =
  `envoyproxy/envoy:${ENVOY_VERSION}-${ENVOY_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/**
 * Calico's workload veth prefix, the default. Duplicated from
 * `k8s/netd/routes.ts`, which is a separate package the server cannot
 * import.
 */
export const DEFAULT_VETH_PREFIX = 'cali'

/**
 * The veth prefix netd matches: the configured value, else Calico's. `--byo`
 * checks it against a node's routing table, since a wrong value silently
 * cuts workspace egress.
 */
export function cniVethPrefix(): string {
  return env.cniVethPrefix ?? DEFAULT_VETH_PREFIX
}

/** Content-hash tag of the netd image (the k8s/netd build context). */
export async function resolveNetdImageTag(image = 'yaac-netd'): Promise<string> {
  return `${image}:${await contextHash(NETD_DIR)}`
}

/** The netd image's in-cluster ref. Lookup-only; `yaac cluster install`
 *  builds it. */
export async function ensureNetdImage(): Promise<string> {
  const localTag = await resolveNetdImageTag(testEnv.netdImage)
  if (await registryHasTag(localTag)) return registryRef(localTag)
  throw missingPrebuiltImage('netd', localTag)
}

/** The mirrored Envoy image's in-cluster ref. Lookup-only, like netd's. */
export async function ensureEnvoyImage(): Promise<string> {
  if (await registryHasTag(ENVOY_MIRROR_TAG)) return registryRef(ENVOY_MIRROR_TAG)
  throw missingPrebuiltImage('Envoy', ENVOY_MIRROR_TAG)
}

function buildNetdServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: NETD_SA_NAME, namespace: k8sNamespace(), labels: { app: NETD_APP_NAME } },
  }
}

/**
 * Read-only access to pods and Services in the install namespace: the
 * workspace pods netd redirects, and the proxy Service's ClusterIP it
 * redirects them to. `list`/`watch` cannot be limited by name, but that
 * namespace holds only yaac's objects. netd never writes to the API, so a
 * compromised netd cannot change cluster state.
 */
function buildNetdRoleManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: NETD_SA_NAME, namespace: k8sNamespace(), labels: { app: NETD_APP_NAME } },
    rules: [{
      apiGroups: [''],
      resources: ['pods', 'services'],
      verbs: ['get', 'list', 'watch'],
    }],
  }
}

function buildNetdRoleBindingManifest(): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: NETD_SA_NAME, namespace: k8sNamespace(), labels: { app: NETD_APP_NAME } },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: NETD_SA_NAME },
    subjects: [{ kind: 'ServiceAccount', name: NETD_SA_NAME, namespace: k8sNamespace() }],
  }
}

/**
 * Delete the cluster-wide pod read an older netd was granted, which would
 * otherwise outlive the namespaced Role that replaces it. A legacy-compat
 * shim: see docs/legacy-compat-shims.md.
 */
async function deleteLegacyNetdClusterRbac(): Promise<void> {
  await kubectlWithRetry([
    'delete', 'clusterrolebinding,clusterrole', '--ignore-not-found',
    '-l', `app=${NETD_APP_NAME},${LABEL_INSTALL_NAMESPACE}=${k8sNamespace()}`,
  ])
}

interface NetdDaemonSetOptions {
  netdImage: string
  envoyImage: string
  /** Cluster pod CIDRs — excluded from the redirect so pod-to-pod stays direct. */
  podCidrs: string[]
  /** The CNI's workload veth prefix (`cali` for Calico). */
  vethPrefix: string
}

/**
 * The DaemonSet:
 *
 * - netd gets `hostNetwork` with `NET_ADMIN`/`NET_RAW`, not `privileged`.
 * - Envoy gets no capabilities: it binds ports above 1024 and uses DNAT,
 *   not TPROXY, so a compromise yields no node privilege.
 * - Envoy waits for netd's bootstrap file, since its file-based config must
 *   exist at startup.
 * - Port numbers, the ssh sentinel and the listener range come from
 *   proxy-constants.ts, shared with the proxy and the network policies
 *   (which admit exactly that range).
 * - Only netd has a readiness probe; it goes ready only once Envoy is
 *   serving the current config.
 */
function buildNetdDaemonSetManifest(opts: NetdDaemonSetOptions): Record<string, unknown> {
  const envoyDir = '/etc/yaac-envoy'
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: NETD_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: NETD_APP_NAME },
    },
    spec: {
      selector: { matchLabels: { app: NETD_APP_NAME } },
      template: {
        metadata: { labels: { app: NETD_APP_NAME } },
        spec: {
          hostNetwork: true,
          dnsPolicy: 'ClusterFirstWithHostNet',
          serviceAccountName: NETD_SA_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          // Trusted infra, so runc. Tolerates everything: a node without
          // netd has no workspace egress.
          tolerations: [{ operator: 'Exists' }],
          priorityClassName: 'system-node-critical',
          containers: [
            {
              name: 'netd',
              image: opts.netdImage,
              imagePullPolicy: 'IfNotPresent',
              securityContext: {
                runAsUser: 0,
                capabilities: { add: ['NET_ADMIN', 'NET_RAW'] },
              },
              env: [
                { name: 'YAAC_NAMESPACE', value: k8sNamespace() },
                { name: 'CLUSTER_POD_CIDRS', value: opts.podCidrs.join(',') },
                { name: 'NETD_VETH_PREFIX', value: opts.vethPrefix },
                { name: 'NETD_LISTENER_PORT_BASE', value: String(NETD_LISTENER_PORT_BASE) },
                { name: 'NETD_LISTENER_SLOTS', value: String(NETD_LISTENER_SLOTS) },
                { name: 'TRANSPARENT_HTTPS_PORT', value: String(TRANSPARENT_HTTPS_PORT) },
                { name: 'TRANSPARENT_HTTP_PORT', value: String(TRANSPARENT_HTTP_PORT) },
                { name: 'TRANSPARENT_TUNNEL_PORT', value: String(TRANSPARENT_TUNNEL_PORT) },
                { name: 'TUNNEL_INGRESS_PORT', value: String(TUNNEL_INGRESS_PORT) },
                { name: 'SSH_TUNNEL_SENTINEL', value: SSH_TUNNEL_SENTINEL },
                { name: 'DNS_STUB_PORT', value: String(DNS_STUB_PORT) },
                { name: 'NETD_ENVOY_DIR', value: envoyDir },
                {
                  name: 'NODE_NAME',
                  valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } },
                },
                // The DNAT target: this node's Envoy.
                {
                  name: 'NODE_IP',
                  valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } },
                },
              ],
              // netd writes this marker only after a successful reconcile,
              // so Ready means the redirect is programmed.
              readinessProbe: {
                exec: { command: ['test', '-f', `${envoyDir}/.ready`] },
                periodSeconds: 5,
                failureThreshold: 3,
              },
              volumeMounts: [{ name: 'envoy-config', mountPath: envoyDir }],
            },
            {
              name: 'envoy',
              image: opts.envoyImage,
              imagePullPolicy: 'IfNotPresent',
              securityContext: {
                runAsUser: 0,
                capabilities: { drop: ['ALL'] },
              },
              command: ['sh', '-c',
                `while [ ! -f ${envoyDir}/bootstrap.yaml ]; do sleep 0.2; done; `
                + `exec envoy -c ${envoyDir}/bootstrap.yaml --log-level warn `
                // Several installs may run Envoy on one node; avoid
                // clashing on base-id 0.
                + '--use-dynamic-base-id',
              ],
              volumeMounts: [{ name: 'envoy-config', mountPath: envoyDir }],
            },
          ],
          volumes: [{ name: 'envoy-config', emptyDir: {} }],
        },
      },
    },
  }
}

/** Create or update netd. Called from `ensureProxyResources`, before any
 *  workspace pod is scheduled. */
export async function ensureNetd(): Promise<void> {
  const [netdImage, envoyImage, podCidrs] = await Promise.all([
    ensureNetdImage(),
    ensureEnvoyImage(),
    clusterPodCidrs(),
  ])
  await kubectlApply(buildNetdServiceAccountManifest())
  await kubectlApply(buildNetdRoleManifest())
  await kubectlApply(buildNetdRoleBindingManifest())
  await kubectlApply(buildNetdDaemonSetManifest({
    netdImage, envoyImage, podCidrs, vethPrefix: cniVethPrefix(),
  }))
  await kubectlWithRetry([
    'rollout', 'status', `daemonset/${NETD_APP_NAME}`,
    '-n', k8sNamespace(), '--timeout=180s',
  ], { timeout: 190_000, maxAttempts: 2 })
  // After the rollout, so the netd pods being replaced keep their watch.
  await deleteLegacyNetdClusterRbac()
}

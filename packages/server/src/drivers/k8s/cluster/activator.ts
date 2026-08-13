/**
 * The vcluster wake activator (docs/vcluster-scale-to-zero.md): a single
 * install-wide Deployment that fronts every ASLEEP vcluster's API
 * Service. `sleepVcluster` points an asleep vcluster's ClusterIP here
 * via a yaac-managed EndpointSlice; the activator (k8s/proxy/activator.ts,
 * shipped in the proxy sidecar image) terminates TLS under a serving
 * cert minted from the vcluster's own server CA, scales the control
 * plane back to 1 on first touch, parks the request until the apiserver
 * answers, deletes the slice, and 307s the client back to the same URL —
 * the re-dial routes to the real endpoint and re-authenticates natively.
 *
 * The activator holds a vcluster's server-CA key during a wake (enough
 * to impersonate that vcluster's API endpoint), so it is deliberately
 * narrow: trusted infra on runc in the install namespace, unreachable
 * from worktrees except on its one port, and granted RBAC only
 * per-vcluster (a Role in each vcluster's namespace, applied with the
 * vcluster and torn down with it — no standing cluster-wide grant).
 */

import {
  LABEL_WORKTREE_ID_LEGACY,
  LABEL_VCLUSTER_MANAGED_BY,
  LABEL_VCLUSTER_NAMESPACE,
  VCLUSTER_API_PORT,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#drivers/k8s/substrate'
import { registryRef } from '#drivers/k8s/container'
import { apiserverIpBlocks, nodeIpBlocks } from './cluster-cidrs'

export const ACTIVATOR_APP_NAME = 'yaac-vc-activator'

/** Name of the interception EndpointSlice while a vcluster is asleep.
 *  Must match sleepSliceName in k8s/proxy/activator.ts. */
export function vclusterSleepSliceName(vcName: string): string {
  return `yaac-sleep-${vcName}`
}

export function buildActivatorServiceAccountManifest(): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      name: ACTIVATOR_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: ACTIVATOR_APP_NAME },
    },
  }
}

/**
 * Per-vcluster grant for the activator SA, applied into the vcluster's
 * own namespace by `ensureWorktreeVcluster` and swept with it. The
 * narrowest RBAC that covers a wake: read the one certs Secret (serving
 * cert + front-proxy identity), scale/read the one control-plane
 * Deployment, find its pod IP, and delete the one interception slice.
 */
export function buildActivatorVclusterRoleManifest(
  vcName: string,
  vcNamespace: string,
  labels: Record<string, string>,
): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: ACTIVATOR_APP_NAME, namespace: vcNamespace, labels },
    rules: [
      {
        apiGroups: [''],
        resources: ['secrets'],
        verbs: ['get'],
        resourceNames: [`${vcName}-certs`],
      },
      {
        apiGroups: ['apps'],
        resources: ['deployments'],
        verbs: ['get'],
        resourceNames: [vcName],
      },
      {
        apiGroups: ['apps'],
        resources: ['deployments/scale'],
        verbs: ['get', 'patch', 'update'],
        resourceNames: [vcName],
      },
      // list cannot be resourceName-scoped; namespace-wide pod reads in
      // the vcluster's own namespace are the control-plane IP lookup.
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
      // Slice list (unscopable, as above): the wake's routing gate reads
      // the controller-managed slice's ready condition before answering.
      { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['list'] },
      {
        apiGroups: ['discovery.k8s.io'],
        resources: ['endpointslices'],
        verbs: ['get', 'delete'],
        resourceNames: [vclusterSleepSliceName(vcName)],
      },
    ],
  }
}

export function buildActivatorVclusterRoleBindingManifest(
  vcNamespace: string,
  labels: Record<string, string>,
): Record<string, unknown> {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: ACTIVATOR_APP_NAME, namespace: vcNamespace, labels },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: ACTIVATOR_APP_NAME },
    subjects: [{ kind: 'ServiceAccount', name: ACTIVATOR_APP_NAME, namespace: k8sNamespace() }],
  }
}

/**
 * The activator Deployment. Runs the proxy sidecar image (the activator
 * ships as another entrypoint in it — no second image pipeline) as
 * trusted yaac infra on runc: like the proxy and the vcluster control
 * plane, it only runs yaac-shipped code, so the sentry buys no
 * containment. No volumes and no hostPaths — the image's non-root
 * `node` user is fine as-is.
 */
export function buildActivatorDeploymentManifest(imageRef: string): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: ACTIVATOR_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: ACTIVATOR_APP_NAME },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: ACTIVATOR_APP_NAME } },
      template: {
        metadata: { labels: { app: ACTIVATOR_APP_NAME } },
        spec: {
          serviceAccountName: ACTIVATOR_APP_NAME,
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          containers: [
            {
              name: 'activator',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              command: ['./node_modules/.bin/tsx', 'activator-main.ts'],
              ports: [{ containerPort: VCLUSTER_API_PORT }],
              env: [
                { name: 'ACTIVATOR_PORT', value: String(VCLUSTER_API_PORT) },
                { name: 'YAAC_INSTALL_NAMESPACE', value: k8sNamespace() },
              ],
              readinessProbe: {
                tcpSocket: { port: VCLUSTER_API_PORT },
                periodSeconds: 2,
                failureThreshold: 30,
              },
            },
          ],
        },
      },
    },
  }
}

/**
 * The activator's containment NetworkPolicy, both directions.
 *
 * Ingress: its one port is reachable by worktree pods (whose intercepted
 * API dials arrive at the activator after kube-proxy's DNAT, so policy is
 * evaluated on the activator as the destination) and by the node (the
 * kubelet readiness probe). A vcluster's synced pods never dial it: while
 * asleep none exist, and their egress floor admits only the node's
 * redirect range and `managed-by` siblings.
 *
 * Egress: exactly the wake surface — the host apiserver (an `ipBlock`
 * over its real endpoint addresses, since NetworkPolicy matches the
 * post-DNAT destination and never the Service VIP) and vcluster
 * control-plane pods on 8443, matched cross-namespace by the chart labels
 * MINUS the syncer-stamped `managed-by` no tenant pod can shed (the
 * control-plane policy's unforgeable-exclusion trick), so a synced pod
 * forging `app=vcluster` can never receive proxied wake traffic. The
 * explicit allow is load-bearing at all because the install-wide
 * world-deny policy selects the activator and default-denies its egress.
 * No DNS: the activator dials literal IPs only.
 */
export function buildActivatorNetworkPolicyManifest(
  nodeCidrs: string[],
  apiserverCidrs: string[],
): Record<string, unknown> {
  const apiPort = { protocol: 'TCP', port: VCLUSTER_API_PORT }
  const blocks = (cidrs: string[]): Array<Record<string, unknown>> =>
    cidrs.map((cidr) => ({ ipBlock: { cidr } }))
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: ACTIVATOR_APP_NAME,
      namespace: k8sNamespace(),
      labels: { app: ACTIVATOR_APP_NAME },
    },
    spec: {
      podSelector: { matchLabels: { app: ACTIVATOR_APP_NAME } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        { from: blocks(nodeCidrs), ports: [apiPort] },
        {
          from: [{
            podSelector: { matchExpressions: [{ key: LABEL_WORKTREE_ID_LEGACY, operator: 'Exists' }] },
          }],
          ports: [apiPort],
        },
      ],
      egress: [
        { to: blocks(apiserverCidrs) },
        {
          to: [{
            namespaceSelector: { matchLabels: { [LABEL_VCLUSTER_NAMESPACE]: 'true' } },
            podSelector: {
              matchLabels: { app: 'vcluster' },
              matchExpressions: [
                { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'DoesNotExist' },
              ],
            },
          }],
          ports: [apiPort],
        },
      ],
    },
  }
}

/**
 * EndpointSlice that intercepts an asleep vcluster's API Service: the
 * `kubernetes.io/service-name` label attaches it to the Service, and a
 * foreign `managed-by` keeps the built-in endpointslice controller's
 * hands off it. Endpoint ports match Service ports BY NAME, so all
 * three named ports must be enumerated (a slice naming only `https`
 * would leave 8443 — the port that matters — unrouted), each targeting
 * the activator's single listener.
 */
export function buildVclusterSleepEndpointSliceManifest(
  vcName: string,
  vcNamespace: string,
  labels: Record<string, string>,
  activatorPodIp: string,
): Record<string, unknown> {
  return {
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: {
      name: vclusterSleepSliceName(vcName),
      namespace: vcNamespace,
      labels: {
        ...labels,
        'kubernetes.io/service-name': vcName,
        'endpointslice.kubernetes.io/managed-by': 'yaac.dev',
      },
    },
    addressType: 'IPv4',
    endpoints: [{ addresses: [activatorPodIp], conditions: { ready: true } }],
    ports: ['yaac-api', 'https', 'kubelet'].map((name) => ({
      name,
      port: VCLUSTER_API_PORT,
      protocol: 'TCP',
    })),
  }
}

interface RawPodList {
  items?: Array<{
    metadata?: { deletionTimestamp?: string }
    status?: { podIP?: string; phase?: string }
  }>
}

/**
 * The live activator pod's IP — the interception slice's target.
 * Throws when no running activator pod exists: sleeping a vcluster
 * without a live activator would strand it unreachable.
 */
export async function getActivatorPodIp(): Promise<string> {
  const list = await kubectlGetJson<RawPodList>([
    'get', 'pods', '-n', k8sNamespace(), '-l', `app=${ACTIVATOR_APP_NAME}`,
  ])
  for (const pod of list?.items ?? []) {
    if (pod.metadata?.deletionTimestamp) continue
    if (pod.status?.phase === 'Running' && pod.status.podIP) return pod.status.podIP
  }
  throw new Error('no running activator pod — is the activator deployment up?')
}

/**
 * Stand up (or converge) the activator. It runs the proxy sidecar image,
 * so the caller passes the tag: the worktree create flow ensures the proxy
 * before the vcluster, and by then it has already built and pushed exactly
 * that tag. Taking it as an argument is what keeps this feature below the
 * worktree feature rather than reaching up into it for the same answer.
 */
export async function ensureActivator(proxyImageTag: string): Promise<void> {
  const imageRef = registryRef(proxyImageTag)
  await kubectlApply(buildActivatorServiceAccountManifest())
  await kubectlApply(buildActivatorDeploymentManifest(imageRef))
  await kubectlApply(buildActivatorNetworkPolicyManifest(
    await nodeIpBlocks(), await apiserverIpBlocks(),
  ))
  await kubectlWithRetry([
    'rollout', 'status', `deployment/${ACTIVATOR_APP_NAME}`,
    '-n', k8sNamespace(),
    '--timeout=120s',
  ], { timeout: 130_000, maxAttempts: 2 })
}

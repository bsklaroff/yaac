/**
 * The deployment shape the install's package caches share (npm-cache.ts,
 * crates-cache.ts; docs/workspace-storage.md, "Package installs"). Each is
 * its own Deployment, so one failing never takes the other down, and each
 * admits workspace pods by its own label, since a NetworkPolicy gates by
 * port rather than by path.
 *
 * Deployed like the main registry: one replica, `Recreate`, an RWO claim, so
 * there is never more than one writer to the cache's files. nginx owns the
 * cache's one port. A cache fetches from its upstream directly, not through
 * the egress proxy, an accepted exception (docs/workspace-egress.md), so only
 * workspace pods labelled for it at launch can reach it, and it can reach
 * nothing in the cluster.
 */
import crypto from 'node:crypto'
import {
  CRATES_CACHE_APP_NAME,
  CRATES_CACHE_PORT,
  LABEL_CRATES_CACHE,
  LABEL_NPM_CACHE,
  LABEL_WORKSPACE_ID,
  NPM_CACHE_APP_NAME,
  NPM_CACHE_PORT,
  PRIORITY_CLASS_INFRA,
  installNameKey,
  k8sNamespace,
  applyObject,
  listObjects,
  waitForRollout,
} from '#drivers/k8s/substrate'
import { clusterPodCidrs, nodeIpBlocks } from './cluster-cidrs'
import { ensureNamespace } from './proxy-apply'

/** A cache's names: its Deployment, Service and `app` label; the port nginx
 *  serves; and the workspace-pod label that admits a pod to it. */
export interface PackageCache {
  app: string
  port: number
  label: string
}

export const NPM_CACHE: PackageCache = { app: NPM_CACHE_APP_NAME, port: NPM_CACHE_PORT, label: LABEL_NPM_CACHE }
export const CRATES_CACHE: PackageCache = {
  app: CRATES_CACHE_APP_NAME, port: CRATES_CACHE_PORT, label: LABEL_CRATES_CACHE,
}

/** Every cache's front, digest-pinned and mirrored like Envoy (netd.ts).
 *  The unprivileged variant runs as a non-root user (uid and gid 101). */
const NGINX_VERSION = '1.30.5'
const NGINX_PIN = 'sha256:ed04ec1ff34502c339ee5c3ae3f855442398edc1d05591e2b98981dcbbd20b1e'
export const NGINX_UPSTREAM_IMAGE = `docker.io/nginxinc/nginx-unprivileged@${NGINX_PIN}`
export const NGINX_MIRROR_TAG =
  `nginxinc/nginx-unprivileged:${NGINX_VERSION}-alpine-${NGINX_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** What a cache adds to the shared shape. */
export interface PackageCacheWorkload extends PackageCache {
  /** Mounted as volume `config`; hashed into the pod template, so an edit
   *  rolls the pod (its containers read it once). */
  config: Record<string, string>
  /** The group the claim (volume `storage`) is made writable by. */
  fsGroup: number
  /** The first is what `kubectl logs` shows by default. */
  containers: Array<Record<string, unknown>>
  /** Volumes beside `config`, `storage` and `nginx-conf`. */
  volumes?: Array<Record<string, unknown>>
}

/** Requested size (ignored by kind's local-path provisioner). Running out
 *  fails installs. */
const STORAGE_SIZE = '20Gi'

/** How long a fresh rollout may take, including the claim binding. */
const ROLLOUT_TIMEOUT_MS = 180_000

/** The claim, keyed by install like every registry store. */
export function cacheClaimName(cache: PackageCache): string {
  return `${cache.app}-storage-${installNameKey()}`
}

/** The URL workspaces reach the cache at: the Service's `.svc.cluster.local`
 *  name (resolved via the proxy's DNS), with a trailing slash. */
export function cacheUrl(cache: PackageCache): string {
  return `http://${cache.app}.${k8sNamespace()}.svc.cluster.local:${cache.port}/`
}

/**
 * The nginx container that owns the cache's port, serving the ConfigMap's
 * `*.template` files. The image's entrypoint renders them into conf.d with
 * the pod's DNS server and substitutes nothing else, so a config resolves
 * its upstream per request (`resolver ${NGINX_LOCAL_RESOLVERS}`) and nginx
 * still starts when DNS is down. `cacheMount` is where its proxy cache lives.
 */
export function cacheNginxContainer(
  image: string,
  cache: PackageCache,
  probePath: string,
  cacheMount: { name: string; mountPath: string },
): Record<string, unknown> {
  return {
    name: 'nginx',
    image,
    imagePullPolicy: 'IfNotPresent',
    ports: [{ containerPort: cache.port }],
    env: [
      { name: 'NGINX_ENTRYPOINT_LOCAL_RESOLVERS', value: '1' },
      { name: 'NGINX_ENVSUBST_FILTER', value: '^NGINX_LOCAL_RESOLVERS$' },
    ],
    readinessProbe: {
      httpGet: { path: probePath, port: cache.port },
      periodSeconds: 2,
      timeoutSeconds: 5,
      failureThreshold: 30,
    },
    resources: {
      requests: { cpu: '100m', memory: String(32 * 1024 ** 2) },
      limits: { memory: String(256 * 1024 ** 2) },
    },
    volumeMounts: [
      { name: 'config', mountPath: '/etc/nginx/templates', readOnly: true },
      // Empty, so the image's default server is not loaded.
      { name: 'nginx-conf', mountPath: '/etc/nginx/conf.d' },
      cacheMount,
    ],
  }
}

function metadata(cache: PackageCache, name: string): Record<string, unknown> {
  return { name, namespace: k8sNamespace(), labels: { app: cache.app } }
}

/** The workspace pods the cache serves. */
function admitted(cache: PackageCache): Record<string, unknown> {
  return {
    matchLabels: { [cache.label]: 'true' },
    matchExpressions: [{ key: LABEL_WORKSPACE_ID, operator: 'Exists' }],
  }
}

/**
 * The cache's objects, in apply order; the Service is separate and applied
 * last (see `ensurePackageCache`). Its policies:
 *  - Workspace egress to the cache port, for pods with the cache's label.
 *  - Ingress from those pods and from the node (kubelet probe).
 *  - Egress to 443 off-cluster (the upstream) and DNS. Pod and node addresses
 *    are excluded, so a compromised cache cannot reach in-cluster services.
 *    netd does not redirect it (not a workspace pod).
 */
function buildManifests(
  w: PackageCacheWorkload,
  cidrs: { nodes: string[]; pods: string[] },
): { workload: Array<Record<string, unknown>>; service: Record<string, unknown> } {
  const configMap = `${w.app}-config`
  const workload = [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata(w, configMap), data: w.config },
    {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: metadata(w, cacheClaimName(w)),
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: STORAGE_SIZE } } },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: metadata(w, w.app),
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app: w.app } },
        template: {
          metadata: {
            labels: { app: w.app },
            annotations: {
              'yaac.config-hash': crypto.createHash('sha256')
                .update(JSON.stringify(w.config)).digest('hex').slice(0, 16),
            },
          },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            // Trusted infra on runc, like the registries.
            priorityClassName: PRIORITY_CLASS_INFRA,
            // Make a root-owned block volume writable by the image's group.
            securityContext: { fsGroup: w.fsGroup },
            // With the default `ndots:5`, the upstream name would first be
            // tried against each search domain, and the node's can hang on a
            // host resolver (e.g. a VPN). The cache needs no short names.
            dnsConfig: { options: [{ name: 'ndots', value: '1' }] },
            containers: w.containers,
            volumes: [
              { name: 'config', configMap: { name: configMap } },
              { name: 'storage', persistentVolumeClaim: { claimName: cacheClaimName(w) } },
              { name: 'nginx-conf', emptyDir: {} },
              ...(w.volumes ?? []),
            ],
          },
        },
      },
    },
    ...buildNodePolicyManifests(w, cidrs),
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(w, `${w.app}-workspace-egress`),
      spec: {
        podSelector: admitted(w),
        policyTypes: ['Egress'],
        egress: [{ to: [{ podSelector: { matchLabels: { app: w.app } } }], ports: [{ protocol: 'TCP', port: w.port }] }],
      },
    },
  ]
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: metadata(w, w.app),
    spec: {
      type: 'ClusterIP',
      selector: { app: w.app },
      ports: [{ name: 'http', port: w.port, targetPort: w.port, protocol: 'TCP' }],
    },
  }
  return { workload, service }
}

/**
 * The cache's two policies that name node addresses: its ingress admits the
 * node (kubelet probes), and its egress to the world excludes nodes and pods.
 */
function buildNodePolicyManifests(
  cache: PackageCache,
  cidrs: { nodes: string[]; pods: string[] },
): Array<Record<string, unknown>> {
  const port = { protocol: 'TCP', port: cache.port }
  return [
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(cache, `${cache.app}-ingress`),
      spec: {
        podSelector: { matchLabels: { app: cache.app } },
        policyTypes: ['Ingress'],
        ingress: [
          { from: [{ podSelector: admitted(cache) }], ports: [port] },
          { from: cidrs.nodes.map((cidr) => ({ ipBlock: { cidr } })), ports: [port] },
        ],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(cache, `${cache.app}-egress`),
      spec: {
        podSelector: { matchLabels: { app: cache.app } },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ ipBlock: { cidr: '0.0.0.0/0', except: [...cidrs.pods, ...cidrs.nodes] } }],
            ports: [{ protocol: 'TCP', port: 443 }],
          },
          { ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        ],
      },
    },
  ]
}

/** Re-render a cache's node-address policies, for `reconcileNodeSet`. */
export async function syncCacheNodes(cache: PackageCache, nodeCidrs: string[]): Promise<void> {
  for (const manifest of buildNodePolicyManifests(cache, { nodes: nodeCidrs, pods: await clusterPodCidrs() })) {
    await applyObject(manifest)
  }
}

/**
 * Create or update a cache and wait for it to serve (run by `yaac cluster
 * install`). The Service is applied only after rollout, so a cache that
 * never came up has no Service.
 */
export async function ensurePackageCache(w: PackageCacheWorkload): Promise<void> {
  await ensureNamespace()
  const { workload, service } = buildManifests(w, { nodes: await nodeIpBlocks(), pods: await clusterPodCidrs() })
  for (const manifest of workload) await applyObject(manifest)
  await waitForRollout({
    workload: `deployment/${w.app}`,
    namespace: k8sNamespace(),
    timeoutMs: ROLLOUT_TIMEOUT_MS,
    hint: `Inspect with \`kubectl -n ${k8sNamespace()} get pods,pvc -l app=${w.app}\` — `
      + 'a Pending PVC means the cluster has no default StorageClass to bind it.',
  })
  await applyObject(service)
}

/**
 * The cache's URL (`cacheUrl`), or null if it is not serving now (absent, or
 * no ready pod). Checked per create, never cached: neither pnpm nor cargo
 * falls back from a configured registry, so pointing at a down cache fails
 * every install, while the upstream is merely slower.
 */
export async function servingCacheUrl(cache: PackageCache): Promise<string | null> {
  const slices = await listObjects<{ endpoints?: Array<{ conditions?: { ready?: boolean } }> }>(
    'discovery.k8s.io/v1', 'EndpointSlice',
    { namespace: k8sNamespace(), labelSelector: `kubernetes.io/service-name=${cache.app}` },
  )
  const ready = slices
    .some((slice) => (slice.endpoints ?? []).some((e) => e.conditions?.ready === true))
  return ready ? cacheUrl(cache) : null
}

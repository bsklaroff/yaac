/**
 * The install's npm cache: one Verdaccio that workspace pods install through
 * (docs/workspace-storage.md, "Package installs"). Each workspace has its own
 * pnpm store, so installs are usually cold; this fetches each package from
 * npmjs once per cluster and keeps working when npmjs is slow or down.
 *
 * Deployed like the main registry: one replica, `Recreate`, an RWO claim,
 * so there is never more than one writer to Verdaccio's plain-file storage.
 *
 * Workspaces cannot publish (the cache is shared across projects), and pnpm
 * verifies every tarball against the lockfile. It is only the default
 * registry: a project's own `.npmrc` wins, and those requests go through the
 * egress proxy. The cache sends no credentials upstream.
 *
 * It fetches directly, not through the proxy, an accepted exception
 * (docs/workspace-egress.md). Only pods labelled `LABEL_NPM_CACHE` at launch
 * (npmCache on, npmjs allowed, no proxied npmjs secret) can reach it.
 *
 * Nothing prunes the cache yet.
 */
import crypto from 'node:crypto'
import {
  LABEL_NPM_CACHE,
  NPM_CACHE_APP_NAME,
  NPM_CACHE_PORT,
  LABEL_WORKSPACE_ID,
  PRIORITY_CLASS_INFRA,
  dataDirHash,
  k8sNamespace,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#drivers/k8s/substrate'
import { missingPrebuiltImage } from '#drivers/k8s/image-engine'
import { registryHasTag, registryRef } from '#drivers/k8s/container'
import { clusterPodCidrs, nodeIpBlocks } from './cluster-cidrs'
import { ensureNamespace } from './proxy-apply'

/** Digest-pinned (multi-arch index) and mirrored like Envoy (netd.ts). */
const VERDACCIO_VERSION = '6.10.4'
const VERDACCIO_PIN = 'sha256:43c4067288b050422265407ea2fe747e511fcd0c407a85ec90ab9a326d9400cd'
export const VERDACCIO_UPSTREAM_IMAGE = `docker.io/verdaccio/verdaccio@${VERDACCIO_PIN}`
export const VERDACCIO_MIRROR_TAG =
  `verdaccio/verdaccio:${VERDACCIO_VERSION}-${VERDACCIO_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** The group the image's `verdaccio` user runs as (uid 10001, `nogroup`). */
const VERDACCIO_GID = 65533

const CONFIG_MAP_NAME = `${NPM_CACHE_APP_NAME}-config`

function npmCacheLabels(): Record<string, string> {
  return { app: NPM_CACHE_APP_NAME }
}

/** The cache's claim, keyed by install like every registry store. */
function npmCachePvcName(): string {
  return `${NPM_CACHE_APP_NAME}-storage-${dataDirHash()}`
}

/** Requested size (ignored by kind's local-path provisioner). Running out
 *  fails installs. */
const NPM_CACHE_STORAGE_SIZE = '20Gi'

/** The registry URL for workspaces: the Service's `.svc.cluster.local`
 *  name (resolved via the proxy's DNS), with npm's trailing slash. */
function npmCacheRegistryUrl(): string {
  return `http://${NPM_CACHE_APP_NAME}.${k8sNamespace()}.svc.cluster.local:${NPM_CACHE_PORT}/`
}

/** Verdaccio's config. `max_users: -1` disables registration, so nobody
 *  can authenticate. No web UI. */
function buildNpmCacheConfigYaml(): string {
  const pkg = [
    '    access: $all',
    '    publish: $nobody',
    '    unpublish: $nobody',
    '    proxy: npmjs',
  ]
  return [
    'storage: /verdaccio/storage/data',
    'auth:',
    '  htpasswd:',
    '    file: /verdaccio/storage/htpasswd',
    '    max_users: -1',
    'uplinks:',
    '  npmjs:',
    '    url: https://registry.npmjs.org/',
    'packages:',
    "  '@*/*':",
    ...pkg,
    "  '**':",
    ...pkg,
    'web:',
    '  enable: false',
    'server:',
    '  keepAliveTimeout: 60',
    'middlewares:',
    '  audit:',
    '    enabled: true',
    // Logs each request, showing installs came through here.
    'log:',
    '  type: stdout',
    '  format: pretty',
    '  level: http',
    '',
  ].join('\n')
}

/**
 * The cache's objects, in apply order; the Service is separate and applied
 * last (see `ensureNpmCache`). Its policies:
 *  - Workspace egress to the cache port, for pods with `LABEL_NPM_CACHE`.
 *  - Ingress from those pods and from the node (kubelet probe).
 *  - Egress to 443 off-cluster (the uplink) and DNS. Pod and node addresses
 *    are excluded, so a compromised cache cannot reach in-cluster services.
 *    netd does not redirect it (not a workspace pod).
 */
function buildNpmCacheManifests(
  imageRef: string,
  cidrs: { nodes: string[]; pods: string[] },
): { workload: Array<Record<string, unknown>>; service: Record<string, unknown> } {
  const ns = k8sNamespace()
  const metadata = (name: string): Record<string, unknown> =>
    ({ name, namespace: ns, labels: npmCacheLabels() })
  const port = { protocol: 'TCP', port: NPM_CACHE_PORT }
  const admitted = {
    matchLabels: { [LABEL_NPM_CACHE]: 'true' },
    matchExpressions: [{ key: LABEL_WORKSPACE_ID, operator: 'Exists' }],
  }
  const workload = [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: metadata(CONFIG_MAP_NAME),
      data: { 'config.yaml': buildNpmCacheConfigYaml() },
    },
    {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: metadata(npmCachePvcName()),
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: NPM_CACHE_STORAGE_SIZE } },
      },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: metadata(NPM_CACHE_APP_NAME),
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: npmCacheLabels() },
        template: {
          metadata: {
            labels: npmCacheLabels(),
            // A config edit must roll the pod: Verdaccio reads it once.
            annotations: {
              'yaac.config-hash': crypto.createHash('sha256')
                .update(buildNpmCacheConfigYaml()).digest('hex').slice(0, 16),
            },
          },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            // Trusted infra on runc, like the registries.
            priorityClassName: PRIORITY_CLASS_INFRA,
            // Make a root-owned block volume writable by the image's group.
            securityContext: { fsGroup: VERDACCIO_GID },
            // With the default `ndots:5`, the uplink name would first be
            // tried against each search domain, and the node's can hang on a
            // host resolver (e.g. a VPN). The cache needs no short names.
            dnsConfig: { options: [{ name: 'ndots', value: '1' }] },
            containers: [{
              name: 'verdaccio',
              image: imageRef,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ containerPort: NPM_CACHE_PORT }],
              readinessProbe: {
                httpGet: { path: '/-/ping', port: NPM_CACHE_PORT },
                periodSeconds: 2,
                failureThreshold: 30,
              },
              resources: {
                requests: { cpu: '50m', memory: String(256 * 1024 ** 2) },
                limits: { memory: String(2 * 1024 ** 3) },
              },
              volumeMounts: [
                { name: 'config', mountPath: '/verdaccio/conf', readOnly: true },
                { name: 'storage', mountPath: '/verdaccio/storage' },
              ],
            }],
            volumes: [
              { name: 'config', configMap: { name: CONFIG_MAP_NAME } },
              { name: 'storage', persistentVolumeClaim: { claimName: npmCachePvcName() } },
            ],
          },
        },
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(`${NPM_CACHE_APP_NAME}-ingress`),
      spec: {
        podSelector: { matchLabels: npmCacheLabels() },
        policyTypes: ['Ingress'],
        ingress: [
          { from: [{ podSelector: admitted }], ports: [port] },
          { from: cidrs.nodes.map((cidr) => ({ ipBlock: { cidr } })), ports: [port] },
        ],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(`${NPM_CACHE_APP_NAME}-egress`),
      spec: {
        podSelector: { matchLabels: npmCacheLabels() },
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
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(`${NPM_CACHE_APP_NAME}-workspace-egress`),
      spec: {
        podSelector: admitted,
        policyTypes: ['Egress'],
        egress: [{ to: [{ podSelector: { matchLabels: npmCacheLabels() } }], ports: [port] }],
      },
    },
  ]
  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: metadata(NPM_CACHE_APP_NAME),
    spec: {
      type: 'ClusterIP',
      selector: npmCacheLabels(),
      ports: [{ name: 'npm', port: NPM_CACHE_PORT, targetPort: NPM_CACHE_PORT, protocol: 'TCP' }],
    },
  }
  return { workload, service }
}

/** How long a fresh rollout may take, including the claim binding. */
const ROLLOUT_TIMEOUT_MS = 180_000

/**
 * Create or update the cache and wait for it to serve (run by `yaac cluster
 * install`). The Service is applied only after rollout, so a cache that
 * never came up has no Service.
 */
export async function ensureNpmCache(): Promise<void> {
  if (!await registryHasTag(VERDACCIO_MIRROR_TAG)) {
    throw missingPrebuiltImage('Verdaccio', VERDACCIO_MIRROR_TAG)
  }
  await ensureNamespace()
  const { workload, service } = buildNpmCacheManifests(
    registryRef(VERDACCIO_MIRROR_TAG),
    { nodes: await nodeIpBlocks(), pods: await clusterPodCidrs() },
  )
  for (const manifest of workload) await kubectlApply(manifest)
  try {
    await kubectlWithRetry([
      'rollout', 'status', `deployment/${NPM_CACHE_APP_NAME}`, '-n', k8sNamespace(),
      `--timeout=${Math.floor(ROLLOUT_TIMEOUT_MS / 1000)}s`,
    ], { timeout: ROLLOUT_TIMEOUT_MS + 10_000, maxAttempts: 2 })
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n`
      + `Inspect with \`kubectl -n ${k8sNamespace()} get pods,pvc -l app=${NPM_CACHE_APP_NAME}\` — `
      + 'a Pending PVC means the cluster has no default StorageClass to bind it.',
    )
  }
  await kubectlApply(service)
}

/**
 * The cache URL, or null if it is not serving now (absent, or no ready pod).
 * Checked per create, never cached: pnpm has no fallback, so pointing at a
 * down cache fails every install, while npmjs is merely slower.
 */
export async function servingNpmCacheUrl(): Promise<string | null> {
  const slices = await kubectlGetJson<{
    items?: Array<{ endpoints?: Array<{ conditions?: { ready?: boolean } }> }>
  }>([
    'get', 'endpointslices', '-n', k8sNamespace(),
    '-l', `kubernetes.io/service-name=${NPM_CACHE_APP_NAME}`,
  ])
  const ready = (slices?.items ?? [])
    .some((slice) => (slice.endpoints ?? []).some((e) => e.conditions?.ready === true))
  return ready ? npmCacheRegistryUrl() : null
}

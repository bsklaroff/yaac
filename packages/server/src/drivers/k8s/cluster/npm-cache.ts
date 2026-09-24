/**
 * The install's npm registry cache: one Verdaccio every worktree pod of the
 * install installs through (docs/worktree-storage.md "Package installs").
 *
 * Each worktree keeps its own pnpm store, on its own pod-local volume, so a
 * cold store is the normal case and every install is a full fetch. This is
 * where those fetches land instead of the internet: a package comes from
 * npmjs once per cluster, and installs keep working while npmjs is slow,
 * rate-limiting, or down.
 *
 * Built the way the main registry is (main-registry.ts), and for the same
 * reasons: a Recreate Deployment of one replica over an RWO claim that names
 * no storage class. Verdaccio's storage is plain files, safe for one process
 * and not for several, so "never two writers" is the invariant — Recreate
 * takes the old pod away before the new one mounts the claim, and RWO holds
 * the claim to one node. The cache belongs to the claim rather than to a
 * node: a pod rescheduled elsewhere reattaches it warm, and a lost claim
 * costs a cold cache and nothing else.
 *
 * Read-only to worktrees: `publish` and `unpublish` are `$nobody` for every
 * package, because every project's worktrees share this one cache and a
 * worktree that could publish could poison what the others install. What
 * they pull is still bounded by their lockfiles — pnpm checks every tarball
 * against the lockfile's integrity hash, whoever served it.
 *
 * The public registry is the only uplink, and the cache is only ever the
 * DEFAULT: a worktree gets it at user-config precedence, below its
 * project's own `.npmrc`, so a project naming a registry of its own — for
 * everything or for a scope — keeps it, and those requests go out through
 * the egress proxy with their credentials. The cache sends none upstream,
 * so it only ever holds what npmjs serves anonymously.
 *
 * It fetches directly, not through the egress proxy, so what it serves is
 * outside the per-worktree allowlist — an accepted exception, bounded to
 * npm content coming IN (docs/worktree-egress.md). Which worktrees may use
 * it at all is per project: only a pod the server labelled
 * `LABEL_NPM_CACHE` at launch (launch.ts) can dial it — the project's
 * `npmCache` setting is on, its allowlist admits npmjs, and it has no
 * proxied npmjs secret — and only such a pod is pointed at it.
 *
 * Nothing prunes the cache: it keeps every tarball it ever fetched, and any
 * worktree can grow it by asking for public packages. Accepted for now —
 * on kind the claim is node disk with no quota (docs/worktree-storage.md).
 */
import crypto from 'node:crypto'
import {
  LABEL_NPM_CACHE,
  NPM_CACHE_APP_NAME,
  NPM_CACHE_PORT,
  LABEL_WORKTREE_ID,
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

/**
 * Digest-pinned upstream, mirrored into the main registry like Envoy
 * (netd.ts): the pin is the multi-arch INDEX digest, and the mirror tag
 * carries it so a re-pin re-mirrors.
 */
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

/**
 * Requested capacity — a request, as for the main registry: kind's
 * local-path provisioner ignores it. Running out fails installs, so it is
 * sized for many projects' dependency trees, every version they have
 * locked.
 */
const NPM_CACHE_STORAGE_SIZE = '20Gi'

/**
 * The registry URL a worktree's pnpm is pointed at: the Service by its
 * `.svc.cluster.local` name, which the proxy's split-horizon DNS forwards
 * to CoreDNS. Trailing slash, as npm config spells a registry.
 */
function npmCacheRegistryUrl(): string {
  return `http://${NPM_CACHE_APP_NAME}.${k8sNamespace()}.svc.cluster.local:${NPM_CACHE_PORT}/`
}

/**
 * Verdaccio's config. Storage and the htpasswd file live on the claim;
 * `max_users: -1` turns registration off, so nothing can authenticate and
 * `$nobody` is really nobody. The web UI is off — nothing browses this.
 */
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
    // `http` logs every request with its status, which is what shows an
    // install came through here.
    'log:',
    '  type: stdout',
    '  format: pretty',
    '  level: http',
    '',
  ].join('\n')
}

/**
 * Every object of the cache: the workload in apply order (config and claim
 * before the Deployment that mounts them, then its three policies), and apart
 * from it the Service, which goes on last — see `ensureNpmCache`.
 *
 * The policies are the wall around a pod worktrees can reach:
 *  - The WORKTREE side: egress to the cache port for worktree pods carrying
 *    `LABEL_NPM_CACHE`, which the install-wide worktree egress policy does
 *    not grant — it cannot tell one project from another, and a label can.
 *  - INGRESS admits the same labelled worktree pods of this namespace on
 *    the cache port, and the node addresses for the kubelet's readiness
 *    probe. Nothing else in the install has a reason to dial it.
 *  - EGRESS admits 443 off-cluster (the uplink) and DNS. Off-cluster
 *    because the cache parses every worktree's requests: compromised, it
 *    must not reach the cluster's own 443 listeners, so the pod and node
 *    addresses are carved out (a Service address is DNAT'd to a pod one
 *    before policy applies). The namespace's world-deny selects this pod
 *    like any other non-proxy pod; NetworkPolicy unions allow rules, so
 *    this is the whole of what it may reach. netd never redirects it — it
 *    is not a worktree pod — so its fetches go straight out, not through
 *    the egress proxy.
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
    matchExpressions: [{ key: LABEL_WORKTREE_ID, operator: 'Exists' }],
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
            // Infra tier, and trusted infra on runc like the registries:
            // every worktree's install goes through it.
            priorityClassName: PRIORITY_CLASS_INFRA,
            // A block-storage claim arrives root-owned; fsGroup hands it to
            // the image's group. (kind's local-path volume is 0777 anyway.)
            securityContext: { fsGroup: VERDACCIO_GID },
            // The uplink's name has two dots, under the default `ndots:5`,
            // so every fetch would first try it against each search domain
            // — and the list ends with the node's own, which CoreDNS
            // forwards to a host resolver that can hang (a VPN owning the
            // host's DNS). `ndots:1` tries a dotted name as-is first; the
            // cache resolves no short cluster names. (A trailing dot in
            // the uplink URL would do the same, but ends up in its TLS
            // Host/SNI.)
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
      metadata: metadata(`${NPM_CACHE_APP_NAME}-worktree-egress`),
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
 * Idempotently stand the cache up in the install namespace and wait for it
 * to serve. `yaac cluster install` runs it; the image is lookup-only, since
 * the same install's image step is what mirrors it.
 *
 * The Service goes on only once the Deployment has rolled out, so a first
 * install whose cache never came up has none at all.
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
 * The registry URL a worktree should install through, or null when the
 * cache is not serving right now: absent (an install converged before it
 * existed), or with no ready pod behind its Service (a rollout, a crash, a
 * claim that cannot attach). Read per create and never cached, because the
 * two mistakes are not symmetric: pnpm has no fallback registry, so a
 * worktree pointed at a cache that is down fails every install, while one
 * left on npmjs only goes slower. A worktree already pointed here when the
 * cache goes down does fail its installs until it is back.
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

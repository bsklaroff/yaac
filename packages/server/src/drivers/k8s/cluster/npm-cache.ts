/**
 * The install's npm cache: one Verdaccio that workspace pods install through
 * (docs/workspace-storage.md, "Package installs"). Each workspace has its own
 * pnpm store, so installs are usually cold; this fetches each package from
 * npmjs once per cluster and keeps working when npmjs is slow or down.
 *
 * Deployed like the main registry: one replica, `Recreate`, an RWO claim,
 * so there is never more than one writer to Verdaccio's plain-file storage.
 *
 * An nginx sidecar owns the cache port and caches Verdaccio's metadata
 * answers on pod-local disk. Verdaccio is one Node event loop that reads and
 * parses a package's whole metadata document on every request, and some
 * documents run to tens of MB, so many workspaces installing at once can
 * starve it. nginx collapses concurrent identical requests into one, serves
 * repeats from disk, and keeps serving a stale copy while it refreshes.
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
  waitForRollout,
} from '#drivers/k8s/substrate'
import { prebuiltRef } from '#drivers/k8s/image-engine'
import { clusterPodCidrs, nodeIpBlocks } from './cluster-cidrs'
import { ensureNamespace } from './proxy-apply'

/** Digest-pinned (multi-arch index) and mirrored like Envoy (netd.ts). */
const VERDACCIO_VERSION = '6.10.4'
const VERDACCIO_PIN = 'sha256:43c4067288b050422265407ea2fe747e511fcd0c407a85ec90ab9a326d9400cd'
export const VERDACCIO_UPSTREAM_IMAGE = `docker.io/verdaccio/verdaccio@${VERDACCIO_PIN}`
export const VERDACCIO_MIRROR_TAG =
  `verdaccio/verdaccio:${VERDACCIO_VERSION}-${VERDACCIO_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** The caching front. The unprivileged variant runs as a non-root user. */
const NGINX_VERSION = '1.30.5'
const NGINX_PIN = 'sha256:ed04ec1ff34502c339ee5c3ae3f855442398edc1d05591e2b98981dcbbd20b1e'
export const NGINX_UPSTREAM_IMAGE = `docker.io/nginxinc/nginx-unprivileged@${NGINX_PIN}`
export const NGINX_MIRROR_TAG =
  `nginxinc/nginx-unprivileged:${NGINX_VERSION}-alpine-${NGINX_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** Where Verdaccio listens: loopback only, so nothing bypasses nginx. */
const VERDACCIO_PORT = 4874

/** Verdaccio's memory limit. The V8 heap is capped at three quarters of it,
 *  so V8 collects harder before the cgroup limit and leaves room for the
 *  off-heap Buffers holding response bodies. Hitting either limit still
 *  restarts Verdaccio. */
const VERDACCIO_MEMORY_MIB = 4096

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

/**
 * nginx's server block, included inside the image's `http {}`. Package
 * metadata is cached. Tarballs are passed through: Verdaccio streams them
 * from its claim without parsing, so a second copy here would cost disk for
 * little CPU. Its `/-/` API (ping, search, audit) is passed through too, so
 * the readiness probe reaches Verdaccio itself.
 *
 * The key includes Accept because npm and pnpm ask for the abbreviated
 * document at the same URL as the full one. Metadata is kept five minutes,
 * as npmjs's own CDN does, so new versions appear but no install outlasts
 * it. Upstream gzip is cached as is and inflated only for a client that
 * cannot take it.
 *
 * Pass-through responses stream through memory buffers rather than spool to
 * the container's disk (`proxy_max_temp_file_size 0`; cached ones are not
 * subject to it). Past `max_size`, or when the node's disk has under
 * `min_free` left, nginx evicts least-recently-used entries. A cache write that hits a full disk
 * sends the client a truncated body, so the cache sheds itself well before
 * that.
 *
 * Verdaccio answers 404 for npm's signing keys and attestations, so nginx
 * fetches those two from npmjs itself. Without the keys, `pnpm audit
 * signatures` finds no keys for this registry, checks nothing, and still
 * reports success. The certificate is verified, since keys from anyone else
 * would make that audit vouch for their packages. Only GET and HEAD go out,
 * and no client's `Authorization` or `Cookie` header does (Verdaccio has no
 * users, so it needs neither). The host is resolved per
 * request through the pod's DNS server, which the image's entrypoint
 * substitutes into this template, so nginx still starts when DNS is down.
 * IPv6 is off because the egress policy allows IPv4 only.
 */
function buildNpmCacheNginxConf(): string {
  return `proxy_cache_path /var/cache/npm levels=1:2 keys_zone=npm:10m max_size=1g min_free=2g inactive=1d use_temp_path=off;
log_format npm_cache '$remote_addr "$request" $status $body_bytes_sent $upstream_cache_status $request_time';
resolver \${NGINX_LOCAL_RESOLVERS} ipv6=off valid=60s;
upstream verdaccio {
  server 127.0.0.1:${VERDACCIO_PORT};
  keepalive 16;
}
server {
  listen ${NPM_CACHE_PORT};
  access_log /dev/stdout npm_cache;
  client_max_body_size 0;
  proxy_max_temp_file_size 0;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_set_header Accept-Encoding gzip;
  proxy_set_header Authorization "";
  proxy_set_header Cookie "";
  gunzip on;
  proxy_cache npm;
  proxy_cache_key "$request_uri $http_accept";
  proxy_ignore_headers Cache-Control Expires Set-Cookie Vary;
  proxy_cache_valid 200 5m;
  proxy_cache_lock on;
  proxy_cache_lock_timeout 60s;
  proxy_cache_lock_age 60s;
  proxy_cache_use_stale updating error timeout http_502 http_503 http_504;
  proxy_cache_background_update on;
  set $npmjs registry.npmjs.org;
  proxy_ssl_server_name on;
  proxy_ssl_verify on;
  proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
  location = /-/npm/v1/keys {
    limit_except GET { deny all; }
    proxy_pass https://$npmjs;
  }
  location ^~ /-/npm/v1/attestations/ {
    limit_except GET { deny all; }
    proxy_pass https://$npmjs;
  }
  location ^~ /-/ {
    proxy_cache off;
    proxy_pass http://verdaccio;
  }
  location ~ \\.tgz$ {
    proxy_cache off;
    proxy_pass http://verdaccio;
  }
  location / {
    proxy_pass http://verdaccio;
  }
}
`
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
  images: { verdaccio: string; nginx: string },
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
      data: { 'config.yaml': buildNpmCacheConfigYaml(), 'npm-cache.conf.template': buildNpmCacheNginxConf() },
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
            // A config edit must roll the pod: both read it once.
            annotations: {
              'yaac.config-hash': crypto.createHash('sha256')
                .update(buildNpmCacheConfigYaml()).update(buildNpmCacheNginxConf())
                .digest('hex').slice(0, 16),
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
            // Verdaccio first, so `kubectl logs` defaults to it.
            containers: [{
              name: 'verdaccio',
              image: images.verdaccio,
              imagePullPolicy: 'IfNotPresent',
              env: [
                { name: 'VERDACCIO_ADDRESS', value: '127.0.0.1' },
                { name: 'VERDACCIO_PORT', value: String(VERDACCIO_PORT) },
                // Tarball URLs in metadata, fixed so nginx can share it.
                { name: 'VERDACCIO_PUBLIC_URL', value: npmCacheRegistryUrl() },
                { name: 'NODE_OPTIONS', value: `--max-old-space-size=${VERDACCIO_MEMORY_MIB * 3 / 4}` },
              ],
              // A full CPU's scheduling weight (four workspaces' requests), so
              // a parse is not starved by the installs it serves; a starved
              // parse is what times out the probe. It is reserved from every
              // install's schedulable CPU (docs/cluster-setup.md).
              resources: {
                requests: { cpu: '1', memory: String(256 * 1024 ** 2) },
                limits: { memory: String(VERDACCIO_MEMORY_MIB * 1024 ** 2) },
              },
              volumeMounts: [
                { name: 'config', mountPath: '/verdaccio/conf', readOnly: true },
                { name: 'storage', mountPath: '/verdaccio/storage' },
              ],
            }, {
              name: 'nginx',
              image: images.nginx,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ containerPort: NPM_CACHE_PORT }],
              // The entrypoint renders the template into conf.d with the
              // pod's DNS server, and substitutes nothing else.
              env: [
                { name: 'NGINX_ENTRYPOINT_LOCAL_RESOLVERS', value: '1' },
                { name: 'NGINX_ENVSUBST_FILTER', value: '^NGINX_LOCAL_RESOLVERS$' },
              ],
              // Through nginx to Verdaccio's uncached ping.
              readinessProbe: {
                httpGet: { path: '/-/ping', port: NPM_CACHE_PORT },
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
                { name: 'http-cache', mountPath: '/var/cache/npm' },
              ],
            }],
            volumes: [
              { name: 'config', configMap: { name: CONFIG_MAP_NAME } },
              { name: 'storage', persistentVolumeClaim: { claimName: npmCachePvcName() } },
              // Lost on restart; Verdaccio's claim still has every package.
              { name: 'http-cache', emptyDir: {} },
              { name: 'nginx-conf', emptyDir: {} },
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
  const verdaccio = await prebuiltRef('Verdaccio', VERDACCIO_MIRROR_TAG)
  const nginx = await prebuiltRef('nginx', NGINX_MIRROR_TAG)
  await ensureNamespace()
  const { workload, service } = buildNpmCacheManifests(
    { verdaccio, nginx },
    { nodes: await nodeIpBlocks(), pods: await clusterPodCidrs() },
  )
  for (const manifest of workload) await kubectlApply(manifest)
  await waitForRollout({
    workload: `deployment/${NPM_CACHE_APP_NAME}`,
    namespace: k8sNamespace(),
    timeoutMs: ROLLOUT_TIMEOUT_MS,
    hint: `Inspect with \`kubectl -n ${k8sNamespace()} get pods,pvc -l app=${NPM_CACHE_APP_NAME}\` — `
      + 'a Pending PVC means the cluster has no default StorageClass to bind it.',
  })
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

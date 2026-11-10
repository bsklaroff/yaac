/**
 * The public-site edge (docs/server-in-cluster.md "The site edge"): what
 * carries internet traffic to a site's live release without passing
 * through the server.
 *
 *  - The router, a stock Envoy that maps `Host` to a site. Install applies
 *    it; its route table is a ConfigMap the server writes.
 *  - The tunnel, cloudflared, which dials out to Cloudflare and hands each
 *    request to the router. Install applies it only once given a token.
 *  - Per site, a headless Service selecting the live release and a policy
 *    admitting the router to the site's release pods. The server applies
 *    these (`syncSiteObjects`).
 *
 * No policy here admits an edge pod to the server, the proxy or a workspace
 * that is not a release, and `yaac cluster check`'s `sites` gate dials them
 * to prove it.
 */
import crypto from 'node:crypto'
import {
  LABEL_SITE_ID,
  LABEL_WORKSPACE_ID,
  PRIORITY_CLASS_INFRA,
  SITE_ROUTER_ADMIN_PORT,
  SITE_ROUTER_APP_NAME,
  SITE_ROUTER_PORT,
  SITE_ROUTES_CONFIGMAP_NAME,
  SITE_TUNNEL_APP_NAME,
  SITE_TUNNEL_METRICS_PORT,
  SITE_TUNNEL_SECRET_NAME,
  apiStatus,
  applyObject,
  createObject,
  deleteObject,
  k8sNamespace,
  listObjects,
  readObject,
  siteServiceName,
  waitForRollout,
  type ObjectRef,
} from '#drivers/k8s/substrate'
import type { SiteRoute } from '#drivers/contract'
import { prebuiltRef } from './registry'
import { clusterDnsCidrs, nodeIpBlocks } from './cluster-cidrs'
import { ensureNamespace } from './proxy-apply'
import { ENVOY_MIRROR_TAG } from './netd'
import { NON_PUBLIC_V4, PUBLIC_V6, dnsEgress } from './policy-manifests'

/** Digest-pinned (multi-arch index) and mirrored like Envoy (netd.ts). */
const CLOUDFLARED_VERSION = '2026.10.7'
const CLOUDFLARED_PIN = 'sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba'
export const CLOUDFLARED_UPSTREAM_IMAGE = `docker.io/cloudflare/cloudflared@${CLOUDFLARED_PIN}`
export const CLOUDFLARED_MIRROR_TAG =
  `cloudflare/cloudflared:${CLOUDFLARED_VERSION}-${CLOUDFLARED_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** The uid/gid the cloudflared image runs as. */
const CLOUDFLARED_UID = 65532
/** The uid/gid of the Envoy image's `envoy` user. */
const ENVOY_UID = 101

/** Where Cloudflare's edge accepts tunnel connections, over TCP and QUIC. */
const TUNNEL_EDGE_PORT = 7844

/** The `app` label of every per-site object, which a sync lists to prune. */
const SITE_OBJECT_APP = 'yaac-site'

/**
 * Carried by the edge's replicas and named by their Deployments' and the
 * router Service's selectors, but not by their policies' pod selectors. A
 * `cluster check` probe pod labelled only `app` is then held to the same
 * policies without the router Service sending public traffic to it.
 */
const LABEL_EDGE_REPLICA = 'yaac.site-edge-replica'

const BOOTSTRAP_CONFIGMAP_NAME = `${SITE_ROUTER_APP_NAME}-bootstrap`
const BOOTSTRAP_DIR = '/etc/yaac-site-router'
const ROUTES_DIR = '/etc/yaac-site-routes'
const ROUTE_CONFIG_NAME = 'sites'

const tcp = (port: number): Record<string, unknown> => ({ protocol: 'TCP', port })

function metadata(name: string, app: string): Record<string, unknown> {
  return { name, namespace: k8sNamespace(), labels: { app } }
}

function replicaLabels(app: string): Record<string, string> {
  return { app, [LABEL_EDGE_REPLICA]: 'true' }
}

/** Envoy's file-based xDS source for one file of the routes ConfigMap. */
function routesFileSource(file: string): Record<string, unknown> {
  return {
    // Watching the directory picks up the kubelet's atomic swap of a
    // ConfigMap volume's `..data` symlink, which a watch on the file misses.
    path_config_source: { path: `${ROUTES_DIR}/${file}`, watched_directory: { path: ROUTES_DIR } },
    resource_api_version: 'V3',
  }
}

/**
 * The router's static bootstrap. The listener is static and its routes
 * (RDS) and clusters (CDS) are read from the routes ConfigMap, so a site
 * change swaps a route table in place and never drains the listener and
 * the other sites' open connections with it.
 *
 * cloudflared is the one trusted hop in front: with `use_remote_address`
 * and one trusted hop, Envoy appends cloudflared's address to the
 * client's `X-Forwarded-For`, takes the client address from the entry
 * cloudflared added, keeps its `X-Forwarded-Proto: https`, and strips
 * `x-envoy-*` request headers from what is then an external request.
 *
 * The route timeout is off, since Envoy's 15 s default would cut long
 * responses and SSE. A stream idle for an hour is closed.
 *
 * The admin listener serves the kubelet's `/ready` probe; policy admits
 * only node addresses to it.
 */
function buildRouterBootstrap(): string {
  return JSON.stringify({
    node: { id: SITE_ROUTER_APP_NAME, cluster: SITE_ROUTER_APP_NAME },
    admin: { address: { socket_address: { address: '0.0.0.0', port_value: SITE_ROUTER_ADMIN_PORT } } },
    static_resources: {
      listeners: [{
        name: 'sites',
        address: { socket_address: { address: '0.0.0.0', port_value: SITE_ROUTER_PORT } },
        filter_chains: [{
          filters: [{
            name: 'envoy.filters.network.http_connection_manager',
            typed_config: {
              '@type': 'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
              stat_prefix: 'sites',
              rds: { route_config_name: ROUTE_CONFIG_NAME, config_source: routesFileSource('rds.json') },
              use_remote_address: true,
              xff_num_trusted_hops: 1,
              stream_idle_timeout: '3600s',
              upgrade_configs: [{ upgrade_type: 'websocket' }],
              http_filters: [{
                name: 'envoy.filters.http.router',
                typed_config: { '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router' },
              }],
            },
          }],
        }],
      }],
    },
    dynamic_resources: { cds_config: routesFileSource('cds.json') },
  }, null, 2)
}

/**
 * The route table for `sites`: the routes ConfigMap's two files, an RDS
 * and a CDS response. Each site is a virtual host for its hostname routed
 * to a cluster on its Service; any other `Host` gets a 404.
 *
 * A site's cluster resolves the Service's absolute name (the trailing dot
 * skips the search domains) as `STRICT_DNS` every second. The Service is
 * headless, so the name resolves to the live release's pod IP and Envoy
 * dials the pod itself. Through a ClusterIP, Envoy's pooled keep-alive
 * connections would stay pinned to the old pod by conntrack after a
 * deploy moves the selector. With pod IPs, new requests go to the new
 * release as soon as DNS shows it, while open connections to the old one
 * finish. DNS shows it within a second where CoreDNS answers
 * `cluster.local` names uncached: kind and the `infra/` clusters
 * (docs/cluster-setup.md "Uncached cluster DNS"). A site with no live
 * release resolves to nothing, so its cluster has no hosts and Envoy
 * answers 503.
 */
function buildSiteRoutes(sites: SiteRoute[]): { 'rds.json': string; 'cds.json': string } {
  const sorted = [...sites].sort((a, b) => a.siteId.localeCompare(b.siteId))
  const rds = {
    resources: [{
      '@type': 'type.googleapis.com/envoy.config.route.v3.RouteConfiguration',
      name: ROUTE_CONFIG_NAME,
      virtual_hosts: [
        ...sorted.map((site) => ({
          name: siteServiceName(site.siteId),
          domains: [site.hostname],
          routes: [{
            match: { prefix: '/' },
            route: { cluster: siteServiceName(site.siteId), timeout: '0s' },
          }],
        })),
        {
          name: 'unknown-host',
          domains: ['*'],
          routes: [{ match: { prefix: '/' }, direct_response: { status: 404 } }],
        },
      ],
    }],
  }
  const cds = {
    resources: sorted.map((site) => ({
      '@type': 'type.googleapis.com/envoy.config.cluster.v3.Cluster',
      name: siteServiceName(site.siteId),
      type: 'STRICT_DNS',
      dns_lookup_family: 'V4_ONLY',
      dns_refresh_rate: '1s',
      connect_timeout: '5s',
      load_assignment: {
        cluster_name: siteServiceName(site.siteId),
        endpoints: [{
          lb_endpoints: [{
            endpoint: {
              address: {
                socket_address: {
                  address: `${siteServiceName(site.siteId)}.${k8sNamespace()}.svc.cluster.local.`,
                  port_value: site.port,
                },
              },
            },
          }],
        }],
      },
    })),
  }
  return { 'rds.json': JSON.stringify(rds, null, 2), 'cds.json': JSON.stringify(cds, null, 2) }
}

function routesConfigMap(sites: SiteRoute[]): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: metadata(SITE_ROUTES_CONFIGMAP_NAME, SITE_ROUTER_APP_NAME),
    data: buildSiteRoutes(sites),
  }
}

/**
 * A site's headless Service and its ingress policy. With no live release
 * the selector names an empty workspace id, which no pod carries, so the
 * Service has no endpoints. Every selector also names the site, so a wrong
 * workspace id can never select a pod that is not one of its releases.
 */
function buildSiteManifests(site: SiteRoute): Array<Record<string, unknown>> {
  const name = siteServiceName(site.siteId)
  return [
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: metadata(name, SITE_OBJECT_APP),
      spec: {
        clusterIP: 'None',
        selector: { [LABEL_SITE_ID]: site.siteId, [LABEL_WORKSPACE_ID]: site.liveWorkspaceId ?? '' },
        ports: [{ name: 'http', port: site.port, targetPort: site.port, protocol: 'TCP' }],
      },
    },
    {
      // Unioned with the workspace ingress lock, which admits only the proxy.
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: metadata(name, SITE_OBJECT_APP),
      spec: {
        podSelector: { matchLabels: { [LABEL_SITE_ID]: site.siteId } },
        policyTypes: ['Ingress'],
        ingress: [{
          from: [{ podSelector: { matchLabels: { app: SITE_ROUTER_APP_NAME } } }],
          ports: [tcp(site.port)],
        }],
      },
    },
  ]
}

/**
 * Converge the per-site objects and the route table to exactly `sites`
 * (the k8s `syncSites` verb). Services go first, so a new cluster's name
 * exists when Envoy loads it, and pruning goes last, once the route table
 * no longer names what it deletes.
 */
export async function syncSiteObjects(sites: SiteRoute[]): Promise<void> {
  await Promise.all(sites.flatMap(buildSiteManifests).map((m) => applyObject(m)))
  await applyObject(routesConfigMap(sites))
  const wanted = new Set(sites.map((s) => siteServiceName(s.siteId)))
  for (const [apiVersion, kind] of [['v1', 'Service'], ['networking.k8s.io/v1', 'NetworkPolicy']] as const) {
    const live = await listObjects(apiVersion, kind, {
      namespace: k8sNamespace(), labelSelector: `app=${SITE_OBJECT_APP}`,
    })
    await Promise.all(live
      .map((o) => o.metadata?.name ?? '')
      .filter((name) => name && !wanted.has(name))
      .map((name) => deleteObject({ apiVersion, kind, name, namespace: k8sNamespace() })))
  }
}

function networkPolicy(name: string, app: string, spec: Record<string, unknown>): Record<string, unknown> {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: metadata(name, app),
    spec: { podSelector: { matchLabels: { app } }, ...spec },
  }
}

/**
 * The edge's four policies. Both pods also fall under the namespace's
 * world-deny, so these allows are all they get:
 *  - tunnel egress: Cloudflare's edge on 7844 (public addresses, nodes
 *    excluded), DNS, and the router's port;
 *  - tunnel ingress: the node (kubelet probe) on the metrics port;
 *  - router ingress: the tunnel on the router port, and the node on admin;
 *  - router egress: DNS, and release pods (any `yaac.site-id`) on any port,
 *    which each site's own policy narrows to its port.
 */
function buildSiteEdgePolicies(nodeCidrs: string[], dnsCidrs: string[]): Array<Record<string, unknown>> {
  const nodes = nodeCidrs.map((cidr) => ({ ipBlock: { cidr } }))
  const edgePorts = [tcp(TUNNEL_EDGE_PORT), { protocol: 'UDP', port: TUNNEL_EDGE_PORT }]
  return [
    networkPolicy(`${SITE_TUNNEL_APP_NAME}-egress`, SITE_TUNNEL_APP_NAME, {
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            { ipBlock: { cidr: '0.0.0.0/0', except: [...nodeCidrs, ...NON_PUBLIC_V4] } },
            { ipBlock: PUBLIC_V6 },
          ],
          ports: edgePorts,
        },
        dnsEgress(dnsCidrs),
        {
          to: [{ podSelector: { matchLabels: { app: SITE_ROUTER_APP_NAME } } }],
          ports: [tcp(SITE_ROUTER_PORT)],
        },
      ],
    }),
    networkPolicy(`${SITE_TUNNEL_APP_NAME}-ingress`, SITE_TUNNEL_APP_NAME, {
      policyTypes: ['Ingress'],
      ingress: [{ from: nodes, ports: [tcp(SITE_TUNNEL_METRICS_PORT)] }],
    }),
    networkPolicy(`${SITE_ROUTER_APP_NAME}-ingress`, SITE_ROUTER_APP_NAME, {
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { app: SITE_TUNNEL_APP_NAME } } }],
          ports: [tcp(SITE_ROUTER_PORT)],
        },
        { from: nodes, ports: [tcp(SITE_ROUTER_ADMIN_PORT)] },
      ],
    }),
    networkPolicy(`${SITE_ROUTER_APP_NAME}-egress`, SITE_ROUTER_APP_NAME, {
      policyTypes: ['Egress'],
      egress: [
        dnsEgress(dnsCidrs),
        { to: [{ podSelector: { matchExpressions: [{ key: LABEL_SITE_ID, operator: 'Exists' }] } }] },
      ],
    }),
  ]
}

/** Re-render the edge's node-address policies, for `reconcileNodeSet`. */
export async function syncSiteEdgeNodes(nodeCidrs: string[], dnsCidrs: string[]): Promise<void> {
  for (const manifest of buildSiteEdgePolicies(nodeCidrs, dnsCidrs)) await applyObject(manifest)
}

/** Pod fields both edge Deployments share: trusted infra on runc, like
 *  the registries, with no API token and no root. */
function edgePodSpec(uid: number): Record<string, unknown> {
  return {
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    priorityClassName: PRIORITY_CLASS_INFRA,
    securityContext: { runAsNonRoot: true, runAsUser: uid, runAsGroup: uid },
  }
}

const containerSecurity = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
}

function edgeDeployment(
  app: string,
  template: { annotations?: Record<string, string>; spec: Record<string, unknown> },
): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: metadata(app, app),
    spec: {
      replicas: 2,
      selector: { matchLabels: replicaLabels(app) },
      template: {
        metadata: { labels: replicaLabels(app), ...(template.annotations ? { annotations: template.annotations } : {}) },
        spec: template.spec,
      },
    },
  }
}

/** The router's bootstrap ConfigMap, Deployment and Service. */
function buildRouterManifests(envoyImage: string): Array<Record<string, unknown>> {
  const bootstrap = buildRouterBootstrap()
  return [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: metadata(BOOTSTRAP_CONFIGMAP_NAME, SITE_ROUTER_APP_NAME),
      data: { 'bootstrap.json': bootstrap },
    },
    edgeDeployment(SITE_ROUTER_APP_NAME, {
      // Envoy reads its bootstrap once, so a change to it must roll the pods.
      annotations: { 'yaac.config-hash': crypto.createHash('sha256').update(bootstrap).digest('hex').slice(0, 16) },
      spec: {
        ...edgePodSpec(ENVOY_UID),
        containers: [{
          name: 'envoy',
          image: envoyImage,
          imagePullPolicy: 'IfNotPresent',
          securityContext: containerSecurity,
          // No hot restart, which would need shared memory.
          command: [
            'envoy', '-c', `${BOOTSTRAP_DIR}/bootstrap.json`, '--log-level', 'warn', '--disable-hot-restart',
          ],
          ports: [{ containerPort: SITE_ROUTER_PORT }],
          readinessProbe: {
            httpGet: { path: '/ready', port: SITE_ROUTER_ADMIN_PORT },
            periodSeconds: 2,
            failureThreshold: 3,
          },
          resources: {
            requests: { cpu: '50m', memory: '64Mi' },
            limits: { memory: '512Mi' },
          },
          volumeMounts: [
            { name: 'bootstrap', mountPath: BOOTSTRAP_DIR, readOnly: true },
            { name: 'routes', mountPath: ROUTES_DIR, readOnly: true },
          ],
        }],
        volumes: [
          { name: 'bootstrap', configMap: { name: BOOTSTRAP_CONFIGMAP_NAME } },
          { name: 'routes', configMap: { name: SITE_ROUTES_CONFIGMAP_NAME } },
        ],
      },
    }),
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: metadata(SITE_ROUTER_APP_NAME, SITE_ROUTER_APP_NAME),
      spec: {
        type: 'ClusterIP',
        selector: replicaLabels(SITE_ROUTER_APP_NAME),
        ports: [{ name: 'http', port: SITE_ROUTER_PORT, targetPort: SITE_ROUTER_PORT, protocol: 'TCP' }],
      },
    },
  ]
}

/**
 * cloudflared, running the remotely-managed tunnel its token names.
 * `/ready` answers 200 only while it holds a connection to Cloudflare, so
 * it is a readiness probe: a liveness probe would restart a tunnel that is
 * only waiting for the network to come back. `--no-autoupdate`, since its
 * egress has no 443 for update checks.
 */
function buildTunnelDeployment(image: string): Record<string, unknown> {
  return edgeDeployment(SITE_TUNNEL_APP_NAME, {
    spec: {
      ...edgePodSpec(CLOUDFLARED_UID),
      containers: [{
        name: 'cloudflared',
        image,
        imagePullPolicy: 'IfNotPresent',
        securityContext: containerSecurity,
        command: [
          'cloudflared', 'tunnel', '--no-autoupdate', '--loglevel', 'info',
          '--metrics', `0.0.0.0:${String(SITE_TUNNEL_METRICS_PORT)}`, 'run',
        ],
        env: [{
          name: 'TUNNEL_TOKEN',
          valueFrom: { secretKeyRef: { name: SITE_TUNNEL_SECRET_NAME, key: 'token' } },
        }],
        readinessProbe: {
          httpGet: { path: '/ready', port: SITE_TUNNEL_METRICS_PORT },
          periodSeconds: 5,
          failureThreshold: 3,
        },
        resources: {
          requests: { cpu: '50m', memory: '64Mi' },
          limits: { memory: '256Mi' },
        },
      }],
    },
  })
}

function tunnelRef(kind: 'Deployment' | 'Secret'): ObjectRef {
  return {
    apiVersion: kind === 'Secret' ? 'v1' : 'apps/v1',
    kind,
    name: kind === 'Secret' ? SITE_TUNNEL_SECRET_NAME : SITE_TUNNEL_APP_NAME,
    namespace: k8sNamespace(),
  }
}

const ROLLOUT_TIMEOUT_MS = 120_000

/**
 * Create or update the edge (run by `yaac cluster install`, and by the e2e
 * harness without a token). The router is always applied. Its route
 * table is created empty only when absent, since the server owns it from
 * then on. The tunnel's Secret is written only when given a token, and its
 * Deployment exists exactly while the Secret does, so a later install
 * without the token keeps the tunnel running.
 */
export async function ensureSiteEdge(opts: { tunnelToken?: string }): Promise<void> {
  await ensureNamespace()
  const envoy = await prebuiltRef('Envoy', ENVOY_MIRROR_TAG)
  await syncSiteEdgeNodes(await nodeIpBlocks(), await clusterDnsCidrs())
  try {
    await createObject(routesConfigMap([]))
  } catch (err) {
    if (apiStatus(err) !== 409) throw err
  }
  for (const manifest of buildRouterManifests(envoy)) await applyObject(manifest)
  await waitForRollout({
    workload: `deployment/${SITE_ROUTER_APP_NAME}`,
    namespace: k8sNamespace(),
    timeoutMs: ROLLOUT_TIMEOUT_MS,
    hint: `Inspect with \`kubectl -n ${k8sNamespace()} get pods -l app=${SITE_ROUTER_APP_NAME}\` and its logs.`,
  })

  if (opts.tunnelToken !== undefined) {
    await applyObject({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: metadata(SITE_TUNNEL_SECRET_NAME, SITE_TUNNEL_APP_NAME),
      type: 'Opaque',
      stringData: { token: opts.tunnelToken },
    })
  } else if (!await readObject(tunnelRef('Secret'))) {
    await deleteObject(tunnelRef('Deployment'))
    return
  }
  await applyObject(buildTunnelDeployment(await prebuiltRef('cloudflared', CLOUDFLARED_MIRROR_TAG)))
  await waitForRollout({
    workload: `deployment/${SITE_TUNNEL_APP_NAME}`,
    namespace: k8sNamespace(),
    timeoutMs: ROLLOUT_TIMEOUT_MS,
    hint: 'cloudflared goes ready only once it holds a connection to Cloudflare: check the '
      + 'token (CF_TUNNEL_TOKEN) and that this network lets out TCP and UDP 7844. Inspect with '
      + `\`kubectl -n ${k8sNamespace()} logs deploy/${SITE_TUNNEL_APP_NAME}\`.`,
  })
}

/**
 * Whether the tunnel holds a connection to Cloudflare: `absent` with no
 * tunnel Deployment, `connected` while a replica is ready (its `/ready`
 * answers 200 only then).
 */
export async function siteTunnelStatus(): Promise<'connected' | 'disconnected' | 'absent'> {
  const dep = await readObject<{ status?: { readyReplicas?: number } }>(tunnelRef('Deployment'))
  if (!dep) return 'absent'
  return (dep.status?.readyReplicas ?? 0) > 0 ? 'connected' : 'disconnected'
}

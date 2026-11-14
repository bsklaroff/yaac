/**
 * The site edge (docs/server-in-cluster.md "The site edge"): what carries
 * traffic to a site's live release without passing through the server.
 *
 *  - The router, a stock Envoy that maps `Host` to a site, with one
 *    listener per edge. Install applies it; its route tables are a
 *    ConfigMap the server writes.
 *  - The Cloudflare tunnel, cloudflared, which dials out to Cloudflare and
 *    hands each request to the public listener. Install applies it only
 *    once given a token.
 *  - The tailnet tunnel, tailscaled and tailgate, one device on the
 *    install's tailnet that hands each request for a name under the site
 *    domain to the tailnet listener with the caller's login. Install
 *    applies it only once given an auth key.
 *  - Per site, a headless Service selecting the live release and a policy
 *    admitting the router to the site's release pods. The server applies
 *    these (`syncSiteObjects`).
 *
 * No policy here admits an edge pod to the server, the proxy or a workspace
 * that is not a release, and `yaac cluster check`'s `sites` gate dials them
 * to prove it. The proxy is admitted to the router's tailnet listener, the
 * one way in from the cluster side.
 */
import crypto from 'node:crypto'
import {
  LABEL_SITE_ID,
  LABEL_WORKSPACE_ID,
  PRIORITY_CLASS_INFRA,
  PROXY_APP_NAME,
  SITE_ROUTER_ADMIN_PORT,
  SITE_ROUTER_APP_NAME,
  SITE_ROUTER_PORT,
  SITE_ROUTER_TAILNET_PORT,
  SITE_ROUTES_CONFIGMAP_NAME,
  SITE_TUNNEL_CLOUDFLARE_APP_NAME,
  SITE_TUNNEL_CLOUDFLARE_METRICS_PORT,
  SITE_TUNNEL_CLOUDFLARE_SECRET_NAME,
  SITE_TUNNEL_TAILNET_APP_NAME,
  SITE_TUNNEL_TAILNET_TLS_SECRET_NAME,
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
import { testEnv } from '@yaac/shared/env'
import { TAILGATE_DIR } from '@yaac/shared/project-paths'
import type { SiteTailnetState } from '@yaac/shared/types'
import { waitFor } from '@yaac/shared/wait-for'
import { prebuiltRef } from './registry'
import { apiserverEndpoints, clusterDnsCidrs, nodeIpBlocks } from './cluster-cidrs'
import { contextHash } from './image-tags'
import { ensureNamespace } from './proxy-apply'
import { ENVOY_MIRROR_TAG } from './netd'
import { NON_PUBLIC_V4, PUBLIC_V6, dnsEgress } from './policy-manifests'

/** Digest-pinned (multi-arch index) and mirrored like Envoy (netd.ts). */
const CLOUDFLARED_VERSION = '2026.10.7'
const CLOUDFLARED_PIN = 'sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba'
export const CLOUDFLARED_UPSTREAM_IMAGE = `docker.io/cloudflare/cloudflared@${CLOUDFLARED_PIN}`
export const CLOUDFLARED_MIRROR_TAG =
  `cloudflare/cloudflared:${CLOUDFLARED_VERSION}-${CLOUDFLARED_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** Digest-pinned and mirrored like cloudflared. */
const TAILSCALE_VERSION = '1.102.4'
const TAILSCALE_PIN = 'sha256:2667499ed87ae29218f292556ba062918402dd5e92e93637af14867e4df12dd3'
export const TAILSCALE_UPSTREAM_IMAGE = `docker.io/tailscale/tailscale@${TAILSCALE_PIN}`
export const TAILSCALE_MIRROR_TAG =
  `tailscale/tailscale:${TAILSCALE_VERSION}-${TAILSCALE_PIN.slice('sha256:'.length, 'sha256:'.length + 12)}`

/** Content-hash tag of the tailgate image (the k8s/tailgate build context). */
export async function resolveTailgateImageTag(image = testEnv.tailgateImage): Promise<string> {
  return `${image}:${await contextHash(TAILGATE_DIR)}`
}

/** The uid/gid the cloudflared image runs as. */
const CLOUDFLARED_UID = 65532
/** The uid/gid tailscaled runs as (root by default, but fine without it in
 *  userspace mode). */
const TAILNET_UID = 1000
/** tailgate's uid: another than tailscaled's, which gives a peer of its own
 *  uid write access to its local API and any other only reads. */
const TAILGATE_UID = 1001

/** tailscaled's `/healthz`, 200 once the device has a tailnet address. */
const TAILSCALED_HEALTH_PORT = 9002
/** tailgate's `/ready`, 200 while it holds a certificate and knows its
 *  tailnet addresses. */
const TAILGATE_HEALTH_PORT = 9003
/**
 * Where tailscaled's serve config forwards 443 and 80, each behind a PROXY
 * v1 header naming the caller: 127.0.0.2, a loopback address userspace
 * tailscaled's forward of every other port of the device (to 127.0.0.1 or
 * ::1) never dials, so no tailnet peer can open these listeners itself and
 * name a caller (k8s/tailgate/tailgate.ts).
 */
const TAILGATE_SERVE_HOST = '127.0.0.2'
const TAILGATE_HTTPS_PORT = 8443
const TAILGATE_HTTP_PORT = 8080
/**
 * How long a site connection may go with no bytes moving before it is
 * closed: the router's stream idle timeout, and tailgate's for each tailnet
 * connection, so both hops let go of a vanished client at the same point.
 * It has no overall deadline, so a long upload or a quiet WebSocket that
 * still sends now and then stays open.
 */
const SITE_IDLE_TIMEOUT_SECONDS = 3600

/** The tailnet tunnel's Secret: its auth key (`authkey`) and the install's
 *  site domain (`domain`). */
const TAILNET_AUTH_SECRET_NAME = SITE_TUNNEL_TAILNET_APP_NAME
/** tailscaled's state, which keeps its device and address across restarts. */
const TAILNET_STATE_SECRET_NAME = `${SITE_TUNNEL_TAILNET_APP_NAME}-state`
const TAILNET_SERVE_CONFIGMAP_NAME = `${SITE_TUNNEL_TAILNET_APP_NAME}-serve`
const TAILSCALE_SOCKET_DIR = '/run/tailscale'

/** The uid/gid of the Envoy image's `envoy` user. */
const ENVOY_UID = 101

/** Where Cloudflare's edge accepts tunnel connections, over TCP and QUIC. */
const TUNNEL_EDGE_PORT = 7844

/**
 * What the Cloudflare tunnel's Deployment, Secret, policies and `app` label
 * were named before the tailnet tunnel joined it (docs/legacy-compat-shims.md
 * "The unsuffixed Cloudflare tunnel").
 */
const LEGACY_TUNNEL_NAME = 'yaac-site-tunnel'

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

/** The route table each router listener reads, and its RDS file. */
const ROUTE_TABLES = {
  public: { name: 'sites', file: 'rds.json' },
  tailnet: { name: 'sites-tailnet', file: 'rds-tailnet.json' },
} as const

function httpFilter(name: string, type: string, config: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, typed_config: { '@type': `type.googleapis.com/${type}`, ...config } }
}

/**
 * The headers Tailscale's own proxies set, which the public route table
 * drops from every request, so an app written for the tailnet edge and
 * published on the public one by mistake sees no identity or app
 * capability rather than one the internet chose. Envoy 1.34 removes
 * request headers only by name.
 */
const TAILNET_IDENTITY_HEADERS = [
  'tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic',
  'tailscale-app-capabilities', 'tailscale-headers-info',
]

/**
 * The tailnet listener answers 403 to a request without a tailnet login,
 * so an app behind it only ever sees requests that carry one, whatever
 * sent them.
 */
const REQUIRE_TAILNET_LOGIN = httpFilter('envoy.filters.http.rbac', 'envoy.extensions.filters.http.rbac.v3.RBAC', {
  rules: {
    action: 'ALLOW',
    policies: {
      'tailnet-login': {
        permissions: [{ any: true }],
        principals: [{ header: { name: 'tailscale-user-login', present_match: true } }],
      },
    },
  },
})

function routerListener(
  edge: keyof typeof ROUTE_TABLES,
  port: number,
  filters: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const table = ROUTE_TABLES[edge]
  return {
    name: table.name,
    address: { socket_address: { address: '0.0.0.0', port_value: port } },
    filter_chains: [{
      filters: [{
        name: 'envoy.filters.network.http_connection_manager',
        typed_config: {
          '@type': 'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
          stat_prefix: table.name,
          rds: { route_config_name: table.name, config_source: routesFileSource(table.file) },
          use_remote_address: true,
          xff_num_trusted_hops: 1,
          stream_idle_timeout: `${String(SITE_IDLE_TIMEOUT_SECONDS)}s`,
          upgrade_configs: [{ upgrade_type: 'websocket' }],
          http_filters: [...filters, httpFilter('envoy.filters.http.router', 'envoy.extensions.filters.http.router.v3.Router')],
        },
      }],
    }],
  }
}

/**
 * The router's static bootstrap: one listener per edge, each with its own
 * route table, so a public site is a virtual host only on the public
 * listener and a tailnet site only on the tailnet one, and no `Host` the
 * Cloudflare tunnel sends can reach a tailnet site. The listeners are
 * static and their routes (RDS) and the clusters they share (CDS) are
 * read from the routes ConfigMap, so a site change swaps a route table in
 * place and never drains a listener and the other sites' open
 * connections with it.
 *
 * Each listener has one trusted hop in front, cloudflared or tailgate:
 * with `use_remote_address` and one trusted hop, Envoy appends that hop's
 * address to the client's `X-Forwarded-For`, takes the client address from
 * the entry the hop added, keeps its `X-Forwarded-Proto: https`, and
 * strips `x-envoy-*` request headers from what is then an external
 * request.
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
      listeners: [
        routerListener('public', SITE_ROUTER_PORT, []),
        routerListener('tailnet', SITE_ROUTER_TAILNET_PORT, [REQUIRE_TAILNET_LOGIN]),
      ],
    },
    dynamic_resources: { cds_config: routesFileSource('cds.json') },
  }, null, 2)
}

/**
 * The route tables: the routes ConfigMap's three files, an RDS response
 * per listener and the CDS response they share. Each site is a virtual
 * host for its hostname, in its own edge's table, routed to a cluster on
 * its Service; any other `Host` gets a 404.
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
function buildSiteRoutes(sites: SiteRoute[]): Record<string, string> {
  const sorted = [...sites].sort((a, b) => a.siteId.localeCompare(b.siteId))
  const rds = (edge: keyof typeof ROUTE_TABLES): string => JSON.stringify({
    resources: [{
      '@type': 'type.googleapis.com/envoy.config.route.v3.RouteConfiguration',
      name: ROUTE_TABLES[edge].name,
      ...(edge === 'public' ? { request_headers_to_remove: TAILNET_IDENTITY_HEADERS } : {}),
      virtual_hosts: [
        ...sorted.filter((site) => site.edge === edge).map((site) => ({
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
  }, null, 2)
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
  return {
    [ROUTE_TABLES.public.file]: rds('public'),
    [ROUTE_TABLES.tailnet.file]: rds('tailnet'),
    'cds.json': JSON.stringify(cds, null, 2),
  }
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
 * The edge's six policies. Every edge pod also falls under the namespace's
 * world-deny, so these allows are all they get:
 *  - Cloudflare tunnel egress: Cloudflare's edge on 7844 (public
 *    addresses, nodes excluded), DNS, and the router's public port;
 *  - Cloudflare tunnel ingress: the node (kubelet probe) on the metrics port;
 *  - tailnet tunnel egress: public addresses on any port (Tailscale's
 *    coordination and relay servers, and peers), DNS, the router's tailnet
 *    port, and the apiserver for tailscaled's state Secret;
 *  - tailnet tunnel ingress: the node on its two health ports;
 *  - router ingress: the Cloudflare tunnel on the public port (by its
 *    current and its legacy label), the tailnet tunnel and the egress
 *    proxy (carrying workspaces' requests) on the tailnet port, and the
 *    node on admin;
 *  - router egress: DNS, and release pods (any `yaac.site-id`) on any port,
 *    which each site's own policy narrows to its port.
 */
function buildSiteEdgePolicies(
  nodeCidrs: string[],
  dnsCidrs: string[],
  apiserver: { cidrs: string[]; ports: number[] },
): Array<Record<string, unknown>> {
  const nodes = nodeCidrs.map((cidr) => ({ ipBlock: { cidr } }))
  const publicAddresses = [
    { ipBlock: { cidr: '0.0.0.0/0', except: [...nodeCidrs, ...NON_PUBLIC_V4] } },
    { ipBlock: PUBLIC_V6 },
  ]
  const edgePorts = [tcp(TUNNEL_EDGE_PORT), { protocol: 'UDP', port: TUNNEL_EDGE_PORT }]
  return [
    networkPolicy(`${SITE_TUNNEL_CLOUDFLARE_APP_NAME}-egress`, SITE_TUNNEL_CLOUDFLARE_APP_NAME, {
      policyTypes: ['Egress'],
      egress: [
        {
          to: publicAddresses,
          ports: edgePorts,
        },
        dnsEgress(dnsCidrs),
        {
          to: [{ podSelector: { matchLabels: { app: SITE_ROUTER_APP_NAME } } }],
          ports: [tcp(SITE_ROUTER_PORT)],
        },
      ],
    }),
    networkPolicy(`${SITE_TUNNEL_CLOUDFLARE_APP_NAME}-ingress`, SITE_TUNNEL_CLOUDFLARE_APP_NAME, {
      policyTypes: ['Ingress'],
      ingress: [{ from: nodes, ports: [tcp(SITE_TUNNEL_CLOUDFLARE_METRICS_PORT)] }],
    }),
    networkPolicy(`${SITE_ROUTER_APP_NAME}-ingress`, SITE_ROUTER_APP_NAME, {
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [SITE_TUNNEL_CLOUDFLARE_APP_NAME, LEGACY_TUNNEL_NAME].map((app) => ({ podSelector: { matchLabels: { app } } })),
          ports: [tcp(SITE_ROUTER_PORT)],
        },
        {
          from: [SITE_TUNNEL_TAILNET_APP_NAME, PROXY_APP_NAME].map((app) => ({ podSelector: { matchLabels: { app } } })),
          ports: [tcp(SITE_ROUTER_TAILNET_PORT)],
        },
        { from: nodes, ports: [tcp(SITE_ROUTER_ADMIN_PORT)] },
      ],
    }),
    networkPolicy(`${SITE_TUNNEL_TAILNET_APP_NAME}-egress`, SITE_TUNNEL_TAILNET_APP_NAME, {
      policyTypes: ['Egress'],
      egress: [
        // Coordination, DERP relays and direct peers, on whatever ports
        // they use. A peer on a private address is reached through a relay.
        { to: publicAddresses },
        dnsEgress(dnsCidrs),
        {
          to: [{ podSelector: { matchLabels: { app: SITE_ROUTER_APP_NAME } } }],
          ports: [tcp(SITE_ROUTER_TAILNET_PORT)],
        },
        // tailscaled keeps its state in a Secret.
        ...(apiserver.cidrs.length > 0
          ? [{ to: apiserver.cidrs.map((cidr) => ({ ipBlock: { cidr } })), ports: apiserver.ports.map(tcp) }]
          : []),
      ],
    }),
    networkPolicy(`${SITE_TUNNEL_TAILNET_APP_NAME}-ingress`, SITE_TUNNEL_TAILNET_APP_NAME, {
      policyTypes: ['Ingress'],
      ingress: [{ from: nodes, ports: [tcp(TAILSCALED_HEALTH_PORT), tcp(TAILGATE_HEALTH_PORT)] }],
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
export async function syncSiteEdgeNodes(
  nodeCidrs: string[],
  dnsCidrs: string[],
  apiserver: { cidrs: string[]; ports: number[] },
): Promise<void> {
  for (const manifest of buildSiteEdgePolicies(nodeCidrs, dnsCidrs, apiserver)) await applyObject(manifest)
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
          ports: [{ containerPort: SITE_ROUTER_PORT }, { containerPort: SITE_ROUTER_TAILNET_PORT }],
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
        ports: [
          { name: 'http', port: SITE_ROUTER_PORT, targetPort: SITE_ROUTER_PORT, protocol: 'TCP' },
          { name: 'tailnet', port: SITE_ROUTER_TAILNET_PORT, targetPort: SITE_ROUTER_TAILNET_PORT, protocol: 'TCP' },
        ],
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
  return edgeDeployment(SITE_TUNNEL_CLOUDFLARE_APP_NAME, {
    spec: {
      ...edgePodSpec(CLOUDFLARED_UID),
      containers: [{
        name: 'cloudflared',
        image,
        imagePullPolicy: 'IfNotPresent',
        securityContext: containerSecurity,
        command: [
          'cloudflared', 'tunnel', '--no-autoupdate', '--loglevel', 'info',
          '--metrics', `0.0.0.0:${String(SITE_TUNNEL_CLOUDFLARE_METRICS_PORT)}`, 'run',
        ],
        env: [{
          name: 'TUNNEL_TOKEN',
          valueFrom: { secretKeyRef: { name: SITE_TUNNEL_CLOUDFLARE_SECRET_NAME, key: 'token' } },
        }],
        readinessProbe: {
          httpGet: { path: '/ready', port: SITE_TUNNEL_CLOUDFLARE_METRICS_PORT },
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

/**
 * tailscaled's serve config: 443 and 80 are forwarded to tailgate as raw
 * TCP behind a PROXY v1 header naming the caller's tailnet address. Any
 * other port of the device (53) userspace mode delivers to the same port
 * on 127.0.0.1.
 */
const TAILNET_SERVE_CONFIG = JSON.stringify({
  TCP: {
    443: { TCPForward: `${TAILGATE_SERVE_HOST}:${String(TAILGATE_HTTPS_PORT)}`, ProxyProtocol: 1 },
    80: { TCPForward: `${TAILGATE_SERVE_HOST}:${String(TAILGATE_HTTP_PORT)}`, ProxyProtocol: 1 },
  },
})

/**
 * The tailnet tunnel's objects bar its two Secrets: the serve config, the
 * account tailscaled writes its state Secret as, and the Deployment.
 *
 * One replica, since it is one tailnet device with one address. tailscaled
 * is Tailscale's stock containerboot in userspace mode, so neither
 * container needs privilege; it joins once with the auth key, keeps its
 * state in a Secret, and is the only container given an API token, by a
 * projected volume (the pod automounts none). tailgate answers DNS for the
 * zone on port 53, which the `ip_unprivileged_port_start` sysctl lets a
 * non-root process bind, ends TLS with the certificate Secret, which is
 * optional so the pod runs without it, and stamps each request with the
 * caller's login (k8s/tailgate).
 */
function buildTailnetManifests(opts: {
  tailscaleImage: string
  tailgateImage: string
  siteDomain: string
}): Array<Record<string, unknown>> {
  const app = SITE_TUNNEL_TAILNET_APP_NAME
  const socket = `${TAILSCALE_SOCKET_DIR}/tailscaled.sock`
  return [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: metadata(TAILNET_SERVE_CONFIGMAP_NAME, app),
      data: { 'serve.json': TAILNET_SERVE_CONFIG },
    },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata(app, app), automountServiceAccountToken: false },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata: metadata(app, app),
      rules: [{
        apiGroups: [''], resources: ['secrets'], resourceNames: [TAILNET_STATE_SECRET_NAME], verbs: ['get', 'update', 'patch'],
      }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: metadata(app, app),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: app },
      subjects: [{ kind: 'ServiceAccount', name: app, namespace: k8sNamespace() }],
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: metadata(app, app),
      spec: {
        replicas: 1,
        // A second device would join while the first still holds the state.
        strategy: { type: 'Recreate' },
        selector: { matchLabels: replicaLabels(app) },
        template: {
          metadata: { labels: replicaLabels(app) },
          spec: {
            ...edgePodSpec(TAILNET_UID),
            serviceAccountName: app,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: TAILNET_UID,
              runAsGroup: TAILNET_UID,
              fsGroup: TAILNET_UID,
              sysctls: [{ name: 'net.ipv4.ip_unprivileged_port_start', value: '0' }],
            },
            containers: [
              {
                name: 'tailscaled',
                image: opts.tailscaleImage,
                imagePullPolicy: 'IfNotPresent',
                securityContext: containerSecurity,
                env: [
                  {
                    name: 'TS_AUTHKEY',
                    valueFrom: { secretKeyRef: { name: TAILNET_AUTH_SECRET_NAME, key: 'authkey' } },
                  },
                  { name: 'TS_AUTH_ONCE', value: 'true' },
                  { name: 'TS_KUBE_SECRET', value: TAILNET_STATE_SECRET_NAME },
                  { name: 'TS_USERSPACE', value: 'true' },
                  { name: 'TS_HOSTNAME', value: 'yaac-sites' },
                  { name: 'TS_SOCKET', value: socket },
                  { name: 'TS_SERVE_CONFIG', value: '/etc/tailscale-serve/serve.json' },
                  { name: 'TS_LOGS_DIR', value: '/tmp' },
                  { name: 'TS_ENABLE_HEALTH_CHECK', value: 'true' },
                  { name: 'TS_LOCAL_ADDR_PORT', value: `0.0.0.0:${String(TAILSCALED_HEALTH_PORT)}` },
                ],
                livenessProbe: {
                  httpGet: { path: '/healthz', port: TAILSCALED_HEALTH_PORT },
                  // Joining a tailnet, or rejoining after a network loss,
                  // can take a while; restarting does not help it.
                  initialDelaySeconds: 120,
                  periodSeconds: 30,
                  failureThreshold: 10,
                },
                resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } },
                volumeMounts: [
                  { name: 'tmp', mountPath: '/tmp' },
                  { name: 'socket', mountPath: TAILSCALE_SOCKET_DIR },
                  { name: 'serve', mountPath: '/etc/tailscale-serve', readOnly: true },
                  { name: 'api', mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true },
                ],
              },
              {
                name: 'tailgate',
                image: opts.tailgateImage,
                imagePullPolicy: 'IfNotPresent',
                securityContext: { ...containerSecurity, runAsUser: TAILGATE_UID, runAsGroup: TAILGATE_UID },
                env: [
                  { name: 'TAILGATE_SITE_DOMAIN', value: opts.siteDomain },
                  { name: 'TAILGATE_TAILSCALE_SOCKET', value: socket },
                  {
                    name: 'TAILGATE_ROUTER',
                    value: `${SITE_ROUTER_APP_NAME}.${k8sNamespace()}.svc.cluster.local:${String(SITE_ROUTER_TAILNET_PORT)}`,
                  },
                  { name: 'TAILGATE_TLS_DIR', value: '/etc/tailgate-tls' },
                  { name: 'TAILGATE_SERVE_HOST', value: TAILGATE_SERVE_HOST },
                  { name: 'TAILGATE_HTTPS_PORT', value: String(TAILGATE_HTTPS_PORT) },
                  { name: 'TAILGATE_HTTP_PORT', value: String(TAILGATE_HTTP_PORT) },
                  { name: 'TAILGATE_HEALTH_PORT', value: String(TAILGATE_HEALTH_PORT) },
                  { name: 'TAILGATE_IDLE_SECONDS', value: String(SITE_IDLE_TIMEOUT_SECONDS) },
                ],
                readinessProbe: {
                  httpGet: { path: '/ready', port: TAILGATE_HEALTH_PORT },
                  periodSeconds: 5,
                  failureThreshold: 3,
                },
                resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } },
                volumeMounts: [
                  // tsx keeps its compile cache here.
                  { name: 'tailgate-tmp', mountPath: '/tmp' },
                  { name: 'socket', mountPath: TAILSCALE_SOCKET_DIR },
                  { name: 'tls', mountPath: '/etc/tailgate-tls', readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: 'tmp', emptyDir: {} },
              { name: 'tailgate-tmp', emptyDir: {} },
              { name: 'socket', emptyDir: {} },
              { name: 'serve', configMap: { name: TAILNET_SERVE_CONFIGMAP_NAME } },
              { name: 'tls', secret: { secretName: SITE_TUNNEL_TAILNET_TLS_SECRET_NAME, optional: true } },
              {
                name: 'api',
                projected: {
                  sources: [
                    { serviceAccountToken: { path: 'token', expirationSeconds: 3600 } },
                    { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
                    { downwardAPI: { items: [{ path: 'namespace', fieldRef: { fieldPath: 'metadata.namespace' } }] } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  ]
}

function tailnetRef(apiVersion: string, kind: string, name = SITE_TUNNEL_TAILNET_APP_NAME): ObjectRef {
  return { apiVersion, kind, name, namespace: k8sNamespace() }
}

/** What exists exactly while the tunnel does. The certificate Secret is
 *  the admin's, and stays. */
function tailnetRefs(): ObjectRef[] {
  return [
    tailnetRef('apps/v1', 'Deployment'),
    tailnetRef('rbac.authorization.k8s.io/v1', 'RoleBinding'),
    tailnetRef('rbac.authorization.k8s.io/v1', 'Role'),
    tailnetRef('v1', 'ServiceAccount'),
    tailnetRef('v1', 'ConfigMap', TAILNET_SERVE_CONFIGMAP_NAME),
    tailnetRef('v1', 'Secret', TAILNET_STATE_SECRET_NAME),
    tailnetRef('v1', 'Secret', TAILNET_AUTH_SECRET_NAME),
  ]
}

/** The device's tailnet addresses, which containerboot records in the
 *  state Secret once it has joined. */
async function tailnetAddresses(): Promise<string[]> {
  const state = await readObject<{ data?: Record<string, string> }>(tailnetRef('v1', 'Secret', TAILNET_STATE_SECRET_NAME))
  const raw = state?.data?.device_ips
  if (!raw) return []
  const ips = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as unknown
  return Array.isArray(ips) ? ips.filter((ip): ip is string => typeof ip === 'string') : []
}

const TAILNET_JOIN_TIMEOUT_MS = 180_000

/** What the tailnet tunnel's Secret holds. */
async function storedTailnetSite(): Promise<{ authKey?: string; siteDomain?: string }> {
  const secret = await readObject<{ data?: Record<string, string> }>(tailnetRef('v1', 'Secret', TAILNET_AUTH_SECRET_NAME))
  const read = (key: string): string | undefined => {
    const value = secret?.data?.[key]
    return value ? Buffer.from(value, 'base64').toString('utf8') : undefined
  }
  return { authKey: read('authkey'), siteDomain: read('domain') }
}

/** The site domain the tailnet tunnel's Secret records, which an install
 *  that names none keeps. */
export async function installedSiteDomain(): Promise<string | undefined> {
  return (await storedTailnetSite()).siteDomain
}

/**
 * Converge the tailnet tunnel (docs/public-sites.md "Tailnet sites"). Its
 * Secret records the auth key and the site domain, each replaced only when
 * given, so a later install that names neither keeps the tunnel as it is,
 * as the Cloudflare tunnel keeps its token. The tunnel exists exactly while
 * the Secret holds both. Waits for the device to join and returns its
 * tailnet addresses, or undefined with no tunnel.
 */
async function ensureTailnetTunnel(
  givenKey: string | undefined,
  givenDomain: string | undefined,
): Promise<{ addresses: string[] } | undefined> {
  const app = SITE_TUNNEL_TAILNET_APP_NAME
  const stored = await storedTailnetSite()
  const authKey = givenKey ?? stored.authKey
  const siteDomain = givenDomain ?? stored.siteDomain
  if (authKey === undefined || siteDomain === undefined) {
    for (const ref of tailnetRefs()) await deleteObject(ref)
    return undefined
  }
  if (authKey !== stored.authKey || siteDomain !== stored.siteDomain) {
    const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
    await applyObject({
      apiVersion: 'v1', kind: 'Secret', metadata: metadata(TAILNET_AUTH_SECRET_NAME, app), type: 'Opaque',
      data: { authkey: b64(authKey), domain: b64(siteDomain) },
    })
  }
  // Created empty, and only when absent: tailscaled owns what is in it.
  try {
    await createObject({ apiVersion: 'v1', kind: 'Secret', metadata: metadata(TAILNET_STATE_SECRET_NAME, app), type: 'Opaque' })
  } catch (err) {
    if (apiStatus(err) !== 409) throw err
  }
  const [tailscaleImage, tailgateImage] = await Promise.all([
    prebuiltRef('tailscale', TAILSCALE_MIRROR_TAG),
    resolveTailgateImageTag().then((tag) => prebuiltRef('tailgate', tag)),
  ])
  for (const manifest of buildTailnetManifests({ tailscaleImage, tailgateImage, siteDomain })) await applyObject(manifest)
  const addresses = await waitFor(async () => {
    const ips = await tailnetAddresses()
    return ips.length > 0 ? ips : null
  }, { timeoutMs: TAILNET_JOIN_TIMEOUT_MS, intervalMs: 2_000 })
  if (!addresses) {
    throw new Error(
      'the tailnet tunnel did not join the tailnet within 3 minutes: check the auth key (TS_SITE_AUTHKEY; '
      + 'a used one-off key cannot join again) and that this network lets the pod out. Inspect with '
      + `\`kubectl -n ${k8sNamespace()} logs deploy/${app} -c tailscaled\`.`,
    )
  }
  return { addresses }
}

/** The tailnet tunnel's site domain and tailnet addresses, or null with no
 *  tunnel; `yaac cluster check` resolves a name under the one to the other. */
export async function siteTailnetDevice(): Promise<{ siteDomain: string; addresses: string[] } | null> {
  const { siteDomain } = await storedTailnetSite()
  return siteDomain ? { siteDomain, addresses: await tailnetAddresses() } : null
}

/**
 * The tailnet tunnel's state: `absent` with no Deployment, `joining`
 * until its device has a tailnet address, `no-certificate` until the
 * certificate Secret exists, and `ready` once tailgate serves.
 */
export async function siteTailnetStatus(): Promise<SiteTailnetState> {
  const dep = await readObject<{ status?: { readyReplicas?: number } }>(tailnetRef('apps/v1', 'Deployment'))
  if (!dep) return 'absent'
  if ((await tailnetAddresses()).length === 0) return 'joining'
  if (!await readObject(tailnetRef('v1', 'Secret', SITE_TUNNEL_TAILNET_TLS_SECRET_NAME))) return 'no-certificate'
  return (dep.status?.readyReplicas ?? 0) > 0 ? 'ready' : 'joining'
}

function tunnelRef(kind: 'Deployment' | 'Secret'): ObjectRef {
  return {
    apiVersion: kind === 'Secret' ? 'v1' : 'apps/v1',
    kind,
    name: kind === 'Secret' ? SITE_TUNNEL_CLOUDFLARE_SECRET_NAME : SITE_TUNNEL_CLOUDFLARE_APP_NAME,
    namespace: k8sNamespace(),
  }
}

const ROLLOUT_TIMEOUT_MS = 120_000

/**
 * Give the router every route file its bootstrap names, empty where absent,
 * leaving the ones the server wrote as they are. Envoy will not start while
 * a file it names is missing, and the server rewrites the table only once
 * it is deployed, after the edge. A table an older server wrote lacks
 * `rds-tailnet.json` (docs/legacy-compat-shims.md "A route table without
 * the tailnet file").
 */
async function ensureRouteFiles(): Promise<void> {
  const empty = routesConfigMap([])
  const live = await readObject<{ data?: Record<string, string> }>({
    apiVersion: 'v1', kind: 'ConfigMap', name: SITE_ROUTES_CONFIGMAP_NAME, namespace: k8sNamespace(),
  })
  if (live === null) {
    try {
      await createObject(empty)
    } catch (err) {
      if (apiStatus(err) !== 409) throw err
    }
    return
  }
  const emptyData = empty.data as Record<string, string>
  if (Object.keys(emptyData).every((file) => live.data?.[file] !== undefined)) return
  await applyObject({ ...empty, data: { ...emptyData, ...live.data } })
}

/**
 * Create or update the edge (run by `yaac cluster install`, and by the e2e
 * harness with neither tunnel). The router is always applied. The server
 * owns its route table, which install only creates empty or completes
 * (`ensureRouteFiles`). Each tunnel then converges on its own (`ensureCloudflareTunnel`,
 * `ensureTailnetTunnel`); what is returned is the tailnet tunnel's.
 */
export async function ensureSiteEdge(opts: {
  tunnelToken?: string
  tailnetAuthKey?: string
  siteDomain?: string
}): Promise<{ addresses: string[] } | undefined> {
  await ensureNamespace()
  const envoy = await prebuiltRef('Envoy', ENVOY_MIRROR_TAG)
  await syncSiteEdgeNodes(await nodeIpBlocks(), await clusterDnsCidrs(), await apiserverEndpoints())
  await ensureRouteFiles()
  for (const manifest of buildRouterManifests(envoy)) await applyObject(manifest)
  await waitForRollout({
    workload: `deployment/${SITE_ROUTER_APP_NAME}`,
    namespace: k8sNamespace(),
    timeoutMs: ROLLOUT_TIMEOUT_MS,
    hint: `Inspect with \`kubectl -n ${k8sNamespace()} get pods -l app=${SITE_ROUTER_APP_NAME}\` and its logs.`,
  })
  await ensureCloudflareTunnel(opts.tunnelToken)
  return ensureTailnetTunnel(opts.tailnetAuthKey, opts.siteDomain)
}

/**
 * Converge the Cloudflare tunnel. Its Secret is written only when given a
 * token, and its Deployment exists exactly while the Secret does, so a
 * later install without the token keeps the tunnel running.
 *
 * A tunnel under its legacy name has its token copied to the current
 * Secret, and its objects are deleted only once the current Deployment is
 * ready. cloudflared runs any number of connectors for one tunnel, so the
 * two overlap and no site drops.
 */
async function ensureCloudflareTunnel(token: string | undefined): Promise<void> {
  const hasSecret = await readObject(tunnelRef('Secret')) !== null
  const legacySecret = token === undefined && !hasSecret
    ? await readObject<{ data?: Record<string, string> }>({ ...tunnelRef('Secret'), name: LEGACY_TUNNEL_NAME })
    : null
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: metadata(SITE_TUNNEL_CLOUDFLARE_SECRET_NAME, SITE_TUNNEL_CLOUDFLARE_APP_NAME),
    type: 'Opaque',
  }
  if (token !== undefined) {
    await applyObject({ ...secret, stringData: { token } })
  } else if (legacySecret) {
    await applyObject({ ...secret, data: legacySecret.data })
  } else if (!hasSecret) {
    await deleteObject(tunnelRef('Deployment'))
    await retireLegacyTunnel()
    return
  }
  await applyObject(buildTunnelDeployment(await prebuiltRef('cloudflared', CLOUDFLARED_MIRROR_TAG)))
  await waitForRollout({
    workload: `deployment/${SITE_TUNNEL_CLOUDFLARE_APP_NAME}`,
    namespace: k8sNamespace(),
    timeoutMs: ROLLOUT_TIMEOUT_MS,
    hint: 'cloudflared goes ready only once it holds a connection to Cloudflare: check the '
      + 'token (CF_TUNNEL_TOKEN) and that this network lets out TCP and UDP 7844. Inspect with '
      + `\`kubectl -n ${k8sNamespace()} logs deploy/${SITE_TUNNEL_CLOUDFLARE_APP_NAME}\`.`,
  })
  await retireLegacyTunnel()
}

async function retireLegacyTunnel(): Promise<void> {
  const namespace = k8sNamespace()
  await Promise.all([
    { apiVersion: 'apps/v1', kind: 'Deployment', name: LEGACY_TUNNEL_NAME },
    { apiVersion: 'v1', kind: 'Secret', name: LEGACY_TUNNEL_NAME },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: `${LEGACY_TUNNEL_NAME}-egress` },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: `${LEGACY_TUNNEL_NAME}-ingress` },
  ].map((ref) => deleteObject({ ...ref, namespace })))
}

/**
 * Whether the tunnel holds a connection to Cloudflare: `absent` with no
 * tunnel Deployment, `connected` while a replica is ready (its `/ready`
 * answers 200 only then).
 */
export async function siteCloudflareStatus(): Promise<'connected' | 'disconnected' | 'absent'> {
  const dep = await readObject<{ status?: { readyReplicas?: number } }>(tunnelRef('Deployment'))
  if (!dep) return 'absent'
  return (dep.status?.readyReplicas ?? 0) > 0 ? 'connected' : 'disconnected'
}

/**
 * The public-site edge's barrel functions: the per-site objects and route
 * table the server converges, the router and tunnel install applies, and
 * the tunnel's status.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as childProcess from 'node:child_process'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { fakeRegistry } from '#test/support/fake-registry'

// The cluster and `kubectl rollout status` are the boundaries.
const rollouts = vi.hoisted((): string[] => [])
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  execFile: (_file: string, args: string[], _opts: unknown, cb: (err: unknown, res?: object) => void) => {
    rollouts.push(args[2])
    cb(null, { stdout: '', stderr: '' })
  },
}))

// The node and DNS address probes behind the policies read the live cluster.
vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  clusterDnsCidrs: vi.fn().mockResolvedValue(['10.96.0.10/32']),
}))

import {
  CLOUDFLARED_MIRROR_TAG,
  ENVOY_MIRROR_TAG,
  ensureSiteEdge,
  registryRef,
  siteTunnelStatus,
  syncSiteObjects,
} from '#drivers/k8s/cluster'

interface Manifest {
  kind: string
  metadata: { name: string; labels?: Record<string, string> }
  spec: Record<string, unknown> & {
    selector?: Record<string, unknown>
    template?: { metadata: { labels: Record<string, string> }; spec: PodSpec }
  }
  data?: Record<string, string>
  stringData?: Record<string, string>
}

interface PodSpec {
  runtimeClassName?: string
  priorityClassName: string
  automountServiceAccountToken: boolean
  securityContext: Record<string, unknown>
  containers: Array<Record<string, unknown> & { command: string[] }>
}

const stored = (kind: string, name: string): Manifest | undefined =>
  fakeCluster.get<Manifest>(kind, name, 'test-ns')

/** The route table as the router reads it from the routes ConfigMap. */
function routes(): { hosts: Array<{ domains: string[]; routes: unknown[] }>; clusters: Array<Record<string, unknown>> } {
  const data = stored('ConfigMap', 'yaac-site-routes')?.data ?? {}
  const rds = JSON.parse(data['rds.json']) as { resources: Array<{ virtual_hosts: Array<{ domains: string[]; routes: unknown[] }> }> }
  const cds = JSON.parse(data['cds.json']) as { resources: Array<Record<string, unknown>> }
  return { hosts: rds.resources[0].virtual_hosts, clusters: cds.resources }
}

/** The pod labels a policy's peers name, for every peer selector in it. */
function peerSelectors(np: Manifest | undefined): unknown[] {
  const rules = [...(np?.spec.ingress as unknown[] ?? []), ...(np?.spec.egress as unknown[] ?? [])] as
    Array<{ from?: Array<{ podSelector?: unknown }>; to?: Array<{ podSelector?: unknown }> }>
  return rules.flatMap((r) => [...r.from ?? [], ...r.to ?? []]).flatMap((p) => (p.podSelector ? [p.podSelector] : []))
}

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  rollouts.length = 0
  fakeRegistry.install()
  fakeRegistry.holdsAll = true
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('syncSiteObjects', () => {
  it('routes each hostname to its live release, answers the rest, and prunes what it no longer lists', async () => {
    // Left by a deleted site, and an object of someone else's.
    fakeCluster.seed(
      { apiVersion: 'v1', kind: 'Service', metadata: { name: 'yaac-site-gone', namespace: 'test-ns', labels: { app: 'yaac-site' } } },
      { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'yaac-site-gone', namespace: 'test-ns', labels: { app: 'yaac-site' } } },
      { apiVersion: 'v1', kind: 'Service', metadata: { name: 'yaac-proxy', namespace: 'test-ns', labels: { app: 'yaac-proxy' } } },
    )
    await syncSiteObjects([
      { siteId: 'blog', hostname: 'blog.example.com', port: 3000, liveWorkspaceId: 'ws-1' },
      { siteId: 'shop', hostname: 'shop.example.com', port: 8000 },
    ])

    // Headless, so the router dials the release's pod and a deploy's flip
    // moves new requests at once. A site with no live release selects
    // nothing, and no selector can pick a pod of another site.
    expect(stored('Service', 'yaac-site-blog')?.spec).toEqual({
      clusterIP: 'None',
      selector: { 'yaac.site-id': 'blog', 'yaac.workspace-id': 'ws-1' },
      ports: [{ name: 'http', port: 3000, targetPort: 3000, protocol: 'TCP' }],
    })
    expect(stored('Service', 'yaac-site-shop')?.spec.selector).toEqual({ 'yaac.site-id': 'shop', 'yaac.workspace-id': '' })
    // Only the router reaches a release, and only on the site's port.
    expect(stored('NetworkPolicy', 'yaac-site-blog')?.spec).toEqual({
      podSelector: { matchLabels: { 'yaac.site-id': 'blog' } },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{ podSelector: { matchLabels: { app: 'yaac-site-router' } } }],
        ports: [{ protocol: 'TCP', port: 3000 }],
      }],
    })

    const { hosts, clusters } = routes()
    expect(hosts.map((h) => h.domains)).toEqual([['blog.example.com'], ['shop.example.com'], ['*']])
    // No route timeout, which would cut SSE and long responses.
    expect(hosts[0].routes).toEqual([{ match: { prefix: '/' }, route: { cluster: 'yaac-site-blog', timeout: '0s' } }])
    expect(hosts[2].routes).toEqual([{ match: { prefix: '/' }, direct_response: { status: 404 } }])
    expect(clusters[1]).toMatchObject({
      name: 'yaac-site-shop',
      type: 'STRICT_DNS',
      dns_refresh_rate: '1s',
      load_assignment: { endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: {
        address: 'yaac-site-shop.test-ns.svc.cluster.local.', port_value: 8000,
      } } } }] }] },
    })

    expect(stored('Service', 'yaac-site-gone')).toBeUndefined()
    expect(stored('NetworkPolicy', 'yaac-site-gone')).toBeUndefined()
    expect(stored('Service', 'yaac-proxy')).toBeDefined()

    // A deploy's flip changes the selector and nothing in the route table.
    const before = stored('ConfigMap', 'yaac-site-routes')?.data
    await syncSiteObjects([
      { siteId: 'blog', hostname: 'blog.example.com', port: 3000, liveWorkspaceId: 'ws-2' },
      { siteId: 'shop', hostname: 'shop.example.com', port: 8000 },
    ])
    expect(stored('Service', 'yaac-site-blog')?.spec.selector).toEqual({ 'yaac.site-id': 'blog', 'yaac.workspace-id': 'ws-2' })
    expect(stored('ConfigMap', 'yaac-site-routes')?.data).toEqual(before)

    // No sites: every Host is a 404.
    await syncSiteObjects([])
    expect(routes()).toEqual({ hosts: [expect.objectContaining({ domains: ['*'] })], clusters: [] })
    expect(fakeCluster.objects<Manifest>('Service').map((s) => s.metadata.name)).toEqual(['yaac-proxy'])
    expect(fakeCluster.objects('NetworkPolicy')).toEqual([])
  })
})

describe('ensureSiteEdge', () => {
  it('stands up the router, walled off from everything but the tunnel and releases, with no tunnel', async () => {
    await ensureSiteEdge({})

    const router = stored('Deployment', 'yaac-site-router')
    expect(router?.spec.replicas).toBe(2)
    const pod = router?.spec.template?.spec
    // Trusted infra on runc, with no API token and no root.
    expect(pod).toMatchObject({
      priorityClassName: 'yaac-infra',
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true },
    })
    expect(pod?.runtimeClassName).toBeUndefined()
    expect(pod?.containers[0]).toMatchObject({
      image: registryRef(ENVOY_MIRROR_TAG),
      readinessProbe: { httpGet: { path: '/ready', port: 9901 } },
    })
    expect(stored('Service', 'yaac-site-router')?.spec).toMatchObject({
      type: 'ClusterIP',
      ports: [{ port: 8080, targetPort: 8080 }],
    })
    // The Service selects only the Deployment's replicas, so a probe pod
    // labelled like the router gets no public traffic.
    expect(stored('Service', 'yaac-site-router')?.spec.selector).toEqual(router?.spec.template?.metadata.labels)
    expect(router?.spec.template?.metadata.labels).not.toEqual({ app: 'yaac-site-router' })

    // A static listener whose routes and clusters come from the routes
    // ConfigMap, reloaded on the kubelet's symlink swap.
    const bootstrap = JSON.parse(stored('ConfigMap', 'yaac-site-router-bootstrap')?.data?.['bootstrap.json'] ?? '') as {
      admin: unknown
      static_resources: { listeners: Array<{ address: unknown; filter_chains: Array<{ filters: Array<{ typed_config: Record<string, unknown> }> }> }> }
      dynamic_resources: { cds_config: unknown }
    }
    const listener = bootstrap.static_resources.listeners[0]
    expect(listener.address).toEqual({ socket_address: { address: '0.0.0.0', port_value: 8080 } })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    const fileSource = (file: string): unknown => ({
      path_config_source: {
        path: `/etc/yaac-site-routes/${file}`, watched_directory: { path: '/etc/yaac-site-routes' },
      },
      resource_api_version: 'V3',
    })
    expect(hcm).toMatchObject({
      rds: { route_config_name: 'sites', config_source: fileSource('rds.json') },
      use_remote_address: true,
      xff_num_trusted_hops: 1,
      upgrade_configs: [{ upgrade_type: 'websocket' }],
    })
    expect(bootstrap.dynamic_resources.cds_config).toEqual(fileSource('cds.json'))
    expect(bootstrap.admin).toEqual({ address: { socket_address: { address: '0.0.0.0', port_value: 9901 } } })
    // Created empty: every Host gets a 404.
    expect(routes().clusters).toEqual([])

    // The router admits the tunnel on its port and the kubelet on admin,
    // and dials only DNS and release pods.
    expect(stored('NetworkPolicy', 'yaac-site-router-ingress')?.spec.ingress).toEqual([
      { from: [{ podSelector: { matchLabels: { app: 'yaac-site-tunnel' } } }], ports: [{ protocol: 'TCP', port: 8080 }] },
      { from: [{ ipBlock: { cidr: '10.89.0.7/32' } }], ports: [{ protocol: 'TCP', port: 9901 }] },
    ])
    expect(stored('NetworkPolicy', 'yaac-site-router-egress')?.spec.egress).toEqual([
      expect.objectContaining({ ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }),
      { to: [{ podSelector: { matchExpressions: [{ key: 'yaac.site-id', operator: 'Exists' }] } }] },
    ])
    // No edge policy names the server, the proxy, or workspaces at large.
    for (const name of ['yaac-site-router-ingress', 'yaac-site-router-egress', 'yaac-site-tunnel-ingress', 'yaac-site-tunnel-egress']) {
      expect(JSON.stringify(peerSelectors(stored('NetworkPolicy', name))), name)
        .not.toMatch(/yaac-server|yaac-proxy|yaac\.workspace-id/)
    }

    expect(stored('Secret', 'yaac-site-tunnel')).toBeUndefined()
    expect(stored('Deployment', 'yaac-site-tunnel')).toBeUndefined()
    expect(rollouts).toEqual(['deployment/yaac-site-router'])
  })

  it('keeps the route table the server wrote', async () => {
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: 'yaac-site-routes', namespace: 'test-ns' },
      data: { 'rds.json': 'server', 'cds.json': 'server' },
    })
    await ensureSiteEdge({})
    expect(stored('ConfigMap', 'yaac-site-routes')?.data).toEqual({ 'rds.json': 'server', 'cds.json': 'server' })
  })

  it('runs the tunnel once given a token, and for as long as its Secret is kept', async () => {
    await ensureSiteEdge({ tunnelToken: 'tok-1' })
    expect(stored('Secret', 'yaac-site-tunnel')?.stringData).toEqual({ token: 'tok-1' })
    const pod = stored('Deployment', 'yaac-site-tunnel')?.spec.template?.spec
    expect(pod).toMatchObject({
      priorityClassName: 'yaac-infra',
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532 },
    })
    expect(pod?.containers[0]).toMatchObject({
      image: registryRef(CLOUDFLARED_MIRROR_TAG),
      command: ['cloudflared', 'tunnel', '--no-autoupdate', '--loglevel', 'info', '--metrics', '0.0.0.0:2000', 'run'],
      env: [{ name: 'TUNNEL_TOKEN', valueFrom: { secretKeyRef: { name: 'yaac-site-tunnel', key: 'token' } } }],
      // Ready only while connected to Cloudflare, and never restarted for it.
      readinessProbe: { httpGet: { path: '/ready', port: 2000 } },
    })
    expect(pod?.containers[0]).not.toHaveProperty('livenessProbe')
    // Out to Cloudflare's edge on 7844 at public addresses only, to DNS, and
    // to the router; in from the kubelet on its metrics port.
    const egress = stored('NetworkPolicy', 'yaac-site-tunnel-egress')?.spec.egress as Array<Record<string, unknown>>
    expect(egress[0]).toEqual({
      to: [
        { ipBlock: expect.objectContaining({ cidr: '0.0.0.0/0', except: expect.arrayContaining(['10.89.0.7/32', '10.0.0.0/8']) as unknown }) as unknown },
        { ipBlock: expect.objectContaining({ cidr: '2000::/3' }) as unknown },
      ],
      ports: [{ protocol: 'TCP', port: 7844 }, { protocol: 'UDP', port: 7844 }],
    })
    expect(egress[2]).toEqual({
      to: [{ podSelector: { matchLabels: { app: 'yaac-site-router' } } }],
      ports: [{ protocol: 'TCP', port: 8080 }],
    })
    expect(stored('NetworkPolicy', 'yaac-site-tunnel-ingress')?.spec.ingress).toEqual([
      { from: [{ ipBlock: { cidr: '10.89.0.7/32' } }], ports: [{ protocol: 'TCP', port: 2000 }] },
    ])
    expect(rollouts).toEqual(['deployment/yaac-site-router', 'deployment/yaac-site-tunnel'])

    // A later install without the token keeps the Secret and the tunnel.
    await ensureSiteEdge({})
    expect(stored('Secret', 'yaac-site-tunnel')?.stringData).toEqual({ token: 'tok-1' })
    expect(stored('Deployment', 'yaac-site-tunnel')).toBeDefined()

    // Without the Secret there is no tunnel.
    fakeCluster.request({ verb: 'delete', apiVersion: 'v1', kind: 'Secret', name: 'yaac-site-tunnel', namespace: 'test-ns' })
    await ensureSiteEdge({})
    expect(stored('Deployment', 'yaac-site-tunnel')).toBeUndefined()
  })

  it('refuses before applying anything when Envoy was never mirrored', async () => {
    fakeRegistry.holdsAll = false
    await expect(ensureSiteEdge({})).rejects.toThrow(/Envoy/)
    expect(fakeCluster.callsOf('apply').filter((c) => c.kind !== 'Namespace')).toEqual([])
  })
})

describe('siteTunnelStatus', () => {
  it('reads the tunnel Deployment: absent, then connected while a replica is ready', async () => {
    await expect(siteTunnelStatus()).resolves.toBe('absent')
    const tunnel = (readyReplicas?: number): void => {
      fakeCluster.seed({
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'yaac-site-tunnel', namespace: 'test-ns' },
        status: readyReplicas === undefined ? {} : { readyReplicas },
      })
    }
    tunnel()
    await expect(siteTunnelStatus()).resolves.toBe('disconnected')
    tunnel(1)
    await expect(siteTunnelStatus()).resolves.toBe('connected')
  })
})

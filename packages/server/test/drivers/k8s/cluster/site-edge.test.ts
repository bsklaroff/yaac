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
  apiserverEndpoints: vi.fn().mockResolvedValue({ cidrs: ['10.89.0.7/32'], ports: [6443] }),
}))

import {
  CLOUDFLARED_MIRROR_TAG,
  ENVOY_MIRROR_TAG,
  TAILSCALE_MIRROR_TAG,
  ensureSiteEdge,
  installedSiteDomain,
  registryRef,
  resolveTailgateImageTag,
  siteCloudflareStatus,
  siteTailnetStatus,
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

interface RouteTable {
  name: string
  request_headers_to_remove?: string[]
  virtual_hosts: Array<{ domains: string[]; routes: unknown[] }>
}

/** A listener's route table as the router reads it from the routes
 *  ConfigMap (`rds.json` public, `rds-tailnet.json` tailnet), and the
 *  clusters the two share. */
function routes(file = 'rds.json'): { hosts: RouteTable['virtual_hosts']; clusters: Array<Record<string, unknown>> } {
  const cds = JSON.parse(stored('ConfigMap', 'yaac-site-routes')?.data?.['cds.json'] ?? '') as { resources: Array<Record<string, unknown>> }
  return { hosts: routeTable(file).virtual_hosts, clusters: cds.resources }
}

function routeTable(file: string): RouteTable {
  const rds = JSON.parse(stored('ConfigMap', 'yaac-site-routes')?.data?.[file] ?? '') as { resources: RouteTable[] }
  return rds.resources[0]
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
      { siteId: 'blog', hostname: 'blog.example.com', edge: 'public', port: 3000, liveWorkspaceId: 'ws-1' },
      { siteId: 'shop', hostname: 'shop.example.com', edge: 'public', port: 8000 },
      { siteId: 'kanban', hostname: 'kanban.apps.example.com', edge: 'tailnet', port: 3000, liveWorkspaceId: 'ws-3' },
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
    // Each listener's table names only its own edge's sites, so no Host the
    // Cloudflare tunnel sends reaches a tailnet site, and the reverse.
    expect(hosts.map((h) => h.domains)).toEqual([['blog.example.com'], ['shop.example.com'], ['*']])
    expect(routes('rds-tailnet.json').hosts.map((h) => h.domains)).toEqual([['kanban.apps.example.com'], ['*']])
    expect(clusters.map((c) => c.name)).toEqual(['yaac-site-blog', 'yaac-site-kanban', 'yaac-site-shop'])
    // The public listener drops any identity a client claims.
    expect(routeTable('rds.json').request_headers_to_remove).toEqual(
      ['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'tailscale-app-capabilities', 'tailscale-headers-info'],
    )
    expect(routeTable('rds-tailnet.json').request_headers_to_remove).toBeUndefined()
    // No route timeout, which would cut SSE and long responses.
    expect(hosts[0].routes).toEqual([{ match: { prefix: '/' }, route: { cluster: 'yaac-site-blog', timeout: '0s' } }])
    expect(hosts[2].routes).toEqual([{ match: { prefix: '/' }, direct_response: { status: 404 } }])
    expect(clusters[2]).toMatchObject({
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
      { siteId: 'blog', hostname: 'blog.example.com', edge: 'public', port: 3000, liveWorkspaceId: 'ws-2' },
      { siteId: 'shop', hostname: 'shop.example.com', edge: 'public', port: 8000 },
      { siteId: 'kanban', hostname: 'kanban.apps.example.com', edge: 'tailnet', port: 3000, liveWorkspaceId: 'ws-3' },
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
      ports: [{ port: 8080, targetPort: 8080 }, { name: 'tailnet', port: 8081, targetPort: 8081 }],
    })
    // The Service selects only the Deployment's replicas, so a probe pod
    // labelled like the router gets no public traffic.
    expect(stored('Service', 'yaac-site-router')?.spec.selector).toEqual(router?.spec.template?.metadata.labels)
    expect(router?.spec.template?.metadata.labels).not.toEqual({ app: 'yaac-site-router' })

    // A static listener per edge whose routes and clusters come from the
    // routes ConfigMap, reloaded on the kubelet's symlink swap.
    const bootstrap = JSON.parse(stored('ConfigMap', 'yaac-site-router-bootstrap')?.data?.['bootstrap.json'] ?? '') as {
      admin: unknown
      static_resources: { listeners: Array<{ address: unknown; filter_chains: Array<{ filters: Array<{ typed_config: Record<string, unknown> }> }> }> }
      dynamic_resources: { cds_config: unknown }
    }
    const [listener, tailnetListener] = bootstrap.static_resources.listeners
    expect(listener.address).toEqual({ socket_address: { address: '0.0.0.0', port_value: 8080 } })
    expect(tailnetListener.address).toEqual({ socket_address: { address: '0.0.0.0', port_value: 8081 } })
    const hcm = listener.filter_chains[0].filters[0].typed_config
    const tailnetHcm = tailnetListener.filter_chains[0].filters[0].typed_config
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
    // The tailnet listener answers 403 to a request carrying no login.
    expect(tailnetHcm).toMatchObject({
      rds: { route_config_name: 'sites-tailnet', config_source: fileSource('rds-tailnet.json') },
      use_remote_address: true,
      xff_num_trusted_hops: 1,
      upgrade_configs: [{ upgrade_type: 'websocket' }],
    })
    expect(JSON.stringify(tailnetHcm.http_filters)).toContain(
      '"principals":[{"header":{"name":"tailscale-user-login","present_match":true}}]',
    )
    expect(JSON.stringify(hcm.http_filters)).not.toContain('rbac')
    expect(bootstrap.dynamic_resources.cds_config).toEqual(fileSource('cds.json'))
    expect(bootstrap.admin).toEqual({ address: { socket_address: { address: '0.0.0.0', port_value: 9901 } } })
    // Created empty: every Host gets a 404.
    expect(routes().clusters).toEqual([])

    // The router admits the Cloudflare tunnel (by its legacy label too) on
    // the public port, the tailnet tunnel and the egress proxy on the
    // tailnet one, and the kubelet on admin, and dials only DNS and release
    // pods.
    expect(stored('NetworkPolicy', 'yaac-site-router-ingress')?.spec.ingress).toEqual([
      {
        from: [
          { podSelector: { matchLabels: { app: 'yaac-site-tunnel-cloudflare' } } },
          { podSelector: { matchLabels: { app: 'yaac-site-tunnel' } } },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
      {
        from: [
          { podSelector: { matchLabels: { app: 'yaac-site-tunnel-tailnet' } } },
          { podSelector: { matchLabels: { app: 'yaac-proxy' } } },
        ],
        ports: [{ protocol: 'TCP', port: 8081 }],
      },
      { from: [{ ipBlock: { cidr: '10.89.0.7/32' } }], ports: [{ protocol: 'TCP', port: 9901 }] },
    ])
    expect(stored('NetworkPolicy', 'yaac-site-router-egress')?.spec.egress).toEqual([
      expect.objectContaining({ ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }),
      { to: [{ podSelector: { matchExpressions: [{ key: 'yaac.site-id', operator: 'Exists' }] } }] },
    ])
    // No edge policy names the server or workspaces at large, and only the
    // router's ingress names the proxy, as a peer admitted in.
    for (const name of [
      'yaac-site-router-ingress', 'yaac-site-router-egress', 'yaac-site-tunnel-cloudflare-ingress',
      'yaac-site-tunnel-cloudflare-egress', 'yaac-site-tunnel-tailnet-ingress', 'yaac-site-tunnel-tailnet-egress',
    ]) {
      expect(JSON.stringify(peerSelectors(stored('NetworkPolicy', name))), name)
        .not.toMatch(name === 'yaac-site-router-ingress' ? /yaac-server|yaac\.workspace-id/ : /yaac-server|yaac-proxy|yaac\.workspace-id/)
    }

    expect(stored('Secret', 'yaac-site-tunnel-cloudflare')).toBeUndefined()
    expect(stored('Deployment', 'yaac-site-tunnel-cloudflare')).toBeUndefined()
    expect(stored('Deployment', 'yaac-site-tunnel-tailnet')).toBeUndefined()
    expect(rollouts).toEqual(['deployment/yaac-site-router'])
  })

  it('keeps the route table the server wrote, giving one an older server wrote the tailnet file it lacks', async () => {
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: 'yaac-site-routes', namespace: 'test-ns' },
      data: { 'rds.json': 'server', 'cds.json': 'server' },
    })
    await ensureSiteEdge({})
    // Envoy will not start while a file its bootstrap names is missing.
    const data = stored('ConfigMap', 'yaac-site-routes')?.data
    expect(data).toMatchObject({ 'rds.json': 'server', 'cds.json': 'server' })
    expect(routeTable('rds-tailnet.json').virtual_hosts.map((h) => h.domains)).toEqual([['*']])

    // A complete table is left alone.
    fakeCluster.seed({
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: 'yaac-site-routes', namespace: 'test-ns' },
      data: { 'rds.json': 'server', 'rds-tailnet.json': 'server', 'cds.json': 'server' },
    })
    await ensureSiteEdge({})
    expect(stored('ConfigMap', 'yaac-site-routes')?.data).toEqual({ 'rds.json': 'server', 'rds-tailnet.json': 'server', 'cds.json': 'server' })
  })

  it('runs the tunnel once given a token, and for as long as its Secret is kept', async () => {
    await ensureSiteEdge({ tunnelToken: 'tok-1' })
    expect(stored('Secret', 'yaac-site-tunnel-cloudflare')?.stringData).toEqual({ token: 'tok-1' })
    const pod = stored('Deployment', 'yaac-site-tunnel-cloudflare')?.spec.template?.spec
    expect(pod).toMatchObject({
      priorityClassName: 'yaac-infra',
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532 },
    })
    expect(pod?.containers[0]).toMatchObject({
      image: registryRef(CLOUDFLARED_MIRROR_TAG),
      command: ['cloudflared', 'tunnel', '--no-autoupdate', '--loglevel', 'info', '--metrics', '0.0.0.0:2000', 'run'],
      env: [{ name: 'TUNNEL_TOKEN', valueFrom: { secretKeyRef: { name: 'yaac-site-tunnel-cloudflare', key: 'token' } } }],
      // Ready only while connected to Cloudflare, and never restarted for it.
      readinessProbe: { httpGet: { path: '/ready', port: 2000 } },
    })
    expect(pod?.containers[0]).not.toHaveProperty('livenessProbe')
    // Out to Cloudflare's edge on 7844 at public addresses only, to DNS, and
    // to the router; in from the kubelet on its metrics port.
    const egress = stored('NetworkPolicy', 'yaac-site-tunnel-cloudflare-egress')?.spec.egress as Array<Record<string, unknown>>
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
    expect(stored('NetworkPolicy', 'yaac-site-tunnel-cloudflare-ingress')?.spec.ingress).toEqual([
      { from: [{ ipBlock: { cidr: '10.89.0.7/32' } }], ports: [{ protocol: 'TCP', port: 2000 }] },
    ])
    expect(rollouts).toEqual(['deployment/yaac-site-router', 'deployment/yaac-site-tunnel-cloudflare'])

    // A later install without the token keeps the Secret and the tunnel.
    await ensureSiteEdge({})
    expect(stored('Secret', 'yaac-site-tunnel-cloudflare')?.stringData).toEqual({ token: 'tok-1' })
    expect(stored('Deployment', 'yaac-site-tunnel-cloudflare')).toBeDefined()

    // Without the Secret there is no tunnel.
    fakeCluster.request({ verb: 'delete', apiVersion: 'v1', kind: 'Secret', name: 'yaac-site-tunnel-cloudflare', namespace: 'test-ns' })
    await ensureSiteEdge({})
    expect(stored('Deployment', 'yaac-site-tunnel-cloudflare')).toBeUndefined()
  })

  it('moves a tunnel from its legacy name, deleting the old objects only once the new one is up', async () => {
    const legacy = [
      { apiVersion: 'v1', kind: 'Secret', name: 'yaac-site-tunnel', data: { token: 'dG9rLTA=' } },
      { apiVersion: 'apps/v1', kind: 'Deployment', name: 'yaac-site-tunnel' },
      { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: 'yaac-site-tunnel-egress' },
      { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: 'yaac-site-tunnel-ingress' },
    ]
    for (const { name, ...o } of legacy) fakeCluster.seed({ ...o, metadata: { name, namespace: 'test-ns' } })
    const legacyNames = new Set(legacy.map((o) => o.name))
    const rolledOutBeforeDelete: boolean[] = []
    fakeCluster.intercept((call) => {
      if (call.verb === 'delete' && legacyNames.has(call.name ?? '')) {
        rolledOutBeforeDelete.push(rollouts.includes('deployment/yaac-site-tunnel-cloudflare'))
      }
      return undefined
    })
    await ensureSiteEdge({})

    expect(rolledOutBeforeDelete).toEqual([true, true, true, true])

    expect(stored('Secret', 'yaac-site-tunnel-cloudflare')?.data).toEqual({ token: 'dG9rLTA=' })
    expect(rollouts).toEqual(['deployment/yaac-site-router', 'deployment/yaac-site-tunnel-cloudflare'])
    const deleted = fakeCluster.callsOf('delete').filter((c) => legacyNames.has(c.name ?? '')).map((c) => `${c.kind}/${c.name}`)
    expect(deleted.sort()).toEqual([
      'Deployment/yaac-site-tunnel', 'NetworkPolicy/yaac-site-tunnel-egress',
      'NetworkPolicy/yaac-site-tunnel-ingress', 'Secret/yaac-site-tunnel',
    ])
    for (const { kind, name } of legacy) expect(stored(kind, name)).toBeUndefined()
  })

  it('runs the tailnet tunnel exactly while its Secret holds an auth key and a site domain, and reports its joined addresses', async () => {
    // tailscaled records its addresses in its state Secret once it joins.
    fakeCluster.intercept((call) => {
      if (call.verb === 'create' && call.kind === 'Secret' && call.name === 'yaac-site-tunnel-tailnet-state') {
        fakeCluster.seed({
          apiVersion: 'v1', kind: 'Secret', metadata: { name: 'yaac-site-tunnel-tailnet-state', namespace: 'test-ns' },
          data: { device_ips: Buffer.from('["100.64.0.9","fd7a:115c:a1e0::9"]').toString('base64') },
        })
      }
      return undefined
    })
    await expect(ensureSiteEdge({ tailnetAuthKey: 'tskey-1', siteDomain: 'apps.example.com' }))
      .resolves.toEqual({ addresses: ['100.64.0.9', 'fd7a:115c:a1e0::9'] })
    // The Secret records the domain beside the key, as the Cloudflare
    // tunnel's keeps its token.
    const secretData = (): Record<string, string> => Object.fromEntries(Object.entries(stored('Secret', 'yaac-site-tunnel-tailnet')?.data ?? {})
      .map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]))
    expect(secretData()).toEqual({ authkey: 'tskey-1', domain: 'apps.example.com' })

    const pod = stored('Deployment', 'yaac-site-tunnel-tailnet')?.spec as unknown as { replicas: number; template: { spec: PodSpec & Record<string, unknown> } }
    expect(pod.replicas).toBe(1)
    const spec = pod.template.spec
    // No privilege: non-root, no API token but tailscaled's own, and port 53
    // opened to non-root binds by sysctl instead of a capability.
    expect(spec).toMatchObject({
      automountServiceAccountToken: false,
      serviceAccountName: 'yaac-site-tunnel-tailnet',
      securityContext: {
        runAsNonRoot: true, runAsUser: 1000, sysctls: [{ name: 'net.ipv4.ip_unprivileged_port_start', value: '0' }],
      },
    })
    const [tailscaled, tailgate] = spec.containers as unknown as Array<{
      image: string
      env: Array<{ name: string; value?: string }>
      volumeMounts: Array<{ name: string }>
      securityContext: { runAsUser?: number }
    }>
    // Another uid than tailscaled's, so its local API gives tailgate only reads.
    expect(tailgate.securityContext.runAsUser).toBe(1001)
    expect(tailscaled.image).toBe(registryRef(TAILSCALE_MIRROR_TAG))
    expect(tailscaled.env).toEqual(expect.arrayContaining([
      { name: 'TS_KUBE_SECRET', value: 'yaac-site-tunnel-tailnet-state' },
      { name: 'TS_USERSPACE', value: 'true' },
      { name: 'TS_AUTH_ONCE', value: 'true' },
    ]))
    expect(tailscaled.volumeMounts.map((m) => m.name)).toContain('api')
    expect(tailgate.image).toBe(registryRef(await resolveTailgateImageTag()))
    expect(tailgate.volumeMounts.map((m) => m.name)).not.toContain('api')
    expect(tailgate.env).toEqual(expect.arrayContaining([
      { name: 'TAILGATE_SITE_DOMAIN', value: 'apps.example.com' },
      { name: 'TAILGATE_ROUTER', value: 'yaac-site-router.test-ns.svc.cluster.local:8081' },
    ]))
    // Its serve config forwards 443 and 80 to tailgate behind a PROXY header.
    expect(JSON.parse(stored('ConfigMap', 'yaac-site-tunnel-tailnet-serve')?.data?.['serve.json'] ?? '')).toEqual({
      TCP: {
        443: { TCPForward: '127.0.0.2:8443', ProxyProtocol: 1 },
        80: { TCPForward: '127.0.0.2:8080', ProxyProtocol: 1 },
      },
    })
    // Its token writes only its own state Secret.
    expect(fakeCluster.get<{ rules: unknown[] }>('Role', 'yaac-site-tunnel-tailnet', 'test-ns')?.rules).toEqual([{
      apiGroups: [''], resources: ['secrets'], resourceNames: ['yaac-site-tunnel-tailnet-state'], verbs: ['get', 'update', 'patch'],
    }])
    // Out to public addresses, DNS, the router's tailnet port and the apiserver.
    const egress = stored('NetworkPolicy', 'yaac-site-tunnel-tailnet-egress')?.spec.egress as Array<Record<string, unknown>>
    expect(egress[0]).not.toHaveProperty('ports')
    expect(egress.slice(2)).toEqual([
      { to: [{ podSelector: { matchLabels: { app: 'yaac-site-router' } } }], ports: [{ protocol: 'TCP', port: 8081 }] },
      { to: [{ ipBlock: { cidr: '10.89.0.7/32' } }], ports: [{ protocol: 'TCP', port: 6443 }] },
    ])

    // A later install naming neither keeps both, and one naming a domain
    // moves the tunnel to it, keeping the key.
    await expect(installedSiteDomain()).resolves.toBe('apps.example.com')
    await expect(ensureSiteEdge({})).resolves.toBeDefined()
    expect(secretData()).toEqual({ authkey: 'tskey-1', domain: 'apps.example.com' })
    await ensureSiteEdge({ siteDomain: 'sites.example.com' })
    expect(secretData()).toEqual({ authkey: 'tskey-1', domain: 'sites.example.com' })
    const tailgateEnv = (): unknown => (stored('Deployment', 'yaac-site-tunnel-tailnet')?.spec as unknown as {
      template: { spec: { containers: Array<{ env: unknown[] }> } }
    }).template.spec.containers[1].env
    expect(tailgateEnv()).toContainEqual({ name: 'TAILGATE_SITE_DOMAIN', value: 'sites.example.com' })

    // Without the Secret there is no tunnel.
    fakeCluster.request({ verb: 'delete', apiVersion: 'v1', kind: 'Secret', name: 'yaac-site-tunnel-tailnet', namespace: 'test-ns' })
    await expect(ensureSiteEdge({})).resolves.toBeUndefined()
    for (const [kind, name] of [
      ['Deployment', 'yaac-site-tunnel-tailnet'], ['Secret', 'yaac-site-tunnel-tailnet'],
      ['Secret', 'yaac-site-tunnel-tailnet-state'], ['Role', 'yaac-site-tunnel-tailnet'],
    ]) expect(stored(kind, name), `${kind}/${name}`).toBeUndefined()
  })

  it('refuses before applying anything when Envoy was never mirrored', async () => {
    fakeRegistry.holdsAll = false
    await expect(ensureSiteEdge({})).rejects.toThrow(/Envoy/)
    expect(fakeCluster.callsOf('apply').filter((c) => c.kind !== 'Namespace')).toEqual([])
  })
})

describe('siteTailnetStatus', () => {
  it('reads the tailnet tunnel: absent, joining, waiting for a certificate, then ready', async () => {
    await expect(siteTailnetStatus()).resolves.toBe('absent')
    const seed = (kind: string, name: string, extra: Record<string, unknown>): void => {
      fakeCluster.seed({ apiVersion: kind === 'Deployment' ? 'apps/v1' : 'v1', kind, metadata: { name, namespace: 'test-ns' }, ...extra })
    }
    seed('Deployment', 'yaac-site-tunnel-tailnet', { status: {} })
    seed('Secret', 'yaac-site-tunnel-tailnet-state', { data: {} })
    await expect(siteTailnetStatus()).resolves.toBe('joining')
    seed('Secret', 'yaac-site-tunnel-tailnet-state', { data: { device_ips: Buffer.from('["100.64.0.9"]').toString('base64') } })
    await expect(siteTailnetStatus()).resolves.toBe('no-certificate')
    seed('Secret', 'yaac-site-tunnel-tailnet-tls', { data: {} })
    seed('Deployment', 'yaac-site-tunnel-tailnet', { status: { readyReplicas: 1 } })
    await expect(siteTailnetStatus()).resolves.toBe('ready')
  })
})

describe('siteCloudflareStatus', () => {
  it('reads the tunnel Deployment: absent, then connected while a replica is ready', async () => {
    await expect(siteCloudflareStatus()).resolves.toBe('absent')
    const tunnel = (readyReplicas?: number): void => {
      fakeCluster.seed({
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'yaac-site-tunnel-cloudflare', namespace: 'test-ns' },
        status: readyReplicas === undefined ? {} : { readyReplicas },
      })
    }
    tunnel()
    await expect(siteCloudflareStatus()).resolves.toBe('disconnected')
    tunnel(1)
    await expect(siteCloudflareStatus()).resolves.toBe('connected')
  })
})

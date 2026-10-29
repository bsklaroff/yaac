/**
 * The crates.io cache's barrel function: deploying the nginx that serves
 * cargo's sparse registry from its claim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as childProcess from 'node:child_process'
import { fakeCluster } from '@yaac/test-utils/k8s-stub'
import { fakeRegistry } from '#test/support/fake-registry'

// The cluster and `kubectl rollout status` are the boundaries; everything
// behind them runs for real. `events` records their order.
const events = vi.hoisted((): string[] => [])
const mockRollout = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  execFile: (_file: string, args: string[], _opts: unknown, cb: (err: unknown, res?: object) => void) => {
    events.push(args.slice(0, 3).join(' '))
    ;(mockRollout() as Promise<void>).then(() => { cb(null, { stdout: '', stderr: '' }) }, cb)
  },
}))

// The node-CIDR probe behind the network policies reads the live cluster.
vi.mock('#drivers/k8s/cluster/cluster-cidrs', () => ({
  nodeIpBlocks: vi.fn().mockResolvedValue(['10.89.0.7/32']),
  clusterPodCidrs: vi.fn().mockResolvedValue(['10.244.0.0/16']),
}))

import { NGINX_MIRROR_TAG, ensureCratesCache, registryRef } from '#drivers/k8s/cluster'
// A setup value: the claim name carries it.
import { installId } from '#drivers/k8s/substrate'

interface Manifest {
  kind: string
  metadata: { name: string; namespace: string }
  spec: Record<string, unknown>
  data?: Record<string, string>
}

const applied = (): Manifest[] => fakeCluster.callsOf('apply').map((c) => c.body as unknown as Manifest)
const appliedNamed = (kind: string, name: string): Manifest | undefined =>
  applied().find((m) => m.kind === kind && m.metadata.name === name)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  events.length = 0
  fakeRegistry.install()
  fakeRegistry.holdsAll = true
  mockRollout.mockResolvedValue(undefined)
  fakeCluster.intercept((call) => { events.push(`${call.verb} ${call.kind}`) })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('ensureCratesCache', () => {
  it('stands up one nginx caching crates.io on its claim, walled to workspaces, and publishes it last', async () => {
    await ensureCratesCache()

    // One writer at a time: one replica, recreated rather than rolled, and
    // its cache on the claim so it outlives the pod.
    const claim = `yaac-crates-cache-storage-${installId()}`
    expect(appliedNamed('Deployment', 'yaac-crates-cache')?.spec).toMatchObject({
      replicas: 1,
      strategy: { type: 'Recreate' },
      template: {
        spec: {
          securityContext: { fsGroup: 101 },
          dnsConfig: { options: [{ name: 'ndots', value: '1' }] },
          containers: [{
            name: 'nginx',
            image: registryRef(NGINX_MIRROR_TAG),
            ports: [{ containerPort: 4875 }],
            // Answered locally, so an upstream outage never unreadies it.
            readinessProbe: { httpGet: { path: '/index/config.json', port: 4875 } },
            volumeMounts: [
              { name: 'config', mountPath: '/etc/nginx/templates', readOnly: true },
              { name: 'nginx-conf', mountPath: '/etc/nginx/conf.d' },
              { name: 'storage', mountPath: '/var/cache/crates' },
            ],
          }],
          volumes: expect.arrayContaining([
            { name: 'storage', persistentVolumeClaim: { claimName: claim } },
          ]) as unknown,
        },
      },
    })
    expect(appliedNamed('PersistentVolumeClaim', claim)?.spec).toEqual({
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '20Gi' } },
    })

    const conf = appliedNamed('ConfigMap', 'yaac-crates-cache-config')?.data?.['crates-cache.conf.template'] ?? ''
    expect(conf).toContain('listen 4875;')
    expect(conf).toMatch(/^proxy_cache_path \/var\/cache\/crates\/index .*keys_zone=crates_index:/m)
    expect(conf).toMatch(/^proxy_cache_path \/var\/cache\/crates\/files .*keys_zone=crates_files:/m)
    // cargo downloads from wherever config.json says, so it names this
    // cache, and names no API to publish to.
    expect(conf).toContain(
      'return 200 \'{"dl":"http://yaac-crates-cache.test-ns.svc.cluster.local:4875/crates/{crate}/{crate}-{version}.crate"}\';')
    // Index files change with each publish: kept briefly, with concurrent
    // misses collapsed and stale copies served while crates.io is down.
    expect(conf).toMatch(
      /location \^~ \/index\/ \{\s*limit_except GET \{ deny all; \}\s*rewrite \^\/index\(\/\.\*\)\$ \$1 break;\s*proxy_cache crates_index;\s*proxy_cache_valid 200 404 1m;\s*proxy_pass https:\/\/\$crates_index;/)
    // A published .crate never changes.
    expect(conf).toMatch(
      /location \^~ \/crates\/ \{\s*limit_except GET \{ deny all; \}\s*proxy_cache crates_files;\s*proxy_cache_valid 200 1y;\s*proxy_pass https:\/\/\$crates_static;/)
    for (const line of [
      'set $crates_index index.crates.io;',
      'set $crates_static static.crates.io;',
      'proxy_cache_lock on;',
      'proxy_cache_use_stale updating error timeout http_500 http_502 http_503 http_504;',
      'proxy_cache_revalidate on;',
      'proxy_set_header Authorization "";',
      'proxy_set_header Cookie "";',
      'proxy_ssl_verify on;',
      'resolver ${NGINX_LOCAL_RESOLVERS} ipv6=off valid=60s;',
    ]) expect(conf).toContain(line)

    // Only workspace pods labelled for this cache (a project with
    // `cratesCache: false` gets no label), on both ends of the connection.
    const admitted = {
      matchLabels: { 'yaac.crates-cache': 'true' },
      matchExpressions: [{ key: 'yaac.workspace-id', operator: 'Exists' }],
    }
    const port = { protocol: 'TCP', port: 4875 }
    expect(appliedNamed('NetworkPolicy', 'yaac-crates-cache-ingress')?.spec).toEqual({
      podSelector: { matchLabels: { app: 'yaac-crates-cache' } },
      policyTypes: ['Ingress'],
      ingress: [
        { from: [{ podSelector: admitted }], ports: [port] },
        { from: [{ ipBlock: { cidr: '10.89.0.7/32' } }], ports: [port] },
      ],
    })
    expect(appliedNamed('NetworkPolicy', 'yaac-crates-cache-workspace-egress')?.spec).toEqual({
      podSelector: admitted,
      policyTypes: ['Egress'],
      egress: [{ to: [{ podSelector: { matchLabels: { app: 'yaac-crates-cache' } } }], ports: [port] }],
    })
    // Egress to crates.io, but never to in-cluster 443 listeners.
    expect(appliedNamed('NetworkPolicy', 'yaac-crates-cache-egress')?.spec).toMatchObject({
      egress: [
        {
          to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.244.0.0/16', '10.89.0.7/32'] } }],
          ports: [{ protocol: 'TCP', port: 443 }],
        },
        { ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
      ],
    })

    // A cache that never came up has no Service.
    expect(events.slice(-2)).toEqual(['rollout status deployment/yaac-crates-cache', 'apply Service'])
    expect(appliedNamed('Service', 'yaac-crates-cache')?.spec).toMatchObject({
      ports: [{ port: 4875, targetPort: 4875, protocol: 'TCP' }],
    })
  })

  it('refuses before applying anything when nginx was never mirrored', async () => {
    fakeRegistry.holdsAll = false
    await expect(ensureCratesCache()).rejects.toThrow(/nginx/)
    expect(applied()).toEqual([])
  })
})

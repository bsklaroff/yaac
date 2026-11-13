/**
 * The public-site objects the server converges
 * (`drivers/k8s/cluster/site-edge.ts`) against a real kube-apiserver, read
 * back with kubectl: the apiserver accepts every one under server-side
 * apply, keeps each policy peer, and a sync prunes what it stops listing.
 * The router and tunnel Deployments are left to the e2e tiers, since a
 * rollout needs controllers this tier does not run.
 */
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { applyObject, ensureKubernetes } from '@yaac/server/drivers/k8s/substrate/api'
import { syncSiteEdgeNodes, syncSiteObjects } from '@yaac/server/drivers/k8s/cluster/site-edge'

const NS = 'yaac-sites'
let kubectlBin = ''
let savedNs: string | undefined

const names = (kind: string): string[] =>
  (JSON.parse(execFileSync(kubectlBin, ['get', kind, '-n', NS, '-o', 'json'], { encoding: 'utf8' })) as {
    items: Array<{ metadata: { name: string } }>
  }).items.map((i) => i.metadata.name)
const get = <T>(kind: string, name: string): T =>
  JSON.parse(execFileSync(kubectlBin, ['get', kind, name, '-n', NS, '-o', 'json'], { encoding: 'utf8' })) as T

beforeAll(async () => {
  savedNs = process.env.YAAC_K8S_NAMESPACE
  process.env.KUBECONFIG = inject('apiserverKubeconfig')
  process.env.YAAC_K8S_NAMESPACE = NS
  kubectlBin = inject('apiserverKubectl')
  await ensureKubernetes()
  await applyObject({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } })
})

afterAll(() => {
  if (savedNs === undefined) delete process.env.YAAC_K8S_NAMESPACE
  else process.env.YAAC_K8S_NAMESPACE = savedNs
})

describe('site objects', () => {
  it('applies, flips and prunes each site\'s Service and policy, and the edge policies', async () => {
    await syncSiteEdgeNodes(['172.18.0.2/32'], ['10.96.0.10/32'], { cidrs: ['172.18.0.2/32'], ports: [6443] })
    expect(names('networkpolicy')).toEqual([
      'yaac-site-router-egress', 'yaac-site-router-ingress', 'yaac-site-tunnel-cloudflare-egress',
      'yaac-site-tunnel-cloudflare-ingress', 'yaac-site-tunnel-tailnet-egress', 'yaac-site-tunnel-tailnet-ingress',
    ])
    type Rule = { from?: unknown[]; to?: unknown[]; ports?: unknown[] }
    const tunnelEgress = get<{ spec: { egress: Rule[] } }>('networkpolicy', 'yaac-site-tunnel-cloudflare-egress')
    expect(tunnelEgress.spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: 7844 }, { protocol: 'UDP', port: 7844 }])
    expect(tunnelEgress.spec.egress.every((r) => r.to)).toBe(true)

    // A headless Service with no live release, whose selector matches no pod.
    await syncSiteObjects([{ siteId: 'blog', hostname: 'blog.example.com', edge: 'public', port: 3000 }])
    type Svc = { spec: { clusterIP: string; selector: Record<string, string> } }
    expect(get<Svc>('service', 'yaac-site-blog').spec).toMatchObject({
      clusterIP: 'None', selector: { 'yaac.site-id': 'blog', 'yaac.workspace-id': '' },
    })
    const ingress = get<{ spec: { ingress: Rule[] } }>('networkpolicy', 'yaac-site-blog').spec.ingress
    expect(ingress[0].from).toEqual([{ podSelector: { matchLabels: { app: 'yaac-site-router' } } }])

    await syncSiteObjects([{ siteId: 'blog', hostname: 'blog.example.com', edge: 'public', port: 3000, liveWorkspaceId: 'ws-1' }])
    expect(get<Svc>('service', 'yaac-site-blog').spec.selector).toEqual({ 'yaac.site-id': 'blog', 'yaac.workspace-id': 'ws-1' })
    expect(Object.keys(get<{ data: Record<string, string> }>('configmap', 'yaac-site-routes').data).sort())
      .toEqual(['cds.json', 'rds-tailnet.json', 'rds.json'])

    await syncSiteObjects([])
    expect(names('service')).toEqual([])
    expect(names('networkpolicy')).not.toContain('yaac-site-blog')
  })
})

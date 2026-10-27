/**
 * `drivers/k8s/substrate/api.ts` against a real kube-apiserver (see
 * global-setup.ts): what reaches etcd, read back with kubectl rather than
 * through the code under test.
 */
import { execFileSync } from 'node:child_process'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import {
  apiStatus,
  applyObject,
  createObject,
  deleteObject,
  deleteObjects,
  ensureKubernetes,
  listObjects,
  patchObject,
  readObject,
} from '@yaac/server/drivers/k8s/substrate/api'
import {
  buildEgressWorldDenyNpManifest,
  buildProxyEgressNpManifest,
  buildProxyIngressNpManifest,
  buildServerFrontIngressNpManifest,
  buildServerIngressNpManifest,
  buildWorkspaceEgressNpManifest,
  buildWorkspaceIngressLockNpManifest,
} from '@yaac/server/drivers/k8s/cluster/policy-manifests'
import { PROXY_APP_NAME, PROXY_EGRESS_NP_NAME } from '@yaac/server/drivers/k8s/substrate/proxy-constants'

const NS = 'yaac'
let kubectlBin = ''

/** An object as stored, read with kubectl against the test API server. */
const stored = <T>(kind: string, name: string): T =>
  JSON.parse(execFileSync(kubectlBin, ['get', kind, name, '-n', NS, '-o', 'json'], { encoding: 'utf8' })) as T
const ref = (kind: string, name: string, apiVersion = 'v1') => ({ apiVersion, kind, name, namespace: NS })
const configMap = (name: string, data: Record<string, string>, labels?: Record<string, string>) => ({
  apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: NS, ...(labels ? { labels } : {}) }, data,
})

beforeAll(async () => {
  process.env.KUBECONFIG = inject('apiserverKubeconfig')
  kubectlBin = inject('apiserverKubectl')
  await ensureKubernetes()
  await applyObject({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } })
})

describe('object writes and reads', () => {
  // client-node's typed models rename a rule's `from` to `_from`; a body
  // serialized through them reaches the server without it, and the rule
  // then admits every source.
  it('stores every NetworkPolicy peer yaac sends, and reads it back in wire shape', async () => {
    const cidrs = ['172.18.0.2/32']
    const policies = [
      buildWorkspaceEgressNpManifest(cidrs),
      buildWorkspaceIngressLockNpManifest(),
      buildProxyIngressNpManifest(cidrs),
      buildProxyEgressNpManifest(cidrs, ['10.96.0.10/32'], { cidrs: ['172.18.0.3/32'], ports: [6443] }),
      buildServerIngressNpManifest(cidrs, true),
      buildServerFrontIngressNpManifest([{ podSelector: { matchLabels: { app: 'fronting' } } }]),
      buildEgressWorldDenyNpManifest(),
    ]
    type Rule = { from?: unknown[]; to?: unknown[] }
    type Policy = { metadata: { name: string }; spec: { ingress?: Rule[]; egress?: Rule[] } }
    const peers = (p: Policy) => [
      (p.spec.ingress ?? []).map((r) => r.from ?? null),
      (p.spec.egress ?? []).map((r) => r.to ?? null),
    ]
    for (const manifest of policies as unknown as Policy[]) {
      await applyObject(manifest)
      const name = manifest.metadata.name
      expect(peers(stored<Policy>('networkpolicy', name)), name).toEqual(peers(manifest))
      const read = await readObject<Policy>(ref('NetworkPolicy', name, 'networking.k8s.io/v1'))
      expect(peers(read!), name).toEqual(peers(manifest))
      expect(JSON.stringify(read)).not.toContain('"_from"')
    }
  })

  // An internal destination is opened by the network operator's own policy
  // (docs/workspace-egress.md "Opening an internal destination"). Allows add
  // up across every policy selecting a pod, so the opening only has to
  // outlive yaac re-applying its own policies, which leave it untouched.
  it('keeps an operator policy opening a CIDR to the proxy across yaac\'s re-apply', async () => {
    const opening = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'operator-git-internal', namespace: NS },
      spec: {
        podSelector: { matchLabels: { app: PROXY_APP_NAME } },
        policyTypes: ['Egress'],
        egress: [{ to: [{ ipBlock: { cidr: '10.20.0.5/32' } }], ports: [{ protocol: 'TCP', port: 443 }] }],
      },
    }
    execFileSync(kubectlBin, ['apply', '-f', '-'], { input: JSON.stringify(opening) })
    await applyObject(buildProxyEgressNpManifest(['172.18.0.2/32'], [], { cidrs: [], ports: [] }))
    await applyObject(buildEgressWorldDenyNpManifest())

    type Policy = { spec: { podSelector: unknown; egress: Array<{ to: Array<{ ipBlock?: { except?: string[] } }> }> } }
    expect(stored<Policy>('networkpolicy', 'operator-git-internal').spec).toEqual(opening.spec)
    // yaac's own policy still denies the range; the opening is the operator's.
    const own = stored<Policy>('networkpolicy', PROXY_EGRESS_NP_NAME)
    expect(own.spec.podSelector).toEqual(opening.spec.podSelector)
    expect(own.spec.egress[0].to[0].ipBlock?.except).toContain('10.0.0.0/8')
  })

  it('prunes what yaac stops sending, but keeps what a merge patch set', async () => {
    await applyObject(configMap('prune', { a: '1', b: '2' }))
    await patchObject(ref('ConfigMap', 'prune'), { metadata: { labels: { claimed: 'yes' } } })
    await applyObject(configMap('prune', { a: '1' }))
    const cm = stored<{ data: object; metadata: { labels?: Record<string, string> } }>('configmap', 'prune')
    expect(cm.data).toEqual({ a: '1' })
    expect(cm.metadata.labels).toEqual({ claimed: 'yes' })

    await patchObject(ref('ConfigMap', 'prune'), { metadata: { labels: { claimed: null } } })
    expect(stored<{ metadata: { labels?: object } }>('configmap', 'prune').metadata.labels).toBeUndefined()
  })

  // The spare claim's compare-and-swap: a merge patch carrying a stale
  // resourceVersion must be refused, so a second claimer loses.
  it('refuses a merge patch that carries a stale resourceVersion', async () => {
    await applyObject(configMap('cas', {}))
    const seen = (await readObject<{ metadata: { resourceVersion: string } }>(ref('ConfigMap', 'cas')))!
    const claim = { metadata: { resourceVersion: seen.metadata.resourceVersion, labels: { claimed: 'yes' } } }
    await patchObject(ref('ConfigMap', 'cas'), claim)
    expect(apiStatus(await patchObject(ref('ConfigMap', 'cas'), claim).catch((e: unknown) => e))).toBe(409)
  })

  it('creates once, lists by selector, and deletes', async () => {
    await createObject(configMap('one', {}, { grp: 'g' }))
    expect(apiStatus(await createObject(configMap('one', {})).catch((e: unknown) => e))).toBe(409)
    await applyObject(configMap('two', {}, { grp: 'h' }))

    const names = async (opts: { labelSelector?: string; fieldSelector?: string }) =>
      (await listObjects('v1', 'ConfigMap', { namespace: NS, ...opts })).map((o) => o.metadata?.name)
    expect(await names({ labelSelector: 'grp=g' })).toEqual(['one'])
    expect(await names({ fieldSelector: 'metadata.name=two' })).toEqual(['two'])

    await deleteObjects('v1', 'ConfigMap', { namespace: NS, labelSelector: 'grp', wait: true })
    expect(await names({ labelSelector: 'grp' })).toEqual([])
    await deleteObject(ref('ConfigMap', 'one'))
  })

  it('reads an absent object, kind or API group as null', async () => {
    expect(await readObject(ref('ConfigMap', 'missing'))).toBeNull()
    expect(await readObject({ apiVersion: 'v1', kind: 'NoSuchKind', name: 'x' })).toBeNull()
    expect(await readObject({ apiVersion: 'crd.projectcalico.org/v1', kind: 'IPPool', name: 'x' })).toBeNull()
  })
})

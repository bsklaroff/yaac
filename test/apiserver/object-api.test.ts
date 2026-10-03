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

const NS = 'yaac'
let kubectlBin = ''

/** kubectl against the test API server; JSON in, JSON out. */
function kubectl(args: string[], input?: object): unknown {
  const out = execFileSync(kubectlBin, args, {
    encoding: 'utf8',
    input: input ? JSON.stringify(input) : '',
  })
  return out.trim().startsWith('{') ? JSON.parse(out) : out
}

const stored = <T>(kind: string, name: string): T =>
  kubectl(['get', kind, name, '-n', NS, '-o', 'json', '--show-managed-fields']) as T
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
      buildProxyEgressNpManifest(cidrs),
      buildServerIngressNpManifest(cidrs),
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

  // An install made before yaac used server-side apply has every field
  // owned by `kubectl-client-side-apply`. Unadopted, a key yaac stops
  // sending (a signed-out credential) would stay forever.
  it('adopts an older client-side apply, so a dropped key or env var is pruned at once', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64')
    const secret = (keys: string[]) => ({
      apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
      metadata: { name: 'creds', namespace: NS },
      data: Object.fromEntries(keys.map((k) => [k, b64(k)])),
    })
    kubectl(['apply', '-f', '-'], secret(['claude.json', 'pi.json']))
    await applyObject(secret(['claude.json']))
    const s = stored<{
      data: object
      metadata: { annotations?: Record<string, string>; managedFields: Array<{ manager: string }> }
    }>('secret', 'creds')
    expect(Object.keys(s.data)).toEqual(['claude.json'])
    expect(s.metadata.managedFields.map((f) => f.manager)).not.toContain('kubectl-client-side-apply')
    expect(s.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']).toBeUndefined()

    const deployment = (env: string[]) => ({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'server', namespace: NS },
      spec: {
        selector: { matchLabels: { app: 'server' } },
        template: {
          metadata: { labels: { app: 'server' } },
          spec: { containers: [{ name: 'c', image: 'x', env: env.map((name) => ({ name, value: '1' })) }] },
        },
      },
    })
    kubectl(['apply', '-f', '-'], deployment(['KEEP', 'YAAC_USE_TOR']))
    await applyObject(deployment(['KEEP']))
    const d = stored<{ spec: { template: { spec: { containers: Array<{ env: Array<{ name: string }> }> } } } }>(
      'deployment', 'server')
    expect(d.spec.template.spec.containers[0].env.map((e) => e.name)).toEqual(['KEEP'])
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

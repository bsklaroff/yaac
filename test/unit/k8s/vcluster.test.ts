import { describe, it, expect, vi, beforeEach } from 'vitest'
import YAML from 'yaml'

interface K8sObj {
  kind: string
  metadata: { labels: Record<string, string> }
}
const parseDocs = (s: string): K8sObj[] =>
  s.split(/^---$/m).map((d) => YAML.parse(d) as K8sObj)

vi.mock('@/lib/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('@/lib/k8s/registry', () => ({
  registryHost: vi.fn(() => 'localhost:5001'),
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('@/lib/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

import {
  LABEL_VCLUSTER,
  LABEL_VCLUSTER_DATA_DIR_HASH,
  LABEL_VCLUSTER_MANAGED_BY,
  LABEL_VCLUSTER_SESSION_ID,
  VCLUSTER_API_PORT,
  VCLUSTER_POD_GUARD_POLICY,
  addYaacLabels,
  buildVclusterCleanupShellCommand,
  buildVclusterControlPlaneCnpManifest,
  buildVclusterNamespaceManifest,
  buildVclusterNamespaceWorldDenyManifest,
  buildVclusterPodGuardBindingManifest,
  buildVclusterPodGuardPolicyManifest,
  buildVclusterSessionNetworkPolicyManifest,
  buildVclusterSyncedPodsNetworkPolicyManifest,
  ensureHelm,
  ensureSessionVcluster,
  ensureVclusterImages,
  getVclusterStatus,
  listVclusterNamespaces,
  renderVclusterManifests,
  vclusterCleanupKubectlArgs,
  vclusterClusterIp,
  vclusterKubeconfigSecretName,
  vclusterName,
  vclusterNamespace,
  waitForVclusterKubeconfig,
} from '@/lib/k8s/vcluster'
import { clusterIpForService } from '@/lib/k8s/bootstrap'
import {
  execFileAsync,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '@/lib/k8s/kubectl'
import { pushImageToRegistry, registryHasTag } from '@/lib/k8s/registry'
import { imageExists } from '@/lib/container/runtime'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(execFileAsync)
const mockHasTag = vi.mocked(registryHasTag)
const mockPush = vi.mocked(pushImageToRegistry)
const mockImageExists = vi.mocked(imageExists)

const SID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'
const VC = 'yvc-0a1b2c3d'
/** The vcluster's dedicated host namespace: <install-ns>-vc-<sid8>. */
const VCNS = 'test-ns-vc-0a1b2c3d'

beforeEach(() => {
  mockApply.mockReset()
  mockApply.mockResolvedValue(undefined)
  mockGetJson.mockReset()
  mockRetry.mockReset()
  mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
  mockExec.mockReset()
  mockExec.mockResolvedValue({ stdout: '', stderr: '' })
  mockHasTag.mockReset()
  mockHasTag.mockResolvedValue(true)
  mockPush.mockReset()
  mockPush.mockImplementation((tag: string) => Promise.resolve(`localhost:5001/${tag}`))
  mockImageExists.mockReset()
  mockImageExists.mockResolvedValue(false)
})

describe('names and pins', () => {
  it('derives yvc-<sid8> from the session UUID', () => {
    expect(vclusterName(SID)).toBe(VC)
    expect(vclusterName('ABC-DEF-123456789')).toBe('yvc-abcdef12')
  })

  it('pins the API Service VIP via the keyed generalization', () => {
    expect(vclusterClusterIp(VC)).toBe(clusterIpForService('test-ns', VC))
  })

  it('names the syncer-written kubeconfig secret vc-<name>', () => {
    expect(vclusterKubeconfigSecretName(VC)).toBe(`vc-${VC}`)
  })
})

describe('addYaacLabels', () => {
  const DOCS = [
    'apiVersion: v1\nkind: Service\nmetadata:\n  name: yvc-x\n  labels:\n    app: vcluster\nspec:\n  type: ClusterIP\n',
    'apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: vc-yvc-x\nrules: []\n',
  ].join('---\n')

  it('adds the yaac labels to every object, merging with existing labels', () => {
    const out = addYaacLabels(DOCS, { [LABEL_VCLUSTER]: VC, [LABEL_VCLUSTER_SESSION_ID]: SID })
    const objs = parseDocs(out)
    expect(objs.map((o) => o.kind)).toEqual(['Service', 'ClusterRole'])
    for (const o of objs) {
      expect(o.metadata.labels[LABEL_VCLUSTER]).toBe(VC)
      expect(o.metadata.labels[LABEL_VCLUSTER_SESSION_ID]).toBe(SID)
    }
    // Existing chart labels survive (the Service already had app: vcluster);
    // an object with no labels block gets one created.
    expect(objs[0].metadata.labels.app).toBe('vcluster')
    expect(objs[1].metadata.labels[LABEL_VCLUSTER]).toBe(VC)
  })

  it('skips empty docs and non-Kubernetes scalars', () => {
    expect(addYaacLabels('', { x: 'y' })).toBe('')
    expect(addYaacLabels('---\n# just a comment\n', { x: 'y' })).toBe('')
  })

  it('keeps a long base64 scalar on one line (lineWidth 0)', () => {
    const blob = 'A'.repeat(400)
    const doc = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  config.yaml: ${blob}\n`
    const out = addYaacLabels(doc, { [LABEL_VCLUSTER]: VC })
    expect(out).toContain(blob) // unbroken — no folding mid-token
  })
})

describe('renderVclusterManifests', () => {
  beforeEach(() => {
    // ensureHelm: helm on PATH; helm template: a tiny two-object stream.
    mockExec.mockReset()
    mockExec.mockImplementation(((file: string, args: string[]) => {
      if (file === 'helm' && args[0] === 'version') {
        return Promise.resolve({ stdout: 'v3.16.4', stderr: '' })
      }
      if (file === 'helm' && args[0] === 'template') {
        return Promise.resolve({
          stdout:
            'apiVersion: v1\nkind: Service\nmetadata:\n  name: '
            + `${VC}\n  namespace: test-ns\nspec:\n  clusterIP: ${vclusterClusterIp(VC)}\n`
            + '---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: '
            + `${VC}\nspec: {}\n`,
          stderr: '',
        })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as never)
  })

  it('shells out to helm template with the per-session --set overrides', async () => {
    await renderVclusterManifests({ sessionId: SID })
    const tmpl = mockExec.mock.calls.find((c) => c[0] === 'helm' && (c[1] as string[])[0] === 'template')
    expect(tmpl).toBeDefined()
    const args = (tmpl![1] as string[]).join(' ')
    const vip = vclusterClusterIp(VC)
    expect(args).toContain(`template ${VC}`)
    expect(args).toContain('vcluster-')
    expect(args).toContain('--namespace test-ns')
    expect(args).toContain('controlPlane.advanced.defaultImageRegistry=localhost:5001')
    expect(args).toContain(`controlPlane.service.spec.clusterIP=${vip}`)
    expect(args).toContain(`controlPlane.proxy.extraSANs[0]=${vip}`)
    expect(args).toContain(`exportKubeConfig.server=https://${vip}:${VCLUSTER_API_PORT}`)
  })

  it('stamps the yaac ownership labels (but never yaac.session-id) on the rendered objects', async () => {
    const out = await renderVclusterManifests({ sessionId: SID })
    const objs = parseDocs(out)
    expect(objs.map((o) => o.kind)).toEqual(['Service', 'Deployment'])
    for (const o of objs) {
      expect(o.metadata.labels[LABEL_VCLUSTER]).toBe(VC)
      expect(o.metadata.labels[LABEL_VCLUSTER_SESSION_ID]).toBe(SID)
      expect(o.metadata.labels[LABEL_VCLUSTER_DATA_DIR_HASH]).toBe('ddh16')
    }
    // The ownership labels carry the session id, but the synced-pod
    // egress label (yaac.session-id) is never stamped here.
    expect(out).not.toContain('yaac.session-id:')
  })
})

describe('ensureHelm', () => {
  it('uses helm from PATH when present', async () => {
    mockExec.mockReset()
    mockExec.mockResolvedValue({ stdout: 'v3.16.4', stderr: '' })
    await expect(ensureHelm()).resolves.toBe('helm')
  })
})

describe('ensureVclusterImages', () => {
  it('skips images the registry already holds', async () => {
    await ensureVclusterImages(false)
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('pulls by pinned digest, tags, and pushes missing images', async () => {
    mockHasTag.mockResolvedValue(false)
    await ensureVclusterImages(false)
    const pulls = mockExec.mock.calls.filter((c) => (c[1] as string[])[0] === 'pull')
    expect(pulls.length).toBeGreaterThanOrEqual(4)
    for (const c of pulls) {
      expect((c[1] as string[])[1]).toMatch(/@sha256:[0-9a-f]{64}$/)
    }
    expect(mockPush).toHaveBeenCalledWith('loft-sh/vcluster-oss:0.34.3')
    expect(mockPush).toHaveBeenCalledWith('loft-sh/kubernetes:v1.35.0')
    expect(mockPush).toHaveBeenCalledWith('coredns/coredns:1.12.1')
    expect(mockPush).toHaveBeenCalledWith('library/alpine:3.20')
  })

  it('fails fast under requirePrebuilt instead of pulling', async () => {
    mockHasTag.mockResolvedValue(false)
    await expect(ensureVclusterImages(true)).rejects.toThrow(/missing/)
    expect(mockExec).not.toHaveBeenCalled()
  })
})

describe('pod guard (VAP)', () => {
  it('builds a per-session Fail-closed policy with the hostPath prefix inlined', () => {
    const m = buildVclusterPodGuardPolicyManifest(VC, SID, '/data/sessions/x/nested-yaac') as {
      metadata: { name: string; labels: Record<string, string> }
      spec: {
        failurePolicy: string
        paramKind?: unknown
        matchConstraints: { resourceRules: Array<{ resources: string[]; operations: string[] }> }
        validations: Array<{ expression: string; message: string }>
      }
    }
    expect(m.metadata.name).toBe(`${VCLUSTER_POD_GUARD_POLICY}-${VC}`)
    expect(m.metadata.labels[LABEL_VCLUSTER]).toBe(VC)
    expect(m.spec.failurePolicy).toBe('Fail')
    // Per-session policy with the prefix as a CEL literal — NO paramKind:
    // VAP paramRef resolution is broken on current kind/k8s 1.36.
    expect(m.spec.paramKind).toBeUndefined()
    expect(m.spec.matchConstraints.resourceRules[0]).toMatchObject({
      resources: ['pods'],
      operations: ['CREATE', 'UPDATE'],
    })
    const exprs = m.spec.validations.map((v) => v.expression).join('\n')
    expect(exprs).toContain("startsWith('/data/sessions/x/nested-yaac')")
    expect(exprs).toContain('hostNetwork')
    expect(exprs).toContain('hostPort')
    expect(exprs).toContain('privileged')
    // The caps rule keys on hostUsers: false (variables.userns) and
    // covers containers + initContainers (variables.cs) — every
    // session-shaped pod carries redirect-init (NET_ADMIN) and relay.
    expect(exprs).toContain('variables.userns ||')
    expect(exprs).toContain('capabilities')
    expect(exprs).toContain('allowPrivilegeEscalation')
    expect(exprs).toContain("seccompProfile.type == 'Unconfined'")
  })

  it('escapes the prefix for the CEL string literal', () => {
    const m = buildVclusterPodGuardPolicyManifest(VC, SID, "/we'ird/pa\\th") as {
      spec: { validations: Array<{ expression: string }> }
    }
    expect(m.spec.validations[0].expression).toContain("startsWith('/we\\'ird/pa\\\\th')")
  })

  it('binds per session via the syncer managed-by label', () => {
    const b = buildVclusterPodGuardBindingManifest(VC, SID) as {
      metadata: { name: string; labels: Record<string, string> }
      spec: {
        policyName: string
        validationActions: string[]
        paramRef?: unknown
        matchResources: {
          namespaceSelector: { matchLabels: Record<string, string> }
          objectSelector: { matchLabels: Record<string, string> }
        }
      }
    }
    expect(b.metadata.name).toBe(`${VCLUSTER_POD_GUARD_POLICY}-${VC}`)
    expect(b.metadata.labels[LABEL_VCLUSTER]).toBe(VC)
    expect(b.spec.policyName).toBe(`${VCLUSTER_POD_GUARD_POLICY}-${VC}`)
    expect(b.spec.validationActions).toEqual(['Deny'])
    expect(b.spec.paramRef).toBeUndefined()
    // Scoped to the vcluster's own host namespace, not the install ns.
    expect(b.spec.matchResources.namespaceSelector.matchLabels)
      .toEqual({ 'kubernetes.io/metadata.name': VCNS })
    expect(b.spec.matchResources.objectSelector.matchLabels)
      .toEqual({ [LABEL_VCLUSTER_MANAGED_BY]: VC })
  })
})

interface NetPol {
  metadata: { name: string; namespace: string }
  spec: {
    podSelector: { matchLabels: Record<string, string> }
    policyTypes: string[]
    egress: Array<{
      to: Array<{
        namespaceSelector?: { matchLabels: Record<string, string> }
        podSelector: { matchLabels: Record<string, string> }
      }>
      ports?: Array<{ protocol: string; port: number }>
    }>
  }
}

describe('namespace + confinement policies', () => {
  it('builds the dedicated per-session vcluster namespace, labeled for GC', () => {
    expect(vclusterNamespace(VC)).toBe(VCNS)
    const m = buildVclusterNamespaceManifest(VC, SID) as unknown as {
      kind: string
      metadata: { name: string; labels: Record<string, string> }
    }
    expect(m.kind).toBe('Namespace')
    expect(m.metadata.name).toBe(VCNS)
    expect(m.metadata.labels[LABEL_VCLUSTER]).toBe(VC)
    expect(m.metadata.labels[LABEL_VCLUSTER_SESSION_ID]).toBe(SID)
    expect(m.metadata.labels[LABEL_VCLUSTER_DATA_DIR_HASH]).toBe('ddh16')
  })

  it('session policy lives in the install ns and reaches the vcluster ns cross-namespace', () => {
    const m = buildVclusterSessionNetworkPolicyManifest(VC, SID) as unknown as NetPol
    expect(m.metadata.name).toBe('yaac-vc-0a1b2c3d')
    expect(m.metadata.namespace).toBe('test-ns') // selects the session pod
    expect(m.spec.podSelector.matchLabels).toEqual({ 'yaac.session-id': SID })
    expect(m.spec.policyTypes).toEqual(['Egress'])
    // The API/synced pods are in the vcluster namespace, so the peers are
    // cross-namespace (namespaceSelector + podSelector).
    expect(m.spec.egress[0].to[0].namespaceSelector?.matchLabels)
      .toEqual({ 'kubernetes.io/metadata.name': VCNS })
    expect(m.spec.egress[0].to[0].podSelector.matchLabels)
      .toEqual({ app: 'vcluster', release: VC })
    expect(m.spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: VCLUSTER_API_PORT }])
    expect(m.spec.egress[1].to[0].namespaceSelector?.matchLabels)
      .toEqual({ 'kubernetes.io/metadata.name': VCNS })
    expect(m.spec.egress[1].to[0].podSelector.matchLabels)
      .toEqual({ [LABEL_VCLUSTER_MANAGED_BY]: VC })
  })

  it('synced-pods backstop lives in the vcluster ns (same-namespace peers)', () => {
    const m = buildVclusterSyncedPodsNetworkPolicyManifest(VC, SID) as unknown as NetPol
    expect(m.metadata.name).toBe('yaac-vc-0a1b2c3d-synced')
    expect(m.metadata.namespace).toBe(VCNS)
    expect(m.spec.podSelector.matchLabels).toEqual({ [LABEL_VCLUSTER_MANAGED_BY]: VC })
    expect(m.spec.egress).toHaveLength(2)
    // Same namespace now, so plain podSelector (no namespaceSelector).
    expect(m.spec.egress[0].to[0].namespaceSelector).toBeUndefined()
    expect(m.spec.egress[0].to[0].podSelector.matchLabels)
      .toEqual({ app: 'vcluster', release: VC })
    expect(m.spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: VCLUSTER_API_PORT }])
    expect(m.spec.egress[1].to[0].podSelector.matchLabels)
      .toEqual({ [LABEL_VCLUSTER_MANAGED_BY]: VC })
  })

  it('blankets the whole vcluster namespace with a world-egress deny', () => {
    const m = buildVclusterNamespaceWorldDenyManifest(VC, SID) as unknown as {
      kind: string
      metadata: { name: string; namespace: string }
      spec: { endpointSelector: object; egressDeny: Array<{ toEntities: string[] }> }
    }
    expect(m.kind).toBe('CiliumNetworkPolicy')
    expect(m.metadata.namespace).toBe(VCNS)
    // Empty endpointSelector = all pods in the namespace (everything there
    // is vcluster-owned and none of it needs the internet).
    expect(m.spec.endpointSelector).toEqual({})
    expect(m.spec.egressDeny).toEqual([{ toEntities: ['world'] }])
  })

  it('locks the control plane to apiserver/host/kube-dns/own pods (CNP), in the vcluster ns', () => {
    const m = buildVclusterControlPlaneCnpManifest(VC, SID) as {
      apiVersion: string
      kind: string
      metadata: { namespace: string }
      spec: {
        endpointSelector: { matchLabels: Record<string, string> }
        egress: Array<Record<string, unknown>>
      }
    }
    expect(m.apiVersion).toBe('cilium.io/v2')
    expect(m.kind).toBe('CiliumNetworkPolicy')
    expect(m.metadata.namespace).toBe(VCNS)
    expect(m.spec.endpointSelector.matchLabels).toEqual({ app: 'vcluster', release: VC })
    expect(m.spec.egress[0]).toEqual({ toEntities: ['kube-apiserver', 'host'] })
    expect(JSON.stringify(m.spec.egress)).toContain('kube-dns')
    expect(JSON.stringify(m.spec.egress)).toContain(`"${LABEL_VCLUSTER_MANAGED_BY}":"${VC}"`)
  })
})

describe('ensureSessionVcluster', () => {
  beforeEach(() => {
    // get service → absent; get deployments (cap check) → none.
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'deployments') return Promise.resolve({ items: [] })
      return Promise.resolve(null)
    })
    // helm (ensureHelm version probe + template render) — a one-object
    // stream so renderVclusterManifests produces real apply input.
    mockExec.mockImplementation(((file: string, args: string[]) => {
      if (file === 'helm' && args[0] === 'template') {
        return Promise.resolve({
          stdout: `apiVersion: v1\nkind: Service\nmetadata:\n  name: ${VC}\nspec: {}\n`,
          stderr: '',
        })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as never)
  })

  it('applies namespace → guard → policies → vendored manifests, in that order', async () => {
    await ensureSessionVcluster({ sessionId: SID, allowedHostPathPrefix: '/x' })

    // The dedicated namespace first, then the VAP guard + the CNI
    // confinement (session NP, synced-pods NP, namespace world-deny CNP,
    // control-plane CNP) — all BEFORE the control plane exists, so no
    // synced pod is ever admitted unguarded/unconfined.
    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual([
      'Namespace',
      'ValidatingAdmissionPolicy',
      'ValidatingAdmissionPolicyBinding',
      'NetworkPolicy',
      'NetworkPolicy',
      'CiliumNetworkPolicy',
      'CiliumNetworkPolicy',
    ])
    // The dedicated namespace is the per-session vcluster namespace.
    const nsManifest = mockApply.mock.calls
      .map((c) => c[0] as { kind: string; metadata: { name: string } })
      .find((m) => m.kind === 'Namespace')
    expect(nsManifest?.metadata.name).toBe(VCNS)
    // The vendored manifests ride `kubectl apply -f -` with the rendered
    // YAML on stdin — last.
    const applyCall = mockRetry.mock.calls.find((c) => c[0][0] === 'apply')
    expect(applyCall).toBeDefined()
    expect((applyCall![1] as { input: string }).input).toContain(`name: ${VC}`)
  })

  it('fails closed with no opt-out when the VAP API is missing', async () => {
    mockRetry.mockImplementation((args: string[]) => {
      if (args[1] === 'validatingadmissionpolicies') {
        return Promise.reject(new Error('the server doesn\'t have a resource type'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    await expect(ensureSessionVcluster({ sessionId: SID, allowedHostPathPrefix: '/x' }))
      .rejects.toThrow(/ValidatingAdmissionPolicy/)
    // Nothing is applied — not the guard, not the policies, not the chart.
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('migrates a drifted Service before re-applying (clusterIP immutable)', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'deployments') return Promise.resolve({ items: [] })
      if (args[1] === 'service') return Promise.resolve({ spec: { clusterIP: '10.96.9.9' } })
      return Promise.resolve(null)
    })
    await ensureSessionVcluster({ sessionId: SID, allowedHostPathPrefix: '/x' })
    expect(mockRetry).toHaveBeenCalledWith([
      'delete', 'service', VC, '-n', VCNS, '--ignore-not-found',
    ])
  })
})

describe('waitForVclusterKubeconfig', () => {
  it('returns the decoded kubeconfig once the secret appears', async () => {
    mockGetJson.mockResolvedValue({
      data: { config: Buffer.from('apiVersion: v1\nkind: Config\n').toString('base64') },
    })
    await expect(waitForVclusterKubeconfig(VC)).resolves.toContain('kind: Config')
  })

  it('times out with an actionable error', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(waitForVclusterKubeconfig(VC, 1)).rejects.toThrow(/kubectl logs deploy\/yvc-/)
  })
})

describe('cleanup', () => {
  it('deletes the vcluster namespace, the cluster-scoped leftovers, and the session NetworkPolicy', () => {
    const args = vclusterCleanupKubectlArgs(VC)
    expect(args).toHaveLength(3)
    // 1: the whole vcluster namespace (sweeps control plane, synced pods,
    // synced-pods/control-plane policies, RBAC, kubeconfig secret).
    expect(args[0]).toEqual([
      'delete', 'namespace', VCNS, '--ignore-not-found', '--wait=false',
    ])
    // 2: cluster-scoped objects by ownership label (no -n).
    expect(args[1].join(' ')).toContain(`${LABEL_VCLUSTER}=${VC}`)
    expect(args[1].join(' ')).toContain('validatingadmissionpolicybindings')
    expect(args[1]).not.toContain('-n')
    // 3: the session NetworkPolicy in the install namespace (it selects
    // the session pod, which stays in the install ns).
    expect(args[2]).toEqual([
      'delete', 'networkpolicies', '-l', `${LABEL_VCLUSTER}=${VC}`,
      '-n', 'test-ns', '--ignore-not-found', '--wait=false',
    ])
  })

  it('renders the detached-script form with per-line error tolerance', () => {
    const cmd = buildVclusterCleanupShellCommand(VC)
    expect(cmd.split('; ')).toHaveLength(3)
    expect(cmd).toContain('2>/dev/null || true')
    expect(cmd).toContain(`delete namespace ${VCNS}`)
  })
})

describe('listVclusterNamespaces', () => {
  it('maps labeled vcluster namespaces to {name, sessionId, namespace, created}', async () => {
    mockGetJson.mockResolvedValue({
      items: [
        {
          metadata: {
            name: VCNS,
            creationTimestamp: '2026-06-15T00:00:00Z',
            labels: {
              [LABEL_VCLUSTER]: VC,
              [LABEL_VCLUSTER_SESSION_ID]: SID,
              [LABEL_VCLUSTER_DATA_DIR_HASH]: 'ddh16',
            },
          },
        },
        // An unlabeled namespace is ignored (not a yaac vcluster).
        { metadata: { name: 'something-else', creationTimestamp: '', labels: {} } },
      ],
    })
    const list = await listVclusterNamespaces()
    expect(list).toEqual([
      { name: VC, sessionId: SID, namespace: VCNS, creationTimestamp: '2026-06-15T00:00:00Z' },
    ])
    // Scoped to this install via the label selector.
    const call = mockGetJson.mock.calls.find((c) => (c[0])[1] === 'namespaces')
    expect(call?.[0].join(' ')).toContain(`${LABEL_VCLUSTER_DATA_DIR_HASH}=ddh16`)
  })
})

describe('getVclusterStatus', () => {
  it('returns null when the session has no vcluster', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(getVclusterStatus(SID)).resolves.toBeNull()
  })

  it('reports readiness from the deployment status', async () => {
    mockGetJson.mockResolvedValue({ status: { readyReplicas: 1 } })
    await expect(getVclusterStatus(SID)).resolves.toEqual({
      name: VC,
      clusterIp: vclusterClusterIp(VC),
      ready: true,
    })
    mockGetJson.mockResolvedValue({ status: {} })
    await expect(getVclusterStatus(SID)).resolves.toMatchObject({ ready: false })
  })
})

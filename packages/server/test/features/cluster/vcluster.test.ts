import { describe, it, expect, vi, beforeEach } from 'vitest'
import YAML from 'yaml'

interface K8sObj {
  kind: string
  metadata: { labels: Record<string, string> }
}
const parseDocs = (s: string): K8sObj[] =>
  s.split(/^---$/m).map((d) => YAML.parse(d) as K8sObj)

vi.mock('#platform/k8s/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlGetJson: vi.fn(),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))

vi.mock('#platform/container/registry', () => ({
  registryHost: vi.fn(() => 'localhost:5001'),
  registryHasTag: vi.fn().mockResolvedValue(true),
  registryRef: vi.fn((tag: string) => `localhost:5001/${tag}`),
  pushImageToRegistry: vi.fn((tag: string) => Promise.resolve(`localhost:5001/${tag}`)),
}))

vi.mock('#platform/container/runtime', () => ({
  imageExists: vi.fn().mockResolvedValue(false),
}))

import {
  buildVclusterCleanupShellCommand,
  ensureWorktreeVcluster,
  ensureVclusterImages,
  getVclusterStatus,
  removeWorktreeVcluster,
  sleepVcluster,
  vapAvailable,
  vclusterLabels,
  vclusterName,
  waitForVclusterKubeconfig,
} from '#features/cluster'
// Setup values (label keys, the guard policy's name) and the cluster-CIDR
// cache reset — not units under test.
import { VCLUSTER_POD_GUARD_POLICY } from '#features/cluster/vcluster'
import {
  LABEL_VCLUSTER,
  LABEL_VCLUSTER_DATA_DIR_HASH,
  LABEL_VCLUSTER_SESSION_ID,
} from '#platform/k8s/vcluster-objects'
import { resetClusterCidrCache } from '#features/cluster/cluster-cidrs'
import { LABEL_VCLUSTER_MANAGED_BY, VCLUSTER_API_PORT } from '#platform/k8s/pods'
import {
  execFileAsync,
  kubectlApply,
  kubectlGetJson,
  kubectlWithRetry,
} from '#platform/k8s/kubectl'
import { pushImageToRegistry, registryHasTag } from '#platform/container/registry'
import { imageExists } from '#platform/container/runtime'

const mockApply = vi.mocked(kubectlApply)
const mockGetJson = vi.mocked(kubectlGetJson)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(execFileAsync)
const mockHasTag = vi.mocked(registryHasTag)
const mockPush = vi.mocked(pushImageToRegistry)
const mockImageExists = vi.mocked(imageExists)

const NODE_IP = '10.89.0.7'

/**
 * The node/apiserver reads cluster-cidrs resolves the policy ipBlocks from.
 * Every `mockGetJson.mockImplementation` below defers to this first so the
 * real probes answer rather than a stubbed sibling.
 */
function cidrRead(args: string[]): Promise<unknown> | null {
  if (args[1] === 'nodes') {
    return Promise.resolve({
      items: [{ status: { addresses: [{ type: 'InternalIP', address: NODE_IP }] } }],
    })
  }
  if (args[1] === 'endpoints') {
    return Promise.resolve({ subsets: [{ addresses: [{ ip: NODE_IP }] }] })
  }
  return null
}

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
  resetClusterCidrCache()
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

interface Applied {
  kind: string
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  spec?: Record<string, unknown>
}
const appliedAll = (kind: string): Applied[] =>
  mockApply.mock.calls.map((c) => c[0] as Applied).filter((m) => m.kind === kind)
const applied = (kind: string): Applied | undefined => appliedAll(kind)[0]

describe('vclusterName', () => {
  it('derives yvc-<sid8> from the session UUID', () => {
    expect(vclusterName(SID)).toBe(VC)
    expect(vclusterName('ABC-DEF-123456789')).toBe('yvc-abcdef12')
  })
})

describe('vclusterLabels', () => {
  it('carries the ownership + install-scope labels', () => {
    expect(vclusterLabels(VC, SID)).toEqual({
      [LABEL_VCLUSTER]: VC,
      [LABEL_VCLUSTER_SESSION_ID]: SID,
      [LABEL_VCLUSTER_DATA_DIR_HASH]: 'ddh16',
    })
  })
})

describe('vapAvailable', () => {
  it('is true when the API answers and false when it is absent', async () => {
    mockRetry.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(vapAvailable()).resolves.toBe(true)
    expect(mockRetry).toHaveBeenCalledWith(
      ['get', 'validatingadmissionpolicies', '-o', 'name'],
      expect.objectContaining({ maxAttempts: 1 }),
    )

    mockRetry.mockRejectedValue(new Error('the server doesn\'t have a resource type'))
    await expect(vapAvailable()).resolves.toBe(false)
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

describe('ensureWorktreeVcluster', () => {
  beforeEach(() => {
    // get service → absent; get deployments (cap check) → none.
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      return cidrRead(args)
        ?? (args[1] === 'deployments' ? Promise.resolve({ items: [] }) : Promise.resolve(null))
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
    await ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' })

    // The dedicated namespace first, then the VAP guard + every policy
    // (session NP, the synced-pod egress floor, the control-plane lock, and
    // the two inner locks) — all BEFORE the control plane exists, so no
    // synced pod is ever admitted unguarded or unconfined.
    const kinds = mockApply.mock.calls.map((c) => (c[0] as { kind: string }).kind)
    expect(kinds).toEqual([
      'Namespace',
      'ValidatingAdmissionPolicy',
      'ValidatingAdmissionPolicyBinding',
      'Role',
      'RoleBinding',
      'NetworkPolicy',
      'NetworkPolicy',
      'NetworkPolicy',
      'NetworkPolicy',
      'NetworkPolicy',
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

  it('holds every apply until a same-named Terminating namespace is gone', async () => {
    // The restart race: teardown deleted the namespace with --wait=false
    // and the re-create runs while it is still Terminating. Applying then
    // would just patch doomed objects, silently lost when termination
    // completes — so nothing may be applied until the namespace is gone.
    // Applies seen at the moment of each namespace probe — must stay 0.
    const appliesAtProbe: number[] = []
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'namespace' && args[2] === VCNS) {
        appliesAtProbe.push(mockApply.mock.calls.length)
        return Promise.resolve(appliesAtProbe.length === 1
          ? { metadata: { deletionTimestamp: '2026-07-14T09:27:50Z' } }
          : null)
      }
      if (args[1] === 'deployments') return Promise.resolve({ items: [] })
      return Promise.resolve(null)
    })
    const onProgress = vi.fn()
    // Fake timers so the wait's poll sleep doesn't cost real seconds.
    vi.useFakeTimers()
    try {
      const done = ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x', onProgress })
      await vi.advanceTimersByTimeAsync(2500)
      await done
    } finally {
      vi.useRealTimers()
    }

    // Polled twice (Terminating, then gone) with nothing applied in between.
    expect(appliesAtProbe).toEqual([0, 0])
    expect(onProgress).toHaveBeenCalledWith(
      'Waiting for the previous virtual cluster to finish terminating...',
    )
    // The full apply sequence then proceeded, namespace first.
    expect(mockApply.mock.calls[0]?.[0]).toMatchObject({ kind: 'Namespace' })
  })

  it('fails closed with no opt-out when the VAP API is missing', async () => {
    mockRetry.mockImplementation((args: string[]) => {
      if (args[1] === 'validatingadmissionpolicies') {
        return Promise.reject(new Error('the server doesn\'t have a resource type'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    await expect(ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' }))
      .rejects.toThrow(/ValidatingAdmissionPolicy/)
    // Nothing is applied — not the guard, not the policies, not the chart.
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('never deletes the API Service (ClusterIP is allocator-assigned, no pin)', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      return cidrRead(args)
        ?? (args[1] === 'deployments' ? Promise.resolve({ items: [] }) : Promise.resolve(null))
    })
    await ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' })
    expect(mockRetry).not.toHaveBeenCalledWith(
      expect.arrayContaining(['delete', 'service']),
    )
  })

  it('reports freshness from the prior control-plane Deployment (born-at-zero gate)', async () => {
    await expect(ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' }))
      .resolves.toEqual({ freshlyCreated: true })

    // A pre-existing Deployment means re-ensure over a live vcluster —
    // the caller must NOT re-sleep it (its state.db is real).
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'deployment' && args[2] === VC) {
        return Promise.resolve({ metadata: { name: VC } })
      }
      if (args[1] === 'deployments') return Promise.resolve({ items: [] })
      return Promise.resolve(null)
    })
    await expect(ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' }))
      .resolves.toEqual({ freshlyCreated: false })
  })

  it('guards synced pods with a Fail-closed per-session policy naming the hostPath prefix', async () => {
    await ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: "/we'ird/pa\\th" })

    const vap = applied('ValidatingAdmissionPolicy') as unknown as {
      metadata: { name: string; labels: Record<string, string> }
      spec: {
        failurePolicy: string
        paramKind?: unknown
        matchConstraints: { resourceRules: Array<{ resources: string[]; operations: string[] }> }
        validations: Array<{ expression: string }>
        variables: Array<{ name: string; expression: string }>
      }
    }
    expect(vap.metadata.name).toBe(`${VCLUSTER_POD_GUARD_POLICY}-${VC}`)
    expect(vap.metadata.labels[LABEL_VCLUSTER]).toBe(VC)
    expect(vap.spec.failurePolicy).toBe('Fail')
    // Per-session policy with the prefix as a CEL literal — NO paramKind:
    // VAP paramRef resolution is broken on current kind/k8s 1.36.
    expect(vap.spec.paramKind).toBeUndefined()
    expect(vap.spec.matchConstraints.resourceRules[0]).toMatchObject({
      resources: ['pods'], operations: ['CREATE', 'UPDATE'],
    })
    const exprs = vap.spec.validations.map((v) => v.expression).join('\n')
    // The prefix is escaped for the CEL string literal.
    expect(exprs).toContain("startsWith('/we\\'ird/pa\\\\th')")
    expect(exprs).toContain('hostNetwork')
    expect(exprs).toContain('hostPort')
    expect(exprs).toContain('privileged')
    // The caps rule admits a grant behind the gvisor sentry tier
    // (variables.sandboxed), across containers + initContainers so a cap
    // grant cannot ride in on an init container.
    expect(exprs).toContain('variables.sandboxed ||')
    expect(exprs).toContain('allowPrivilegeEscalation')
    expect(exprs).toContain("seccompProfile.type == 'Unconfined'")
    const sandboxed = vap.spec.variables.find((v) => v.name === 'sandboxed')
    expect(sandboxed?.expression).toContain("runtimeClassName == 'gvisor'")
    expect(sandboxed?.expression).toContain("runtimeClassName == 'gvisor-nested'")

    const binding = applied('ValidatingAdmissionPolicyBinding') as unknown as {
      metadata: { name: string }
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
    expect(binding.spec.policyName).toBe(`${VCLUSTER_POD_GUARD_POLICY}-${VC}`)
    expect(binding.spec.validationActions).toEqual(['Deny'])
    expect(binding.spec.paramRef).toBeUndefined()
    // Scoped to the vcluster's own host namespace, not the install ns, and
    // bound per session through the unforgeable syncer managed-by label.
    expect(binding.spec.matchResources.namespaceSelector.matchLabels)
      .toEqual({ 'kubernetes.io/metadata.name': VCNS })
    expect(binding.spec.matchResources.objectSelector.matchLabels)
      .toEqual({ [LABEL_VCLUSTER_MANAGED_BY]: VC })
  })

  it('confines it: labeled namespace, a session egress hole, and a control-plane lock', async () => {
    await ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' })

    // The dedicated per-session namespace, labeled for GC and install scope.
    const ns = applied('Namespace')!
    expect(ns.metadata.name).toBe(VCNS)
    expect(ns.metadata.labels?.[LABEL_VCLUSTER]).toBe(VC)
    expect(ns.metadata.labels?.[LABEL_VCLUSTER_SESSION_ID]).toBe(SID)
    expect(ns.metadata.labels?.[LABEL_VCLUSTER_DATA_DIR_HASH]).toBe('ddh16')
    // ...and for the privileged Pod Security Standard. Inert on a cluster
    // yaac builds; on an adopted one whose cluster-wide default is
    // baseline/restricted, the synced tenant pods this namespace holds —
    // whose shape is decided by the vcluster's own admission guard, not the
    // host default — would otherwise be rejected at admission here.
    expect(ns.metadata.labels?.['pod-security.kubernetes.io/enforce']).toBe('privileged')

    const nps = appliedAll('NetworkPolicy')
    // The session policy lives in the INSTALL namespace (it selects the
    // session pod) and reaches the vcluster namespace cross-namespace.
    const worktreeNp = nps.find((m) => m.metadata.namespace === 'test-ns')! as unknown as NetPol
    expect(worktreeNp.spec.podSelector.matchLabels).toEqual({ 'yaac.session-id': SID })
    expect(worktreeNp.spec.policyTypes).toEqual(['Egress'])
    expect(worktreeNp.spec.egress[0].to[0].namespaceSelector?.matchLabels)
      .toEqual({ 'kubernetes.io/metadata.name': VCNS })
    expect(worktreeNp.spec.egress[0].to[0].podSelector.matchLabels)
      .toEqual({ app: 'vcluster', release: VC })
    expect(worktreeNp.spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: VCLUSTER_API_PORT }])
    expect(worktreeNp.spec.egress[1].to[0].podSelector.matchLabels)
      .toEqual({ [LABEL_VCLUSTER_MANAGED_BY]: VC })
    // The activator hole: while asleep the API ClusterIP DNATs to the
    // activator pod (same install namespace), and NetworkPolicy matches the
    // post-DNAT destination — without this rule the wake-triggering first
    // touch would be dropped.
    expect(worktreeNp.spec.egress[2].to[0].namespaceSelector).toBeUndefined()
    expect(worktreeNp.spec.egress[2].to[0].podSelector.matchLabels)
      .toEqual({ app: 'yaac-vc-activator' })

    // The control-plane lock, in the vcluster namespace.
    // The control-plane lock is the one selecting the chart's own pods by
    // release; the egress floor next to it selects on managed-by instead.
    const cp = nps.find((m) => {
      const sel = (m.spec as { podSelector?: { matchLabels?: Record<string, string> } }).podSelector
      return m.metadata.namespace === VCNS && sel?.matchLabels?.release === VC
    }) as unknown as {
      spec: {
        podSelector: {
          matchLabels: Record<string, string>
          matchExpressions: Array<{ key: string; operator: string }>
        }
        policyTypes: string[]
        egress: Array<Record<string, unknown>>
      }
    }
    expect(cp.spec.podSelector.matchLabels).toEqual({ app: 'vcluster', release: VC })
    expect(cp.spec.policyTypes).toEqual(['Egress'])
    // managed-by DoesNotExist excludes synced pods unforgeably: a tenant
    // could forge `app=vcluster, release=<vc>` (those labels propagate to
    // the host pod) and otherwise inherit this policy's apiserver egress.
    expect(cp.spec.podSelector.matchExpressions).toEqual([
      { key: LABEL_VCLUSTER_MANAGED_BY, operator: 'DoesNotExist' },
    ])
    // The apiserver as an ipBlock, resolved through the real cluster-cidrs
    // probe: NetworkPolicy matches the post-DNAT destination, so naming the
    // Service VIP would never match.
    expect(cp.spec.egress[0]).toEqual({ to: [{ ipBlock: { cidr: `${NODE_IP}/32` } }] })
    expect(JSON.stringify(cp.spec.egress)).toContain('kube-dns')
  })

  it('applies the chart with yaac ownership labels and no control-plane replicas', async () => {
    mockExec.mockImplementation(((file: string, args: string[]) => {
      if (file === 'helm' && args[0] === 'template') {
        return Promise.resolve({
          stdout: [
            `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${VC}\n  labels:\n    app: vcluster\nspec:\n  replicas: 1\n  selector: {}\n`,
            'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: other\nspec:\n  replicas: 2\n',
          ].join('---\n'),
          stderr: '',
        })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as never)

    await ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' })

    const applyCall = mockRetry.mock.calls.find((c) => c[0][0] === 'apply')!
    const docs = parseDocs((applyCall[1] as { input: string }).input)
    // Every rendered object carries the ownership labels, merged with the
    // chart's own — that is what the cluster-scoped cleanup selects on.
    for (const d of docs) {
      expect(d.metadata.labels[LABEL_VCLUSTER]).toBe(VC)
      expect(d.metadata.labels[LABEL_VCLUSTER_SESSION_ID]).toBe(SID)
    }
    expect(docs[0].metadata.labels.app).toBe('vcluster')
    // The control-plane Deployment's replicas are stripped so the chart
    // never fights the sleep scale-down; other Deployments keep theirs.
    const objs = docs as unknown as Array<{
      kind: string
      metadata: { name: string }
      spec?: { replicas?: number; selector?: unknown }
    }>
    const cp = objs.find((o) => o.kind === 'Deployment' && o.metadata.name === VC)
    expect(cp?.spec?.replicas).toBeUndefined()
    expect(cp?.spec?.selector).toBeDefined()
    expect(objs.find((o) => o.metadata.name === 'other')?.spec?.replicas).toBe(2)
  })

  it('proceeds on an absent namespace and on a live one, without re-polling', async () => {
    const probes = (): number =>
      mockGetJson.mock.calls.filter((c) => (c[0])[1] === 'namespace').length

    // Absent: one probe, straight through.
    await ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' })
    expect(probes()).toBe(1)

    // Present without a deletionTimestamp — the ensure-over-existing path;
    // the applies must proceed against the live vcluster.
    mockApply.mockClear()
    mockGetJson.mockClear()
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'namespace') return Promise.resolve({ metadata: {} })
      if (args[1] === 'deployments') return Promise.resolve({ items: [] })
      return Promise.resolve(null)
    })
    await ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' })
    expect(probes()).toBe(1)
    expect(mockApply).toHaveBeenCalled()
  })

  it('gives up on a namespace stuck Terminating with an actionable error', async () => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      const cidr = cidrRead(args)
      if (cidr) return cidr
      if (args[1] === 'namespace') {
        return Promise.resolve({ metadata: { deletionTimestamp: '2026-07-14T09:27:50Z' } })
      }
      if (args[1] === 'deployments') return Promise.resolve({ items: [] })
      return Promise.resolve(null)
    })
    vi.useFakeTimers()
    try {
      const settled = expect(
        ensureWorktreeVcluster({ worktreeId: SID, allowedHostPathPrefix: '/x' }),
      ).rejects.toThrow(new RegExp(`still Terminating.*kubectl get namespace ${VCNS}`))
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sleepVcluster', () => {
  const ACTIVATOR_IP = '10.244.0.99'

  beforeEach(() => {
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'secret' && args[2] === `${VC}-certs`) {
        return Promise.resolve({ metadata: { name: `${VC}-certs` } })
      }
      if (args[1] === 'pods' && args.includes('app=yaac-vc-activator')) {
        return Promise.resolve({
          items: [{ status: { phase: 'Running', podIP: ACTIVATOR_IP } }],
        })
      }
      // Control-plane pods: already gone.
      if (args[1] === 'pods') return Promise.resolve({ items: [] })
      return Promise.resolve(null)
    })
  })

  it('intercepts the Service, scales to 0, then deletes the orphaned synced pods', async () => {
    await sleepVcluster(VC, SID)

    // 1. EndpointSlice → activator applied BEFORE the scale-down: a
    // client touching the API mid-sleep lands on the activator (and
    // just wakes the vcluster) rather than a black-holed ClusterIP.
    const slice = mockApply.mock.calls
      .map((c) => c[0] as {
        kind: string
        metadata: { name: string; namespace: string; labels: Record<string, string> }
        endpoints: Array<{ addresses: string[] }>
        ports: Array<{ name: string; port: number }>
      })
      .find((m) => m.kind === 'EndpointSlice')
    expect(slice).toBeDefined()
    expect(slice!.metadata.name).toBe(`yaac-sleep-${VC}`)
    expect(slice!.metadata.namespace).toBe(VCNS)
    expect(slice!.metadata.labels[LABEL_VCLUSTER]).toBe(VC)
    expect(slice!.endpoints[0].addresses).toEqual([ACTIVATOR_IP])
    // Endpoint ports match Service ports BY NAME — all three named ports
    // must be enumerated or 8443 stays unrouted.
    expect(slice!.ports.map((p) => p.name).sort()).toEqual(['https', 'kubelet', 'yaac-api'])
    for (const p of slice!.ports) expect(p.port).toBe(VCLUSTER_API_PORT)

    const scaleIdx = mockRetry.mock.calls.findIndex((c) => c[0][0] === 'scale')
    expect(mockRetry.mock.calls[scaleIdx][0]).toEqual([
      'scale', 'deployment', VC, '-n', VCNS, '--replicas=0',
    ])
    // 3. Synced host pods (CoreDNS) deleted by the unforgeable managed-by
    // label — the syncer is down and cannot GC them itself.
    const del = mockRetry.mock.calls.find((c) => c[0][0] === 'delete' && c[0][1] === 'pods')
    expect(del).toBeDefined()
    expect(del![0]).toContain(`${LABEL_VCLUSTER_MANAGED_BY}=${VC}`)
  })

  it('refuses to sleep when the certs secret is missing (activator could not serve it)', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(sleepVcluster(VC, SID)).rejects.toThrow(/certs/)
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalledWith(expect.arrayContaining(['scale']))
  })

  it('waits for the control-plane pod to terminate before deleting synced pods', async () => {
    let cpPolls = 0
    mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
      if (args[1] === 'secret') return Promise.resolve({ metadata: {} })
      if (args[1] === 'pods' && args.includes('app=yaac-vc-activator')) {
        return Promise.resolve({ items: [{ status: { phase: 'Running', podIP: ACTIVATOR_IP } }] })
      }
      if (args[1] === 'pods') {
        cpPolls += 1
        return Promise.resolve(cpPolls === 1 ? { items: [{}] } : { items: [] })
      }
      return Promise.resolve(null)
    })
    await sleepVcluster(VC, SID, { pollMs: 1 })
    expect(cpPolls).toBe(2)
  })
})

describe('removeWorktreeVcluster', () => {
  it('deletes the namespace, the cluster-scoped leftovers, and the session policy', async () => {
    await removeWorktreeVcluster(VC)

    const argvs = mockRetry.mock.calls.map((c) => c[0])
    expect(argvs).toHaveLength(3)
    // 1: the whole vcluster namespace (sweeps control plane, synced pods,
    // synced-pod/control-plane policies, RBAC, kubeconfig secret).
    expect(argvs[0]).toEqual([
      'delete', 'namespace', VCNS, '--ignore-not-found', '--wait=false',
    ])
    // 2: cluster-scoped objects by ownership label (no -n).
    expect(argvs[1].join(' ')).toContain(`${LABEL_VCLUSTER}=${VC}`)
    expect(argvs[1].join(' ')).toContain('validatingadmissionpolicybindings')
    expect(argvs[1]).not.toContain('-n')
    // 3: the session NetworkPolicy in the install namespace (it selects the
    // session pod, which stays in the install ns).
    expect(argvs[2]).toEqual([
      'delete', 'networkpolicies', '-l', `${LABEL_VCLUSTER}=${VC}`,
      '-n', 'test-ns', '--ignore-not-found', '--wait=false',
    ])
  })

  it('logs and continues when one delete fails — teardown is best-effort', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockRetry.mockRejectedValueOnce(new Error('apiserver down'))
    await expect(removeWorktreeVcluster(VC)).resolves.toBeUndefined()
    // The remaining two still ran.
    expect(mockRetry).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('apiserver down'))
    warn.mockRestore()
  })
})

describe('buildVclusterCleanupShellCommand', () => {
  it('renders the detached-script form with per-line error tolerance', () => {
    // Same three steps as removeWorktreeVcluster, as one shell string: the
    // session pod's own teardown runs it detached, where a failed line must
    // not abort the rest.
    const cmd = buildVclusterCleanupShellCommand(VC)
    expect(cmd.split('; ')).toHaveLength(3)
    expect(cmd).toContain('2>/dev/null || true')
    expect(cmd).toContain(`delete namespace ${VCNS}`)
    expect(cmd).toContain(`${LABEL_VCLUSTER}=${VC}`)
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

describe('getVclusterStatus', () => {
  it('returns null when the session has no vcluster', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(getVclusterStatus(SID)).resolves.toBeNull()
  })

  it('reports readiness + phase from the deployment', async () => {
    mockGetJson.mockResolvedValue({ spec: { replicas: 1 }, status: { readyReplicas: 1 } })
    await expect(getVclusterStatus(SID)).resolves.toEqual({
      name: VC,
      ready: true,
      phase: 'ready',
    })
    mockGetJson.mockResolvedValue({ spec: { replicas: 1 }, status: {} })
    await expect(getVclusterStatus(SID)).resolves.toMatchObject({ ready: false, phase: 'waking' })
    // Scaled to zero → asleep (the activator wakes it on first touch).
    mockGetJson.mockResolvedValue({ spec: { replicas: 0 }, status: {} })
    await expect(getVclusterStatus(SID)).resolves.toMatchObject({ ready: false, phase: 'asleep' })
  })
  it('maps replicas/readiness to asleep | waking | ready', async () => {
    const stage = (replicas: number, ready: number): void => {
      mockGetJson.mockImplementation((args: string[]): Promise<unknown> => {
        if (args[1] === 'deployment') {
          return Promise.resolve({ spec: { replicas }, status: { readyReplicas: ready } })
        }
        return Promise.resolve(null)
      })
    }
    stage(0, 0)
    expect((await getVclusterStatus(VC))?.phase).toBe('asleep')
    stage(1, 0)
    expect((await getVclusterStatus(VC))?.phase).toBe('waking')
    stage(1, 1)
    expect((await getVclusterStatus(VC))?.phase).toBe('ready')
  })
})

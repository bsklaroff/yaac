import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#platform/k8s/kubectl', () => ({
  dataDirHash: vi.fn(() => 'outer00000000000'),
  k8sNamespace: vi.fn(() => 'yaac'),
  kubectlGetJson: vi.fn(),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
vi.mock('#platform/k8s/tick-snapshot', () => ({ createTickSnapshot: vi.fn() }))
vi.mock('#log', () => ({ serverLog: vi.fn() }))

import {
  reconcileInnerRedirects,
  _resetInnerRedirectStateForTests,
} from '#features/sessions/reconcile/inner-redirect-reconcile'
import type { TickSnapshot } from '#platform/k8s/tick-snapshot'
import type { VclusterNamespaceInfo, VclusterService } from '#features/cluster/vcluster'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '#platform/k8s/kubectl'
import { serverLog } from '#log'
import {
  INNER_EGRESS_REDIRECT_CEC_NAME,
  INNER_PROXY_INGRESS_CNP_NAME,
  INNER_SESSION_EGRESS_REDIRECT_CNP_NAME,
  LABEL_PROJECTION,
  PROJECTION_INNER_REDIRECT,
} from '#features/cluster/proxy-constants'
import { LABEL_DATA_DIR_HASH } from '#platform/k8s/pods'

const mockGetJson = vi.mocked(kubectlGetJson)
const mockApply = vi.mocked(kubectlApply)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockLog = vi.mocked(serverLog)

const VC: VclusterNamespaceInfo =
  { name: 'yvc-1', sessionId: 's1', namespace: 'yaac-vc-1', creationTimestamp: '' }
// vcluster-translated inner proxy Services, one per inner install.
const SVC_AMBIENT = 'yaac-proxy-x-yaac-x-yvc-1'
const SVC_E2E = 'yaac-proxy-x-yaac-test-ab12-x-yvc-1'
const HASH_AMBIENT = 'aaaa000000000001'
const HASH_E2E = 'eeee000000000002'

/**
 * Fake one pass's cluster view: the vcluster list and its (single) host
 * namespace's syncer-managed Services now come from the snapshot, not kubectl.
 */
function snap(opts: {
  vclusters?: VclusterNamespaceInfo[]
  services?: VclusterService[]
  resync?: boolean
} = {}): TickSnapshot {
  return {
    resync: opts.resync ?? true,
    pods: () => Promise.resolve([]),
    jobs: () => Promise.resolve([]),
    vclusters: () => Promise.resolve(opts.vclusters ?? [VC]),
    vclusterPods: () => Promise.resolve([]),
    vclusterServices: () => Promise.resolve(opts.services ?? []),
  }
}

interface FakeObject { metadata: { name: string; labels?: Record<string, string> } }

/**
 * Route kubectlGetJson: only the two projected-object prune listings
 * (`get <kind> -l yaac.projection=inner-redirect`) remain on kubectl.
 */
function wireGets(opts: {
  projectedCecs?: FakeObject[]
  projectedCnps?: FakeObject[]
}): void {
  mockGetJson.mockImplementation((args) => {
    if (args[1] === 'ciliumenvoyconfig') return Promise.resolve({ items: opts.projectedCecs ?? [] })
    if (args[1] === 'ciliumnetworkpolicy') return Promise.resolve({ items: opts.projectedCnps ?? [] })
    return Promise.resolve(null)
  })
}

function proxySvc(name: string, installHash?: string): VclusterService {
  return { name, labels: installHash ? { [LABEL_DATA_DIR_HASH]: installHash } : {} }
}

function appliedNames(): Array<{ kind: string; name: string; namespace: string }> {
  return mockApply.mock.calls.map(([m]) => {
    const o = m as { kind: string; metadata: { name: string; namespace: string } }
    return { kind: o.kind, name: o.metadata.name, namespace: o.metadata.namespace }
  })
}

function retryCalls(): string[] {
  return mockRetry.mock.calls.map(([args]) => args.join(' '))
}

const LEGACY_DELETE =
  `delete ciliumenvoyconfig/${INNER_EGRESS_REDIRECT_CEC_NAME} `
  + `ciliumnetworkpolicy/${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME} `
  + '-n yaac-vc-1 --ignore-not-found'

describe('reconcileInnerRedirects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetInnerRedirectStateForTests()
    wireGets({})
  })

  it('no-ops when there are no managed vclusters', async () => {
    await reconcileInnerRedirects(snap({ vclusters: [] }))
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
    expect(mockGetJson).not.toHaveBeenCalled()
  })

  it('projects one CEC+override per inner install plus the shared ingress lock', async () => {
    await reconcileInnerRedirects(
      snap({ services: [proxySvc(SVC_E2E, HASH_E2E), proxySvc(SVC_AMBIENT, HASH_AMBIENT)] }))

    // Sorted by service name (deterministic): 'yaac-proxy-x-yaac-test-…'
    // precedes 'yaac-proxy-x-yaac-x-…' ('t' < 'x') — the very ordering that
    // made the old first-match discovery pick an e2e proxy over the ambient
    // one.
    expect(appliedNames()).toEqual([
      { kind: 'CiliumEnvoyConfig', name: `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_E2E}`, namespace: 'yaac-vc-1' },
      { kind: 'CiliumNetworkPolicy', name: `${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_E2E}`, namespace: 'yaac-vc-1' },
      { kind: 'CiliumEnvoyConfig', name: `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_AMBIENT}`, namespace: 'yaac-vc-1' },
      { kind: 'CiliumNetworkPolicy', name: `${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_AMBIENT}`, namespace: 'yaac-vc-1' },
      { kind: 'CiliumNetworkPolicy', name: INNER_PROXY_INGRESS_CNP_NAME, namespace: 'yaac-vc-1' },
    ])

    // Each CEC is EDS-backed by ITS OWN install's discovered Service, and each
    // override selects that install and references that CEC's listeners.
    const cecE2e = mockApply.mock.calls[0][0] as { spec: { backendServices: Array<{ name: string }> } }
    expect(cecE2e.spec.backendServices[0].name).toBe(SVC_E2E)
    const cnpE2e = mockApply.mock.calls[1][0] as {
      spec: {
        endpointSelector: { matchExpressions: Array<{ key: string; values?: string[] }> }
        egress: Array<{ toPorts: Array<{ listener?: { envoyConfig: { name: string } } }> }>
      }
    }
    expect(cnpE2e.spec.endpointSelector.matchExpressions)
      .toContainEqual({ key: LABEL_DATA_DIR_HASH, operator: 'In', values: [HASH_E2E] })
    expect(cnpE2e.spec.egress[0].toPorts[0].listener?.envoyConfig.name)
      .toBe(`${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_E2E}`)
    const cecAmbient = mockApply.mock.calls[2][0] as { spec: { backendServices: Array<{ name: string }> } }
    expect(cecAmbient.spec.backendServices[0].name).toBe(SVC_AMBIENT)

    // Only the legacy fixed-name cleanup ran — nothing labeled was stale.
    expect(retryCalls()).toEqual([LEGACY_DELETE])
  })

  it('prunes a vanished install but keeps the survivors', async () => {
    wireGets({
      projectedCecs: [
        { metadata: { name: `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_AMBIENT}` } },
        { metadata: { name: `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_E2E}` } },
      ],
      projectedCnps: [
        { metadata: { name: `${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_AMBIENT}` } },
        { metadata: { name: `${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_E2E}` } },
        { metadata: { name: INNER_PROXY_INGRESS_CNP_NAME } },
      ],
    })

    // The e2e install is gone from the snapshot's Services.
    await reconcileInnerRedirects(snap({ services: [proxySvc(SVC_AMBIENT, HASH_AMBIENT)] }))

    expect(retryCalls()).toEqual([
      LEGACY_DELETE,
      `delete ciliumenvoyconfig ${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_E2E} -n yaac-vc-1 --ignore-not-found`,
      `delete ciliumnetworkpolicy ${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_E2E} -n yaac-vc-1 --ignore-not-found`,
    ])
    // The surviving install (and the shared ingress lock) are re-applied.
    expect(appliedNames().map((a) => a.name)).toEqual([
      `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_AMBIENT}`,
      `${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_AMBIENT}`,
      INNER_PROXY_INGRESS_CNP_NAME,
    ])
  })

  it('prunes everything (including the ingress lock) when no inner proxy remains', async () => {
    wireGets({
      projectedCecs: [{ metadata: { name: `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_AMBIENT}` } }],
      projectedCnps: [
        { metadata: { name: `${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_AMBIENT}` } },
        { metadata: { name: INNER_PROXY_INGRESS_CNP_NAME } },
      ],
    })

    await reconcileInnerRedirects(snap({ services: [] }))

    expect(appliedNames()).toEqual([])
    expect(retryCalls()).toEqual([
      LEGACY_DELETE,
      `delete ciliumenvoyconfig ${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_AMBIENT} -n yaac-vc-1 --ignore-not-found`,
      `delete ciliumnetworkpolicy ${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_AMBIENT} -n yaac-vc-1 --ignore-not-found`,
      `delete ciliumnetworkpolicy ${INNER_PROXY_INGRESS_CNP_NAME} -n yaac-vc-1 --ignore-not-found`,
    ])
  })

  it('ignores (and logs once) a yaac-proxy Service without an install label', async () => {
    // Pre-per-install inner yaac. Resync passes so both actually run.
    await reconcileInnerRedirects(snap({ services: [proxySvc(SVC_AMBIENT)] }))
    await reconcileInnerRedirects(snap({ services: [proxySvc(SVC_AMBIENT)] }))

    expect(mockApply).not.toHaveBeenCalled()
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(String(mockLog.mock.calls[0][0])).toContain(SVC_AMBIENT)
  })

  it('non-proxy synced services never trigger a projection', async () => {
    await reconcileInnerRedirects(snap({
      services: [{ name: 'some-app-x-yaac-x-yvc-1', labels: { [LABEL_DATA_DIR_HASH]: HASH_E2E } }],
    }))

    expect(mockApply).not.toHaveBeenCalled()
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('lists projected objects by the projection label, never by app alone', async () => {
    await reconcileInnerRedirects(snap({ services: [proxySvc(SVC_AMBIENT, HASH_AMBIENT)] }))

    const listSelectors = mockGetJson.mock.calls
      .map(([args]) => args)
      .map((a) => a[a.indexOf('-l') + 1])
    expect(listSelectors).toEqual([
      `${LABEL_PROJECTION}=${PROJECTION_INNER_REDIRECT}`,
      `${LABEL_PROJECTION}=${PROJECTION_INNER_REDIRECT}`,
    ])
  })

  it('delta pass with an unchanged projection performs no kubectl work', async () => {
    const services = [proxySvc(SVC_AMBIENT, HASH_AMBIENT)]
    await reconcileInnerRedirects(snap({ services, resync: false }))
    expect(mockApply).toHaveBeenCalled() // first pass projects

    // Same desired state on a delta pass: the memo skips the namespace
    // entirely — pod/service churn must not become apply spam.
    vi.clearAllMocks()
    await reconcileInnerRedirects(snap({ services, resync: false }))
    expect(mockGetJson).not.toHaveBeenCalled()
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()

    // A changed desired state on a delta pass does re-project.
    await reconcileInnerRedirects(snap({
      services: [...services, proxySvc(SVC_E2E, HASH_E2E)],
      resync: false,
    }))
    expect(appliedNames().map((a) => a.name)).toContain(
      `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_E2E}`)
  })

  it('resync pass re-prunes and re-applies even when nothing changed', async () => {
    const services = [proxySvc(SVC_AMBIENT, HASH_AMBIENT)]
    await reconcileInnerRedirects(snap({ services, resync: true }))

    vi.clearAllMocks()
    await reconcileInnerRedirects(snap({ services, resync: true }))
    expect(retryCalls()).toContain(LEGACY_DELETE)
    expect(appliedNames().map((a) => a.name)).toEqual([
      `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_AMBIENT}`,
      `${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_AMBIENT}`,
      INNER_PROXY_INGRESS_CNP_NAME,
    ])
  })

  it('drops the memo when the namespace disappears, so a comeback re-projects', async () => {
    const services = [proxySvc(SVC_AMBIENT, HASH_AMBIENT)]
    await reconcileInnerRedirects(snap({ services, resync: false }))

    // The vcluster is torn down: its memo entry is dropped...
    await reconcileInnerRedirects(snap({ vclusters: [], resync: false }))

    // ...so the same namespace coming back (same desired state) is
    // projected again instead of being skipped by a stale memo.
    vi.clearAllMocks()
    await reconcileInnerRedirects(snap({ services, resync: false }))
    expect(appliedNames().map((a) => a.name)).toEqual([
      `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_AMBIENT}`,
      `${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_AMBIENT}`,
      INNER_PROXY_INGRESS_CNP_NAME,
    ])
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/k8s/kubectl', () => ({
  dataDirHash: vi.fn(() => 'outer00000000000'),
  k8sNamespace: vi.fn(() => 'yaac'),
  kubectlGetJson: vi.fn(),
  kubectlApply: vi.fn().mockResolvedValue(undefined),
  kubectlWithRetry: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}))
// bootstrap.ts (imported for the real builders) only uses isTorEnabled from git.
vi.mock('@/lib/git', () => ({ isTorEnabled: vi.fn(() => false) }))
vi.mock('@/lib/k8s/vcluster', () => ({
  listVclusterNamespaces: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/server/log', () => ({ serverLog: vi.fn() }))

import { reconcileInnerRedirects } from '@/lib/session/inner-redirect-reconcile'
import { kubectlApply, kubectlGetJson, kubectlWithRetry } from '@/lib/k8s/kubectl'
import { listVclusterNamespaces } from '@/lib/k8s/vcluster'
import { serverLog } from '@/server/log'
import {
  INNER_EGRESS_REDIRECT_CEC_NAME,
  INNER_PROXY_INGRESS_CNP_NAME,
  INNER_SESSION_EGRESS_REDIRECT_CNP_NAME,
  LABEL_PROJECTION,
  PROJECTION_INNER_REDIRECT,
} from '@/lib/k8s/bootstrap'
import { LABEL_DATA_DIR_HASH } from '@/lib/k8s/pods'

const mockGetJson = vi.mocked(kubectlGetJson)
const mockApply = vi.mocked(kubectlApply)
const mockRetry = vi.mocked(kubectlWithRetry)
const mockList = vi.mocked(listVclusterNamespaces)
const mockLog = vi.mocked(serverLog)

const VC = { name: 'yvc-1', sessionId: 's1', namespace: 'yaac-vc-1', creationTimestamp: '' }
// vcluster-translated inner proxy Services, one per inner install.
const SVC_AMBIENT = 'yaac-proxy-x-yaac-x-yvc-1'
const SVC_E2E = 'yaac-proxy-x-yaac-test-ab12-x-yvc-1'
const HASH_AMBIENT = 'aaaa000000000001'
const HASH_E2E = 'eeee000000000002'

interface FakeObject { metadata: { name: string; labels?: Record<string, string> } }

/**
 * Route kubectlGetJson by query: the services discovery vs the two projected-
 * object prune listings (`get <kind> -l yaac.projection=inner-redirect`).
 */
function wireGets(opts: {
  services?: FakeObject[]
  projectedCecs?: FakeObject[]
  projectedCnps?: FakeObject[]
}): void {
  mockGetJson.mockImplementation((args) => {
    if (args[1] === 'services') return Promise.resolve({ items: opts.services ?? [] })
    if (args[1] === 'ciliumenvoyconfig') return Promise.resolve({ items: opts.projectedCecs ?? [] })
    if (args[1] === 'ciliumnetworkpolicy') return Promise.resolve({ items: opts.projectedCnps ?? [] })
    return Promise.resolve(null)
  })
}

function proxySvc(name: string, installHash?: string): FakeObject {
  return { metadata: { name, labels: installHash ? { [LABEL_DATA_DIR_HASH]: installHash } : {} } }
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
    mockList.mockResolvedValue([])
    wireGets({})
  })

  it('no-ops when there are no managed vclusters', async () => {
    await reconcileInnerRedirects()
    expect(mockApply).not.toHaveBeenCalled()
    expect(mockRetry).not.toHaveBeenCalled()
  })

  it('projects one CEC+override per inner install plus the shared ingress lock', async () => {
    mockList.mockResolvedValue([VC])
    wireGets({ services: [proxySvc(SVC_E2E, HASH_E2E), proxySvc(SVC_AMBIENT, HASH_AMBIENT)] })

    await reconcileInnerRedirects()

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
    mockList.mockResolvedValue([VC])
    wireGets({
      services: [proxySvc(SVC_AMBIENT, HASH_AMBIENT)], // the e2e install is gone
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

    await reconcileInnerRedirects()

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
    mockList.mockResolvedValue([VC])
    wireGets({
      services: [],
      projectedCecs: [{ metadata: { name: `${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_AMBIENT}` } }],
      projectedCnps: [
        { metadata: { name: `${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_AMBIENT}` } },
        { metadata: { name: INNER_PROXY_INGRESS_CNP_NAME } },
      ],
    })

    await reconcileInnerRedirects()

    expect(appliedNames()).toEqual([])
    expect(retryCalls()).toEqual([
      LEGACY_DELETE,
      `delete ciliumenvoyconfig ${INNER_EGRESS_REDIRECT_CEC_NAME}-${HASH_AMBIENT} -n yaac-vc-1 --ignore-not-found`,
      `delete ciliumnetworkpolicy ${INNER_SESSION_EGRESS_REDIRECT_CNP_NAME}-${HASH_AMBIENT} -n yaac-vc-1 --ignore-not-found`,
      `delete ciliumnetworkpolicy ${INNER_PROXY_INGRESS_CNP_NAME} -n yaac-vc-1 --ignore-not-found`,
    ])
  })

  it('ignores (and logs once) a yaac-proxy Service without an install label', async () => {
    mockList.mockResolvedValue([VC])
    wireGets({ services: [proxySvc(SVC_AMBIENT)] }) // pre-per-install inner yaac

    await reconcileInnerRedirects()
    await reconcileInnerRedirects()

    expect(mockApply).not.toHaveBeenCalled()
    expect(mockLog).toHaveBeenCalledTimes(1)
    expect(String(mockLog.mock.calls[0][0])).toContain(SVC_AMBIENT)
  })

  it('non-proxy synced services never trigger a projection', async () => {
    mockList.mockResolvedValue([VC])
    wireGets({ services: [{ metadata: { name: 'some-app-x-yaac-x-yvc-1', labels: { [LABEL_DATA_DIR_HASH]: HASH_E2E } } }] })

    await reconcileInnerRedirects()

    expect(mockApply).not.toHaveBeenCalled()
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('lists projected objects by the projection label, never by app alone', async () => {
    mockList.mockResolvedValue([VC])
    wireGets({ services: [proxySvc(SVC_AMBIENT, HASH_AMBIENT)] })

    await reconcileInnerRedirects()

    const listSelectors = mockGetJson.mock.calls
      .map(([args]) => args)
      .filter((a) => a[1] !== 'services')
      .map((a) => a[a.indexOf('-l') + 1])
    expect(listSelectors).toEqual([
      `${LABEL_PROJECTION}=${PROJECTION_INNER_REDIRECT}`,
      `${LABEL_PROJECTION}=${PROJECTION_INNER_REDIRECT}`,
    ])
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The object layer's only boundary is the kubectl list call; the mappers are
// pure. Nothing else is faked.
vi.mock('#platform/k8s/kubectl', () => ({
  k8sNamespace: vi.fn(() => 'test-ns'),
  dataDirHash: vi.fn(() => 'ddh16'),
  kubectlGetJson: vi.fn(),
}))

import {
  LABEL_VCLUSTER,
  LABEL_VCLUSTER_DATA_DIR_HASH,
  LABEL_VCLUSTER_SESSION_ID,
  listVclusterConfigMaps,
  listVclusterNamespaces,
  listVclusterPods,
  listVclusterServices,
  mapVclusterConfigMapObject,
  mapVclusterNamespaceObject,
  mapVclusterPodObject,
  mapVclusterServiceObject,
  vclusterNamespaceSelector,
} from '#platform/k8s/vcluster-objects'
import { LABEL_VCLUSTER_MANAGED_BY } from '#platform/k8s/pods'
import { kubectlGetJson } from '#platform/k8s/kubectl'

const mockGetJson = vi.mocked(kubectlGetJson)

const SID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'
const VC = 'yvc-0a1b2c3d'
/** The vcluster's dedicated host namespace: <install-ns>-vc-<sid8>. */
const VCNS = 'test-ns-vc-0a1b2c3d'

beforeEach(() => {
  mockGetJson.mockReset()
})

describe('vclusterNamespaceSelector', () => {
  it('requires the vcluster label and scopes by data-dir-hash', () => {
    expect(vclusterNamespaceSelector())
      .toBe(`${LABEL_VCLUSTER},${LABEL_VCLUSTER_DATA_DIR_HASH}=ddh16`)
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

describe('listVclusterPods', () => {
  it('lists all pods in the vcluster namespace, dropping malformed rows', async () => {
    mockGetJson.mockResolvedValue({
      items: [
        { metadata: { name: 'p1' }, status: { podIP: '10.0.0.1' } },
        { metadata: { name: 'p2' } }, // no IP yet
        {}, // malformed → dropped, not fatal
      ],
    })
    await expect(listVclusterPods(VCNS)).resolves.toEqual([
      { name: 'p1', podIP: '10.0.0.1', labels: {} },
      { name: 'p2', labels: {} },
    ])
    expect(mockGetJson).toHaveBeenCalledWith(['get', 'pods', '-n', VCNS])
  })

  it('returns [] when the list call yields null (namespace gone)', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(listVclusterPods(VCNS)).resolves.toEqual([])
  })
})

describe('listVclusterServices', () => {
  it('lists syncer-managed services by the managed-by label and maps them', async () => {
    mockGetJson.mockResolvedValue({
      items: [
        { metadata: { name: 'yaac-proxy-x-yaac-x-yvc-1', labels: { 'yaac.data-dir-hash': 'ddh16' } } },
        {}, // malformed → dropped
      ],
    })
    await expect(listVclusterServices(VCNS, VC)).resolves.toEqual([
      { name: 'yaac-proxy-x-yaac-x-yvc-1', labels: { 'yaac.data-dir-hash': 'ddh16' } },
    ])
    expect(mockGetJson).toHaveBeenCalledWith([
      'get', 'services', '-n', VCNS, '-l', `${LABEL_VCLUSTER_MANAGED_BY}=${VC}`,
    ])
  })

  it('returns [] when the list call yields null', async () => {
    mockGetJson.mockResolvedValue(null)
    await expect(listVclusterServices(VCNS, VC)).resolves.toEqual([])
  })
})

describe('listVclusterConfigMaps', () => {
  it('lists the vcluster namespace ConfigMaps, dropping unmappable ones', async () => {
    mockGetJson.mockResolvedValue({
      items: [
        { metadata: { name: 'kube-root-ca.crt', namespace: VCNS }, data: { 'ca.crt': 'PEM' } },
        { metadata: {} },
      ],
    })
    const cms = await listVclusterConfigMaps(VCNS)
    expect(mockGetJson).toHaveBeenCalledWith(['get', 'configmaps', '-n', VCNS])
    expect(cms).toHaveLength(1)
    expect(cms[0].name).toBe('kube-root-ca.crt')
  })
})

describe('mapVclusterNamespaceObject', () => {
  const rawNs = (): { metadata: { name: string; creationTimestamp: string | Date; labels: Record<string, string> } } => ({
    metadata: {
      name: VCNS,
      creationTimestamp: '2026-06-15T00:00:00Z',
      labels: {
        [LABEL_VCLUSTER]: VC,
        [LABEL_VCLUSTER_SESSION_ID]: SID,
        [LABEL_VCLUSTER_DATA_DIR_HASH]: 'ddh16',
      },
    },
  })

  it('maps a labeled vcluster namespace to VclusterNamespaceInfo', () => {
    expect(mapVclusterNamespaceObject(rawNs())).toEqual({
      name: VC, sessionId: SID, namespace: VCNS, creationTimestamp: '2026-06-15T00:00:00Z',
    })
  })

  it('normalizes a Date creationTimestamp (informer list-call class objects) to ISO', () => {
    const raw = rawNs()
    raw.metadata.creationTimestamp = new Date('2026-06-15T00:00:00Z')
    expect(mapVclusterNamespaceObject(raw)?.creationTimestamp).toBe('2026-06-15T00:00:00.000Z')
  })

  it('returns null for a namespace without the vcluster ownership labels', () => {
    expect(mapVclusterNamespaceObject({
      metadata: { name: 'something-else', creationTimestamp: '', labels: {} },
    })).toBeNull()
    // Both ownership labels are required.
    const raw = rawNs()
    delete raw.metadata.labels[LABEL_VCLUSTER_SESSION_ID]
    expect(mapVclusterNamespaceObject(raw)).toBeNull()
  })

  it('returns null for malformed objects instead of throwing', () => {
    expect(mapVclusterNamespaceObject({})).toBeNull()
    expect(mapVclusterNamespaceObject(null)).toBeNull()
    expect(mapVclusterNamespaceObject({ metadata: {} })).toBeNull()
  })
})

describe('mapVclusterPodObject', () => {
  it('maps the pod name, IP and labels', () => {
    expect(mapVclusterPodObject({
      metadata: { name: 'p1', labels: { 'vcluster.loft.sh/managed-by': 'yvc1' } },
      status: { podIP: '10.0.0.1' },
    })).toEqual({
      name: 'p1', podIP: '10.0.0.1', labels: { 'vcluster.loft.sh/managed-by': 'yvc1' },
    })
  })

  it('omits podIP when the pod has none yet, and defaults labels', () => {
    // Claim validation reads the syncer's managed-by label off these, so a
    // label-less pod must map to an empty record rather than be dropped.
    expect(mapVclusterPodObject({ metadata: { name: 'p1' }, status: {} }))
      .toEqual({ name: 'p1', labels: {} })
    expect(mapVclusterPodObject({ metadata: { name: 'p1' } }))
      .toEqual({ name: 'p1', labels: {} })
  })

  it('returns null for malformed objects', () => {
    expect(mapVclusterPodObject({})).toBeNull()
    expect(mapVclusterPodObject({ metadata: {} })).toBeNull()
  })
})

describe('mapVclusterServiceObject', () => {
  it('maps the service name and labels', () => {
    expect(mapVclusterServiceObject({
      metadata: { name: 'yaac-proxy-x-yaac-x-yvc-1', labels: { 'yaac.data-dir-hash': 'ddh16' } },
    })).toEqual({ name: 'yaac-proxy-x-yaac-x-yvc-1', labels: { 'yaac.data-dir-hash': 'ddh16' } })
  })

  it('defaults missing labels to an empty record', () => {
    expect(mapVclusterServiceObject({ metadata: { name: 'svc' } }))
      .toEqual({ name: 'svc', labels: {} })
  })

  it('returns null for malformed objects', () => {
    expect(mapVclusterServiceObject({})).toBeNull()
    expect(mapVclusterServiceObject({ metadata: {} })).toBeNull()
  })
})

describe('mapVclusterConfigMapObject', () => {
  it('maps a ConfigMap to its name and data, and rejects a shapeless object', () => {
    expect(mapVclusterConfigMapObject({
      metadata: { name: 'claims', namespace: VCNS },
      data: { claims: 'a,b' },
    })).toEqual({ name: 'claims', data: { claims: 'a,b' } })
    expect(mapVclusterConfigMapObject({})).toBeNull()
    expect(mapVclusterConfigMapObject(null)).toBeNull()
  })
})

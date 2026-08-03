import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The object layer's only boundary is the kubectl list call; the mappers are
// pure and run for real behind it.
type ExecResult = { stdout: string; stderr: string }
type ExecCallback = (err: unknown, res?: ExecResult) => void
const execFileMock = vi.fn<(file: string, args: readonly string[]) => Promise<ExecResult>>()
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: readonly string[], opts: unknown, cb?: ExecCallback) => {
    const actualCb = (typeof opts === 'function' ? opts : cb) as ExecCallback
    void execFileMock(file, args).then(
      (res) => actualCb(null, res),
      (err: unknown) => actualCb(err),
    )
    return { stdin: { end: vi.fn() } }
  },
  exec: vi.fn(),
}))

import {
  LABEL_VCLUSTER,
  LABEL_VCLUSTER_DATA_DIR_HASH,
  LABEL_VCLUSTER_SESSION_ID,
  dataDirHash,
  listVclusterNamespaces,
} from '#platform/k8s'

const SID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'
const VC = 'yvc-0a1b2c3d'
/** The vcluster's dedicated host namespace: <install-ns>-vc-<sid8>. */
const VCNS = 'test-ns-vc-0a1b2c3d'

function rawNs(overrides: { creationTimestamp?: string | Date; labels?: Record<string, string> } = {}): unknown {
  return {
    metadata: {
      name: VCNS,
      creationTimestamp: overrides.creationTimestamp ?? '2026-06-15T00:00:00Z',
      labels: overrides.labels ?? {
        [LABEL_VCLUSTER]: VC,
        [LABEL_VCLUSTER_SESSION_ID]: SID,
        [LABEL_VCLUSTER_DATA_DIR_HASH]: dataDirHash(),
      },
    },
  }
}

const listReturns = (payload: unknown): void => {
  execFileMock.mockResolvedValue({ stdout: JSON.stringify(payload), stderr: '' })
}

beforeEach(() => {
  vi.stubEnv('YAAC_K8S_NAMESPACE', 'test-ns')
  execFileMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('listVclusterNamespaces', () => {
  it('maps labeled vcluster namespaces, scoped to this install', async () => {
    listReturns({
      items: [
        rawNs(),
        // An unlabeled namespace is not a yaac vcluster — skipped, not fatal.
        { metadata: { name: 'kube-system', creationTimestamp: '', labels: {} } },
        // Both ownership labels are required.
        rawNs({ labels: { [LABEL_VCLUSTER]: VC } }),
        // Malformed rows never take the listing down.
        {},
        { metadata: {} },
      ],
    })
    await expect(listVclusterNamespaces()).resolves.toEqual([
      { name: VC, sessionId: SID, namespace: VCNS, creationTimestamp: '2026-06-15T00:00:00Z' },
    ])
    // Only namespaces this install owns: plain `yaac.vcluster` presence plus
    // the data-dir-hash of this data dir.
    expect(execFileMock).toHaveBeenCalledWith('kubectl', [
      'get', 'namespaces',
      '-l', `${LABEL_VCLUSTER},${LABEL_VCLUSTER_DATA_DIR_HASH}=${dataDirHash()}`,
      '-o', 'json',
    ])
  })

  it('tolerates a namespace with no creationTimestamp', async () => {
    // The GC grace anchor is optional in the schema; an empty string reads
    // as epoch, which is exactly the "no grace left" answer we want.
    listReturns({ items: [{ ...(rawNs() as object), metadata: {
      name: VCNS,
      labels: {
        [LABEL_VCLUSTER]: VC,
        [LABEL_VCLUSTER_SESSION_ID]: SID,
        [LABEL_VCLUSTER_DATA_DIR_HASH]: dataDirHash(),
      },
    } }] })
    const [ns] = await listVclusterNamespaces()
    expect(ns.creationTimestamp).toBe('')
  })

  it('returns [] when the list call yields nothing', async () => {
    execFileMock.mockRejectedValue(
      Object.assign(new Error('kubectl failed'), { stderr: 'Error from server (NotFound)' }),
    )
    await expect(listVclusterNamespaces()).resolves.toEqual([])
  })
})

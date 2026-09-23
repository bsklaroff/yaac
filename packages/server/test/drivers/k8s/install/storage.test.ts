/**
 * The two claims and their static PVs, exercised through the barrel.
 * kubectl is the process boundary; the manifests are built for real and
 * asserted on, and `ensureStorageClaims` is driven against a data dir on
 * real disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type * as kubectlModule from '#drivers/k8s/substrate/kubectl'

const mockApply = vi.hoisted(() => vi.fn())
const mockGetJson = vi.hoisted(() => vi.fn())
const mockWithRetry = vi.hoisted(() => vi.fn())
vi.mock('#drivers/k8s/substrate/kubectl', async (importOriginal) => ({
  ...(await importOriginal<typeof kubectlModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh16',
  kubectlApply: mockApply,
  kubectlGetJson: mockGetJson,
  kubectlWithRetry: mockWithRetry,
}))

import {
  buildGlobalPvManifest,
  buildGlobalPvcManifest,
  buildServerLocalPvManifest,
  buildServerLocalPvcManifest,
  ensureStorageClaims,
  storageVolumeName,
} from '#drivers/k8s/install'

interface Pv {
  kind: string
  metadata: { name: string; namespace?: string; labels: Record<string, string> }
  spec: {
    accessModes: string[]
    persistentVolumeReclaimPolicy?: string
    storageClassName: string
    claimRef?: { namespace: string; name: string }
    hostPath?: { path: string; type: string }
    volumeName?: string
    capacity?: { storage: string }
    resources?: { requests: { storage: string } }
  }
}

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  tmpDir = await createTempDataDir()
  mockApply.mockResolvedValue(undefined)
  mockWithRetry.mockResolvedValue({ stdout: '', stderr: '' })
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

const applied = (): Pv[] => (mockApply.mock.calls as Array<[Pv]>).map(([m]) => m)

describe('buildGlobalPvManifest', () => {
  it('is a static, retained, claim-bound hostPath volume named by the install', () => {
    const pv = buildGlobalPvManifest({ hostPath: '/data/yaac/global' }) as unknown as Pv
    expect(pv.kind).toBe('PersistentVolume')
    expect(pv.metadata.name).toBe('yaac-global-ddh16')
    expect(pv.metadata.labels).toEqual({
      app: 'yaac-server', 'yaac.install-namespace': 'test-ns', 'yaac.data-dir-hash': 'ddh16',
    })
    expect(pv.spec.accessModes).toEqual(['ReadWriteMany'])
    // `Retain` is what keeps a claim or namespace delete from touching the
    // host bytes; the empty class is what makes the pair static.
    expect(pv.spec.persistentVolumeReclaimPolicy).toBe('Retain')
    expect(pv.spec.storageClassName).toBe('')
    expect(pv.spec.claimRef).toEqual({ namespace: 'test-ns', name: 'yaac-global' })
    // `Directory`, never `DirectoryOrCreate`: a kubelet-made directory is
    // root-owned, and install creates both as the user first.
    expect(pv.spec.hostPath).toEqual({ path: '/data/yaac/global', type: 'Directory' })
    expect(pv.spec.capacity?.storage).toBeDefined()
  })
})

describe('buildServerLocalPvManifest', () => {
  it('is the RWO twin', () => {
    const pv = buildServerLocalPvManifest({ hostPath: '/data/yaac/server-local' }) as unknown as Pv
    expect(pv.metadata.name).toBe('yaac-server-local-ddh16')
    expect(pv.spec.accessModes).toEqual(['ReadWriteOnce'])
    expect(pv.spec.claimRef).toEqual({ namespace: 'test-ns', name: 'yaac-server-local' })
    expect(pv.spec.hostPath).toEqual({ path: '/data/yaac/server-local', type: 'Directory' })
  })
})

describe('buildGlobalPvcManifest', () => {
  it('names its volume outright, in the install namespace, with no hash of its own', () => {
    const pvc = buildGlobalPvcManifest() as unknown as Pv
    expect(pvc.kind).toBe('PersistentVolumeClaim')
    expect(pvc.metadata).toMatchObject({ name: 'yaac-global', namespace: 'test-ns' })
    expect(pvc.spec.storageClassName).toBe('')
    expect(pvc.spec.volumeName).toBe('yaac-global-ddh16')
    expect(pvc.spec.accessModes).toEqual(['ReadWriteMany'])
    expect(pvc.spec.resources?.requests.storage).toBe(
      (buildGlobalPvManifest({ hostPath: '/x' }) as unknown as Pv).spec.capacity?.storage,
    )
  })
})

describe('buildServerLocalPvcManifest', () => {
  it('is the RWO twin', () => {
    const pvc = buildServerLocalPvcManifest() as unknown as Pv
    expect(pvc.metadata).toMatchObject({ name: 'yaac-server-local', namespace: 'test-ns' })
    expect(pvc.spec.volumeName).toBe('yaac-server-local-ddh16')
    expect(pvc.spec.accessModes).toEqual(['ReadWriteOnce'])
  })
})

describe('storageVolumeName', () => {
  it('suffixes the claim name with the install hash', () => {
    expect(storageVolumeName('yaac-global')).toBe('yaac-global-ddh16')
  })
})

describe('ensureStorageClaims', () => {
  const dirs = (): { globalHostPath: string; serverLocalHostPath: string; nodeLocalHostPath: string } => ({
    globalHostPath: path.join(tmpDir, 'global'),
    serverLocalHostPath: path.join(tmpDir, 'server-local'),
    nodeLocalHostPath: path.join(tmpDir, 'node-local'),
  })

  it('creates the host dirs as the user, applies PV before PVC per tier, and waits on Bound', async () => {
    // Pending on the first read of each claim, Bound afterwards.
    const reads = new Map<string, number>()
    mockGetJson.mockImplementation((args: string[]) => {
      const name = args[2]
      const n = (reads.get(name) ?? 0) + 1
      reads.set(name, n)
      if (n === 1) return Promise.resolve(null)
      return Promise.resolve({
        spec: { volumeName: storageVolumeName(name) },
        status: { phase: n === 2 ? 'Pending' : 'Bound' },
      })
    })
    const log = vi.fn()

    await ensureStorageClaims({ ...dirs(), log })

    for (const dir of Object.values(dirs())) {
      expect((await fs.stat(dir)).isDirectory()).toBe(true)
    }
    expect(applied().map((m) => `${m.kind}/${m.metadata.name}`)).toEqual([
      'PersistentVolume/yaac-global-ddh16',
      'PersistentVolumeClaim/yaac-global',
      'PersistentVolume/yaac-server-local-ddh16',
      'PersistentVolumeClaim/yaac-server-local',
    ])
    expect(applied()[0].spec.hostPath?.path).toBe(path.join(tmpDir, 'global'))
    expect(applied()[2].spec.hostPath?.path).toBe(path.join(tmpDir, 'server-local'))
    expect(log.mock.calls.flat().join('\n')).toMatch(/yaac-global bound/)
    expect(log.mock.calls.flat().join('\n')).toMatch(/yaac-server-local bound/)
  })

  it('clears the stale claim reference of a Released volume before binding', async () => {
    // The claim was deleted by hand; the Retain PV survived it, `Released`.
    let pvReads = 0
    const claimReads = new Map<string, number>()
    mockGetJson.mockImplementation((args: string[]) => {
      if (args[1] === 'pv') {
        pvReads += 1
        return Promise.resolve({ status: { phase: args[2] === 'yaac-global-ddh16' ? 'Released' : 'Available' } })
      }
      const n = (claimReads.get(args[2]) ?? 0) + 1
      claimReads.set(args[2], n)
      if (n === 1) return Promise.resolve(null)
      return Promise.resolve({
        spec: { volumeName: storageVolumeName(args[2]) }, status: { phase: 'Bound' },
      })
    })
    const log = vi.fn()

    await ensureStorageClaims({ ...dirs(), log })

    expect(pvReads).toBe(2)
    const patches = mockWithRetry.mock.calls
      .map(([args]) => args as string[])
      .filter((args) => args[0] === 'patch')
    expect(patches).toHaveLength(1)
    expect(patches[0].slice(0, 3)).toEqual(['patch', 'pv', 'yaac-global-ddh16'])
    expect(JSON.parse(patches[0][patches[0].length - 1])).toEqual({
      spec: { claimRef: { uid: null, resourceVersion: null } },
    })
    expect(log.mock.calls.flat().join('\n')).toMatch(/yaac-global-ddh16 was Released/)
  })

  it('skips a claim already bound to its volume rather than re-applying an immutable spec', async () => {
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve({
      spec: { volumeName: storageVolumeName(args[2]) },
      status: { phase: 'Bound' },
    }))

    await ensureStorageClaims(dirs())

    expect(mockApply).not.toHaveBeenCalled()
  })

  it('refuses a claim bound to some other volume, naming both', async () => {
    mockGetJson.mockImplementation((args: string[]) => Promise.resolve(
      args[2] === 'yaac-global'
        ? { spec: { volumeName: 'yaac-global-elsewhere' }, status: { phase: 'Bound' } }
        : null,
    ))

    await expect(ensureStorageClaims(dirs()))
      .rejects.toThrow(/yaac-global claim .* bound to yaac-global-elsewhere, not to yaac-global-ddh16/)
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('fails with the claim named when it never binds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      mockGetJson.mockResolvedValue({ status: { phase: 'Pending' } })
      const pending = ensureStorageClaims(dirs())
      const verdict = expect(pending).rejects.toThrow(/yaac-global claim did not bind/)
      for (let i = 0; i < 200; i += 1) {
        await new Promise((r) => setImmediate(r))
        await vi.advanceTimersByTimeAsync(1_000)
      }
      await verdict
    } finally {
      vi.useRealTimers()
    }
  })
})

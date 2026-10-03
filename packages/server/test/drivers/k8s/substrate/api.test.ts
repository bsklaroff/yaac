import type * as childProcess from 'node:child_process'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiError, fakeCluster } from '@yaac/test-utils/k8s-stub'

// execFile is the one process boundary api.ts still crosses.
type ExecResult = { stdout: string; stderr: string }
const execFileMock = vi.fn<(file: string, args: readonly string[], opts: unknown) => Promise<ExecResult>>()
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  execFile: (file: string, args: readonly string[], opts: unknown, cb: (err: unknown, res?: ExecResult) => void) => {
    void execFileMock(file, args, opts).then((res) => { cb(null, res) }, (err: unknown) => { cb(err) })
  },
}))

import {
  apiStatus,
  applyObject,
  createObject,
  dataDirHash,
  deleteObject,
  deleteObjects,
  ensureKubernetes,
  execFileAsync,
  isAbsent,
  k8sErrorSummary,
  k8sNamespace,
  listObjects,
  patchObject,
  readObject,
} from '#drivers/k8s/substrate'
import { getDataDir, setDataDir } from '@yaac/shared/paths'

const cm = (name: string, labels: Record<string, string> = {}, data: Record<string, string> = {}) => ({
  apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: 'yaac', labels }, data,
})
const ref = (name: string) => ({ apiVersion: 'v1', kind: 'ConfigMap', name, namespace: 'yaac' })

describe('k8sNamespace', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to "yaac" and honors the YAAC_K8S_NAMESPACE test hook', () => {
    expect(k8sNamespace()).toBe('yaac')
    vi.stubEnv('YAAC_K8S_NAMESPACE', 'yaac-test-abc')
    expect(k8sNamespace()).toBe('yaac-test-abc')
  })
})

describe('dataDirHash', () => {
  let originalDataDir: string

  beforeEach(() => {
    originalDataDir = getDataDir()
  })

  afterEach(() => {
    setDataDir(originalDataDir)
  })

  it('is a label-safe hash, stable per data dir and distinct across dirs', () => {
    expect(dataDirHash()).toMatch(/^[0-9a-f]{16}$/)
    setDataDir('/tmp/yaac-hash-a')
    const a = dataDirHash()
    expect(dataDirHash()).toBe(a)
    setDataDir('/tmp/yaac-hash-b')
    expect(dataDirHash()).not.toBe(a)
  })
})

describe('execFileAsync', () => {
  it('runs a binary with a large output buffer and rejects without retrying', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: 'kind v0.30.0', stderr: '' })
    await expect(execFileAsync('kind', ['version'])).resolves.toEqual({ stdout: 'kind v0.30.0', stderr: '' })
    expect(execFileMock).toHaveBeenCalledWith('kind', ['version'], expect.objectContaining({ maxBuffer: 64 << 20 }))

    execFileMock.mockReset().mockRejectedValueOnce(new Error('boom'))
    await expect(execFileAsync('kind', ['get', 'clusters'])).rejects.toThrow('boom')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('applyObject', () => {
  it('server-side applies the manifest, replacing what yaac sent before', async () => {
    await applyObject(cm('a', {}, { k: '1' }))
    await applyObject(cm('a', {}, { k: '2' }))
    expect(fakeCluster.get('ConfigMap', 'a', 'yaac')).toMatchObject({ data: { k: '2' } })
    expect(fakeCluster.callsOf('apply')).toHaveLength(2)
  })
})

describe('createObject', () => {
  it('creates once and fails with 409 when the object exists', async () => {
    await createObject(cm('a'))
    const err = await createObject(cm('a')).catch((e: unknown) => e)
    expect(apiStatus(err)).toBe(409)
  })
})

describe('readObject', () => {
  it('returns the object in wire shape, and null for an absent object or kind', async () => {
    fakeCluster.seed(cm('a', {}, { k: 'v' }))
    const got = await readObject<{ data: Record<string, string>; metadata: { creationTimestamp: unknown } }>(ref('a'))
    expect(got?.data).toEqual({ k: 'v' })
    expect(typeof got?.metadata.creationTimestamp).toBe('string')
    await expect(readObject(ref('missing'))).resolves.toBeNull()
    fakeCluster.removeKind('ConfigMap')
    await expect(readObject(ref('a'))).resolves.toBeNull()
  })

  it('retries a transient failure, but fails at once on a denial', async () => {
    fakeCluster.seed(cm('a'))
    let unavailable = 1
    fakeCluster.intercept(() => {
      if (unavailable-- > 0) throw apiError(503, 'the server is currently unable to handle the request')
      return undefined
    })
    await expect(readObject(ref('a'))).resolves.toMatchObject({ metadata: { name: 'a' } })
    expect(fakeCluster.callsOf('read')).toHaveLength(2)

    fakeCluster.reset()
    fakeCluster.intercept(() => { throw apiError(403, 'forbidden') })
    await expect(readObject(ref('a'))).rejects.toThrow('403')
    expect(fakeCluster.callsOf('read')).toHaveLength(1)
  })
})

describe('listObjects', () => {
  it('filters by namespace, label selector and field selector', async () => {
    fakeCluster.seed(cm('a', { app: 'x' }), cm('b', { app: 'y' }), { ...cm('c', { app: 'x' }), metadata: { name: 'c', namespace: 'other', labels: { app: 'x' } } })
    const names = async (opts: Parameters<typeof listObjects>[2]) =>
      (await listObjects('v1', 'ConfigMap', opts)).map((o) => o.metadata?.name).sort()
    expect(await names({ namespace: 'yaac' })).toEqual(['a', 'b'])
    expect(await names({ labelSelector: 'app=x' })).toEqual(['a', 'c'])
    expect(await names({ namespace: 'yaac', fieldSelector: 'metadata.name=b' })).toEqual(['b'])
  })
})

describe('patchObject', () => {
  it('merge-patches, deleting a field set to null', async () => {
    fakeCluster.seed(cm('a', { keep: '1', drop: '1' }))
    await patchObject(ref('a'), { metadata: { labels: { drop: null, add: '2' } } })
    expect(fakeCluster.get<{ metadata: { labels: object } }>('ConfigMap', 'a', 'yaac')?.metadata.labels)
      .toEqual({ keep: '1', add: '2' })
  })
})

describe('deleteObject', () => {
  it('deletes, and treats an absent object as success', async () => {
    fakeCluster.seed(cm('a'))
    await deleteObject(ref('a'), { wait: true })
    await deleteObject(ref('a'))
    expect(fakeCluster.get('ConfigMap', 'a', 'yaac')).toBeUndefined()
    expect(fakeCluster.callsOf('delete')).toHaveLength(2)
  })
})

describe('deleteObjects', () => {
  it('deletes only the objects the selector matches', async () => {
    fakeCluster.seed(cm('a', { app: 'x' }), cm('b', { app: 'y' }))
    await deleteObjects('v1', 'ConfigMap', { namespace: 'yaac', labelSelector: 'app=x' })
    expect(fakeCluster.objects('ConfigMap').map((o) => o.metadata.name)).toEqual(['b'])
  })
})

describe('apiStatus', () => {
  it('is the HTTP code of an API failure and undefined for anything else', () => {
    expect(apiStatus(apiError(409))).toBe(409)
    expect(apiStatus(new Error('ECONNREFUSED'))).toBeUndefined()
  })
})

describe('isAbsent', () => {
  it('counts a 404 or an unknown kind as absent, but not a denial or a webhook failure', () => {
    expect(isAbsent(apiError(404))).toBe(true)
    expect(isAbsent(new Error('Unrecognized API version and kind: crd.projectcalico.org/v1 FelixConfiguration'))).toBe(true)
    expect(isAbsent(apiError(403))).toBe(false)
    expect(isAbsent(apiError(500, 'failed calling webhook: service "calico-apiserver" not found'))).toBe(false)
  })
})

describe('k8sErrorSummary', () => {
  it('shows the status and the API server\'s message on one capped line', () => {
    expect(k8sErrorSummary(apiError(403, 'nodes is forbidden'))).toBe('403: nodes is forbidden')
    expect(k8sErrorSummary(new Error('connect ECONNREFUSED\nstack'))).toBe('connect ECONNREFUSED')
    expect(k8sErrorSummary(new Error('x'.repeat(300)))).toHaveLength(141)
  })
})

describe('ensureKubernetes', () => {
  it('resolves when the API server answers and points at setup when it does not', async () => {
    await expect(ensureKubernetes()).resolves.toBeUndefined()
    fakeCluster.unreachable = new Error('connect ECONNREFUSED 127.0.0.1:6443')
    await expect(ensureKubernetes()).rejects.toThrow(/not reachable[\s\S]*yaac cluster check[\s\S]*ECONNREFUSED/)
  })
})

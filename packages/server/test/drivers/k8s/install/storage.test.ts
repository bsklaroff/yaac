/**
 * The two storage claims, bound through both storage shapes. kubectl is
 * backed by a small fake of the apiserver's claims and volumes, with a
 * provisioner that binds only once a pod uses the claim (like a
 * `WaitForFirstConsumer` class). The static shape uses a real data dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
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

import { deleteStorageVolumes, ensureStorageClaims, type StorageShape } from '#drivers/k8s/install'

interface Obj {
  kind: string
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  spec: {
    accessModes?: string[]
    persistentVolumeReclaimPolicy?: string
    storageClassName?: string
    claimRef?: { namespace?: string; name?: string; uid?: string | null }
    hostPath?: { path: string; type: string }
    csi?: { driver: string }
    mountOptions?: string[]
    volumeName?: string
    capacity?: { storage: string }
    resources?: { requests: { storage: string } }
    securityContext?: Record<string, unknown>
    containers?: Array<{ image: string; command: string[] }>
  }
  status?: { phase: string }
}

/**
 * The fake apiserver's storage. A claim naming a volume binds at once; a
 * claim naming only a class stays Pending until the binder pod uses it, then
 * gets a volume with the class's settings (`Delete`, its mount options).
 */
let claims: Map<string, Obj>
let volumes: Map<string, Obj>
let classOptions: string[]
/** What the binder pod prints; a test may change it. */
let binderLogs: string
let binderPhase: string

function provision(claim: Obj): void {
  const name = `pvc-${claim.metadata.name}-provisioned`
  volumes.set(name, {
    kind: 'PersistentVolume',
    metadata: { name, labels: {} },
    spec: {
      storageClassName: claim.spec.storageClassName,
      persistentVolumeReclaimPolicy: 'Delete',
      csi: { driver: claim.spec.accessModes?.[0] === 'ReadWriteMany' ? 'nfs.csi.k8s.io' : 'rancher.io/local-path' },
      mountOptions: claim.spec.accessModes?.[0] === 'ReadWriteMany' ? [...classOptions] : [],
      claimRef: { namespace: 'test-ns', name: claim.metadata.name },
      capacity: { storage: claim.spec.resources?.requests.storage ?? '' },
    },
    status: { phase: 'Bound' },
  })
  claim.spec.volumeName = name
  claim.status = { phase: 'Bound' }
}

function fakeApply(manifest: Obj): Promise<void> {
  if (manifest.kind === 'PersistentVolume') {
    const existing = volumes.get(manifest.metadata.name)
    volumes.set(manifest.metadata.name, { ...manifest, status: existing?.status ?? { phase: 'Available' } })
  } else if (manifest.kind === 'PersistentVolumeClaim') {
    const claim: Obj = structuredClone(manifest)
    claim.status = { phase: 'Pending' }
    const volume = claim.spec.volumeName ? volumes.get(claim.spec.volumeName) : undefined
    if (volume && volume.status?.phase === 'Available') {
      claim.status = { phase: 'Bound' }
      volume.status = { phase: 'Bound' }
    }
    claims.set(manifest.metadata.name, claim)
  } else if (manifest.kind === 'Pod' && binderPhase === 'Succeeded') {
    for (const claim of claims.values()) if (claim.status?.phase === 'Pending') provision(claim)
  }
  return Promise.resolve()
}

function fakeGetJson(args: string[]): Promise<unknown> {
  const [, kind, name] = args
  if (kind === 'pvc') return Promise.resolve(claims.get(name) ?? null)
  if (kind === 'pv' && name === '-l') {
    const wanted = args[3].split(',').map((kv) => kv.split('=') as [string, string])
    return Promise.resolve({
      items: [...volumes.values()].filter((v) =>
        wanted.every(([k, val]) => v.metadata.labels?.[k] === val)),
    })
  }
  if (kind === 'pv') return Promise.resolve(volumes.get(name) ?? null)
  if (kind === 'pod') return Promise.resolve({ status: { phase: binderPhase } })
  return Promise.resolve(null)
}

function fakeRetry(args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (args[0] === 'patch' && args[1] === 'pv') {
    const volume = volumes.get(args[2])
    const patch = JSON.parse(args[args.length - 1]) as Partial<Obj>
    if (volume) {
      volume.metadata.labels = { ...volume.metadata.labels, ...patch.metadata?.labels }
      volume.spec = { ...volume.spec, ...patch.spec, claimRef: { ...volume.spec.claimRef, ...patch.spec?.claimRef } }
      if (patch.spec?.claimRef && volume.status?.phase === 'Released') volume.status = { phase: 'Available' }
    }
  }
  if (args[0] === 'logs') return Promise.resolve({ stdout: binderLogs, stderr: '' })
  if (args[0] === 'wait') {
    const pending = args.filter((a) => a.startsWith('pvc/'))
      .filter((a) => claims.get(a.slice(4))?.status?.phase !== 'Bound')
    if (pending.length > 0) return Promise.reject(new Error('timed out waiting for the condition'))
  }
  return Promise.resolve({ stdout: '', stderr: '' })
}

let tmpDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  tmpDir = await createTempDataDir()
  claims = new Map()
  volumes = new Map()
  classOptions = ['nfsvers=4.1']
  binderLogs = ''
  binderPhase = 'Succeeded'
  mockApply.mockImplementation(fakeApply)
  mockGetJson.mockImplementation(fakeGetJson)
  mockWithRetry.mockImplementation(fakeRetry)
})

afterEach(async () => {
  await cleanupTempDir(tmpDir)
})

const applied = (): Obj[] => (mockApply.mock.calls as Array<[Obj]>).map(([m]) => m)
const patches = (): string[][] => (mockWithRetry.mock.calls as Array<[string[]]>)
  .map(([args]) => args).filter((args) => args[0] === 'patch')

describe('ensureStorageClaims', () => {
  const staticShape = (): StorageShape => ({
    kind: 'static',
    globalHostPath: path.join(tmpDir, 'global'),
    serverLocalHostPath: path.join(tmpDir, 'server-local'),
    nodeLocalHostPath: path.join(tmpDir, 'node-local'),
  })
  const classShape: StorageShape = {
    kind: 'classes',
    rwx: 'nfs-class',
    rwo: 'block-class',
    identity: { uid: 1000, gid: 1000 },
    installId: 'install-1',
    binderImage: 'reg.local:5000/yaac-server:abc',
  }

  it('static: makes the host dirs, binds a retained hostPath volume per tier, claim-bound by name', async () => {
    const log = vi.fn()
    await ensureStorageClaims({ shape: staticShape(), log })

    for (const dir of ['global', 'server-local', 'node-local']) {
      expect((await fs.stat(path.join(tmpDir, dir))).isDirectory()).toBe(true)
    }
    expect(applied().map((m) => `${m.kind}/${m.metadata.name}`)).toEqual([
      'PersistentVolume/yaac-global-ddh16',
      'PersistentVolumeClaim/yaac-global',
      'PersistentVolume/yaac-server-local-ddh16',
      'PersistentVolumeClaim/yaac-server-local',
    ])
    const [globalPv, globalPvc, localPv] = applied()
    expect(globalPv.metadata.labels).toEqual({
      app: 'yaac-server', 'yaac.install-namespace': 'test-ns',
      'yaac.data-dir-hash': 'ddh16', 'yaac.claim': 'yaac-global',
    })
    // `Retain` survives a claim or namespace delete; the empty class makes
    // the binding static; `Directory`, since a kubelet-created directory
    // would be root-owned.
    expect(globalPv.spec).toMatchObject({
      accessModes: ['ReadWriteMany'],
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: '',
      claimRef: { namespace: 'test-ns', name: 'yaac-global' },
      hostPath: { path: path.join(tmpDir, 'global'), type: 'Directory' },
    })
    expect(localPv.spec).toMatchObject({
      accessModes: ['ReadWriteOnce'],
      hostPath: { path: path.join(tmpDir, 'server-local'), type: 'Directory' },
    })
    expect(globalPvc.metadata).toMatchObject({ name: 'yaac-global', namespace: 'test-ns' })
    expect(globalPvc.spec).toMatchObject({ storageClassName: '', volumeName: 'yaac-global-ddh16' })
    // No binder pod: the host created the dirs as its user.
    expect(applied().some((m) => m.kind === 'Pod')).toBe(false)
    expect(log.mock.calls.flat().join('\n')).toMatch(/yaac-server-local bound/)
  })

  it('static: clears the stale claim reference of a Released volume before binding', async () => {
    volumes.set('yaac-global-ddh16', {
      kind: 'PersistentVolume', metadata: { name: 'yaac-global-ddh16' },
      spec: { claimRef: { namespace: 'test-ns', name: 'yaac-global', uid: 'old' } },
      status: { phase: 'Released' },
    })
    const log = vi.fn()
    await ensureStorageClaims({ shape: staticShape(), log })

    expect(patches()).toHaveLength(1)
    expect(patches()[0].slice(0, 3)).toEqual(['patch', 'pv', 'yaac-global-ddh16'])
    expect(JSON.parse(patches()[0].at(-1)!)).toEqual({
      spec: { claimRef: { namespace: 'test-ns', name: 'yaac-global', uid: null, resourceVersion: null } },
    })
    expect(claims.get('yaac-global')?.status?.phase).toBe('Bound')
  })

  it('static: leaves a bound claim alone, and refuses one bound to another volume', async () => {
    claims.set('yaac-global', {
      kind: 'PersistentVolumeClaim', metadata: { name: 'yaac-global' },
      spec: { volumeName: 'yaac-global-ddh16' }, status: { phase: 'Bound' },
    })
    claims.set('yaac-server-local', {
      kind: 'PersistentVolumeClaim', metadata: { name: 'yaac-server-local' },
      spec: { volumeName: 'yaac-server-local-ddh16' }, status: { phase: 'Bound' },
    })
    await ensureStorageClaims({ shape: staticShape() })
    expect(mockApply).not.toHaveBeenCalled()

    claims.get('yaac-global')!.spec.volumeName = 'yaac-global-elsewhere'
    await expect(ensureStorageClaims({ shape: staticShape() }))
      .rejects.toThrow(/yaac-global claim .* bound to yaac-global-elsewhere, not to yaac-global-ddh16/)
  })

  it('static: fails with the claim named when it never binds', async () => {
    mockApply.mockResolvedValue(undefined)
    claims.set('yaac-global', {
      kind: 'PersistentVolumeClaim', metadata: { name: 'yaac-global' }, spec: {}, status: { phase: 'Pending' },
    })
    await expect(ensureStorageClaims({ shape: staticShape() }))
      .rejects.toThrow(/yaac-global claim did not bind within 60s \(phase Pending\)/)
    expect(mockWithRetry).toHaveBeenCalledWith(expect.arrayContaining([
      'wait', 'pvc/yaac-global', 'pvc/yaac-server-local', '--for=jsonpath={.status.phase}=Bound',
    ]), expect.anything())
  })

  it('classes: provisions through the named classes, binds by consuming, and pins what bound', async () => {
    // A typical class: `Delete`, and a long attribute cache.
    classOptions = ['nfsvers=4.1', 'soft', 'actimeo=30']
    binderLogs = 'BIND_CHOWNED=/claims/global\nBIND_CHOWNED=/claims/server-local\n'
    const log = vi.fn()
    await ensureStorageClaims({ shape: classShape, log })

    const [globalPvc, localPvc] = applied().filter((m) => m.kind === 'PersistentVolumeClaim')
    expect(globalPvc.spec).toMatchObject({ storageClassName: 'nfs-class', accessModes: ['ReadWriteMany'] })
    expect(globalPvc.spec.volumeName).toBeUndefined()
    expect(localPvc.spec).toMatchObject({ storageClassName: 'block-class', accessModes: ['ReadWriteOnce'] })
    // The RWO claim requests a real size.
    expect(localPvc.spec.resources?.requests.storage).toMatch(/Gi$/)

    // The binder pod is the first consumer, so it triggers binding. It runs
    // as root to chown each volume root to the install's user.
    const binder = applied().find((m) => m.kind === 'Pod')!
    expect(binder.metadata.name).toBe('yaac-storage-bind')
    expect(binder.spec.securityContext).toEqual({ runAsUser: 0, runAsGroup: 0 })
    expect(binder.spec.containers?.[0].image).toBe('reg.local:5000/yaac-server:abc')
    expect(binder.spec.containers?.[0].command.slice(-3)).toEqual(['1000', '1000', 'install-1'])
    expect(log.mock.calls.flat().join('\n')).toMatch(/\/claims\/global now belongs to uid 1000/)

    const globalPv = volumes.get('pvc-yaac-global-provisioned')!
    const localPv = volumes.get('pvc-yaac-server-local-provisioned')!
    // Retain regardless of class, so a namespace delete keeps the data.
    expect(globalPv.spec.persistentVolumeReclaimPolicy).toBe('Retain')
    expect(localPv.spec.persistentVolumeReclaimPolicy).toBe('Retain')
    // The class's options are kept, except actimeo, which yaac lowers.
    expect(globalPv.spec.mountOptions).toEqual(['nfsvers=4.1', 'soft', 'actimeo=1'])
    expect(localPv.spec.mountOptions).toEqual([])
    // Labelled with the install id so only this install re-adopts them.
    expect(globalPv.metadata.labels).toMatchObject({
      'yaac.install-id': 'install-1', 'yaac.install-namespace': 'test-ns', 'yaac.claim': 'yaac-global',
    })
  })

  /** A volume that outlived its claim. */
  const looseVolume = (name: string, labels: Record<string, string>, over: Partial<Obj['spec']> = {}, phase = 'Released'): void => {
    volumes.set(name, {
      kind: 'PersistentVolume',
      metadata: { name, labels: { 'yaac.install-namespace': 'test-ns', 'yaac.claim': 'yaac-global', ...labels } },
      spec: {
        storageClassName: 'nfs-class', capacity: { storage: '100Gi' }, mountOptions: ['actimeo=1'],
        claimRef: { namespace: 'test-ns', name: 'yaac-global', uid: 'old' }, ...over,
      },
      status: { phase },
    })
  }

  it('classes: re-adopts this install\'s Released volume, and no other install\'s', async () => {
    // Near-misses: still Bound, another namespace's, and another claim
    // name under the same install id.
    looseVolume('pvc-bound', { 'yaac.install-id': 'install-1' }, {}, 'Bound')
    looseVolume('pvc-other-ns', { 'yaac.install-id': 'install-1', 'yaac.install-namespace': 'other-ns' })
    looseVolume('pvc-other-claim', { 'yaac.install-id': 'install-1', 'yaac.claim': 'something-else' })
    // After a namespace delete, the Retain volumes remain.
    looseVolume('pvc-old-global', { 'yaac.install-id': 'install-1', 'yaac.data-dir-hash': 'ddh16' })
    const log = vi.fn()
    await ensureStorageClaims({ shape: classShape, log })

    const globalPvc = applied().find((m) => m.kind === 'PersistentVolumeClaim' && m.metadata.name === 'yaac-global')!
    expect(globalPvc.spec).toMatchObject({ volumeName: 'pvc-old-global', storageClassName: 'nfs-class' })
    expect(JSON.parse(patches()[0].at(-1)!)).toMatchObject({ spec: { claimRef: { uid: null } } })
    expect(patches()[0][2]).toBe('pvc-old-global')
    expect(claims.get('yaac-global')?.spec.volumeName).toBe('pvc-old-global')
    expect(volumes.has('pvc-yaac-server-local-provisioned')).toBe(true)
    expect(volumes.has('pvc-yaac-global-provisioned')).toBe(false)
    expect(log.mock.calls.flat().join('\n')).toMatch(/Re-adopting yaac-global's volume pvc-old-global/)
  })

  it('classes: refuses another install\'s volume from the same data-dir path, and this one\'s under another class', async () => {
    // Same path hash but another install id (e.g. the same `~/.yaac` on
    // another machine). Its data must only be adopted on purpose.
    looseVolume('pvc-theirs', { 'yaac.install-id': 'install-2', 'yaac.data-dir-hash': 'ddh16' })
    const foreign = ensureStorageClaims({ shape: classShape })
    await expect(foreign).rejects.toThrow(/volume pvc-theirs .* not by this one \(its install id is install-2, this install's is install-1\)/)
    await expect(foreign).rejects.toThrow(/kubectl label pv pvc-theirs yaac.install-id=install-1 --overwrite/)
    expect(applied()).toEqual([])
    expect(patches()).toEqual([])

    // With the hash label removed it no longer matches, and a new volume
    // is provisioned.
    delete volumes.get('pvc-theirs')!.metadata.labels!['yaac.data-dir-hash']
    await ensureStorageClaims({ shape: classShape })
    expect(claims.get('yaac-global')?.spec.volumeName).toBe('pvc-yaac-global-provisioned')

    // This install's volume under a different class is refused too.
    claims.clear()
    volumes.clear()
    looseVolume('pvc-mine', { 'yaac.install-id': 'install-1' }, { storageClassName: 'old-class' })
    await expect(ensureStorageClaims({ shape: classShape }))
      .rejects.toThrow(/volume pvc-mine is in class "old-class", not "nfs-class"/)
  })

  it('classes: leaves bound claims alone but still re-pins them, and refuses a class change', async () => {
    await ensureStorageClaims({ shape: classShape })
    mockApply.mockClear()
    volumes.get('pvc-yaac-global-provisioned')!.spec.persistentVolumeReclaimPolicy = 'Delete'

    await ensureStorageClaims({ shape: classShape })
    expect(applied().filter((m) => m.kind === 'PersistentVolumeClaim')).toEqual([])
    // A re-install restores a policy someone changed back.
    expect(volumes.get('pvc-yaac-global-provisioned')!.spec.persistentVolumeReclaimPolicy).toBe('Retain')

    await expect(ensureStorageClaims({ shape: { ...classShape, rwx: 'other-class' } }))
      .rejects.toThrow(/provisioned through class "nfs-class", not "other-class"/)
  })

  it('classes: the binder claims empty roots and refuses one holding another install\'s data', async () => {
    // The binder's script, run by a real sh against real directories.
    await ensureStorageClaims({ shape: classShape })
    const [, , script] = applied().find((m) => m.kind === 'Pod')!.spec.containers![0].command
    const claimsDir = path.join(tmpDir, 'claims')
    const bind = async (id: string): Promise<{ code: number; out: string }> => {
      const rebased = script.replaceAll('/claims/', `${claimsDir}/`)
      return new Promise((resolve) => {
        execFile('sh', ['-c', rebased, '--', String(process.getuid!()), String(process.getgid!()), id],
          (err, stdout) => resolve({ code: err ? 1 : 0, out: stdout }))
      })
    }
    for (const root of ['global', 'server-local']) await fs.mkdir(path.join(claimsDir, root), { recursive: true })
    // A fresh block volume has lost+found, which counts as empty.
    await fs.mkdir(path.join(claimsDir, 'server-local', 'lost+found'))
    expect(await bind('install-1')).toMatchObject({ code: 0 })
    expect(await fs.readFile(path.join(claimsDir, 'global', '.yaac-install'), 'utf8')).toBe('install-1')
    expect(((await fs.stat(path.join(claimsDir, 'global'))).mode & 0o7777).toString(8)).toBe('2775')
    // Idempotent for the same install, even with data present.
    await fs.writeFile(path.join(claimsDir, 'global', 'db'), 'rows')
    expect(await bind('install-1')).toMatchObject({ code: 0 })

    // Another install given the same directories (a class with a fixed
    // subDir) is refused by the marker.
    const other = await bind('install-2')
    expect(other.code).toBe(1)
    expect(other.out).toContain(`BIND_FOREIGN=${claimsDir}/global=install-1`)
    expect(await fs.readFile(path.join(claimsDir, 'global', '.yaac-install'), 'utf8')).toBe('install-1')
    // A root with content but no marker is refused too.
    await fs.rm(path.join(claimsDir, 'global', '.yaac-install'))
    expect((await bind('install-2')).out).toContain(`BIND_FOREIGN=${claimsDir}/global=`)

    // Install reports it naming both installs and the fix.
    claims.clear()
    volumes.clear()
    binderLogs = 'BIND_FOREIGN=/claims/global=install-9\n'
    binderPhase = 'Failed'
    await expect(ensureStorageClaims({ shape: classShape }))
      .rejects.toThrow(/\/claims\/global already holds the install install-9's data, not this install's \(install-1\)[\s\S]*fixed `subDir`/)
  })

  it('classes: names the fix when the export will not let root chown the volume root', async () => {
    binderLogs = 'BIND_REFUSED=/claims/global\n'
    binderPhase = 'Failed'
    await expect(ensureStorageClaims({ shape: classShape }))
      .rejects.toThrow(/\/claims\/global belong to uid 1000[\s\S]*no_root_squash[\s\S]*mountPermissions/)
  })
})

describe('deleteStorageVolumes', () => {
  it('deletes the cluster-scoped volumes by install namespace, never waiting on them', async () => {
    await deleteStorageVolumes('yaac-test-run')
    expect(mockWithRetry.mock.calls[0][0]).toEqual([
      'delete', 'pv', '-l', 'yaac.install-namespace=yaac-test-run', '--ignore-not-found', '--wait=false',
    ])
  })
})

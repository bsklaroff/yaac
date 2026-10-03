/**
 * The two storage claims, bound through both storage shapes, against the
 * shared fake cluster. A reconcile hook run before every read plays the
 * apiserver's binding controllers: a claim naming an Available volume
 * binds at once, and a claim naming only a class stays Pending until the
 * binder pod has run (like a `WaitForFirstConsumer` class). The static
 * shape uses a real data dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fakeCluster, type FakeCall } from '@yaac/test-utils/k8s-stub'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type * as apiModule from '#drivers/k8s/substrate/api'

vi.mock('#drivers/k8s/substrate/api', async (importOriginal) => ({
  ...(await importOriginal<typeof apiModule>()),
  k8sNamespace: () => 'test-ns',
  dataDirHash: () => 'ddh16',
}))

import { deleteStorageVolumes, ensureStorageClaims, type StorageShape } from '#drivers/k8s/install'

interface Obj {
  apiVersion?: string
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

let classOptions: string[]
/** What the binder pod prints and how it ends; a test may change them. */
let binderLogs: string
let binderPhase: string
/** Whether claims bind at all; off stands in for a stuck provisioner. */
let binding: boolean

const volume = (name: string): Obj | undefined => fakeCluster.get<Obj>('PersistentVolume', name)
const claim = (name: string): Obj | undefined => fakeCluster.get<Obj>('PersistentVolumeClaim', name, 'test-ns')
const put = (obj: Obj): void => { fakeCluster.seed({ apiVersion: 'v1', ...obj }) }

function provision(pvc: Obj): void {
  const name = `pvc-${pvc.metadata.name}-provisioned`
  put({
    kind: 'PersistentVolume',
    metadata: { name, labels: {} },
    spec: {
      storageClassName: pvc.spec.storageClassName,
      persistentVolumeReclaimPolicy: 'Delete',
      csi: { driver: pvc.spec.accessModes?.[0] === 'ReadWriteMany' ? 'nfs.csi.k8s.io' : 'rancher.io/local-path' },
      mountOptions: pvc.spec.accessModes?.[0] === 'ReadWriteMany' ? [...classOptions] : [],
      claimRef: { namespace: 'test-ns', name: pvc.metadata.name },
      capacity: { storage: pvc.spec.resources?.requests.storage ?? '' },
    },
    status: { phase: 'Bound' },
  })
  put({ ...pvc, spec: { ...pvc.spec, volumeName: name }, status: { phase: 'Bound' } })
}

/** The binding controllers, run before every read. */
function reconcile(call: FakeCall): void {
  if (call.verb !== 'read' && call.verb !== 'list') return
  for (const pv of fakeCluster.objects<Obj>('PersistentVolume')) {
    // A cleared claimRef uid frees a Released volume.
    const freed = pv.status?.phase === 'Released' && pv.spec.claimRef && !pv.spec.claimRef.uid
    if (!pv.status || freed) put({ ...pv, status: { phase: 'Available' } })
  }
  for (const pvc of fakeCluster.objects<Obj>('PersistentVolumeClaim')) {
    if (pvc.status?.phase === 'Bound') continue
    const pv = pvc.spec.volumeName ? volume(pvc.spec.volumeName) : undefined
    if (binding && pv?.status?.phase === 'Available') {
      put({ ...pv, status: { phase: 'Bound' } })
      put({ ...pvc, status: { phase: 'Bound' } })
    } else if (!pvc.status) {
      put({ ...pvc, status: { phase: 'Pending' } })
    }
  }
  const binder = fakeCluster.get<Obj>('Pod', 'yaac-storage-bind', 'test-ns')
  if (binder && !binder.status) {
    put({ ...binder, status: { phase: binderPhase } })
    if (binding && binderPhase === 'Succeeded') {
      for (const pvc of fakeCluster.objects<Obj>('PersistentVolumeClaim')) {
        if (pvc.status?.phase === 'Pending') provision(pvc)
      }
    }
  }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  classOptions = ['nfsvers=4.1']
  binderLogs = ''
  binderPhase = 'Succeeded'
  binding = true
  wipe()
})

/** An empty cluster with the binding controllers running. */
function wipe(): void {
  fakeCluster.reset()
  fakeCluster.intercept(reconcile)
  fakeCluster.intercept((call) => {
    if (call.verb === 'read' && call.kind === 'Pod') fakeCluster.podLogs.set('yaac-storage-bind', binderLogs)
  })
}

afterEach(async () => {
  vi.useRealTimers()
  await cleanupTempDir(tmpDir)
})

const applied = (): Obj[] => fakeCluster.callsOf('apply').map((c) => c.body as unknown as Obj)
const patches = (): FakeCall[] => fakeCluster.callsOf('patch', 'PersistentVolume')

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
    // A server-side apply keeps the status and the claimRef uid the
    // controllers own, which the fake's apply drops; restore them until the
    // patch clears the uid.
    fakeCluster.intercept((call) => {
      const pv = volume('yaac-global-ddh16')
      if (call.verb === 'read' && call.name === 'yaac-global-ddh16' && pv && patches().length === 0) {
        put({ ...pv, spec: { ...pv.spec, claimRef: { ...pv.spec.claimRef, uid: 'old' } }, status: { phase: 'Released' } })
      }
    })
    const log = vi.fn()
    await ensureStorageClaims({ shape: staticShape(), log })

    expect(patches()).toHaveLength(1)
    expect(patches()[0]).toMatchObject({
      name: 'yaac-global-ddh16',
      body: { spec: { claimRef: { namespace: 'test-ns', name: 'yaac-global', uid: null, resourceVersion: null } } },
    })
    expect(claim('yaac-global')?.status?.phase).toBe('Bound')
  })

  it('static: leaves a bound claim alone, and refuses one bound to another volume', async () => {
    const boundClaim = (name: string, volumeName: string): void => put({
      kind: 'PersistentVolumeClaim', metadata: { name, namespace: 'test-ns' },
      spec: { volumeName }, status: { phase: 'Bound' },
    })
    boundClaim('yaac-global', 'yaac-global-ddh16')
    boundClaim('yaac-server-local', 'yaac-server-local-ddh16')
    await ensureStorageClaims({ shape: staticShape() })
    expect(applied()).toEqual([])

    boundClaim('yaac-global', 'yaac-global-elsewhere')
    await expect(ensureStorageClaims({ shape: staticShape() }))
      .rejects.toThrow(/yaac-global claim .* bound to yaac-global-elsewhere, not to yaac-global-ddh16/)
  })

  it('static: fails with the claim named when it never binds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    binding = false
    let settled = false
    const run = ensureStorageClaims({ shape: staticShape() }).finally(() => { settled = true })
    const failed = expect(run).rejects.toThrow(/yaac-global claim did not bind within 60s \(phase Pending\)/)
    // Tick until settled, letting the real disk I/O run between ticks.
    for (let i = 0; i < 1_000 && !settled; i += 1) {
      await new Promise((r) => setImmediate(r))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await failed
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

    const globalPv = volume('pvc-yaac-global-provisioned')!
    const localPv = volume('pvc-yaac-server-local-provisioned')!
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
    put({
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
    expect(patches()[0]).toMatchObject({ name: 'pvc-old-global', body: { spec: { claimRef: { uid: null } } } })
    expect(claim('yaac-global')?.spec.volumeName).toBe('pvc-old-global')
    expect(volume('pvc-yaac-server-local-provisioned')).toBeDefined()
    expect(volume('pvc-yaac-global-provisioned')).toBeUndefined()
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
    const theirs = volume('pvc-theirs')!
    delete theirs.metadata.labels!['yaac.data-dir-hash']
    put(theirs)
    await ensureStorageClaims({ shape: classShape })
    expect(claim('yaac-global')?.spec.volumeName).toBe('pvc-yaac-global-provisioned')

    // This install's volume under a different class is refused too.
    wipe()
    looseVolume('pvc-mine', { 'yaac.install-id': 'install-1' }, { storageClassName: 'old-class' })
    await expect(ensureStorageClaims({ shape: classShape }))
      .rejects.toThrow(/volume pvc-mine is in class "old-class", not "nfs-class"/)
  })

  it('classes: leaves bound claims alone but still re-pins them, and refuses a class change', async () => {
    await ensureStorageClaims({ shape: classShape })
    const pv = volume('pvc-yaac-global-provisioned')!
    put({ ...pv, spec: { ...pv.spec, persistentVolumeReclaimPolicy: 'Delete' } })
    fakeCluster.calls = []

    await ensureStorageClaims({ shape: classShape })
    expect(applied().filter((m) => m.kind === 'PersistentVolumeClaim')).toEqual([])
    // A re-install restores a policy someone changed back.
    expect(volume('pvc-yaac-global-provisioned')!.spec.persistentVolumeReclaimPolicy).toBe('Retain')

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
    wipe()
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
  it('deletes the cluster-scoped volumes by install namespace, and only those', async () => {
    const pv = (name: string, ns: string): void => put({
      kind: 'PersistentVolume', metadata: { name, labels: { 'yaac.install-namespace': ns } }, spec: {},
    })
    pv('mine', 'yaac-test-run')
    pv('theirs', 'yaac')
    await deleteStorageVolumes('yaac-test-run')
    expect(fakeCluster.objects('PersistentVolume').map((o) => o.metadata.name)).toEqual(['theirs'])
  })
})

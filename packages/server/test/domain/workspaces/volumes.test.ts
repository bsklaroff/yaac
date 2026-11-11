/**
 * Volumes as the API and `yaac-mama` reach them: create, list, grow and
 * delete, and the sweep that ends a lease once its holder's runtime is gone
 * (docs/workspace-volumes.md). The driver is the fake, recording what it was
 * asked; leases are taken by real creates in restart.test.ts.
 */
import { namedWorkflowFor } from '#test/support/workflows'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { collectDeletedVolumes, createVolume, deleteVolume, listVolumes, reconcileVolumeLeases, resizeVolume, workspacesAlive } from '#domain/workspaces'
import { BUILT_IN_USER_ID, claimVolume, findVolumeByName, insertSite, listDeletedVolumeIds, setWorkspaceVolume, stageVolume, updateSite } from '#db'
import { closeDb } from '#db/client'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { clearAllProvisioningForTests, provision } from '#domain/workspaces/provisioning'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, snapshotFixture } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import type { RuntimeHandle, VolumeRef } from '#drivers/contract'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const stranger = { kind: 'local', userId: 'someone-else' } as const

let tmpDir: string
/** What the driver was asked, in order. */
let asked: string[]
/** Units the driver reports, by workspace id. */
let units: Set<string>
/** Volume ids whose disks the driver reports bound. */
let bound: Set<string>
/** The volume storage the driver reports, by volume id: whether a pod mounts it. */
let stored: Map<string, boolean>

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject()
  asked = []
  units = new Set()
  bound = new Set()
  stored = new Map()
  installFakeWorkspaceDriver({
    ensureVolume: (v: VolumeRef) => { asked.push(`ensure ${v.size}`); return Promise.resolve() },
    resizeVolume: (v, size) => { asked.push(`resize ${v.size}->${size}`); return Promise.resolve() },
    deleteVolume: (id) => { asked.push(`delete ${id}`); return Promise.resolve() },
    volumeStorage: () => Promise.resolve([...stored].map(([volumeId, mounted]) => ({ volumeId, mounted }))),
    pinVolumes: (ids) => Promise.resolve(ids.filter((id) => bound.has(id))),
    findForTeardown: (id) => Promise.resolve(units.has(id) ? { workspaceId: id, projectId: DEMO_PROJECT_ID, unitName: id } : undefined),
  })
})

afterEach(async () => {
  clearAllProvisioningForTests()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const held = (workspaceId: string): RuntimeHandle =>
  handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId, jobName: workspaceId })

async function holding(workspaceId: string, name: string): Promise<void> {
  await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId, title: `T ${workspaceId}` })
  const v = await findVolumeByName(DEMO_PROJECT_ID, name)
  await claimVolume(v!.id, workspaceId)
  await setWorkspaceVolume(workspaceId, v!.id)
}

describe('createVolume', () => {
  it('makes its storage, and refuses a bad name or size, a taken name, a non-owner and a host server', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'merge-queue')
    await createVolume(local, DEMO_PROJECT_ID, 'small', '500Mi')
    expect(asked).toEqual(['ensure 10Gi', 'ensure 500Mi'])

    await expect(createVolume(local, DEMO_PROJECT_ID, 'Bad Name')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(createVolume(local, DEMO_PROJECT_ID, 'x', '10 gigs')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(createVolume(local, DEMO_PROJECT_ID, 'small')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(createVolume(stranger, DEMO_PROJECT_ID, 'y')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // Storage that cannot be made leaves no row behind.
    installFakeWorkspaceDriver({ ensureVolume: () => Promise.reject(new Error('quota')) })
    await expect(createVolume(local, DEMO_PROJECT_ID, 'z')).rejects.toThrow('quota')
    expect(await findVolumeByName(DEMO_PROJECT_ID, 'z')).toBeUndefined()

    installFakeWorkspaceDriver({ kind: 'containerless' })
    await expect(createVolume(local, DEMO_PROJECT_ID, 'w')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })
})

describe('listVolumes', () => {
  it('shows each volume\'s holder and the stopped workspaces that would take it back', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'queue')
    await createVolume(local, DEMO_PROJECT_ID, 'spare')
    await holding('ws-run', 'queue')
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'ws-old' })
    await recordWorkspaceStopped(DEMO_PROJECT_ID, 'ws-old')
    await setWorkspaceVolume('ws-old', (await findVolumeByName(DEMO_PROJECT_ID, 'queue'))!.id)

    const [queue, spare] = await listVolumes(DEMO_PROJECT_ID)
    expect(queue).toMatchObject({
      name: 'queue',
      size: '10Gi',
      holder: { workspaceId: 'ws-run', title: 'T ws-run' },
      stoppedWorkspaces: [{ workspaceId: 'ws-old' }],
    })
    expect(spare).toMatchObject({ name: 'spare', stoppedWorkspaces: [] })
    expect(spare.holder).toBeUndefined()
  })
})

describe('resizeVolume', () => {
  it('grows a volume through the driver, refusing a smaller or equal size', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'queue')
    await expect(resizeVolume(local, DEMO_PROJECT_ID, 'queue', '10240Mi')).rejects.toMatchObject({ code: 'VALIDATION' })
    await resizeVolume(local, DEMO_PROJECT_ID, 'queue', '20Gi')
    expect(asked).toContain('resize 10Gi->20Gi')
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'queue'))?.size).toBe('20Gi')
    await expect(resizeVolume(local, DEMO_PROJECT_ID, 'nope', '20Gi')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('deleteVolume', () => {
  it('refuses while a site keeps its data there', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    const v = (await findVolumeByName(DEMO_PROJECT_ID, 'data'))!
    const site = await insertSite({ projectId: DEMO_PROJECT_ID, repoId: DEMO_PROJECT_ID, name: 'shop', hostname: 'shop.example.com', port: 3000, namedWorkflowId: await namedWorkflowFor(DEMO_PROJECT_ID), volumeId: v.id })
    await expect(deleteVolume(local, DEMO_PROJECT_ID, 'data')).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('"shop"') as unknown })
    await updateSite(site.id, { volumeId: null })
    await deleteVolume(local, DEMO_PROJECT_ID, 'data')
  })

  it('refuses while a running workspace holds it, and deletes it once that runtime is gone', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'queue')
    await holding('ws-run', 'queue')
    units.add('ws-run')
    await expect(deleteVolume(local, DEMO_PROJECT_ID, 'queue')).rejects.toMatchObject({ code: 'VOLUME_HELD' })
    expect(asked).not.toContain('delete')

    expect(asked.some((a) => a.startsWith('delete'))).toBe(false)

    units.delete('ws-run')
    const id = (await findVolumeByName(DEMO_PROJECT_ID, 'queue'))!.id
    await deleteVolume(local, DEMO_PROJECT_ID, 'queue')
    expect(asked).toContain(`delete ${id}`)
    expect(await findVolumeByName(DEMO_PROJECT_ID, 'queue')).toBeUndefined()
  })

  it('succeeds once the row is gone even when its storage cannot be removed yet', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'queue')
    installFakeWorkspaceDriver({ deleteVolume: () => Promise.reject(new Error('apiserver blip')) })
    await deleteVolume(local, DEMO_PROJECT_ID, 'queue')
    expect(await findVolumeByName(DEMO_PROJECT_ID, 'queue')).toBeUndefined()
  })
})

describe('reconcileVolumeLeases', () => {
  it('ends the leases of runtimes that are gone, and records disks bound since', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'live')
    await createVolume(local, DEMO_PROJECT_ID, 'dead')
    await holding('ws-live', 'live')
    await holding('ws-dead', 'dead')
    const liveId = (await findVolumeByName(DEMO_PROJECT_ID, 'live'))!.id
    bound.add(liveId)

    await createVolume(local, DEMO_PROJECT_ID, 'starting')
    await holding('ws-job', 'starting')
    // ws-job has a Job and no pod yet: live, as far as its lease goes.
    await reconcileVolumeLeases(snapshotFixture([held('ws-live')], [
      { workspaceId: 'ws-job', unitName: 'ws-job', projectId: DEMO_PROJECT_ID, createdAtMs: Date.now(), prewarmed: false },
    ]))
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'starting'))?.holderWorkspaceId).toBe('ws-job')
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'live'))).toMatchObject({ holderWorkspaceId: 'ws-live' })
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'live'))?.pinnedAt).toBeInstanceOf(Date)
    const dead = await findVolumeByName(DEMO_PROJECT_ID, 'dead')
    expect(dead?.holderWorkspaceId).toBeUndefined()
    expect(dead?.pinnedAt).toBeUndefined()
  })

  it('forgets a site release staged as next holder once its runtime is gone', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'data')
    await holding('ws-live', 'data')
    const v = (await findVolumeByName(DEMO_PROJECT_ID, 'data'))!
    await stageVolume(v.id, 'rel-new')
    await reconcileVolumeLeases(snapshotFixture([held('ws-live'), held('rel-new')]))
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'data'))?.nextHolderWorkspaceId).toBe('rel-new')
    await reconcileVolumeLeases(snapshotFixture([held('ws-live')]))
    expect(await findVolumeByName(DEMO_PROJECT_ID, 'data')).toMatchObject({ holderWorkspaceId: 'ws-live' })
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'data'))?.nextHolderWorkspaceId).toBeUndefined()
  })
})

describe('workspacesAlive', () => {
  it('counts a listed unit, a Job with no pod yet and a launch in flight, and nothing else', async () => {
    const alive = await workspacesAlive(snapshotFixture([held('ws-pod')], [
      { workspaceId: 'ws-job', unitName: 'ws-job', projectId: DEMO_PROJECT_ID, createdAtMs: Date.now(), prewarmed: false },
    ]))
    expect(['ws-pod', 'ws-job', 'ws-gone'].map(alive)).toEqual([true, true, false])
  })
})

describe('reconcileVolumeLeases (a launch that settled after the runtime was listed)', () => {
  it('keeps the lease of a restart that finished between the listing and the sweep', async () => {
    await createVolume(local, DEMO_PROJECT_ID, 'queue')
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'ws-h' })
    // The pass listed the runtime before ws-h's pod was there...
    const snapshot = snapshotFixture([])
    await new Promise((r) => setTimeout(r, 5))
    // ...then ws-h's restart claimed the volume and settled.
    const id = (await findVolumeByName(DEMO_PROJECT_ID, 'queue'))!.id
    await provision({ workspaceId: 'ws-h', projectId: DEMO_PROJECT_ID, kind: 'restart' }, async () => {
      await claimVolume(id, 'ws-h')
      return { workspaceId: 'ws-h' }
    })(() => undefined)
    await reconcileVolumeLeases(snapshot)
    expect((await findVolumeByName(DEMO_PROJECT_ID, 'queue'))?.holderWorkspaceId).toBe('ws-h')
  })
})

describe('collectDeletedVolumes', () => {
  it('finishes deletes once no pod mounts the storage, and never touches storage it has no record of deleting', async () => {
    for (const name of ['kept', 'gone', 'mounted', 'failed']) await createVolume(local, DEMO_PROJECT_ID, name)
    const id = async (name: string): Promise<string> => (await findVolumeByName(DEMO_PROJECT_ID, name))!.id
    const [kept, , mounted, failed] = await Promise.all(['kept', 'gone', 'mounted', 'failed'].map(id))
    installFakeWorkspaceDriver({ deleteVolume: () => Promise.reject(new Error('apiserver blip')) })
    for (const name of ['gone', 'mounted', 'failed']) await deleteVolume(local, DEMO_PROJECT_ID, name)
    // A database restored without some volume's row: its storage is unknown,
    // not deleted.
    const unknown = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a'
    stored = new Map([[kept, false], [mounted, true], [failed, false], [unknown, false]])
    installFakeWorkspaceDriver({
      deleteVolume: (v) => { asked.push(`delete ${v}`); return Promise.resolve() },
      volumeStorage: () => Promise.resolve([...stored].map(([volumeId, m]) => ({ volumeId, mounted: m }))),
    })
    asked = []

    await collectDeletedVolumes()
    expect(asked).toEqual([`delete ${failed}`])
    // `gone`'s storage is already gone, so its tombstone is dropped; the
    // others keep theirs until their storage disappears.
    expect((await listDeletedVolumeIds()).sort()).toEqual([mounted, failed].sort())
  })
})

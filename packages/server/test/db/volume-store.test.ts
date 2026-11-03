import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  claimVolume,
  deleteProjectVolumeRows,
  deleteVolumeRow,
  findVolumeByName,
  getVolumeRow,
  insertVolume,
  leaseOf,
  listHeldVolumes,
  listProjectVolumes,
  forgetDeletedVolume,
  listDeletedVolumeIds,
  listUnpinnedVolumes,
  listVolumeWorkspaces,
  setVolumeSize,
  setWorkspaceVolume,
  stageVolume,
  handOverVolume,
  listStagedVolumes,
  unstageVolume,
  type VolumeLease,
} from '#db/volume-store'
import { applyWorkspaceEvent } from '#db/apply-workspace-event'
import { findWorkspaceRow, recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** The lease a volume has now, as a sweep or takeover would read it. */
const leaseNow = async (id: string): Promise<VolumeLease | undefined> => leaseOf((await getVolumeRow(id))!)

const release = (volumeId: string, lease: VolumeLease): Promise<void> =>
  applyWorkspaceEvent({ type: 'volume-released', volumeId, lease })

describe('insertVolume', () => {
  it('names volumes per project, refusing a name the project already uses', async () => {
    await insertVolume(PROJ, 'queue', '10Gi')
    await insertVolume(OTHER, 'queue', '10Gi')
    await expect(insertVolume(PROJ, 'queue', '5Gi')).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('listProjectVolumes', () => {
  it("lists one project's volumes by name", async () => {
    await insertVolume(PROJ, 'queue', '10Gi')
    await insertVolume(PROJ, 'app', '1Gi')
    await insertVolume(OTHER, 'db', '1Gi')
    expect((await listProjectVolumes(PROJ)).map((v) => v.name)).toEqual(['app', 'queue'])
  })
})

describe('findVolumeByName', () => {
  it('finds a volume within its project only', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    expect(await findVolumeByName(PROJ, 'queue')).toMatchObject({ id: v.id, size: '10Gi' })
    expect(await findVolumeByName(OTHER, 'queue')).toBeUndefined()
  })
})

describe('getVolumeRow', () => {
  it('reads a volume by id, and nothing for a malformed one', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    expect((await getVolumeRow(v.id))?.name).toBe('queue')
    expect(await getVolumeRow('not-a-uuid')).toBeUndefined()
  })
})

describe('listDeletedVolumeIds', () => {
  it('lists the volumes deleted since their storage was last seen, and nothing a database never deleted', async () => {
    await insertVolume(PROJ, 'kept', '1Gi')
    const a = await insertVolume(PROJ, 'a', '1Gi')
    const b = await insertVolume(OTHER, 'b', '1Gi')
    await deleteVolumeRow(a.id)
    await deleteProjectVolumeRows(OTHER)
    expect((await listDeletedVolumeIds()).sort()).toEqual([a.id, b.id].sort())
  })
})

describe('forgetDeletedVolume', () => {
  it("drops one volume's tombstone", async () => {
    const a = await insertVolume(PROJ, 'a', '1Gi')
    await deleteVolumeRow(a.id)
    await forgetDeletedVolume(a.id)
    expect(await listDeletedVolumeIds()).toEqual([])
  })
})

describe('setVolumeSize', () => {
  it('records a new size', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    await setVolumeSize(v.id, '20Gi')
    expect((await getVolumeRow(v.id))?.size).toBe('20Gi')
  })
})

describe('claimVolume', () => {
  it('gives the lease to one workspace at a time, and one volume to a workspace', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    const first = await claimVolume(v.id, 'ws-a')
    expect(first?.holderWorkspaceId).toBe('ws-a')
    // The holder again (a restart) wins, renewing the lease; anyone else loses.
    expect(await claimVolume(v.id, 'ws-a')).toBeDefined()
    expect(await claimVolume(v.id, 'ws-b')).toBeUndefined()
    const w = await insertVolume(PROJ, 'other', '1Gi')
    await expect(claimVolume(w.id, 'ws-a')).rejects.toThrow()
  })

  it('takes over only the exact lease it found gone, not one its holder renewed since', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    await claimVolume(v.id, 'ws-h')
    // W reads H's lease and judges H gone; meanwhile H restarts and renews.
    const seen = (await leaseNow(v.id))!
    await new Promise((r) => setTimeout(r, 5))
    expect(await claimVolume(v.id, 'ws-h')).toBeDefined()
    expect(await claimVolume(v.id, 'ws-w', seen)).toBeUndefined()
    expect((await leaseNow(v.id))?.holderWorkspaceId).toBe('ws-h')

    // With no renewal, the takeover wins.
    const now = (await leaseNow(v.id))!
    expect((await claimVolume(v.id, 'ws-w', now))?.holderWorkspaceId).toBe('ws-w')
  })

  it('is ended by a release only while the lease is the one released', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    await claimVolume(v.id, 'ws-h')
    const seen = (await leaseNow(v.id))!
    await new Promise((r) => setTimeout(r, 5))
    await claimVolume(v.id, 'ws-h')
    await release(v.id, seen)
    expect((await leaseNow(v.id))?.holderWorkspaceId).toBe('ws-h')

    await release(v.id, (await leaseNow(v.id))!)
    expect(await leaseNow(v.id)).toBeUndefined()
    expect(await claimVolume(v.id, 'ws-c')).toBeDefined()
  })
})

describe('leaseOf', () => {
  it("reads a volume's lease, or none", async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    expect(leaseOf(v)).toBeUndefined()
    const lease = await claimVolume(v.id, 'ws-a')
    expect(leaseOf((await getVolumeRow(v.id))!)).toEqual(lease)
  })
})

describe('listHeldVolumes', () => {
  it('lists only volumes someone holds', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    await insertVolume(PROJ, 'free', '1Gi')
    await claimVolume(v.id, 'ws-a')
    expect((await listHeldVolumes()).map((r) => r.holderWorkspaceId)).toEqual(['ws-a'])
  })
})

describe('listUnpinnedVolumes', () => {
  it('lists volumes until a pin is reported, keeping the first pin time', async () => {
    const a = await insertVolume(PROJ, 'a', '1Gi')
    const b = await insertVolume(PROJ, 'b', '1Gi')
    await applyWorkspaceEvent({ type: 'volumes-pinned', volumeIds: [a.id] })
    expect((await listUnpinnedVolumes()).map((r) => r.id)).toEqual([b.id])
    const pinnedAt = (await getVolumeRow(a.id))?.pinnedAt
    expect(pinnedAt).toBeInstanceOf(Date)
    await applyWorkspaceEvent({ type: 'volumes-pinned', volumeIds: [a.id] })
    expect((await getVolumeRow(a.id))?.pinnedAt).toEqual(pinnedAt)
  })
})

describe('setWorkspaceVolume', () => {
  it('records the volume a workspace takes back on restart, and forgets it', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'ws-a' })
    await setWorkspaceVolume('ws-a', v.id)
    expect((await findWorkspaceRow('ws-a'))?.volumeId).toBe(v.id)
    await setWorkspaceVolume('ws-a', null)
    expect((await findWorkspaceRow('ws-a'))?.volumeId).toBeUndefined()
  })
})

describe('listVolumeWorkspaces', () => {
  it('lists the workspaces naming each volume, with their titles and whether they stopped', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'ws-a', title: 'Merge queue' })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'ws-b' })
    await recordWorkspaceStopped(PROJ, 'ws-b')
    await setWorkspaceVolume('ws-a', v.id)
    await setWorkspaceVolume('ws-b', v.id)
    expect(await listVolumeWorkspaces([v.id])).toEqual(expect.arrayContaining([
      { volumeId: v.id, workspaceId: 'ws-a', title: 'Merge queue', stopped: false },
      { volumeId: v.id, workspaceId: 'ws-b', stopped: true },
    ]))
    expect(await listVolumeWorkspaces([])).toEqual([])
  })
})

describe('deleteVolumeRow', () => {
  it('deletes only an unheld volume, and forgets it on every workspace that named it', async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'ws-a' })
    await setWorkspaceVolume('ws-a', v.id)
    const lease = (await claimVolume(v.id, 'ws-a'))!
    expect(await deleteVolumeRow(v.id)).toBe(false)
    await release(v.id, lease)
    expect(await deleteVolumeRow(v.id)).toBe(true)
    expect(await getVolumeRow(v.id)).toBeUndefined()
    expect((await findWorkspaceRow('ws-a'))?.volumeId).toBeUndefined()
  })
})

describe('deleteProjectVolumeRows', () => {
  it("drops a project's volumes, held or not, and no other project's", async () => {
    const v = await insertVolume(PROJ, 'queue', '10Gi')
    await claimVolume(v.id, 'ws-a')
    await insertVolume(OTHER, 'db', '1Gi')
    await deleteProjectVolumeRows(PROJ)
    expect(await listProjectVolumes(PROJ)).toEqual([])
    expect(await listProjectVolumes(OTHER)).toHaveLength(1)
  })
})

describe('stageVolume', () => {
  it('records one next holder at a time, while another workspace holds the lease', async () => {
    const v = await insertVolume(PROJ, 'data', '1Gi')
    await claimVolume(v.id, 'old')
    expect(await stageVolume(v.id, 'new')).toBe(true)
    expect(await stageVolume(v.id, 'new')).toBe(true)
    expect(await stageVolume(v.id, 'other')).toBe(false)
    expect(await getVolumeRow(v.id)).toMatchObject({ holderWorkspaceId: 'old', nextHolderWorkspaceId: 'new' })
  })
})

describe('claimVolume while staged', () => {
  it('refuses every claim but the staged holder\'s, which only a handover passes it', async () => {
    const v = await insertVolume(PROJ, 'data', '1Gi')
    await stageVolume(v.id, 'release')
    expect(await claimVolume(v.id, 'dev')).toBeUndefined()
    expect((await getVolumeRow(v.id))?.holderWorkspaceId).toBeUndefined()
    await unstageVolume(v.id, 'release')
    expect(await claimVolume(v.id, 'dev')).toBeDefined()
  })
})

describe('handOverVolume', () => {
  it('passes the lease to the staged holder once it is free or exactly the lease found gone', async () => {
    const v = await insertVolume(PROJ, 'data', '1Gi')
    const old = await claimVolume(v.id, 'old')
    await stageVolume(v.id, 'new')
    // Not staged for this one, and the old holder still holds it.
    expect(await handOverVolume(v.id, 'other')).toBeUndefined()
    expect(await handOverVolume(v.id, 'new')).toBeUndefined()
    const lease = await handOverVolume(v.id, 'new', old)
    expect(lease?.holderWorkspaceId).toBe('new')
    expect(await getVolumeRow(v.id)).toMatchObject({ holderWorkspaceId: 'new' })
    expect((await getVolumeRow(v.id))?.nextHolderWorkspaceId).toBeUndefined()
  })
})

describe('listStagedVolumes', () => {
  it('lists only volumes with a next holder', async () => {
    const a = await insertVolume(PROJ, 'a', '1Gi')
    await insertVolume(PROJ, 'b', '1Gi')
    await stageVolume(a.id, 'new')
    expect((await listStagedVolumes()).map((v) => v.name)).toEqual(['a'])
  })
})

describe('unstageVolume', () => {
  it('forgets the next holder it names, and no other', async () => {
    const v = await insertVolume(PROJ, 'data', '1Gi')
    await stageVolume(v.id, 'new')
    await unstageVolume(v.id, 'other')
    expect((await getVolumeRow(v.id))?.nextHolderWorkspaceId).toBe('new')
    await unstageVolume(v.id, 'new')
    expect((await getVolumeRow(v.id))?.nextHolderWorkspaceId).toBeUndefined()
  })
})

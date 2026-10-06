import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb, getDb } from '#db/client'
import {
  claimQueuedLaunch,
  deleteProjectQueuedWorkspaces,
  deleteQueuedWorkspace,
  failQueuedLaunch,
  finishQueuedLaunch,
  getQueuedWorkspaceRow,
  insertQueuedWorkspace,
  listQueuedWorkspaceRows,
  releaseQueuedChildren,
  releaseQueuedWorkspace,
  setQueuedWorkspaceTitle,
  updateQueuedWorkspace,
  type QueuedParent,
  type QueuedWorkspaceRow,
} from '#db/queued-workspace-store'
import { deleteProjectWorkspaces, recordWorkspaceCreated } from '#db/workspace-store'
import { deleteWorkspaceGroup } from '#db/group-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'

const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

describe('queued workspace store', () => {
  let tmpDir: string
  let pushes: number

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorkspaceListChangedForTests()
    pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })
  })

  afterEach(async () => {
    _resetWorkspaceListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const settings = {
    prompt: 'next', tool: 'claude', model: 'opus', mode: 'tui', permissionMode: 'bypass', branch: 'main',
  } as const
  const queue = (parent: QueuedParent, prompt = 'next', projectId = PROJ): Promise<QueuedWorkspaceRow> =>
    insertQueuedWorkspace(projectId, parent, { ...settings, prompt })

  const parentOf = async (id: string): Promise<QueuedParent | undefined> => {
    const row = await getQueuedWorkspaceRow(id)
    if (!row) return undefined
    return row.parentQueuedId !== undefined
      ? { parentQueuedId: row.parentQueuedId }
      : { parentWorkspaceId: row.parentWorkspaceId ?? '' }
  }

  it('keeps exactly one parent column set through every write', async () => {
    const top = await queue({ parentWorkspaceId: 'wt-a' })
    expect(pushes).toBe(1)
    const child = await queue({ parentQueuedId: top.id })
    expect(child).toMatchObject({ parentQueuedId: top.id, projectId: PROJ, branch: 'main' })
    expect(child.parentWorkspaceId).toBeUndefined()

    // Re-parented onto a workspace, the entry column clears.
    await updateQueuedWorkspace(child.id, {
      ...settings, parent: { parentWorkspaceId: 'wt-b' }, prompt: 'edited', title: 'Named', groupId: 'g1',
    })
    const moved = await getQueuedWorkspaceRow(child.id)
    expect(moved).toMatchObject({ parentWorkspaceId: 'wt-b', prompt: 'edited', title: 'Named', groupId: 'g1' })
    expect(moved?.parentQueuedId).toBeUndefined()

    // An update replaces every setting: a title or group it leaves out is none.
    await updateQueuedWorkspace(child.id, settings)
    expect(await getQueuedWorkspaceRow(child.id)).not.toHaveProperty('title')
    expect(await getQueuedWorkspaceRow(child.id)).not.toHaveProperty('groupId')
  })

  it('keeps a generated title only for the untitled, unclaimed prompt it was made from', async () => {
    const entry = await queue({ parentWorkspaceId: 'wt-a' })
    const titleOf = async (): Promise<string | undefined> => (await getQueuedWorkspaceRow(entry.id))?.generatedTitle

    // A write for a prompt the entry no longer holds is dropped.
    await setQueuedWorkspaceTitle(entry.id, 'stale', 'Stale title')
    expect(await titleOf()).toBeUndefined()
    await setQueuedWorkspaceTitle(entry.id, 'next', 'Next up')
    await setQueuedWorkspaceTitle(entry.id, 'next', 'Second title')
    expect(await titleOf()).toBe('Next up')

    // An edit that keeps the prompt keeps the title; a new prompt drops it.
    await updateQueuedWorkspace(entry.id, { ...settings, branch: 'dev' })
    expect(await titleOf()).toBe('Next up')
    await updateQueuedWorkspace(entry.id, { ...settings, prompt: 'edited' })
    expect(await titleOf()).toBeUndefined()

    // A user title, or a claimed launch, shuts the writer out.
    await updateQueuedWorkspace(entry.id, { ...settings, prompt: 'edited', title: 'Mine' })
    await setQueuedWorkspaceTitle(entry.id, 'edited', 'Generated')
    expect(await titleOf()).toBeUndefined()
    await updateQueuedWorkspace(entry.id, { ...settings, prompt: 'edited' })
    await claimQueuedLaunch(entry.id, 'wt-new')
    await setQueuedWorkspaceTitle(entry.id, 'edited', 'Generated')
    expect(await titleOf()).toBeUndefined()

    // An insert carries a draft's generated title.
    const fromDraft = await insertQueuedWorkspace(PROJ, { parentWorkspaceId: 'wt-a' }, settings, 'From draft')
    expect(fromDraft.generatedTitle).toBe('From draft')
  })

  it('claims a launch once, re-pointing its children at the workspace it becomes', async () => {
    const top = await queue({ parentWorkspaceId: 'wt-a' })
    const child = await queue({ parentQueuedId: top.id })

    expect(await claimQueuedLaunch(top.id, 'wt-new')).toBe(true)
    // The compare-and-set: a double-click or a racing reconcile pass loses.
    expect(await claimQueuedLaunch(top.id, 'wt-other')).toBe(false)
    expect((await getQueuedWorkspaceRow(top.id))?.launchWorkspaceId).toBe('wt-new')
    expect(await parentOf(child.id)).toEqual({ parentWorkspaceId: 'wt-new' })

    // Mid-launch, nothing edits, removes or re-releases it.
    expect(await updateQueuedWorkspace(top.id, { ...settings, prompt: 'x' })).toBeUndefined()
    expect(await deleteQueuedWorkspace(top.id)).toBe(false)
    expect(await releaseQueuedWorkspace(top.id)).toBeUndefined()

    // Only the launch holding the claim can resolve it: a caller with a stale
    // view of it (a reconcile pass racing a Run now) changes nothing.
    await failQueuedLaunch(top.id, 'wt-stale', 'x')
    await finishQueuedLaunch(top.id, 'wt-stale')
    expect(await getQueuedWorkspaceRow(top.id)).toMatchObject({ launchWorkspaceId: 'wt-new' })
    expect(await parentOf(child.id)).toEqual({ parentWorkspaceId: 'wt-new' })

    // A child that ended up on the entry anyway follows it to the workspace.
    const late = await queue({ parentWorkspaceId: 'wt-a' })
    await updateQueuedWorkspace(late.id, { ...settings, parent: { parentQueuedId: top.id } })
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-new' })
    await finishQueuedLaunch(top.id, 'wt-new')
    expect(await getQueuedWorkspaceRow(top.id)).toBeUndefined()
    expect((await listQueuedWorkspaceRows(PROJ)).map((r) => r.id)).not.toContain(top.id)
    expect(await parentOf(child.id)).toEqual({ parentWorkspaceId: 'wt-new' })
    expect(await parentOf(late.id)).toEqual({ parentWorkspaceId: 'wt-new' })

    // Launched, the entry stays on as a record of what that workspace was
    // queued as — shut out of every write — until the workspace's row goes.
    const launched = async () => (await (await getDb()).$client.query<{ launched_workspace_id: string }>(
      'SELECT launched_workspace_id FROM queued_workspaces WHERE id = $1', [top.id],
    )).rows
    expect(await launched()).toEqual([{ launched_workspace_id: 'wt-new' }])
    expect(await deleteQueuedWorkspace(top.id)).toBe(false)
    await failQueuedLaunch(top.id, 'wt-new', 'x')
    expect(await launched()).toEqual([{ launched_workspace_id: 'wt-new' }])
    await deleteProjectWorkspaces(PROJ)
    expect(await launched()).toEqual([])
  })

  it('leaves a launched entry\'s record as it was queued when its old parent or group changes', async () => {
    // Run now on a child of a pending entry: it launches still pointing at it.
    const parent = await queue({ parentWorkspaceId: 'wt-a' })
    const child = await insertQueuedWorkspace(PROJ, { parentQueuedId: parent.id }, { ...settings, groupId: 'g1' })
    await claimQueuedLaunch(child.id, 'wt-child')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-child' })
    await finishQueuedLaunch(child.id, 'wt-child')

    await deleteWorkspaceGroup(PROJ, 'g1')
    await claimQueuedLaunch(parent.id, 'wt-parent')
    await failQueuedLaunch(parent.id, 'wt-parent', 'x')
    expect(await deleteQueuedWorkspace(parent.id)).toBe(true)

    const record = await (await getDb()).$client.query(
      'SELECT parent_workspace_id, parent_queued_id, group_id FROM queued_workspaces WHERE id = $1', [child.id],
    )
    expect(record.rows).toEqual([{ parent_workspace_id: null, parent_queued_id: parent.id, group_id: 'g1' }])
  })

  it('puts a failed launch back, with its unreleased children, but never takes a release back', async () => {
    const top = await queue({ parentWorkspaceId: 'wt-a' })
    const child = await queue({ parentQueuedId: top.id })
    const released = await queue({ parentQueuedId: top.id })
    await releaseQueuedWorkspace(top.id)
    await claimQueuedLaunch(top.id, 'wt-new')
    // Queued under the provisioning row while the launch was in flight.
    const late = await queue({ parentWorkspaceId: 'wt-new' })
    // The new workspace's stop released this one before the launch failed.
    await releaseQueuedWorkspace(released.id)
    // Another project's workspace with the same id is not this one.
    const elsewhere = await queue({ parentWorkspaceId: 'wt-new' }, 'x', OTHER)

    await failQueuedLaunch(top.id, 'wt-new', 'image build exploded')

    const back = await getQueuedWorkspaceRow(top.id)
    expect(back).toMatchObject({ launchError: 'image build exploded' })
    expect(back?.launchWorkspaceId).toBeUndefined()
    expect(back?.releasedAt).toBeUndefined()
    expect(await parentOf(child.id)).toEqual({ parentQueuedId: top.id })
    expect(await parentOf(late.id)).toEqual({ parentQueuedId: top.id })
    expect(await parentOf(released.id)).toEqual({ parentWorkspaceId: 'wt-new' })
    expect(await parentOf(elsewhere.id)).toEqual({ parentWorkspaceId: 'wt-new' })

    // The next release is the next attempt: it clears the error.
    expect((await releaseQueuedWorkspace(top.id))?.launchError).toBeUndefined()
  })

  it('releases a workspace\'s direct children only, and splices a discarded entry\'s children up', async () => {
    const a = await queue({ parentWorkspaceId: 'wt-a' }, 'a')
    const b = await queue({ parentQueuedId: a.id }, 'b')
    const c = await queue({ parentQueuedId: b.id }, 'c')
    await queue({ parentWorkspaceId: 'wt-a' }, 'sibling')

    const released = await releaseQueuedChildren(PROJ, 'wt-a')
    expect(released.map((r) => r.prompt).sort()).toEqual(['a', 'sibling'])
    expect((await getQueuedWorkspaceRow(b.id))?.releasedAt).toBeUndefined()
    expect(await releaseQueuedChildren(OTHER, 'wt-a')).toEqual([])

    // Discarding the middle of a chain moves the rest up one link.
    expect(await deleteQueuedWorkspace(b.id)).toBe(true)
    expect(await parentOf(c.id)).toEqual({ parentQueuedId: a.id })
    // Discarding the top moves them under the workspace.
    expect(await deleteQueuedWorkspace(a.id)).toBe(true)
    expect(await parentOf(c.id)).toEqual({ parentWorkspaceId: 'wt-a' })
    expect(await deleteQueuedWorkspace(a.id)).toBe(false)

    // Oldest first.
    expect((await listQueuedWorkspaceRows(PROJ)).map((r) => r.prompt)).toEqual(['c', 'sibling'])
    await queue({ parentWorkspaceId: 'wt-z' }, 'z', OTHER)
    await deleteProjectQueuedWorkspaces(PROJ)
    expect(await listQueuedWorkspaceRows(PROJ)).toEqual([])
    expect(await listQueuedWorkspaceRows()).toHaveLength(1)
  })
})

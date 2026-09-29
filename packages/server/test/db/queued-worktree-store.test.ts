import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  claimQueuedLaunch,
  deleteProjectQueuedWorktrees,
  deleteQueuedWorktree,
  failQueuedLaunch,
  finishQueuedLaunch,
  getQueuedWorktreeRow,
  insertQueuedWorktree,
  listQueuedWorktreeRows,
  releaseQueuedChildren,
  releaseQueuedWorktree,
  updateQueuedWorktree,
  type QueuedParent,
  type QueuedWorktreeRow,
} from '#db/queued-worktree-store'
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'

describe('queued worktree store', () => {
  let tmpDir: string
  let pushes: number

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorktreeListChangedForTests()
    pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })
  })

  afterEach(async () => {
    _resetWorktreeListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const settings = {
    prompt: 'next', tool: 'claude', model: 'opus', mode: 'tui', permissionMode: 'bypass', branch: 'main',
  } as const
  const queue = (parent: QueuedParent, prompt = 'next', projectSlug = 'proj'): Promise<QueuedWorktreeRow> =>
    insertQueuedWorktree(projectSlug, parent, { ...settings, prompt })

  const parentOf = async (id: string): Promise<QueuedParent | undefined> => {
    const row = await getQueuedWorktreeRow(id)
    if (!row) return undefined
    return row.parentQueuedId !== undefined
      ? { parentQueuedId: row.parentQueuedId }
      : { parentWorktreeId: row.parentWorktreeId ?? '' }
  }

  it('keeps exactly one parent column set through every write', async () => {
    const top = await queue({ parentWorktreeId: 'wt-a' })
    expect(pushes).toBe(1)
    const child = await queue({ parentQueuedId: top.id })
    expect(child).toMatchObject({ parentQueuedId: top.id, projectSlug: 'proj', branch: 'main' })
    expect(child.parentWorktreeId).toBeUndefined()

    // Re-parented onto a worktree, the entry column clears.
    await updateQueuedWorktree(child.id, {
      ...settings, parent: { parentWorktreeId: 'wt-b' }, prompt: 'edited', title: 'Named', groupId: 'g1',
    })
    const moved = await getQueuedWorktreeRow(child.id)
    expect(moved).toMatchObject({ parentWorktreeId: 'wt-b', prompt: 'edited', title: 'Named', groupId: 'g1' })
    expect(moved?.parentQueuedId).toBeUndefined()

    // An update replaces every setting: a title or group it leaves out is none.
    await updateQueuedWorktree(child.id, settings)
    expect(await getQueuedWorktreeRow(child.id)).not.toHaveProperty('title')
    expect(await getQueuedWorktreeRow(child.id)).not.toHaveProperty('groupId')
  })

  it('claims a launch once, re-pointing its children at the worktree it becomes', async () => {
    const top = await queue({ parentWorktreeId: 'wt-a' })
    const child = await queue({ parentQueuedId: top.id })

    expect(await claimQueuedLaunch(top.id, 'wt-new')).toBe(true)
    // The compare-and-set: a double-click or a racing reconcile pass loses.
    expect(await claimQueuedLaunch(top.id, 'wt-other')).toBe(false)
    expect((await getQueuedWorktreeRow(top.id))?.launchWorktreeId).toBe('wt-new')
    expect(await parentOf(child.id)).toEqual({ parentWorktreeId: 'wt-new' })

    // Mid-launch, nothing edits, removes or re-releases it.
    expect(await updateQueuedWorktree(top.id, { ...settings, prompt: 'x' })).toBeUndefined()
    expect(await deleteQueuedWorktree(top.id)).toBe(false)
    expect(await releaseQueuedWorktree(top.id)).toBeUndefined()

    // Only the launch holding the claim can resolve it: a caller with a stale
    // view of it (a reconcile pass racing a Run now) changes nothing.
    await failQueuedLaunch(top.id, 'wt-stale', 'x')
    await finishQueuedLaunch(top.id, 'wt-stale')
    expect(await getQueuedWorktreeRow(top.id)).toMatchObject({ launchWorktreeId: 'wt-new' })
    expect(await parentOf(child.id)).toEqual({ parentWorktreeId: 'wt-new' })

    // A child that ended up on the entry anyway follows it to the worktree.
    const late = await queue({ parentWorktreeId: 'wt-a' })
    await updateQueuedWorktree(late.id, { ...settings, parent: { parentQueuedId: top.id } })
    await finishQueuedLaunch(top.id, 'wt-new')
    expect(await getQueuedWorktreeRow(top.id)).toBeUndefined()
    expect(await parentOf(child.id)).toEqual({ parentWorktreeId: 'wt-new' })
    expect(await parentOf(late.id)).toEqual({ parentWorktreeId: 'wt-new' })
  })

  it('puts a failed launch back, with its unreleased children, but never takes a release back', async () => {
    const top = await queue({ parentWorktreeId: 'wt-a' })
    const child = await queue({ parentQueuedId: top.id })
    const released = await queue({ parentQueuedId: top.id })
    await releaseQueuedWorktree(top.id)
    await claimQueuedLaunch(top.id, 'wt-new')
    // Queued under the provisioning row while the launch was in flight.
    const late = await queue({ parentWorktreeId: 'wt-new' })
    // The new worktree's stop released this one before the launch failed.
    await releaseQueuedWorktree(released.id)
    // Another project's worktree with the same id is not this one.
    const elsewhere = await queue({ parentWorktreeId: 'wt-new' }, 'x', 'other')

    await failQueuedLaunch(top.id, 'wt-new', 'image build exploded')

    const back = await getQueuedWorktreeRow(top.id)
    expect(back).toMatchObject({ launchError: 'image build exploded' })
    expect(back?.launchWorktreeId).toBeUndefined()
    expect(back?.releasedAt).toBeUndefined()
    expect(await parentOf(child.id)).toEqual({ parentQueuedId: top.id })
    expect(await parentOf(late.id)).toEqual({ parentQueuedId: top.id })
    expect(await parentOf(released.id)).toEqual({ parentWorktreeId: 'wt-new' })
    expect(await parentOf(elsewhere.id)).toEqual({ parentWorktreeId: 'wt-new' })

    // The next release is the next attempt: it clears the error.
    expect((await releaseQueuedWorktree(top.id))?.launchError).toBeUndefined()
  })

  it('releases a worktree\'s direct children only, and splices a discarded entry\'s children up', async () => {
    const a = await queue({ parentWorktreeId: 'wt-a' }, 'a')
    const b = await queue({ parentQueuedId: a.id }, 'b')
    const c = await queue({ parentQueuedId: b.id }, 'c')
    await queue({ parentWorktreeId: 'wt-a' }, 'sibling')

    const released = await releaseQueuedChildren('proj', 'wt-a')
    expect(released.map((r) => r.prompt).sort()).toEqual(['a', 'sibling'])
    expect((await getQueuedWorktreeRow(b.id))?.releasedAt).toBeUndefined()
    expect(await releaseQueuedChildren('other', 'wt-a')).toEqual([])

    // Discarding the middle of a chain moves the rest up one link.
    expect(await deleteQueuedWorktree(b.id)).toBe(true)
    expect(await parentOf(c.id)).toEqual({ parentQueuedId: a.id })
    // Discarding the top moves them under the worktree.
    expect(await deleteQueuedWorktree(a.id)).toBe(true)
    expect(await parentOf(c.id)).toEqual({ parentWorktreeId: 'wt-a' })
    expect(await deleteQueuedWorktree(a.id)).toBe(false)

    // Oldest first.
    expect((await listQueuedWorktreeRows('proj')).map((r) => r.prompt)).toEqual(['c', 'sibling'])
    await queue({ parentWorktreeId: 'wt-z' }, 'z', 'other')
    await deleteProjectQueuedWorktrees('proj')
    expect(await listQueuedWorktreeRows('proj')).toEqual([])
    expect(await listQueuedWorktreeRows()).toHaveLength(1)
  })
})

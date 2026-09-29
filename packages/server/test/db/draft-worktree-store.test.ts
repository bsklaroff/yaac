import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  deleteDraftWorktree,
  deleteProjectDraftWorktrees,
  insertDraftWorktree,
  listDraftWorktreeRows,
  setDraftWorktreeTitle,
  updateDraftWorktree,
} from '#db/draft-worktree-store'
import type { DraftWorktreeSettings } from '@yaac/shared/types'
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'

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

const SETTINGS: DraftWorktreeSettings = {
  prompt: 'an idea', tool: 'codex', mode: 'acp', permissionMode: 'plan',
  model: 'gpt-5.5', branch: 'dev', startAfter: 'w-parent',
}
const UNKNOWN = '00000000-0000-4000-8000-000000000000'

describe('insertDraftWorktree', () => {
  it('stores every field it is given, and nothing for the ones it is not', async () => {
    const full = await insertDraftWorktree('proj', SETTINGS)
    expect(full).toMatchObject({ projectSlug: 'proj', ...SETTINGS })
    expect(full.title).toBeUndefined()
    const bare = await insertDraftWorktree('proj', { prompt: 'p', tool: 'claude', mode: 'tui', permissionMode: 'manual' })
    expect(bare).not.toHaveProperty('model')
    expect(bare).not.toHaveProperty('branch')
    expect(bare).not.toHaveProperty('startAfter')
    expect(pushes).toBe(2)
  })
})

describe('updateDraftWorktree', () => {
  it('replaces the whole draft, keeping its title only while the prompt stands', async () => {
    const { id } = await insertDraftWorktree('proj', SETTINGS)
    await setDraftWorktreeTitle(id, 'an idea', 'An idea')

    // Same prompt: the title still describes it. A field left out is cleared.
    const { startAfter: _, ...now } = SETTINGS
    const same = await updateDraftWorktree('proj', id, now)
    expect(same).toMatchObject({ title: 'An idea', prompt: 'an idea' })
    expect(same).not.toHaveProperty('startAfter')
    expect(same!.updatedAt.getTime()).toBeGreaterThanOrEqual(same!.createdAt.getTime())

    const edited = await updateDraftWorktree('proj', id, { ...now, prompt: 'a different idea' })
    expect(edited).not.toHaveProperty('title')
    expect(edited?.prompt).toBe('a different idea')

    // Gone, never a draft id at all, or another project's: nothing to
    // update, and no push.
    const before = pushes
    expect(await updateDraftWorktree('proj', UNKNOWN, SETTINGS)).toBeUndefined()
    expect(await updateDraftWorktree('proj', 'nope', SETTINGS)).toBeUndefined()
    expect(await updateDraftWorktree('other', id, SETTINGS)).toBeUndefined()
    expect((await listDraftWorktreeRows())[0]).toMatchObject({ projectSlug: 'proj', prompt: 'a different idea' })
    expect(pushes).toBe(before)
  })
})

describe('setDraftWorktreeTitle', () => {
  it('titles an untitled draft only while it holds the prompt the title was made from', async () => {
    const { id } = await insertDraftWorktree('proj', SETTINGS)
    // The prompt moved on while the model ran: a summary of the old one is dropped.
    await updateDraftWorktree('proj', id, { ...SETTINGS, prompt: 'edited meanwhile' })
    await setDraftWorktreeTitle(id, 'an idea', 'Stale title')
    expect((await listDraftWorktreeRows())[0].title).toBeUndefined()

    await setDraftWorktreeTitle(id, 'edited meanwhile', 'Fresh title')
    await setDraftWorktreeTitle(id, 'edited meanwhile', 'Second title')
    expect((await listDraftWorktreeRows())[0].title).toBe('Fresh title')
  })
})

describe('deleteDraftWorktree', () => {
  it('answers whether there was one to delete', async () => {
    const { id } = await insertDraftWorktree('proj', SETTINGS)
    expect(await deleteDraftWorktree(id)).toBe(true)
    expect(await deleteDraftWorktree(id)).toBe(false)
    expect(await deleteDraftWorktree('nope')).toBe(false)
    expect(await listDraftWorktreeRows()).toEqual([])
  })
})

describe('listDraftWorktreeRows', () => {
  it('lists every project\'s drafts, oldest first', async () => {
    const a = await insertDraftWorktree('proj', { ...SETTINGS, prompt: 'first' })
    const b = await insertDraftWorktree('other', { ...SETTINGS, prompt: 'second' })
    expect((await listDraftWorktreeRows()).map((d) => d.id)).toEqual([a.id, b.id])
  })
})

describe('deleteProjectDraftWorktrees', () => {
  it('forgets one project\'s drafts and no one else\'s', async () => {
    await insertDraftWorktree('proj', SETTINGS)
    const kept = await insertDraftWorktree('other', SETTINGS)
    await deleteProjectDraftWorktrees('proj')
    expect((await listDraftWorktreeRows()).map((d) => d.id)).toEqual([kept.id])
  })
})

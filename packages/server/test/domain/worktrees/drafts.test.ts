import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { discardDraftWorktree, draftGeneratedTitle, listDraftWorktrees, saveDraftWorktree } from '#domain/worktrees'
import { setDraftWorktreeTitle } from '#db'
import { recordProject } from '#db/project-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { DraftWorktreeSettings } from '@yaac/shared/types'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const SETTINGS: DraftWorktreeSettings = { prompt: 'an idea', tool: 'claude', mode: 'tui', permissionMode: 'manual' }
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

describe('saveDraftWorktree', () => {
  it('saves a new draft, replaces one by id, and refuses what does not exist', async () => {
    const saved = await saveDraftWorktree('proj', SETTINGS)
    expect(saved).toMatchObject({ projectSlug: 'proj', ...SETTINGS })
    expect(saved.createdAt).toMatch(STAMP)

    const replaced = await saveDraftWorktree('proj', {
      ...SETTINGS, prompt: 'a better idea', branch: 'dev', title: '  My   idea ', groupId: 'g1',
    }, saved.id)
    expect(replaced).toMatchObject({ id: saved.id, prompt: 'a better idea', branch: 'dev', title: 'My idea', groupId: 'g1' })
    // A blank title is none, leaving the draft to be auto-titled.
    expect(await saveDraftWorktree('proj', { ...SETTINGS, title: ' ' }, saved.id)).not.toHaveProperty('title')

    await expect(saveDraftWorktree('nope', SETTINGS)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(saveDraftWorktree('proj', SETTINGS, 'gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // An update is scoped to the project it names.
    await recordProject({ slug: 'other', remoteUrl: 'https://example.com/other', addedAt: '2026-01-01T00:00:00.000Z' })
    await expect(saveDraftWorktree('other', SETTINGS, saved.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('discardDraftWorktree', () => {
  it('deletes a draft once', async () => {
    const { id } = await saveDraftWorktree('proj', SETTINGS)
    await discardDraftWorktree(id)
    await expect(discardDraftWorktree(id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('draftGeneratedTitle', () => {
  it('answers a draft\'s generated title only for the prompt it describes', async () => {
    const { id } = await saveDraftWorktree('proj', SETTINGS)
    expect(await draftGeneratedTitle('proj', id, 'an idea')).toBeUndefined()
    await setDraftWorktreeTitle(id, 'an idea', 'An idea')
    expect(await draftGeneratedTitle('proj', id, 'an idea')).toBe('An idea')
    expect(await draftGeneratedTitle('proj', id, 'an edited idea')).toBeUndefined()
    expect(await draftGeneratedTitle('proj', id, undefined)).toBeUndefined()
    expect(await draftGeneratedTitle('other', id, 'an idea')).toBeUndefined()
    expect(await draftGeneratedTitle('proj', undefined, 'an idea')).toBeUndefined()
  })
})

describe('listDraftWorktrees', () => {
  it('feeds the snapshot every draft, with wire timestamps', async () => {
    const { id } = await saveDraftWorktree('proj', SETTINGS)
    const [listed] = await listDraftWorktrees()
    expect(listed).toMatchObject({ id, prompt: 'an idea' })
    expect(listed.updatedAt).toMatch(STAMP)
  })
})

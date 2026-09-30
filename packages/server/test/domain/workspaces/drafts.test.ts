import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { discardDraftWorkspace, draftGeneratedTitle, listDraftWorkspaces, saveDraftWorkspace } from '#domain/workspaces'
import { setDraftWorkspaceTitle } from '#db'
import { recordProject } from '#db/project-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { DraftWorkspaceSettings } from '@yaac/shared/types'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

const SETTINGS: DraftWorkspaceSettings = { prompt: 'an idea', tool: 'claude', mode: 'tui', permissionMode: 'manual' }
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

describe('saveDraftWorkspace', () => {
  it('saves a new draft, replaces one by id, and refuses what does not exist', async () => {
    const saved = await saveDraftWorkspace('proj', SETTINGS)
    expect(saved).toMatchObject({ projectSlug: 'proj', ...SETTINGS })
    expect(saved.createdAt).toMatch(STAMP)

    const replaced = await saveDraftWorkspace('proj', {
      ...SETTINGS, prompt: 'a better idea', branch: 'dev', title: '  My   idea ', groupId: 'g1',
    }, saved.id)
    expect(replaced).toMatchObject({ id: saved.id, prompt: 'a better idea', branch: 'dev', title: 'My idea', groupId: 'g1' })
    // A blank title is none, leaving the draft to be auto-titled.
    expect(await saveDraftWorkspace('proj', { ...SETTINGS, title: ' ' }, saved.id)).not.toHaveProperty('title')

    await expect(saveDraftWorkspace('nope', SETTINGS)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(saveDraftWorkspace('proj', SETTINGS, 'gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // An update is scoped to the project it names.
    await recordProject({ slug: 'other', remoteUrl: 'https://example.com/other', addedAt: '2026-01-01T00:00:00.000Z' })
    await expect(saveDraftWorkspace('other', SETTINGS, saved.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('discardDraftWorkspace', () => {
  it('deletes a draft once', async () => {
    const { id } = await saveDraftWorkspace('proj', SETTINGS)
    await discardDraftWorkspace(id)
    await expect(discardDraftWorkspace(id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('draftGeneratedTitle', () => {
  it('answers a draft\'s generated title only for the prompt it describes', async () => {
    const { id } = await saveDraftWorkspace('proj', SETTINGS)
    expect(await draftGeneratedTitle('proj', id, 'an idea')).toBeUndefined()
    await setDraftWorkspaceTitle(id, 'an idea', 'An idea')
    expect(await draftGeneratedTitle('proj', id, 'an idea')).toBe('An idea')
    expect(await draftGeneratedTitle('proj', id, 'an edited idea')).toBeUndefined()
    expect(await draftGeneratedTitle('proj', id, undefined)).toBeUndefined()
    expect(await draftGeneratedTitle('other', id, 'an idea')).toBeUndefined()
    expect(await draftGeneratedTitle('proj', undefined, 'an idea')).toBeUndefined()
  })
})

describe('listDraftWorkspaces', () => {
  it('feeds the snapshot every draft, with wire timestamps', async () => {
    const { id } = await saveDraftWorkspace('proj', SETTINGS)
    const [listed] = await listDraftWorkspaces()
    expect(listed).toMatchObject({ id, prompt: 'an idea' })
    expect(listed.updatedAt).toMatch(STAMP)
  })
})

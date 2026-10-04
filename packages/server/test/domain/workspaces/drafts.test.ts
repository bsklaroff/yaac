import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { claimDraft, discardDraftWorkspace, listDraftWorkspaces, saveDraftWorkspace } from '#domain/workspaces'
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

describe('claimDraft', () => {
  const ids = async (): Promise<string[]> => (await listDraftWorkspaces()).map((d) => d.id)

  it('hides a draft while one request runs from it, deleting it on success and showing it again on failure', async () => {
    const { id } = await saveDraftWorkspace('proj', SETTINGS)
    const failing = await claimDraft('proj', id)
    expect(await ids()).toEqual([])
    // A second tab, a retry or a double click is refused while it runs.
    await expect(claimDraft('proj', id)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(failing.run(() => Promise.reject(new Error('no token')))).rejects.toThrow('no token')
    expect(await ids()).toEqual([id])

    // A request refused before it ran gives the draft back too.
    ;(await claimDraft('proj', id)).release()
    expect(await ids()).toEqual([id])

    let finish!: (v: string) => void
    const running = (await claimDraft('proj', id)).run(() => new Promise<string>((resolve) => { finish = resolve }))
    expect(await ids()).toEqual([])
    finish('created')
    expect(await running).toBe('created')
    expect(await ids()).toEqual([])
    // Once used, the draft is gone, so a late duplicate is refused as well.
    await expect(claimDraft('proj', id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(claimDraft('proj', 'gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses a draft of another project, and claims nothing without an id', async () => {
    const { id } = await saveDraftWorkspace('proj', SETTINGS)
    await expect(claimDraft('other', id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const none = await claimDraft('proj', undefined)
    expect(none.generatedTitle('an idea')).toBeUndefined()
    expect(await none.run(() => Promise.resolve(1))).toBe(1)
    expect(await ids()).toEqual([id])
  })

  it('answers the draft\'s generated title only for the prompt it describes', async () => {
    const { id } = await saveDraftWorkspace('proj', SETTINGS)
    const untitled = await claimDraft('proj', id)
    expect(untitled.generatedTitle('an idea')).toBeUndefined()
    untitled.release()
    await setDraftWorkspaceTitle(id, 'an idea', 'An idea')
    const titled = await claimDraft('proj', id)
    expect(titled.generatedTitle('an idea')).toBe('An idea')
    expect(titled.generatedTitle('an edited idea')).toBeUndefined()
    expect(titled.generatedTitle(undefined)).toBeUndefined()
    titled.release()
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

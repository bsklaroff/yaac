import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  deleteDraftWorkspace,
  deleteProjectDraftWorkspaces,
  insertDraftWorkspace,
  listDraftWorkspaceRows,
  setDraftWorkspaceTitle,
  updateDraftWorkspace,
} from '#db/draft-workspace-store'
import type { DraftWorkspaceSettings } from '@yaac/shared/types'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'

const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

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

const SETTINGS: DraftWorkspaceSettings = {
  prompt: 'an idea', tool: 'codex', mode: 'acp', permissionMode: 'plan',
  model: 'gpt-5.5', branch: 'dev', startAfter: 'w-parent',
}
const UNKNOWN = '00000000-0000-4000-8000-000000000000'

describe('insertDraftWorkspace', () => {
  it('stores every field it is given, and nothing for the ones it is not', async () => {
    const full = await insertDraftWorkspace(PROJ, SETTINGS)
    expect(full).toMatchObject({ projectId: PROJ, ...SETTINGS })
    expect(full.generatedTitle).toBeUndefined()
    const bare = await insertDraftWorkspace(PROJ, { prompt: 'p', tool: 'claude', mode: 'tui', permissionMode: 'manual' })
    expect(bare).not.toHaveProperty('model')
    expect(bare).not.toHaveProperty('branch')
    expect(bare).not.toHaveProperty('startAfter')
    expect(pushes).toBe(2)
  })
})

describe('updateDraftWorkspace', () => {
  it('replaces the whole draft, keeping its generated title only while the prompt stands', async () => {
    const { id } = await insertDraftWorkspace(PROJ, SETTINGS)
    await setDraftWorkspaceTitle(id, 'an idea', 'An idea')

    // Same prompt: the title still describes it. A field left out is cleared.
    const { startAfter: _, ...now } = SETTINGS
    const same = await updateDraftWorkspace(PROJ, id, now)
    expect(same).toMatchObject({ generatedTitle: 'An idea', prompt: 'an idea' })
    expect(same).not.toHaveProperty('startAfter')
    expect(same!.updatedAt.getTime()).toBeGreaterThanOrEqual(same!.createdAt.getTime())

    const edited = await updateDraftWorkspace(PROJ, id, { ...now, prompt: 'a different idea', title: 'Mine' })
    expect(edited).not.toHaveProperty('generatedTitle')
    expect(edited).toMatchObject({ prompt: 'a different idea', title: 'Mine' })

    // Gone, never a draft id at all, or another project's: nothing to
    // update, and no push.
    const before = pushes
    expect(await updateDraftWorkspace(PROJ, UNKNOWN, SETTINGS)).toBeUndefined()
    expect(await updateDraftWorkspace(PROJ, 'nope', SETTINGS)).toBeUndefined()
    expect(await updateDraftWorkspace(OTHER, id, SETTINGS)).toBeUndefined()
    expect((await listDraftWorkspaceRows())[0]).toMatchObject({ projectId: PROJ, prompt: 'a different idea' })
    expect(pushes).toBe(before)
  })
})

describe('setDraftWorkspaceTitle', () => {
  it('titles an untitled draft only while it holds the prompt the title was made from', async () => {
    const { id } = await insertDraftWorkspace(PROJ, SETTINGS)
    // The prompt moved on while the model ran: a summary of the old one is dropped.
    await updateDraftWorkspace(PROJ, id, { ...SETTINGS, prompt: 'edited meanwhile' })
    await setDraftWorkspaceTitle(id, 'an idea', 'Stale title')
    expect((await listDraftWorkspaceRows())[0].generatedTitle).toBeUndefined()

    await setDraftWorkspaceTitle(id, 'edited meanwhile', 'Fresh title')
    await setDraftWorkspaceTitle(id, 'edited meanwhile', 'Second title')
    expect((await listDraftWorkspaceRows())[0].generatedTitle).toBe('Fresh title')

    // Titled by the user, it is never given a generated one.
    const named = await insertDraftWorkspace(PROJ, { ...SETTINGS, title: 'Mine' })
    await setDraftWorkspaceTitle(named.id, SETTINGS.prompt, 'Generated')
    expect((await listDraftWorkspaceRows()).find((d) => d.id === named.id)).not.toHaveProperty('generatedTitle')
  })
})

describe('deleteDraftWorkspace', () => {
  it('answers whether there was one to delete', async () => {
    const { id } = await insertDraftWorkspace(PROJ, SETTINGS)
    expect(await deleteDraftWorkspace(id)).toBe(true)
    expect(await deleteDraftWorkspace(id)).toBe(false)
    expect(await deleteDraftWorkspace('nope')).toBe(false)
    expect(await listDraftWorkspaceRows()).toEqual([])
  })
})

describe('listDraftWorkspaceRows', () => {
  it('lists every project\'s drafts, oldest first', async () => {
    const a = await insertDraftWorkspace(PROJ, { ...SETTINGS, prompt: 'first' })
    const b = await insertDraftWorkspace(OTHER, { ...SETTINGS, prompt: 'second' })
    expect((await listDraftWorkspaceRows()).map((d) => d.id)).toEqual([a.id, b.id])
  })
})

describe('deleteProjectDraftWorkspaces', () => {
  it('forgets one project\'s drafts and no one else\'s', async () => {
    await insertDraftWorkspace(PROJ, SETTINGS)
    const kept = await insertDraftWorkspace(OTHER, SETTINGS)
    await deleteProjectDraftWorkspaces(PROJ)
    expect((await listDraftWorkspaceRows()).map((d) => d.id)).toEqual([kept.id])
  })
})

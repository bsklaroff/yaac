import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID } from '@yaac/test-utils/project-fixture'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { projectDir } from '@yaac/shared/project-paths'
import { BUILT_IN_USER_ID, closeDb, insertRoutine, insertSite, recordProject, upsertRunSecret, type RoutineFields } from '#db'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { listProjectRunSecrets, removeRunSecret, resolveRunSecrets, setRunSecret } from '#domain/projects'

/**
 * Run secrets above the store: only a person sets them, only on this
 * project's sites and on routines whose runs a person fixed, and a value
 * leaves only for the launches that name it.
 */

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const agent = { kind: 'workspace', workspaceId: 'w1', userId: BUILT_IN_USER_ID } as const
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const COMMIT = 'a'.repeat(40)
const CI = { test: { run: ['pnpm test'] } }

const routineFields = (over: Partial<RoutineFields>): RoutineFields => ({
  name: 'Nightly', cron: '0 9 * * *', timeZone: 'UTC', tool: 'claude', model: 'opus',
  mode: 'acp', permissionMode: 'bypass', ...over,
})

let tmpDir: string
let pushed: Array<Record<string, string>>

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await fs.mkdir(projectDir(DEMO_PROJECT_ID), { recursive: true })
  await recordProject({ id: DEMO_PROJECT_ID, name: 'demo', remoteUrl: 'https://github.com/o/r.git', addedAt: 'now' }, BUILT_IN_USER_ID)
  pushed = []
  installFakeWorkspaceDriver({
    syncProjectSecrets: (_projectId, _values, runValues) => { pushed.push(runValues); return Promise.resolve() },
  })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('setRunSecret', () => {
  it('stores a person\'s secret for this project\'s sites and pinned non-interactive routines only', async () => {
    const site = await insertSite({ projectId: DEMO_PROJECT_ID, name: 'relay', hostname: 'relay.example.com', port: 3000, steps: CI })
    const pinned = await insertRoutine(DEMO_PROJECT_ID, routineFields({ commit: COMMIT, steps: CI, nonInteractive: true }), null)
    const onBranch = await insertRoutine(DEMO_PROJECT_ID, routineFields({ branch: 'main', steps: CI, nonInteractive: true }), null)
    const interactive = await insertRoutine(DEMO_PROJECT_ID, routineFields({ commit: COMMIT, prompt: 'triage' }), null)
    const elsewhere = await insertSite({ projectId: OTHER, name: 'x', hostname: 'x.example.com', port: 3000, steps: CI })

    const saved = await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem', siteIds: [site.id, site.id], routineIds: [pinned.id] })
    expect(saved).toEqual({ id: saved.id, name: 'P8_KEY', hasValue: true, siteIds: [site.id], routineIds: [pinned.id] })
    // The value reaches the runtime at the launch that names it, not here.
    expect(pushed).toEqual([])

    // A branch's tip is whatever was pushed last, and an interactive run has an agent.
    await expect(setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', siteIds: [], routineIds: [onBranch.id] }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', siteIds: [], routineIds: [interactive.id] }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', siteIds: [elsewhere.id], routineIds: [] }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A workspace's agent never sets one, though it acts as the owner.
    await expect(setRunSecret(agent, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'leak', siteIds: [], routineIds: [] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(setRunSecret(local, DEMO_PROJECT_ID, { name: '1BAD', value: 'v', siteIds: [], routineIds: [] }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    // Only the targets change without a value, which a new secret lacks.
    expect(await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', siteIds: [], routineIds: [] }))
      .toMatchObject({ hasValue: true, siteIds: [], routineIds: [] })
    await expect(setRunSecret(local, DEMO_PROJECT_ID, { name: 'NEW', siteIds: [], routineIds: [] }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await resolveRunSecrets(DEMO_PROJECT_ID, site.id)).toEqual({})
  })
})

describe('listProjectRunSecrets', () => {
  it('lists names and targets, never a value', async () => {
    await upsertRunSecret(DEMO_PROJECT_ID, { name: 'A', value: 'sekrit', siteIds: [], routineIds: [] })
    const listed = await listProjectRunSecrets(DEMO_PROJECT_ID)
    expect(listed).toEqual([{ id: listed[0].id, name: 'A', hasValue: true, siteIds: [], routineIds: [] }])
    expect(JSON.stringify(listed)).not.toContain('sekrit')
    await expect(listProjectRunSecrets(OTHER)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('removeRunSecret', () => {
  it('deletes one and takes its value off the runtime', async () => {
    const a = await upsertRunSecret(DEMO_PROJECT_ID, { name: 'A', value: '1', siteIds: [], routineIds: [] })
    await upsertRunSecret(DEMO_PROJECT_ID, { name: 'B', value: '2', siteIds: [], routineIds: [] })
    await removeRunSecret(local, DEMO_PROJECT_ID, a!.id)
    expect(pushed).toEqual([{ B: '2' }])
    await expect(removeRunSecret(local, DEMO_PROJECT_ID, a!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('resolveRunSecrets', () => {
  it('answers the values a site or routine is given, and only those', async () => {
    const target = 'a1b2c3d4-0000-4000-8000-000000000001'
    await upsertRunSecret(DEMO_PROJECT_ID, { name: 'MINE', value: 'v', siteIds: [target], routineIds: [] })
    await upsertRunSecret(DEMO_PROJECT_ID, { name: 'ALSO', value: 'w', siteIds: [], routineIds: [target] })
    await upsertRunSecret(DEMO_PROJECT_ID, { name: 'NOT_MINE', value: 'x', siteIds: [], routineIds: [] })
    expect(await resolveRunSecrets(DEMO_PROJECT_ID, target)).toEqual({ ALSO: 'w', MINE: 'v' })
    expect(await resolveRunSecrets(DEMO_PROJECT_ID, OTHER)).toEqual({})
  })
})

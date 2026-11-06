import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { repoDir } from '@yaac/shared/project-paths'
import { BUILT_IN_USER_ID, closeDb, insertRoutine, insertSite, upsertRunSecret } from '#db'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import {
  approveWorkflowRef,
  createWorkflow,
  deleteWorkflow,
  editWorkflow,
  listProjectRunSecrets,
  listProjectWorkflows,
  removeRunSecret,
  resolveWorkflow,
  setRunSecret,
  showWorkflow,
  workflowLaunch,
} from '#domain/projects'

/**
 * Workflows above the store: only a person names run secrets or approves,
 * and a launch gets them only on a commit a person ran it on.
 */

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const agent = { kind: 'workspace', workspaceId: 'w1', userId: BUILT_IN_USER_ID } as const
const server = { kind: 'system' } as const
const CI = { test: { run: ['pnpm test'] } }
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

let tmpDir: string
let pushed: Array<Record<string, string>>
/** origin/main, and a later commit on origin/dev. */
let main: string
let dev: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject()
  const repo = repoDir(DEMO_PROJECT_ID)
  main = (await git(repo, ['rev-parse', 'origin/main'])).trim()
  await git(repo, ['commit', '--allow-empty', '-m', 'later'])
  dev = (await git(repo, ['rev-parse', 'HEAD'])).trim()
  await git(repo, ['update-ref', 'refs/remotes/origin/dev', dev])
  pushed = []
  installFakeWorkspaceDriver({
    syncProjectSecrets: (_projectId, _values, runValues) => { pushed.push(runValues); return Promise.resolve() },
  })
  await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' })
})

afterEach(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A workflow giving its runs P8_KEY. */
const relay = () => createWorkflow(local, DEMO_PROJECT_ID, { name: 'relay', steps: CI, secrets: ['P8_KEY'] })
const revisionOf = async (name: string) => (await resolveWorkflow(DEMO_PROJECT_ID, name)).current.id

describe('createWorkflow', () => {
  it('stores revision 1, naming run secrets only for a person and only ones that exist', async () => {
    expect(await relay()).toMatchObject({ name: 'relay', current: { number: 1, steps: CI, secrets: ['P8_KEY'] } })
    await expect(createWorkflow(agent, DEMO_PROJECT_ID, { name: 'leak', steps: CI, secrets: ['P8_KEY'] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'plain', steps: CI })).current.secrets).toEqual([])
    await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: 'x', steps: CI, secrets: ['NOPE'] }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: 'bad name', steps: CI })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: 'y', steps: { claude: { run: 'x' } } }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('editWorkflow', () => {
  it('adds a revision; one naming secrets is a person\'s and carries its graph', async () => {
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'ci', steps: CI })
    // An agent may edit one that names none, but not give it secrets.
    expect((await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: { t: { run: 'true' } } })).current.number).toBe(2)
    await expect(editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: CI, secrets: ['P8_KEY'] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    // Naming secrets without the graph would vouch for steps unseen.
    await expect(editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: ['P8_KEY'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { steps: CI, secrets: ['P8_KEY'] })).current)
      .toMatchObject({ number: 3, secrets: ['P8_KEY'] })
    // Now only a person edits it; taking the secrets off needs no graph.
    await expect(editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: CI })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: [] })).current).toMatchObject({ number: 4, steps: CI, secrets: [] })
    await expect(editWorkflow(local, DEMO_PROJECT_ID, 'ci', {})).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('deleteWorkflow', () => {
  it('refuses while a routine or site runs it', async () => {
    const w = await relay()
    const site = await insertSite({ projectId: DEMO_PROJECT_ID, name: 'push', hostname: 'push.example.com', port: 3000, workflowId: w.id })
    await expect(deleteWorkflow(local, DEMO_PROJECT_ID, 'relay')).rejects.toMatchObject({ code: 'CONFLICT' })
    await insertRoutine(DEMO_PROJECT_ID, {
      name: 'r', cron: '@daily', timeZone: 'UTC', tool: 'claude', model: 'm', mode: 'acp', permissionMode: 'bypass',
      branch: 'main', workflowId: (await createWorkflow(local, DEMO_PROJECT_ID, { name: 'nightly', steps: CI })).id,
    }, null)
    await expect(deleteWorkflow(local, DEMO_PROJECT_ID, 'nightly')).rejects.toMatchObject({ code: 'CONFLICT' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'spare', steps: CI })
    await deleteWorkflow(local, DEMO_PROJECT_ID, 'spare')
    expect((await listProjectWorkflows(DEMO_PROJECT_ID)).map((x) => x.name)).toEqual(['nightly', 'relay'])
    expect(site.workflowId).toBe(w.id)
  })
})

describe('listProjectWorkflows', () => {
  it('lists each with its current revision and approvals', async () => {
    const w = await relay()
    await approveWorkflowRef(local, w.id, { branch: 'main' })
    await approveWorkflowRef(local, w.id, { commit: main })
    expect(await listProjectWorkflows(DEMO_PROJECT_ID)).toMatchObject([
      { name: 'relay', current: { number: 1 }, approvedCommits: [main], approvedBranches: ['main'] },
    ])
    await expect(listProjectWorkflows(OTHER)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('resolveWorkflow', () => {
  it('finds one by name, or refuses as NOT_FOUND', async () => {
    const w = await relay()
    expect((await resolveWorkflow(DEMO_PROJECT_ID, 'relay')).id).toBe(w.id)
    await expect(resolveWorkflow(DEMO_PROJECT_ID, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('showWorkflow', () => {
  it('lists every revision, newest first', async () => {
    await relay()
    await editWorkflow(local, DEMO_PROJECT_ID, 'relay', { secrets: [] })
    expect((await showWorkflow(DEMO_PROJECT_ID, 'relay')).revisions.map((r) => [r.number, r.secrets]))
      .toEqual([[2, []], [1, ['P8_KEY']]])
  })
})

describe('approveWorkflowRef', () => {
  it('records a person\'s approval, and holds anyone else to one already made', async () => {
    const w = await relay()
    await expect(approveWorkflowRef(agent, w.id, { branch: 'main' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await approveWorkflowRef(local, w.id, { branch: 'main' })
    await approveWorkflowRef(agent, w.id, { branch: 'main' })
    // A workflow that names no secrets needs no approval.
    const plain = await createWorkflow(local, DEMO_PROJECT_ID, { name: 'plain', steps: CI })
    await approveWorkflowRef(agent, plain.id, { commit: dev })
    expect((await listProjectWorkflows(DEMO_PROJECT_ID)).find((x) => x.name === 'plain')?.approvedCommits).toEqual([])
  })
})

describe('workflowLaunch', () => {
  it('hands the secrets only on a commit a person ran, refusing rather than running without them', async () => {
    await relay()
    const first = await revisionOf('relay')
    // Interactive, it gets none and is not refused.
    expect((await workflowLaunch(server, DEMO_PROJECT_ID, { revisionId: first, commit: dev, secrets: false })).runSecrets).toEqual({})
    // No person ran it on dev: refused, for the server as for an agent.
    await expect(workflowLaunch(server, DEMO_PROJECT_ID, { revisionId: first, commit: dev, secrets: true }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    // A person's launch approves its commit and gets them, current values
    // handed to the runtime first.
    const ran = await workflowLaunch(local, DEMO_PROJECT_ID, { revisionId: first, commit: main, secrets: true })
    expect(ran).toMatchObject({ revision: { steps: CI }, runSecrets: { P8_KEY: 'pem' } })
    expect(pushed.at(-1)).toEqual({ P8_KEY: 'pem' })
    expect((await workflowLaunch(agent, DEMO_PROJECT_ID, { revisionId: first, commit: main, secrets: true })).runSecrets)
      .toEqual({ P8_KEY: 'pem' })

    // An approved branch: a launch with no commit runs at its tip.
    const w = await resolveWorkflow(DEMO_PROJECT_ID, 'relay')
    await approveWorkflowRef(local, w.id, { branch: 'dev' })
    expect(await workflowLaunch(server, DEMO_PROJECT_ID, { revisionId: first, branch: 'dev', secrets: true }))
      .toMatchObject({ commit: dev, runSecrets: { P8_KEY: 'pem' } })

    // After an edit the old revision keeps only the commits it ran on;
    // approvals reach the current one.
    await editWorkflow(local, DEMO_PROJECT_ID, 'relay', { steps: { t: { run: 'true' } }, secrets: ['P8_KEY'] })
    const second = await revisionOf('relay')
    await git(repoDir(DEMO_PROJECT_ID), ['commit', '--allow-empty', '-m', 'newer'])
    const newer = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'HEAD'])).trim()
    await approveWorkflowRef(local, w.id, { commit: newer })
    expect((await workflowLaunch(server, DEMO_PROJECT_ID, { revisionId: first, commit: main, secrets: true })).runSecrets)
      .toEqual({ P8_KEY: 'pem' })
    await expect(workflowLaunch(server, DEMO_PROJECT_ID, { revisionId: first, commit: newer, secrets: true }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await workflowLaunch(server, DEMO_PROJECT_ID, { revisionId: second, commit: newer, secrets: true })).runSecrets)
      .toEqual({ P8_KEY: 'pem' })

    // A rotated value reaches every launch at once; a deleted one fails it.
    await upsertRunSecret(DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'rotated' })
    expect((await workflowLaunch(server, DEMO_PROJECT_ID, { revisionId: first, commit: main, secrets: true })).runSecrets)
      .toEqual({ P8_KEY: 'rotated' })
    await removeRunSecret(local, DEMO_PROJECT_ID, (await listProjectRunSecrets(DEMO_PROJECT_ID))[0].id)
    await expect(workflowLaunch(server, DEMO_PROJECT_ID, { revisionId: second, commit: newer, secrets: true }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(workflowLaunch(server, OTHER, { revisionId: second, commit: newer, secrets: true }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

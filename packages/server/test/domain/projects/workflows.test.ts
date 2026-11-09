import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { repoDir } from '@yaac/shared/project-paths'
import { BUILT_IN_USER_ID, closeDb, insertRoutine, insertSite, recordProject, upsertRunSecret } from '#db'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import {
  approveWorkflowRef,
  checkWorkflowRef,
  createWorkflow,
  deleteWorkflow,
  editWorkflow,
  listProjectRunSecrets,
  listProjectWorkflows,
  removeRunSecret,
  initWorkflowOf,
  resolveWorkflow,
  setInitWorkflow,
  setRunSecret,
  showWorkflow,
  storeSteps,
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
const current = async (name: string) => (await resolveWorkflow(DEMO_PROJECT_ID, name))

describe('createWorkflow', () => {
  it('names a workflow, giving run secrets only for a person and only ones that exist', async () => {
    expect(await relay()).toMatchObject({ name: 'relay', steps: CI, secrets: ['P8_KEY'] })
    await expect(createWorkflow(agent, DEMO_PROJECT_ID, { name: 'leak', steps: CI, secrets: ['P8_KEY'] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'plain', steps: CI })).secrets).toEqual([])
    await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: 'x', steps: CI, secrets: ['NOPE'] }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: 'bad name', steps: CI })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: 'y', steps: { claude: { run: 'x' } } }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    // Two names with the same content share one workflow.
    expect((await current('plain')).workflow.id).toBe((await storeSteps(DEMO_PROJECT_ID, CI)).id)
  })
})

describe('editWorkflow', () => {
  it('points the name at new content; naming secrets is a person\'s and carries its graph', async () => {
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'ci', steps: CI })
    const first = (await current('ci')).workflow.id
    // An agent may edit one that names none, but not give it secrets.
    expect((await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: { t: { run: 'true' } } })).steps).toEqual({ t: { run: ['true'] } })
    expect((await current('ci')).workflow.id).not.toBe(first)
    await expect(editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: CI, secrets: ['P8_KEY'] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    // Naming secrets without the graph would vouch for steps unseen.
    await expect(editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: ['P8_KEY'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { steps: CI, secrets: ['P8_KEY'] })).toMatchObject({ secrets: ['P8_KEY'] })
    // Now only a person edits it; taking the secrets off needs no graph.
    await expect(editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: CI })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: [] })).toMatchObject({ steps: CI, secrets: [] })
    expect((await current('ci')).workflow.id).toBe(first)
    await expect(editWorkflow(local, DEMO_PROJECT_ID, 'ci', {})).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('deleteWorkflow', () => {
  it('refuses while a routine, site or the init steps follow it', async () => {
    await relay()
    const named = await current('relay')
    await insertSite({ projectId: DEMO_PROJECT_ID, name: 'push', hostname: 'push.example.com', port: 3000, namedWorkflowId: named.id })
    await expect(deleteWorkflow(local, DEMO_PROJECT_ID, 'relay')).rejects.toMatchObject({ code: 'CONFLICT' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'nightly', steps: CI })
    await insertRoutine(DEMO_PROJECT_ID, {
      name: 'r', cron: '@daily', timeZone: 'UTC', tool: 'claude', model: 'm', mode: 'acp', permissionMode: 'bypass',
      branch: 'main', namedWorkflowId: (await current('nightly')).id,
    }, null)
    await expect(deleteWorkflow(local, DEMO_PROJECT_ID, 'nightly')).rejects.toMatchObject({ code: 'CONFLICT' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'setup', steps: CI })
    await setInitWorkflow(local, DEMO_PROJECT_ID, 'setup')
    await expect(deleteWorkflow(local, DEMO_PROJECT_ID, 'setup')).rejects.toMatchObject({ code: 'CONFLICT' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'spare', steps: CI })
    await deleteWorkflow(local, DEMO_PROJECT_ID, 'spare')
    expect((await listProjectWorkflows(DEMO_PROJECT_ID)).map((x) => x.name)).toEqual(['nightly', 'relay', 'setup'])
  })
})

describe('listProjectWorkflows', () => {
  it('lists each with its graph, secrets and approvals', async () => {
    await relay()
    const named = await current('relay')
    await approveWorkflowRef(local, named.id, { branch: 'main' })
    await approveWorkflowRef(local, named.id, { commit: main })
    expect(await listProjectWorkflows(DEMO_PROJECT_ID)).toMatchObject([
      { name: 'relay', steps: CI, secrets: ['P8_KEY'], approvedCommits: [main], approvedBranches: ['main'] },
    ])
    await expect(listProjectWorkflows(OTHER)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('resolveWorkflow', () => {
  it('finds one by name, or refuses as NOT_FOUND', async () => {
    await relay()
    expect((await resolveWorkflow(DEMO_PROJECT_ID, 'relay')).workflow.secrets).toEqual(['P8_KEY'])
    await expect(resolveWorkflow(DEMO_PROJECT_ID, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('showWorkflow', () => {
  it('answers one by name', async () => {
    await relay()
    expect(await showWorkflow(DEMO_PROJECT_ID, 'relay')).toMatchObject({ name: 'relay', steps: CI })
  })
})

describe('storeSteps', () => {
  it('makes a graph given by itself a workflow naming no secrets, the same one each time', async () => {
    const a = await storeSteps(DEMO_PROJECT_ID, { test: { run: 'pnpm test' } })
    expect(a).toMatchObject({ steps: CI, secrets: [] })
    expect((await storeSteps(DEMO_PROJECT_ID, CI)).id).toBe(a.id)
    await expect(storeSteps(DEMO_PROJECT_ID, { a: { run: 'x', needs: ['b'] } })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('initWorkflowOf', () => {
  it('answers the init steps\' workflow, and the name they follow', async () => {
    expect(await initWorkflowOf(DEMO_PROJECT_ID)).toBeUndefined()
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'setup', steps: CI })
    await setInitWorkflow(local, DEMO_PROJECT_ID, 'setup')
    expect(await initWorkflowOf(DEMO_PROJECT_ID)).toMatchObject({ name: 'setup', workflow: { steps: CI } })
  })
})

describe('checkWorkflowRef', () => {
  it('refuses what a write would approve, recording nothing', async () => {
    await relay()
    const named = await current('relay')
    await expect(checkWorkflowRef(agent, named.id, { commit: main })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await checkWorkflowRef(local, named.id, { branch: 'main' })
    expect((await listProjectWorkflows(DEMO_PROJECT_ID))[0].approvedBranches).toEqual([])
    await recordProject({ id: OTHER, name: 'shared', remoteUrl: 'r', addedAt: 'now', sharedFrom: DEMO_PROJECT_ID }, BUILT_IN_USER_ID)
    await expect(checkWorkflowRef(local, named.id, { branch: 'main' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await checkWorkflowRef(local, named.id, { commit: main })
  })
})

describe('approveWorkflowRef', () => {
  it('records a person\'s approval, and holds anyone else to one already made', async () => {
    await relay()
    const named = await current('relay')
    await expect(approveWorkflowRef(agent, named.id, { branch: 'main' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await approveWorkflowRef(local, named.id, { branch: 'main' })
    await approveWorkflowRef(agent, named.id, { branch: 'main' })
    // A workflow that names no secrets needs no approval.
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'plain', steps: CI })
    await approveWorkflowRef(agent, (await current('plain')).id, { commit: dev })
    expect((await listProjectWorkflows(DEMO_PROJECT_ID)).find((x) => x.name === 'plain')?.approvedCommits).toEqual([])
  })
})

describe('workflowLaunch', () => {
  it('hands the secrets only on a commit a person ran, refusing rather than running without them', async () => {
    await relay()
    const named = await current('relay')
    const first = named.workflow.id
    const launch = (actor: typeof local | typeof agent | typeof server, workflowId: string, more: { commit?: string; branch?: string; secrets?: boolean } = {}) =>
      workflowLaunch(actor, DEMO_PROJECT_ID, { workflowId, secrets: true, ...more })
    // Interactive, it gets none and is not refused.
    expect((await launch(server, first, { commit: dev, secrets: false })).runSecrets).toEqual({})
    // No person ran it on dev: refused, for the server as for an agent.
    await expect(launch(server, first, { commit: dev })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // A person's launch through its name approves its commit and gets them,
    // current values handed to the runtime first.
    expect((await workflowLaunch(local, DEMO_PROJECT_ID, { workflowId: first, namedWorkflowId: named.id, commit: main, secrets: true })).runSecrets)
      .toEqual({ P8_KEY: 'pem' })
    expect(pushed.at(-1)).toEqual({ P8_KEY: 'pem' })
    expect((await launch(agent, first, { commit: main })).runSecrets).toEqual({ P8_KEY: 'pem' })

    // An approved branch: a launch with no commit runs at its tip.
    await approveWorkflowRef(local, named.id, { branch: 'dev' })
    expect(await launch(server, first, { branch: 'dev' })).toMatchObject({ commit: dev, runSecrets: { P8_KEY: 'pem' } })

    // After an edit the old workflow keeps only the commits it ran on;
    // approvals reach the one the name points at now.
    await editWorkflow(local, DEMO_PROJECT_ID, 'relay', { steps: { t: { run: 'true' } }, secrets: ['P8_KEY'] })
    const second = (await current('relay')).workflow.id
    await git(repoDir(DEMO_PROJECT_ID), ['commit', '--allow-empty', '-m', 'newer'])
    const newer = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'HEAD'])).trim()
    await approveWorkflowRef(local, named.id, { commit: newer })
    expect((await launch(server, first, { commit: main })).runSecrets).toEqual({ P8_KEY: 'pem' })
    await expect(launch(server, first, { commit: newer })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await launch(server, second, { commit: newer })).runSecrets).toEqual({ P8_KEY: 'pem' })

    // Once another user can push the remote through a share, a branch
    // approval no longer gives the secrets, and none can be made.
    await recordProject({ id: OTHER, name: 'shared', remoteUrl: 'r', addedAt: 'now', sharedFrom: DEMO_PROJECT_ID }, BUILT_IN_USER_ID)
    await expect(launch(server, second, { branch: 'dev' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(approveWorkflowRef(local, named.id, { branch: 'main' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await launch(server, first, { commit: main })).runSecrets).toEqual({ P8_KEY: 'pem' })

    // A rotated value reaches every launch at once; a deleted one fails it.
    await upsertRunSecret(DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'rotated' })
    expect((await launch(server, first, { commit: main })).runSecrets).toEqual({ P8_KEY: 'rotated' })
    await removeRunSecret(local, DEMO_PROJECT_ID, (await listProjectRunSecrets(DEMO_PROJECT_ID))[0].id)
    await expect(launch(server, second, { commit: newer })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(workflowLaunch(server, '0a0a0a0a-0000-4000-8000-0000000000ff', { workflowId: second, commit: newer, secrets: true }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

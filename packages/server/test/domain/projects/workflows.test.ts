import fs from 'node:fs/promises'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { repoDir } from '@yaac/shared/project-paths'
import {
  addRepoShare, BUILT_IN_USER_ID, closeDb, deleteWorkspaceRecords, insertRepo, insertRoutine, insertSite, linkProjectRepo,
  upsertRunSecret,
} from '#db'
import { setWorkspaceRepoStart } from '#db/repo-store'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { seeTailnetUser } from '#db/user-store'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import {
  approveWorkflowStart,
  assertWorkflowRepos,
  checkWorkflowStart,
  createWorkflow,
  deleteWorkflow,
  editWorkflow,
  listInitWorkflows,
  listProjectRunSecrets,
  listProjectWorkflows,
  mintWorkflowName,
  missingRepos,
  projectRepoIds,
  removeRunSecret,
  resolveWorkflow,
  setInitWorkflows,
  setRunSecret,
  showWorkflow,
  workflowLaunch,
} from '#domain/projects'

/**
 * Workflows above the store: their repos and the init flag, only a person
 * names run secrets or approves, and a launch gets them only when every
 * repo it starts with is at a commit that passes.
 */

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const agent = { kind: 'workspace', workspaceId: 'w1', userId: BUILT_IN_USER_ID } as const
const server = { kind: 'system' } as const
const CI = { test: { run: ['pnpm test'] } }
/** A second repo of the project, in the folder `docs`. */
const DOCS = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'

/** Share the project's repo with another user, who may then push it. */
async function shareRepo(): Promise<void> {
  await addRepoShare(DEMO_PROJECT_ID, await seeTailnetUser('other@example.com', 'Other'))
}

/** Link the second repo, `docs`, whose main clone is a copy of the
 *  first's. */
async function linkDocs(): Promise<void> {
  await fs.cp(repoDir(DEMO_PROJECT_ID), repoDir(DOCS), { recursive: true })
  await insertRepo({ id: DOCS, owner: BUILT_IN_USER_ID, remoteUrl: 'https://example.com/docs' })
  await linkProjectRepo(DEMO_PROJECT_ID, DOCS, 'docs')
}

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
  it('names a workflow, giving run secrets only for a person and only ones that exist, with its repos', async () => {
    expect(await relay()).toMatchObject({ name: 'relay', steps: CI, secrets: ['P8_KEY'], repos: [], init: false })
    await expect(createWorkflow(agent, DEMO_PROJECT_ID, { name: 'leak', steps: CI, secrets: ['P8_KEY'] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'plain', steps: CI })).secrets).toEqual([])
    await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: 'x', steps: CI, secrets: ['NOPE'] }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    // A name follows a step's rule: no ".", which joins a workflow to its step.
    for (const bad of ['bad name', 'web.init', 'x'.repeat(49)]) {
      await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: bad, steps: CI })).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    // A step may now take a tool's name, or `shell`.
    expect(Object.keys((await createWorkflow(local, DEMO_PROJECT_ID, { name: 'tools', steps: { claude: { run: 'x' }, shell: { run: 'y' } } })).steps))
      .toEqual(['claude', 'shell'])
    // Repos by folder, and an init workflow in one step; the same graph in
    // other repos is another workflow.
    await linkDocs()
    expect(await createWorkflow(local, DEMO_PROJECT_ID, { name: 'docs-init', steps: CI, repos: ['docs'], init: true }))
      .toMatchObject({ repos: ['docs'], init: true })
    expect((await current('docs-init')).workflow.id).not.toBe((await current('plain')).workflow.id)
    await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: 'z', steps: CI, repos: ['nope'] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
    // Now only a person edits it, its repos included, so an agent cannot
    // move a secret-bearing graph into another repo's root.
    await linkDocs()
    await expect(editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: CI })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { repos: ['docs'] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // A person moves it to other repos without its graph, which they saw.
    expect(await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { repos: ['docs'] })).toMatchObject({ steps: CI, secrets: ['P8_KEY'], repos: ['docs'] })
    expect(await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { repos: [] })).toMatchObject({ secrets: ['P8_KEY'], repos: [] })
    expect(await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: [] })).toMatchObject({ steps: CI, secrets: [] })
    expect((await current('ci')).workflow.id).toBe(first)
    await expect(editWorkflow(local, DEMO_PROJECT_ID, 'ci', {})).rejects.toMatchObject({ code: 'VALIDATION' })
    // Other repos are other content; none is what it was.
    expect(await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { repos: ['docs'] })).toMatchObject({ steps: CI, repos: ['docs'] })
    expect((await current('ci')).workflow.id).not.toBe(first)
    expect(await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { repos: [] })).toMatchObject({ repos: [] })
    expect((await current('ci')).workflow.id).toBe(first)
    // Marking it init changes no content.
    expect(await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { init: true })).toMatchObject({ init: true })
    expect((await current('ci')).workflow.id).toBe(first)
    expect(await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { init: false })).toMatchObject({ init: false })
  })
})

describe('setInitWorkflows', () => {
  it('makes exactly the named workflows the project\'s init workflows', async () => {
    for (const name of ['web-init', 'api-init', 'lint']) await createWorkflow(local, DEMO_PROJECT_ID, { name, steps: CI })
    expect((await setInitWorkflows(local, DEMO_PROJECT_ID, ['web-init', 'api-init'])).map((w) => w.name)).toEqual(['api-init', 'web-init'])
    expect((await setInitWorkflows(local, DEMO_PROJECT_ID, ['lint'])).map((w) => w.name)).toEqual(['lint'])
    expect(await setInitWorkflows(local, DEMO_PROJECT_ID, [])).toEqual([])
    await expect(setInitWorkflows(local, DEMO_PROJECT_ID, ['nope'])).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('listInitWorkflows', () => {
  it('lists the init workflows with what they point at', async () => {
    expect(await listInitWorkflows(DEMO_PROJECT_ID)).toEqual([])
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'setup', steps: CI, init: true })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'other', steps: CI })
    expect(await listInitWorkflows(DEMO_PROJECT_ID)).toMatchObject([{ name: 'setup', init: true, workflow: { steps: CI } }])
  })
})

describe('deleteWorkflow', () => {
  it('refuses while a routine or site follows it, and deletes an init workflow', async () => {
    await relay()
    const named = await current('relay')
    await insertSite({
      projectId: DEMO_PROJECT_ID, repos: [{ repo: DEMO_PROJECT_ID, branch: 'main' }], follow: false, name: 'push',
      hostname: 'push.example.com', port: 3000, namedWorkflowId: named.id,
    })
    await expect(deleteWorkflow(local, DEMO_PROJECT_ID, 'relay')).rejects.toMatchObject({ code: 'CONFLICT' })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'nightly', steps: CI })
    await insertRoutine(DEMO_PROJECT_ID, {
      name: 'r', cron: '@daily', timeZone: 'UTC', tool: 'claude', model: 'm', mode: 'acp', permissionMode: 'bypass',
      repos: [{ repo: DEMO_PROJECT_ID, branch: 'main' }], nested: false, cwd: '.', namedWorkflowId: (await current('nightly')).id,
    }, null)
    await expect(deleteWorkflow(local, DEMO_PROJECT_ID, 'nightly')).rejects.toMatchObject({ code: 'CONFLICT' })
    // Deleting an init workflow is how its steps stop running.
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'setup', steps: CI, init: true })
    await deleteWorkflow(local, DEMO_PROJECT_ID, 'setup')
    expect((await listProjectWorkflows(DEMO_PROJECT_ID)).map((x) => x.name)).toEqual(['nightly', 'relay'])
  })
})

describe('listProjectWorkflows', () => {
  it('lists each with its graph, secrets, repos and approvals', async () => {
    await relay()
    const named = await current('relay')
    await approveWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, branch: 'main' }])
    await approveWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, commit: main }])
    expect(await listProjectWorkflows(DEMO_PROJECT_ID)).toMatchObject([
      { name: 'relay', steps: CI, secrets: ['P8_KEY'], repos: [], init: false, approvedCommits: [main], approvedBranches: ['main'] },
    ])
    await expect(listProjectWorkflows(DOCS)).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
  it('answers one by name, an approved branch as <dir>@<branch> once the project has several repos', async () => {
    await relay()
    expect(await showWorkflow(DEMO_PROJECT_ID, 'relay')).toMatchObject({ name: 'relay', steps: CI })
    const named = await current('relay')
    await approveWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, branch: 'main' }])
    expect((await showWorkflow(DEMO_PROJECT_ID, 'relay')).approvedBranches).toEqual(['main'])
    await linkDocs()
    await approveWorkflowStart(local, named.id, [{ repo: DOCS, branch: 'dev' }])
    expect((await showWorkflow(DEMO_PROJECT_ID, 'relay')).approvedBranches.sort()).toEqual(['demo@main', 'docs@dev'])
  })
})

describe('projectRepoIds', () => {
  it('names the project\'s repos by id, from folders or ids', async () => {
    await linkDocs()
    expect(await projectRepoIds(DEMO_PROJECT_ID, ['docs', DEMO_PROJECT_ID, 'docs'])).toEqual([DOCS, DEMO_PROJECT_ID])
    expect(await projectRepoIds(DEMO_PROJECT_ID, [])).toEqual([])
    await expect(projectRepoIds(DEMO_PROJECT_ID, ['nope'])).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('missingRepos', () => {
  it('answers the folders of the repos a workflow names that a start lacks', async () => {
    await linkDocs()
    expect(await missingRepos(DEMO_PROJECT_ID, [DEMO_PROJECT_ID, DOCS], [DEMO_PROJECT_ID])).toEqual(['docs'])
    expect(await missingRepos(DEMO_PROJECT_ID, [], [])).toEqual([])
  })
})

describe('assertWorkflowRepos', () => {
  it('refuses a start that lacks a repo the workflow names, naming it', async () => {
    await linkDocs()
    await expect(assertWorkflowRepos(DEMO_PROJECT_ID, 'workflow "docs"', [DOCS], [DEMO_PROJECT_ID]))
      .rejects.toMatchObject({ code: 'VALIDATION', message: 'workflow "docs" runs in docs, which this start does not include' })
    await assertWorkflowRepos(DEMO_PROJECT_ID, 'workflow "docs"', [DOCS], [DOCS, DEMO_PROJECT_ID])
  })
})

describe('mintWorkflowName', () => {
  it('answers a short name no workflow of the workspace or project has', async () => {
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'ci', steps: CI })
    const name = await mintWorkflowName(DEMO_PROJECT_ID, ['k3f9'])
    expect(name).toMatch(/^[a-z][a-z0-9]{3}$/)
    expect(['ci', 'k3f9']).not.toContain(name)
  })
})

describe('checkWorkflowStart', () => {
  it('refuses what a write would approve for every repo, recording nothing', async () => {
    await relay()
    const named = await current('relay')
    await linkDocs()
    await expect(checkWorkflowStart(agent, named.id, [{ repo: DEMO_PROJECT_ID, commit: main }]))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining(`demo@${main.slice(0, 12)}`) as unknown })
    await checkWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, branch: 'main' }, { repo: DOCS, commit: dev }])
    expect((await listProjectWorkflows(DEMO_PROJECT_ID))[0]).toMatchObject({ approvedBranches: [], approvedCommits: [] })
    // A branch of a shared repo is approved like any other.
    await shareRepo()
    await checkWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, branch: 'main' }])
  })
})

describe('approveWorkflowStart', () => {
  it('records a person\'s approval of each repo, and holds anyone else to ones already made', async () => {
    await relay()
    const named = await current('relay')
    await linkDocs()
    const start = [{ repo: DEMO_PROJECT_ID, branch: 'main' }, { repo: DOCS, commit: dev }]
    await expect(approveWorkflowStart(agent, named.id, start)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await approveWorkflowStart(local, named.id, start)
    await approveWorkflowStart(agent, named.id, start)
    expect(await showWorkflow(DEMO_PROJECT_ID, 'relay')).toMatchObject({ approvedCommits: [dev], approvedBranches: ['demo@main'] })
    // An agent's start with one repo not yet approved is refused whole.
    await expect(approveWorkflowStart(agent, named.id, [...start, { repo: DOCS, commit: main }])).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // A workflow that names no secrets needs no approval.
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'plain', steps: CI })
    await approveWorkflowStart(agent, (await current('plain')).id, [{ repo: DEMO_PROJECT_ID, commit: dev }])
    expect((await showWorkflow(DEMO_PROJECT_ID, 'plain')).approvedCommits).toEqual([])
  })
})

describe('workflowLaunch', () => {
  it('hands the secrets only when each repo is at a commit a person ran, refusing rather than running without them', async () => {
    await relay()
    const named = await current('relay')
    const first = named.workflow.id
    type Repo = { repoId: string; branch?: string; commit?: string }
    const launch = (actor: typeof local | typeof agent | typeof server, workflowId: string, more: { namedWorkflowId?: string; repos?: Repo[]; secrets?: boolean; commit?: string; branch?: string } = {}) => {
      const { commit, branch, ...rest } = more
      return workflowLaunch(actor, DEMO_PROJECT_ID, {
        workflowId, secrets: true,
        repos: [{ repoId: DEMO_PROJECT_ID, ...(commit !== undefined ? { commit } : {}), ...(branch !== undefined ? { branch } : {}) }], ...rest,
      })
    }
    // Interactive, it gets none and is not refused.
    expect((await launch(server, first, { commit: dev, secrets: false })).runSecrets).toEqual({})
    // A start with no repos runs only steps a person wrote, and passes.
    expect((await launch(server, first, { repos: [] })).runSecrets).toEqual({ P8_KEY: 'pem' })
    // No person ran it on dev: refused, naming the repo, for the server as
    // for an agent.
    await expect(launch(server, first, { commit: dev })).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('demo@') as unknown })
    // A person's launch through its name approves its commit and gets them,
    // current values handed to the runtime first.
    expect((await launch(local, first, { namedWorkflowId: named.id, commit: main })).runSecrets).toEqual({ P8_KEY: 'pem' })
    expect(pushed.at(-1)).toEqual({ P8_KEY: 'pem' })
    expect((await launch(agent, first, { commit: main })).runSecrets).toEqual({ P8_KEY: 'pem' })

    // An approved branch: a launch at a branch runs at its tip, and one at
    // the commit that is its tip passes without naming the branch.
    await approveWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, branch: 'dev' }])
    expect(await launch(server, first, { branch: 'dev' })).toMatchObject({ commits: { [DEMO_PROJECT_ID]: dev }, runSecrets: { P8_KEY: 'pem' } })
    expect((await launch(server, first, { commit: dev })).runSecrets).toEqual({ P8_KEY: 'pem' })

    // After an edit the old workflow keeps only the commits it ran on;
    // approvals reach the one the name points at now.
    await editWorkflow(local, DEMO_PROJECT_ID, 'relay', { steps: { t: { run: 'true' } }, secrets: ['P8_KEY'] })
    const second = (await current('relay')).workflow.id
    await git(repoDir(DEMO_PROJECT_ID), ['commit', '--allow-empty', '-m', 'newer'])
    const newer = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'HEAD'])).trim()
    await approveWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, commit: newer }])
    await expect(launch(server, first, { commit: newer })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await launch(server, second, { commit: newer })).runSecrets).toEqual({ P8_KEY: 'pem' })

    // A branch of a repo shared with another user still passes.
    await shareRepo()
    expect((await launch(server, second, { branch: 'dev' })).runSecrets).toEqual({ P8_KEY: 'pem' })

    // A rotated value reaches every launch at once; a deleted one fails it.
    await upsertRunSecret(DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'rotated' })
    expect((await launch(server, second, { commit: newer })).runSecrets).toEqual({ P8_KEY: 'rotated' })
    await removeRunSecret(local, DEMO_PROJECT_ID, (await listProjectRunSecrets(DEMO_PROJECT_ID))[0].id)
    await expect(launch(server, second, { commit: newer })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(workflowLaunch(server, '0a0a0a0a-0000-4000-8000-0000000000ff', { workflowId: second, repos: [], secrets: true }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('checks each repo of a start on its own', async () => {
    await relay()
    const named = await current('relay')
    await linkDocs()
    const flow = named.workflow.id
    // One repo at an approved commit, the other at an approved branch's tip.
    await approveWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, commit: main }, { repo: DOCS, branch: 'dev' }])
    const two = (docs: { commit?: string; branch?: string }) =>
      workflowLaunch(agent, DEMO_PROJECT_ID, { workflowId: flow, secrets: true, repos: [{ repoId: DEMO_PROJECT_ID, commit: main }, { repoId: DOCS, ...docs }] })
    expect(await two({ branch: 'dev' })).toMatchObject({ commits: { [DEMO_PROJECT_ID]: main, [DOCS]: dev } })
    // The branch is approved for docs alone, not for the first repo.
    await expect(workflowLaunch(agent, DEMO_PROJECT_ID, { workflowId: flow, secrets: true, repos: [{ repoId: DEMO_PROJECT_ID, branch: 'dev' }] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    // One repo unapproved: refused, with nothing approved by the try.
    await expect(two({ commit: main })).resolves.toBeDefined()
    await git(repoDir(DEMO_PROJECT_ID), ['commit', '--allow-empty', '-m', 'newer'])
    const newer = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'HEAD'])).trim()
    await expect(two({ commit: newer })).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining(`docs@${newer.slice(0, 12)}`) as unknown })
    expect((await showWorkflow(DEMO_PROJECT_ID, 'relay')).approvedCommits).not.toContain(newer)

    // A commit an earlier non-interactive workspace of the workflow started
    // at passes, until that workspace is deleted; an interactive one never
    // counts.
    const ran = async (workspaceId: string, nonInteractive: boolean): Promise<void> => {
      await recordWorkspaceCreated({
        projectId: DEMO_PROJECT_ID, workspaceId, workflowId: flow, workflowName: 'relay', nonInteractive,
        repos: [{ repoId: DOCS, path: 'docs' }],
      })
      await setWorkspaceRepoStart(workspaceId, DOCS, { startCommit: newer })
    }
    await ran('w-interactive', false)
    await expect(two({ commit: newer })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await ran('w-ci', true)
    expect((await two({ commit: newer })).runSecrets).toEqual({ P8_KEY: 'pem' })
    await deleteWorkspaceRecords(DEMO_PROJECT_ID, 'w-ci')
    await expect(two({ commit: newer })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

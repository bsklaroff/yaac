import fs from 'node:fs/promises'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { repoDir } from '@yaac/shared/project-paths'
import {
  addRepoShare, BUILT_IN_USER_ID, closeDb, insertRepo, insertRoutine, insertSite, linkProjectRepo, listApprovals,
  upsertRunSecret,
} from '#db'
import { seeTailnetUser } from '#db/user-store'
import { installFakeWorkspaceDriver } from '#test/support/fake-driver'
import {
  admitLaunch,
  ApprovalRequiredError,
  approveContent,
  approveStart,
  approveWorkflowStart,
  assertWorkflowRepos,
  createWorkflow,
  deleteWorkflow,
  editWorkflow,
  listInitWorkflows,
  listProjectRunSecrets,
  listProjectWorkflows,
  listWorkflowSummaries,
  missingRepos,
  projectRepoIds,
  removeRunSecret,
  resolveWorkflow,
  setInitWorkflows,
  setRunSecret,
  showWorkflow,
  workflowLaunch,
  workflowSpec,
} from '#domain/projects'
import { workspaceDelegate } from '#test/support/delegate'

/**
 * Workflows above the store: their repos and the init flag, anyone who may
 * write the project names run secrets, only a person approves, and a launch
 * gets them only when every repo it starts with is at a commit approved for
 * exactly the content it runs.
 */

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const agent = workspaceDelegate(BUILT_IN_USER_ID, 'w1')
const server = { kind: 'system' } as const
const CI = { test: { run: ['pnpm test'] } }
/** A graph an agent writes, which no person wrote. */
const LEAK = { leak: { run: ['printenv P8_KEY | base64'] } }
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
  it('names a workflow, with run secrets that exist, whoever writes it, and its repos', async () => {
    expect(await relay()).toMatchObject({ name: 'relay', steps: CI, secrets: ['P8_KEY'], repos: [], init: false })
    expect((await showWorkflow(DEMO_PROJECT_ID, 'relay')).writtenByAgent).toBeUndefined()
    // An agent names them too: naming approves nothing, and the content is
    // marked as an agent's.
    expect(await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'agents', steps: LEAK, secrets: ['P8_KEY', 'P8_KEY'] }))
      .toMatchObject({ secrets: ['P8_KEY'], writtenByAgent: true, approvedCommits: [], approvedBranches: [] })
    expect((await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'plain', steps: CI })).secrets).toEqual([])
    await expect(createWorkflow(local, DEMO_PROJECT_ID, { name: 'x', steps: CI, secrets: ['NOPE'] }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    // A name follows a step's rule: no ".", which joins a workflow to its
    // step, and no leading "_", which only the server's own names have.
    for (const bad of ['bad name', 'web.init', 'x'.repeat(49), '_steps']) {
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
  it('points the name at new content, whoever edits it, keeping what is left out', async () => {
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'ci', steps: CI })
    const first = (await current('ci')).workflow.id
    expect((await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: { t: { run: 'true' } } })).steps).toEqual({ t: { run: ['true'] } })
    expect((await current('ci')).workflow.id).not.toBe(first)
    // Secrets alone keep the graph, and an agent may give them; what it
    // writes is an agent's until a person writes the same content.
    expect(await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: CI, secrets: ['P8_KEY'] })).toMatchObject({ steps: CI, secrets: ['P8_KEY'], writtenByAgent: true })
    expect((await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { steps: CI })).writtenByAgent).toBeUndefined()
    expect((await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: CI })).writtenByAgent).toBeUndefined()
    // A person giving an agent's steps secrets or repos was not shown the
    // steps, so they stay the agent's; steps a person wrote stay theirs.
    await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { steps: LEAK })
    expect((await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: [] })).writtenByAgent).toBe(true)
    expect((await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: ['P8_KEY'] })).writtenByAgent).toBe(true)
    await approveStart(local, workflowSpec((await current('ci')).workflow.id), [{ repo: DEMO_PROJECT_ID, branch: 'main' }])
    expect((await showWorkflow(DEMO_PROJECT_ID, 'ci')).approvedBranches).toEqual([])
    await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { steps: CI })
    expect((await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: ['P8_KEY'] })).writtenByAgent).toBeUndefined()
    await linkDocs()
    expect(await editWorkflow(agent, DEMO_PROJECT_ID, 'ci', { repos: ['docs'] })).toMatchObject({ steps: CI, secrets: ['P8_KEY'], repos: ['docs'] })
    expect(await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { repos: [] })).toMatchObject({ secrets: ['P8_KEY'], repos: [] })
    expect(await editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: [] })).toMatchObject({ steps: CI, secrets: [] })
    expect((await current('ci')).workflow.id).toBe(first)
    await expect(editWorkflow(local, DEMO_PROJECT_ID, 'ci', {})).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(editWorkflow(local, DEMO_PROJECT_ID, 'ci', { secrets: ['NOPE'] })).rejects.toMatchObject({ code: 'VALIDATION' })
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
      port: 3000, namedWorkflowId: named.id,
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

describe('listWorkflowSummaries', () => {
  it('lists every project\'s named workflows without their approvals, for the snapshot', async () => {
    await relay()
    await approveWorkflowStart(local, (await current('relay')).id, [{ repo: DEMO_PROJECT_ID, branch: 'main' }])
    const [summary] = await listWorkflowSummaries()
    expect(summary).toMatchObject({ projectId: DEMO_PROJECT_ID, name: 'relay', steps: CI, secrets: ['P8_KEY'], repos: [], init: false })
    expect(summary).not.toHaveProperty('approvedBranches')
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

describe('workflowSpec', () => {
  it('keys a launch outside a site by its workflow\'s content alone', () => {
    expect(workflowSpec('w1')).toEqual({ spec: 'w1', workflowId: 'w1' })
  })
})

describe('approveContent', () => {
  it('marks content a person was shown as theirs, so their own actions approve runs of it', async () => {
    await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'leak', steps: CI, secrets: ['P8_KEY'] })
    const id = (await current('leak')).workflow.id
    await expect(approveContent(agent, DEMO_PROJECT_ID, id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(approveContent(local, DOCS, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await approveStart(local, workflowSpec(id), [{ repo: DEMO_PROJECT_ID, commit: main }])
    expect(await listApprovals(id)).toEqual([])
    await approveContent(local, DEMO_PROJECT_ID, id)
    expect((await showWorkflow(DEMO_PROJECT_ID, 'leak')).writtenByAgent).toBeUndefined()
    await approveStart(local, workflowSpec(id), [{ repo: DEMO_PROJECT_ID, commit: main }])
    expect(await listApprovals(id)).toEqual([main])
  })
})

describe('approveStart', () => {
  it('records a person\'s approval of each repo\'s branch or commit for a spec, and nothing for anyone else', async () => {
    await relay()
    const spec = workflowSpec((await current('relay')).workflow.id)
    await linkDocs()
    const start = [{ repo: DEMO_PROJECT_ID, branch: 'main' }, { repo: DOCS, commit: dev }]
    await approveStart(agent, spec, start)
    await approveStart(server, spec, start)
    expect(await listApprovals(spec.spec)).toEqual([])
    await approveStart(local, spec, start)
    expect((await listApprovals(spec.spec)).sort()).toEqual([`${DEMO_PROJECT_ID}:refs/heads/main`, dev].sort())
    await expect(approveStart(local, spec, [{ repo: DOCS }])).rejects.toMatchObject({ code: 'VALIDATION' })
    // A start with no repos approves the spec alone.
    await approveStart(local, spec, [])
    expect(await listApprovals(spec.spec)).toContain('-')
    // Content an agent wrote is approved by no person's action until a
    // person is shown it.
    await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'agents', steps: LEAK, secrets: ['P8_KEY'] })
    const theirs = workflowSpec((await current('agents')).workflow.id)
    await approveStart(local, theirs, start)
    expect(await listApprovals(theirs.spec)).toEqual([])
    // A branch of a shared repo is approved like any other.
    await shareRepo()
    await approveStart(local, spec, [{ repo: DEMO_PROJECT_ID, branch: 'dev' }])
    expect(await listApprovals(spec.spec)).toContain(`${DEMO_PROJECT_ID}:refs/heads/dev`)
  })
})

describe('approveWorkflowStart', () => {
  it('approves a named workflow\'s current content for a person, only where it names secrets', async () => {
    await relay()
    const named = await current('relay')
    await linkDocs()
    const start = [{ repo: DEMO_PROJECT_ID, branch: 'main' }, { repo: DOCS, commit: dev }]
    await approveWorkflowStart(agent, named.id, start)
    expect(await showWorkflow(DEMO_PROJECT_ID, 'relay')).toMatchObject({ approvedCommits: [], approvedBranches: [] })
    await approveWorkflowStart(local, named.id, start)
    expect(await showWorkflow(DEMO_PROJECT_ID, 'relay')).toMatchObject({ approvedCommits: [dev], approvedBranches: ['demo@main'] })
    // An edit is new content, which the approvals do not reach.
    await editWorkflow(agent, DEMO_PROJECT_ID, 'relay', { steps: { t: { run: 'true' } } })
    expect(await showWorkflow(DEMO_PROJECT_ID, 'relay')).toMatchObject({ approvedCommits: [], approvedBranches: [] })
    // A workflow that names no secrets needs no approval.
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'plain', steps: CI })
    await approveWorkflowStart(local, (await current('plain')).id, [{ repo: DEMO_PROJECT_ID, commit: dev }])
    expect((await showWorkflow(DEMO_PROJECT_ID, 'plain')).approvedCommits).toEqual([])
  })
})

describe('admitLaunch', () => {
  it('approves a person\'s launch, and passes anyone else\'s only on approved commits, recording them', async () => {
    await relay()
    const spec = workflowSpec((await current('relay')).workflow.id)
    await expect(admitLaunch(false, DEMO_PROJECT_ID, spec, { [DEMO_PROJECT_ID]: dev }))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', message: expect.stringContaining(`demo@${dev.slice(0, 12)}`) as unknown })
    await admitLaunch(true, DEMO_PROJECT_ID, spec, { [DEMO_PROJECT_ID]: main })
    await admitLaunch(false, DEMO_PROJECT_ID, spec, { [DEMO_PROJECT_ID]: main })
    expect(await listApprovals(spec.spec)).toEqual([main])
    // The tip of an approved branch passes, and is recorded, so it still
    // passes once the branch moves on.
    await approveStart(local, spec, [{ repo: DEMO_PROJECT_ID, branch: 'dev' }])
    await admitLaunch(false, DEMO_PROJECT_ID, spec, { [DEMO_PROJECT_ID]: dev })
    expect(await listApprovals(spec.spec)).toContain(dev)
    // Another spec of the same workflow, such as a site's, is approved apart.
    await expect(admitLaunch(false, DEMO_PROJECT_ID, { ...spec, spec: `site:${spec.spec}` }, { [DEMO_PROJECT_ID]: main }))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    // A launch with no repos needs its spec approved, which only a
    // person's launch of it does.
    await expect(admitLaunch(false, DEMO_PROJECT_ID, spec, {})).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED', message: expect.stringContaining('no person has approved this workflow') as unknown,
    })
    await admitLaunch(true, DEMO_PROJECT_ID, spec, {})
    await admitLaunch(false, DEMO_PROJECT_ID, spec, {})
    // A person's launch of content an agent wrote approves nothing, and the
    // refusal carries what it would run, for a person to be shown.
    await createWorkflow(agent, DEMO_PROJECT_ID, { name: 'agents', steps: LEAK, secrets: ['P8_KEY'] })
    const theirs = workflowSpec((await current('agents')).workflow.id)
    const refused = await admitLaunch(true, DEMO_PROJECT_ID, theirs, { [DEMO_PROJECT_ID]: main }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(ApprovalRequiredError)
    expect(refused).toMatchObject({
      message: expect.stringContaining('last written by an agent') as unknown,
      request: { workflowId: theirs.workflowId, commits: { [DEMO_PROJECT_ID]: main } },
    })
    expect(await listApprovals(theirs.spec)).toEqual([])
  })
})

describe('workflowLaunch', () => {
  it('hands the secrets only when each repo is at a commit a person approved, refusing rather than running without them', async () => {
    await relay()
    const named = await current('relay')
    const first = named.workflow.id
    type Repo = { repoId: string; branch?: string; commit?: string }
    const launch = (actor: typeof local | typeof agent | typeof server, workflowId: string, more: { repos?: Repo[]; secrets?: boolean; commit?: string; branch?: string } = {}) => {
      const { commit, branch, ...rest } = more
      return workflowLaunch(actor, DEMO_PROJECT_ID, {
        workflowId, secrets: true,
        repos: [{ repoId: DEMO_PROJECT_ID, ...(commit !== undefined ? { commit } : {}), ...(branch !== undefined ? { branch } : {}) }], ...rest,
      })
    }
    // Interactive, it gets none and is not refused.
    expect((await launch(server, first, { commit: dev, secrets: false })).runSecrets).toEqual({})
    // A start with no repos is approved by a person's launch of it, as a
    // start with repos is.
    await expect(launch(server, first, { repos: [] })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect((await launch(local, first, { repos: [] })).runSecrets).toEqual({ P8_KEY: 'pem' })
    expect((await launch(server, first, { repos: [] })).runSecrets).toEqual({ P8_KEY: 'pem' })
    // No person ran it on dev: refused, naming the repo, for the server as
    // for an agent.
    await expect(launch(server, first, { commit: dev })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', message: expect.stringContaining('demo@') as unknown })
    // A person's launch approves its commit and gets them, current values
    // handed to the runtime first.
    expect((await launch(local, first, { commit: main })).runSecrets).toEqual({ P8_KEY: 'pem' })
    expect(pushed.at(-1)).toEqual({ P8_KEY: 'pem' })
    expect((await launch(agent, first, { commit: main })).runSecrets).toEqual({ P8_KEY: 'pem' })

    // An approved branch: a launch at a branch runs at its tip, and one at
    // the commit that is its tip passes without naming the branch.
    await approveWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, branch: 'dev' }])
    expect(await launch(server, first, { branch: 'dev' })).toMatchObject({ commits: { [DEMO_PROJECT_ID]: dev }, runSecrets: { P8_KEY: 'pem' } })
    expect((await launch(server, first, { commit: dev })).runSecrets).toEqual({ P8_KEY: 'pem' })

    // An agent's edit is new content, which nothing approved: its runs wait
    // for a person, on commits and branches alike, while the old content
    // keeps what it had. Pointing the name back is the same content again.
    await editWorkflow(agent, DEMO_PROJECT_ID, 'relay', { steps: { t: { run: 'true' } } })
    const second = (await current('relay')).workflow.id
    await expect(launch(server, second, { commit: main })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(launch(server, second, { branch: 'dev' })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect((await launch(server, first, { commit: main })).runSecrets).toEqual({ P8_KEY: 'pem' })
    await editWorkflow(agent, DEMO_PROJECT_ID, 'relay', { steps: CI })
    expect((await current('relay')).workflow.id).toBe(first)
    await editWorkflow(local, DEMO_PROJECT_ID, 'relay', { steps: { t: { run: 'true' } } })
    await git(repoDir(DEMO_PROJECT_ID), ['commit', '--allow-empty', '-m', 'newer'])
    const newer = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'HEAD'])).trim()
    await approveWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, commit: newer }])
    await expect(launch(server, first, { commit: newer })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect((await launch(server, second, { commit: newer })).runSecrets).toEqual({ P8_KEY: 'pem' })
    // A site's deploy names its own spec, approved apart.
    await expect(workflowLaunch(server, DEMO_PROJECT_ID, {
      workflowId: second, spec: { spec: `site:${second}`, workflowId: second }, secrets: true, repos: [{ repoId: DEMO_PROJECT_ID, commit: newer }],
    })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })

    // A branch of a repo shared with another user still passes.
    await approveWorkflowStart(local, named.id, [{ repo: DEMO_PROJECT_ID, branch: 'dev' }])
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
    // The branch is approved for docs alone, not for the first repo.
    await expect(workflowLaunch(agent, DEMO_PROJECT_ID, { workflowId: flow, secrets: true, repos: [{ repoId: DEMO_PROJECT_ID, branch: 'dev' }] }))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(await two({ branch: 'dev' })).toMatchObject({ commits: { [DEMO_PROJECT_ID]: main, [DOCS]: dev } })
    // One repo unapproved: refused, with nothing approved by the try.
    await expect(two({ commit: main })).resolves.toBeDefined()
    await git(repoDir(DEMO_PROJECT_ID), ['commit', '--allow-empty', '-m', 'newer'])
    const newer = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'HEAD'])).trim()
    await expect(two({ commit: newer })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', message: expect.stringContaining(`docs@${newer.slice(0, 12)}`) as unknown })
    expect((await showWorkflow(DEMO_PROJECT_ID, 'relay')).approvedCommits).not.toContain(newer)
  })
})

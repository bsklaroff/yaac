import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createYaacTestEnv, setTestGitIdentity, spawnYaacServer, runYaac, type YaacTestEnv } from '#support/cli'
import { assignTestGitCredential, type SpawnedServer } from '@yaac/test-utils/api'
import { createTestRepo } from '@yaac/test-utils/setup'
import { addTestProject } from '#support/cluster'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { containerlessJobName, containerlessWorkspacePaths } from '@yaac/server/drivers/containerless/paths'
import type { StoppedWorkspaceEntry, WorkspaceListEntry } from '@yaac/shared/types'

const execFileAsync = promisify(execFile)

/**
 * Workspace steps and workflows end to end on the containerless driver
 * (docs/workspace-steps.md, docs/workflows.md): the real CLI against a real
 * server running workspaces as tmux sessions on this host. One server and
 * project of two repos for the file; the interactive workspace of one repo
 * is shared by the cases that read it, and the cases that stop their
 * subjects run last.
 *
 * Every workspace here opens no session, so no agent is staged.
 */

let testEnv: YaacTestEnv
let server: SpawnedServer
let serverEnv: NodeJS.ProcessEnv
let repoPath: string
let projectId: string
/** The project's second repo, in the folder `lib`, and its path. */
let libPath: string
/** The shared interactive workspace of the project's first repo alone,
 *  started on its init workflow `init`. */
let workspaceId: string
/** A terminal opened in it, whose log only its owner may read. */
let terminalName: string

const NAME = 'cl-steps'
const LIB = 'cl-steps-lib'
const CAN_RUN = await execFileAsync('sh', ['-c', 'command -v tmux && command -v git']).then(() => true, () => false)

const origin = (): string => `http://127.0.0.1:${String(server.lock.port)}`
const api = (p: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${origin()}/api${p}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
const yaac = (...args: string[]): ReturnType<typeof runYaac> => runYaac(serverEnv, ...args)

async function listed(id: string): Promise<WorkspaceListEntry | undefined> {
  const body = await (await api('/workspace/list')).json() as { workspaces: WorkspaceListEntry[] }
  return body.workspaces.find((w) => w.workspaceId === id)
}

/** Each step of a running workspace's life as `state` or `state code`. */
async function stepStates(id: string): Promise<Record<string, string>> {
  const steps = (await listed(id))?.steps ?? []
  return Object.fromEntries(steps.map((s) => [s.name, s.exitCode !== undefined ? `${s.state} ${String(s.exitCode)}` : s.state]))
}

async function stopped(id: string): Promise<StoppedWorkspaceEntry | undefined> {
  const body = await (await api(`/workspace/list-stopped?workspace=${id}`)).json() as { entries: StoppedWorkspaceEntry[] }
  return body.entries.find((e) => e.workspaceId === id)
}

/** Create a workspace through the API, answering its id once it runs. */
async function create(body: Record<string, unknown>): Promise<string> {
  const res = await api('/workspace/create', { method: 'POST', body: JSON.stringify({ project: projectId, ...body }) })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await consumeNdjsonStream<{ workspaceId: string }>(res, () => {})).workspaceId
}

/** A provisioned stream's workspace id (a rerun's). */
async function provisioned(p: string, body: Record<string, unknown>): Promise<string> {
  const res = await api(p, { method: 'POST', body: JSON.stringify(body) })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await consumeNdjsonStream<{ workspaceId: string }>(res, () => {})).workspaceId
}

/**
 * Add a step to a running workspace with the CLI, which prints its full
 * name, and wait for it to succeed. Answers the full name.
 */
async function addStep(id: string, ...args: string[]): Promise<string> {
  const added = await yaac('workspace', 'step', 'add', id, ...args)
  expect(added.exitCode, added.stderr).toBe(0)
  const full = added.stdout.trim()
  await vi.waitFor(async () => {
    expect((await stepStates(id))[full]).toBe('succeeded 0')
  }, { timeout: 30_000, interval: 500 })
  return full
}

/**
 * Run `yaac-mama` inside a running workspace as a step of its own, which is
 * where an agent's call comes from, and answer what the step printed.
 */
async function mamaStep(id: string, name: string, ...commands: string[]): Promise<string> {
  const full = await addStep(id, '--name', name, ...commands.flatMap((c) => ['--run', c]))
  return (await yaac('workspace', 'logs', id, full)).stdout
}

/** The full name of a workspace's step of a bare name, from its newest
 *  life's logs, which a stopped workspace keeps. */
async function logged(id: string, step: string): Promise<string> {
  const lives = await (await api(`/workspace/${id}/logs`)).json() as Array<{ files: Array<{ name: string }> }>
  const file = lives[0]?.files.find((f) => f.name.endsWith(`.${step}.log`))
  return file?.name.slice(0, -'.log'.length) ?? step
}

/** Write a graph to a file of the test's scratch, answering its path. */
async function graphFile(name: string, graph: Record<string, unknown>): Promise<string> {
  const file = path.join(testEnv.scratchDir, `${name}.json`)
  await fs.writeFile(file, JSON.stringify(graph))
  return file
}

const tmux = async (id: string, ...args: string[]): Promise<string> =>
  (await execFileAsync('tmux', ['-S', containerlessWorkspacePaths(containerlessJobName(projectId, id)).tmuxSock, ...args])).stdout

beforeAll(async () => {
  if (!CAN_RUN) return
  testEnv = await createYaacTestEnv()
  serverEnv = {
    ...testEnv.env,
    // Create would otherwise attach a PTY and hang without a TTY.
    YAAC_E2E_NO_ATTACH: '1',
    // The project's remote is fake; skip the fetch.
    YAAC_E2E_SKIP_FETCH: '1',
    GIT_EDITOR: 'true',
  }
  delete serverEnv.YAAC_WORKSPACE_ID
  server = await spawnYaacServer(serverEnv)
  await setTestGitIdentity(serverEnv)
  repoPath = await createTestRepo(path.join(testEnv.scratchDir, NAME))
  projectId = await addTestProject(server, repoPath, { remoteUrl: `https://github.com/test/${NAME}.git` })
  await assignTestGitCredential(server, NAME, 'ghp_steps_test')
  // A second repo, linked as `lib`: a staged project's repo carries the
  // project's id.
  libPath = await createTestRepo(path.join(testEnv.scratchDir, LIB))
  // Its own history: two test repos made alike in one second share a commit.
  await execFileAsync('git', ['-C', libPath, 'commit', '--allow-empty', '-m', 'lib'])
  const libRepo = await addTestProject(server, libPath, { remoteUrl: `https://github.com/test/${LIB}.git` })
  await assignTestGitCredential(server, LIB, 'ghp_steps_lib')
  const linked = await yaac('project', 'repo', 'add', NAME, '--repo-id', libRepo.slice(0, 8), '--dir', 'lib')
  expect(linked.exitCode, linked.stderr).toBe(0)

  // The project's init workflow, made as a user would from a file: a
  // parallel branch, a failure and what it blocks, and a service gated on
  // its ready check.
  const file = await graphFile('init-steps', {
    prep: { run: ['echo prep-out', 'printf ok > prep.txt'] },
    flaky: { run: 'test -f fixed.txt || { echo failing; exit 3; }' },
    'after-flaky': { run: 'echo after-flaky-ran', needs: ['flaky'] },
    svc: { run: ['sleep 1', 'touch svc.ready', 'exec sleep 600'], service: true, ready: 'test -f svc.ready' },
    gated: { run: 'cat prep.txt; echo " gated-ran"', needs: ['prep', 'svc'] },
  })
  const set = await yaac('workflow', 'create', NAME, 'init', '--file', file, '--init')
  expect(set.exitCode, set.stderr).toBe(0)
  expect(set.stdout).toContain('an init workflow')
  workspaceId = await create({ noSession: true, repos: [{ repo: NAME }], nested: false })
}, 120_000)

afterAll(async () => {
  if (!CAN_RUN) return
  await server?.stop()
  await testEnv?.cleanup()
})

describe.skipIf(!CAN_RUN)('workspace steps (containerless)', () => {
  it('runs the project\'s init workflow as a graph: in parallel, after their needs, skipping what a failure blocks', async () => {
    await vi.waitFor(async () => {
      expect(await stepStates(workspaceId)).toEqual({
        'init.prep': 'succeeded 0',
        'init.flaky': 'failed 3',
        'init.after-flaky': 'skipped',
        'init.svc': 'ready',
        'init.gated': 'succeeded 0',
      })
    }, { timeout: 60_000, interval: 500 })
    // A step's window is not a terminal tab, but the webapp can open it.
    const entry = await listed(workspaceId)
    expect(entry?.terminals?.map((t) => t.name)).toEqual([])
    expect(entry?.steps?.find((s) => s.name === 'init.svc')).toMatchObject({ workflow: 'init', target: expect.stringMatching(/^window:@\d+$/) as unknown })
    // Each step's output is in its log, read by its full name or a bare one.
    expect((await yaac('workspace', 'logs', workspaceId, 'init.gated')).stdout).toContain('ok gated-ran')
    expect((await yaac('workspace', 'logs', workspaceId, 'gated')).stdout).toContain('ok gated-ran')
  }, 90_000)

  it('logs a terminal opened in the workspace, and runs a step added to it once its needs are met', async () => {
    const term = await (await api(`/workspace/${workspaceId}/terminals`, { method: 'POST' })).json() as { name: string }
    terminalName = term.name
    await tmux(workspaceId, 'send-keys', '-t', `=yaac:=${term.name}`, 'echo hello-from-a-terminal', 'Enter')
    await vi.waitFor(async () => {
      expect((await yaac('workspace', 'logs', workspaceId, term.name)).stdout).toContain('hello-from-a-terminal')
    }, { timeout: 20_000, interval: 500 })

    // A bare need, while one workflow has the step, is stored in full; a
    // full one names a step of another workflow outright.
    const added = await addStep(workspaceId, '--run', 'echo "added-$((1 + 1))"', '--name', 'added', '--needs', 'gated')
    expect(added).toBe('_added-1.added')
    expect((await listed(workspaceId))?.steps?.find((s) => s.name === added)?.spec.needs).toEqual(['init.gated'])
    expect((await yaac('workspace', 'logs', workspaceId, added)).stdout).toContain('added-2')
    const after = await addStep(workspaceId, '--run', 'echo after-added', '--needs', `${added},init.prep`)
    expect(after).toBe('_added-2.run')
    expect((await yaac('workspace', 'logs', workspaceId, after)).stdout).toContain('after-added')
    const missing = await yaac('workspace', 'step', 'add', workspaceId, '--run', 'true', '--needs', 'nope.step')
    expect(missing.stderr).toContain('not a step of this workspace')
  }, 60_000)

  it('reads its steps\' logs through yaac-mama, but not a terminal\'s', async () => {
    const out = await mamaStep(workspaceId, 'mama-logs',
      'yaac-mama logs "$YAAC_WORKSPACE_ID"',
      'echo "<tail>"; yaac-mama logs "$YAAC_WORKSPACE_ID" gated --tail 1; echo "</tail>"',
      `yaac-mama logs "$YAAC_WORKSPACE_ID" ${terminalName}; echo "refused=$?"`)
    expect(out).toMatch(/^init\.gated\s+succeeded\s+0\s+prep,svc\s+\d+ B$/m)
    expect(out).toMatch(/^init\.svc\s+ready \(service\)\s+\d+ B$/m)
    expect(out).toMatch(/^init\.flaky\s+failed\s+3\s+\d+ B$/m)
    expect(/<tail>\n([^]*)<\/tail>/.exec(out)?.[1]).toBe('ok gated-ran\n')
    expect(out).toContain(`yaac-mama: workspace ${workspaceId.slice(0, 8)} has no step "${terminalName}"`)
    expect(out).toContain('refused=1')
    expect(out).not.toContain('hello-from-a-terminal')
  }, 60_000)

  it('reruns a failed step with the steps it skipped', async () => {
    await fs.writeFile(path.join(containerlessWorkspacePaths(containerlessJobName(projectId, workspaceId)).workspaceDir, 'fixed.txt'), '')
    const rerun = await yaac('workspace', 'step', 'rerun', workspaceId, 'flaky')
    expect(rerun.exitCode, rerun.stderr).toBe(0)
    await vi.waitFor(async () => {
      expect(await stepStates(workspaceId)).toMatchObject({ 'init.flaky': 'succeeded 0', 'init.after-flaky': 'succeeded 0' })
    }, { timeout: 30_000, interval: 500 })
  }, 60_000)

  it('gives a workflow\'s run secret only on commits a person ran it on, through the CLI and yaac-mama', async () => {
    const head = (await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim()
    const libHead = (await execFileAsync('git', ['-C', libPath, 'rev-parse', 'HEAD'])).stdout.trim()
    const set = await runYaac(serverEnv, 'config', 'env', NAME, 'RELAY_KEY', '--run-secret', { stdin: 'relay-key-value\n' })
    expect(set.exitCode, set.stderr).toBe(0)
    expect((await yaac('config', 'env', NAME)).stdout).toMatch(/Run secrets in cl-steps:\n {2}RELAY_KEY {2}\*{8}/)

    const stepsFile = await graphFile('relay-ci', { check: { run: 'test "$RELAY_KEY" = "relay-key-value"' } })
    const made = await yaac('workflow', 'create', NAME, 'relay', '--file', stepsFile, '--secret', 'RELAY_KEY')
    expect(made.exitCode, made.stderr).toBe(0)
    expect(made.stdout).toContain('workflow "relay" (check), given RELAY_KEY')
    expect((await yaac('workflow', 'list', NAME)).stdout).toMatch(/relay\s+check\s+-\s+-\s+RELAY_KEY/)
    // Secrets go only with the graph they reach.
    expect((await yaac('workflow', 'edit', NAME, 'relay', '--secret', 'RELAY_KEY')).stderr).toContain('carries its whole graph')

    // No person has run it yet, so an agent's launch is refused; the agent
    // never sees the value either way.
    const refused = await mamaStep(workspaceId, 'mama-workflow',
      'yaac-mama workflow list',
      `yaac-mama create --non-interactive --workflow relay --repo ${NAME}@${head}; echo "refused=$?"`,
      'echo "key=[${RELAY_KEY:-}]"')
    expect(refused).toMatch(/relay\s+steps check {2}run secrets RELAY_KEY/)
    expect(refused).toContain('no person has run it')
    expect(refused).toContain('refused=1')
    expect(refused).toContain('key=[]')

    // A person's routine at the commit approves it, and its run gets the value.
    const routine = await yaac('routine', 'create', NAME, '--name', 'Relay CI', '--cron', '@yearly',
      '--non-interactive', '--workflow', 'relay', '--repo', `${NAME}@${head}`)
    expect(routine.exitCode, routine.stderr).toBe(0)
    const routineId = /Created routine (\S+) /.exec(routine.stdout)![1]
    const ran = await yaac('routine', 'run', routineId)
    const runId = /Started workspace (\S+) /.exec(ran.stdout)![1]
    await vi.waitFor(async () => expect((await stopped(runId))?.stepsOutcome).toBe('succeeded'), { timeout: 60_000, interval: 500 })
    expect((await yaac('workflow', 'show', NAME, 'relay')).stdout).toContain(`approved commits   ${head.slice(0, 12)}`)

    // Now an agent may launch it there too.
    const allowed = await mamaStep(workspaceId, 'mama-workflow-2',
      `yaac-mama create --non-interactive --workflow relay --repo ${NAME}@${head} --wait; echo "exit=$?"`)
    expect(allowed).toContain('exit=0')

    // Each repo of a launch of two is checked on its own: lib's commit is
    // no person's yet, so an agent's launch of both is refused, until a
    // person runs both commits by hand.
    const both = ['--repo', `${NAME}@${head}`, '--repo', `lib@${libHead}`]
    const twoRefused = await mamaStep(workspaceId, 'mama-two',
      `yaac-mama create --non-interactive --workflow relay ${both.join(' ')}; echo "refused=$?"`)
    expect(twoRefused).toContain(`no person has run it on lib@${libHead.slice(0, 12)}`)
    expect(twoRefused).toContain('refused=1')
    const byHand = await yaac('workspace', 'create', NAME, '--non-interactive', '--workflow', 'relay', ...both, '--wait')
    expect(byHand.exitCode, byHand.stderr).toBe(0)
    const twoAllowed = await mamaStep(workspaceId, 'mama-two-2',
      `yaac-mama create --non-interactive --workflow relay ${both.join(' ')} --wait; echo "exit=$?"`)
    expect(twoAllowed).toContain('exit=0')

    // A routine runs it, so it stays; it can lose its secrets.
    expect((await yaac('workflow', 'delete', NAME, 'relay')).stderr).toContain('is run by routine')
    expect((await yaac('workflow', 'edit', NAME, 'relay', '--no-secrets')).stdout).toContain('workflow "relay" (check).')
    expect((await yaac('routine', 'delete', routineId)).exitCode).toBe(0)
    expect((await yaac('workflow', 'delete', NAME, 'relay')).stdout).toContain('Deleted workflow "relay"')
    expect((await yaac('config', 'env', NAME, '--unset', 'RELAY_KEY')).stdout).toContain('Removed run secret RELAY_KEY')
  }, 300_000)

  it('adds a named workflow\'s steps to a running workspace, from the CLI and from an agent', async () => {
    expect((await yaac('workflow', 'create', NAME, 'hello', '--file', await graphFile('hello', { hello: { run: 'echo hello-from-a-workflow' } }))).exitCode).toBe(0)
    expect((await yaac('workspace', 'step', 'add', workspaceId, '--workflow', 'hello')).stdout.trim()).toBe('hello.hello')
    await vi.waitFor(async () => expect((await stepStates(workspaceId))['hello.hello']).toBe('succeeded 0'), { timeout: 30_000, interval: 500 })
    // Once a life: adding it again is refused.
    expect((await yaac('workspace', 'step', 'add', workspaceId, '--workflow', 'hello')).stderr).toContain('already runs in this workspace')
    // An agent adds one through yaac-mama, from a step of its own workspace.
    expect((await yaac('workflow', 'create', NAME, 'from-agent', '--file', await graphFile('from-agent', { 'from-agent': { run: 'echo added-by-an-agent' } }))).exitCode).toBe(0)
    const addedByAgent = await mamaStep(workspaceId, 'mama-add-workflow',
      'yaac-mama create --workspace "$YAAC_WORKSPACE_ID" --workflow from-agent --title x; echo "refused=$?"',
      'yaac-mama create --workspace "$YAAC_WORKSPACE_ID" --workflow from-agent')
    expect(addedByAgent).toContain('does not take --title')
    expect(addedByAgent).toContain('refused=1')
    expect(addedByAgent).toMatch(/^from-agent\.from-agent$/m)
    await vi.waitFor(async () => expect((await stepStates(workspaceId))['from-agent.from-agent']).toBe('succeeded 0'), { timeout: 30_000, interval: 500 })
    for (const name of ['from-agent', 'hello']) expect((await yaac('workflow', 'delete', NAME, name)).exitCode).toBe(0)
  }, 120_000)

  it('gives workflows repos and marks init workflows, which start in each workspace that has their repos', async () => {
    const where = { where: { run: 'pwd' } }
    // --repo and --init on create; --repo, --no-repos, --init and --no-init
    // on edit; list and show say both.
    const web = await yaac('workflow', 'create', NAME, 'web-init', '--file', await graphFile('where', where), '--repo', NAME, '--init')
    expect(web.exitCode, web.stderr).toBe(0)
    expect(web.stdout).toContain(`workflow "web-init" (where), in ${NAME}, an init workflow`)
    expect((await yaac('workflow', 'create', NAME, 'lib-init', '--file', await graphFile('where', where))).exitCode).toBe(0)
    expect((await yaac('workflow', 'edit', NAME, 'lib-init', '--repo', NAME)).stdout).toContain(`in ${NAME}.`)
    expect((await yaac('workflow', 'edit', NAME, 'lib-init', '--no-repos')).stdout).toContain('workflow "lib-init" (where).')
    expect((await yaac('workflow', 'edit', NAME, 'lib-init', '--repo', 'lib', '--init')).stdout).toContain('in lib, an init workflow')
    expect((await yaac('workflow', 'edit', NAME, 'lib-init', '--no-init')).stdout).not.toContain('an init workflow')
    expect((await yaac('workflow', 'edit', NAME, 'lib-init', '--repo', 'lib', '--no-repos')).stderr).toContain('not both')
    expect((await yaac('workflow', 'list', NAME)).stdout).toMatch(new RegExp(`web-init\\s+where\\s+${NAME}\\s+yes\\s+-`))
    expect((await yaac('workflow', 'show', NAME, 'lib-init')).stdout).toMatch(/repos\s+lib\n\s+init\s+no/)

    // config init-workflows sets the whole list, prints it, and --none
    // clears it.
    const setList = await yaac('config', 'init-workflows', NAME, 'web-init', 'lib-init')
    expect(setList.exitCode, setList.stderr).toBe(0)
    expect(setList.stdout).toContain('are now: lib-init, web-init')
    const printed = await yaac('config', 'init-workflows', NAME)
    expect(printed.stdout).toContain(`web-init  repos ${NAME}`)
    expect(printed.stdout).toContain('lib-init  repos lib')
    expect((await yaac('config', 'show', NAME)).stdout).toMatch(new RegExp(`init-workflows\\s+lib-init \\(lib\\), web-init \\(${NAME}\\)`))

    // A workspace of both repos starts both, each in its own repo's checkout.
    const two = await create({ noSession: true, repos: [{ repo: NAME }, { repo: 'lib' }] })
    await vi.waitFor(async () => {
      expect(await stepStates(two)).toEqual({ 'web-init.where': 'succeeded 0', 'lib-init.where': 'succeeded 0' })
    }, { timeout: 60_000, interval: 500 })
    const dir = containerlessWorkspacePaths(containerlessJobName(projectId, two)).workspaceDir
    expect((await yaac('workspace', 'logs', two, 'web-init.where')).stdout.trim()).toBe(path.join(dir, NAME))
    expect((await yaac('workspace', 'logs', two, 'lib-init.where')).stdout.trim()).toBe(path.join(dir, 'lib'))
    // A bare name two workflows have is refused, naming both.
    expect((await yaac('workspace', 'logs', two, 'where')).stderr).toContain('web-init.where')
    // A step added with --repo runs in that checkout.
    const added = await addStep(two, '--run', 'pwd', '--repo', 'lib')
    expect((await yaac('workspace', 'logs', two, added)).stdout.trim()).toBe(path.join(dir, 'lib'))
    await yaac('workspace', 'stop', two)

    // A workspace of one starts only its own, saying the other was skipped,
    // and a launch naming the other is refused for lack of its repo.
    const res = await api('/workspace/create', { method: 'POST', body: JSON.stringify({ project: projectId, noSession: true, repos: [{ repo: NAME }] }) })
    const progress: string[] = []
    const one = (await consumeNdjsonStream<{ workspaceId: string }>(res, (e) => { progress.push(JSON.stringify(e)) })).workspaceId
    expect(progress.join('\n')).toContain('Init workflow \\"lib-init\\" skipped: this workspace has no lib')
    await vi.waitFor(async () => expect(await stepStates(one)).toEqual({ 'web-init.where': 'succeeded 0' }), { timeout: 60_000, interval: 500 })
    await yaac('workspace', 'stop', one)
    const named = await yaac('workspace', 'create', NAME, '--no-session', '--repo', NAME, '--workflow', 'lib-init')
    expect(named.stderr).toContain('workflow "lib-init" runs in lib')
    expect((await yaac('workspace', 'step', 'add', workspaceId, '--run', 'true', '--repo', 'lib')).stderr).toContain('runs in lib')

    // An unlinked repo would leave its workflows nowhere to run.
    expect((await yaac('project', 'repo', 'remove', NAME, 'lib')).stderr).toContain('workflow "lib-init"')

    // --none clears the list; init is the project's again.
    expect((await yaac('config', 'init-workflows', NAME, '--none')).stdout).toContain('are now: none')
    expect((await yaac('config', 'init-workflows', NAME)).stdout).toContain('has no init workflows')
    expect((await yaac('config', 'init-workflows', NAME, 'init')).stdout).toContain('are now: init')
    for (const name of ['web-init', 'lib-init']) expect((await yaac('workflow', 'delete', NAME, name)).exitCode).toBe(0)
  }, 240_000)

  it('keeps every log after the workspace stops', async () => {
    const stop = await yaac('workspace', 'stop', workspaceId)
    expect(stop.exitCode, stop.stderr).toBe(0)
    await vi.waitFor(async () => expect(await stopped(workspaceId)).toBeDefined(), { timeout: 30_000, interval: 500 })
    expect((await yaac('workspace', 'logs', workspaceId, 'init.prep')).stdout).toContain('prep-out')
    expect((await yaac('workspace', 'logs', workspaceId, 'init.after-flaky')).stdout).toContain('after-flaky-ran')
  }, 60_000)

  it('runs a non-interactive workspace untouched at a commit, records its outcome, stops it, and reruns it', async () => {
    const head = (await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim()
    const id = await create({
      nonInteractive: true,
      repos: [{ repo: NAME, commit: head }],
      nested: false,
      steps: { test: { run: ['sleep 3', 'echo ci-out', 'exit 1'] } },
    })
    // Nothing may change it while it runs: no terminal, no step, no session,
    // and no restart.
    expect((await api(`/workspace/${id}/terminals`, { method: 'POST' })).status).toBe(409)
    expect((await api(`/workspace/${id}/steps`, { method: 'POST', body: JSON.stringify({ steps: { x: { run: 'true' } } }) })).status).toBe(409)
    expect((await api(`/workspace/${id}/sessions`, { method: 'POST', body: JSON.stringify({ tool: 'claude' }) })).status).toBe(409)
    expect((await listed(id))?.repos[0]?.startCommit).toBe(head)

    const entry = await vi.waitFor(async () => {
      const e = await stopped(id)
      expect(e?.stepsOutcome).toBe('failed')
      return e!
    }, { timeout: 60_000, interval: 500 })
    expect(entry.nonInteractive).toBe(true)
    // Its graph is a workflow named `_steps`.
    const test = await logged(id, 'test')
    expect(test).toBe('_steps.test')
    expect((await yaac('workspace', 'logs', id, test)).stdout).toContain('ci-out')
    expect((await api('/workspace/restart', { method: 'POST', body: JSON.stringify({ workspaceId: id }) })).status).toBe(409)

    // A rerun is a new workspace at the same commit, linked to the first.
    const again = await provisioned('/workspace/rerun', { workspaceId: id })
    expect(again).not.toBe(id)
    await vi.waitFor(async () => expect((await stopped(again))?.stepsOutcome).toBe('failed'), { timeout: 60_000, interval: 500 })
    expect((await stopped(again))?.rerunOf).toBe(id)

    // An interactive rerun runs the same graph, under the same name, in a
    // workspace that stays up.
    const debug = await provisioned('/workspace/rerun', { workspaceId: id, interactive: true })
    await vi.waitFor(async () => {
      expect(await stepStates(debug)).toEqual({ [test]: 'failed 1' })
    }, { timeout: 60_000, interval: 500 })
    const stillUp = await listed(debug)
    expect(stillUp?.nonInteractive).toBeUndefined()
    expect(stillUp?.repos[0]?.startCommit).toBe(head)
    // yaac-mama shows the commit each workspace made at one is pinned to,
    // running or stopped; one on a branch shows none.
    const listing = await mamaStep(debug, 'mama-list', 'yaac-mama list', 'yaac-mama list --stopped')
    const pinned = (short: string): RegExp => new RegExp(`^${short}( \\(you\\))?\\s.*\\b${head.slice(0, 12)}\\b`, 'm')
    expect(listing).toMatch(/\bCOMMIT\b/)
    expect(listing).toMatch(pinned(debug.slice(0, 8)))
    expect(listing).toMatch(pinned(id.slice(0, 8)))
    expect(listing).toMatch(new RegExp(`^${workspaceId.slice(0, 8)}\\s`, 'm'))
    expect(listing).not.toMatch(pinned(workspaceId.slice(0, 8)))
    await yaac('workspace', 'stop', debug)
  }, 240_000)
})

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
 * Workspace steps end to end on the containerless driver
 * (docs/workspace-steps.md): the real CLI against a real server running
 * workspaces as tmux sessions on this host. One server and project for the
 * file; the interactive workspace is shared by the cases that read it, and
 * the non-interactive cases, which stop their subjects, run last.
 *
 * Every workspace here opens no session, so no agent is staged.
 */

let testEnv: YaacTestEnv
let server: SpawnedServer
let serverEnv: NodeJS.ProcessEnv
let repoPath: string
let projectId: string
/** The shared interactive workspace, started on the project's init steps. */
let workspaceId: string
/** A terminal opened in it, whose log only its owner may read. */
let terminalName: string

const NAME = 'cl-steps'
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
 * Run `yaac-mama` inside a running workspace as a step of its own, which is
 * where an agent's call comes from, and answer what the step printed.
 */
async function mamaStep(id: string, name: string, ...commands: string[]): Promise<string> {
  const added = await yaac('workspace', 'step', 'add', id, '--name', name, ...commands.flatMap((c) => ['--run', c]))
  expect(added.exitCode, added.stderr).toBe(0)
  await vi.waitFor(async () => {
    expect((await stepStates(id))[name]).toBe('succeeded 0')
  }, { timeout: 30_000, interval: 500 })
  return (await yaac('workspace', 'logs', id, name)).stdout
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

  // The project's init steps, set as a user would: a parallel branch, a
  // failure and what it blocks, and a service gated on its ready check.
  const file = path.join(testEnv.scratchDir, 'init-steps.json')
  await fs.writeFile(file, JSON.stringify({
    prep: { run: ['echo prep-out', 'printf ok > prep.txt'] },
    flaky: { run: 'test -f fixed.txt || { echo failing; exit 3; }' },
    'after-flaky': { run: 'echo after-flaky-ran', needs: ['flaky'] },
    svc: { run: ['sleep 1', 'touch svc.ready', 'exec sleep 600'], service: true, ready: 'test -f svc.ready' },
    gated: { run: 'cat prep.txt; echo " gated-ran"', needs: ['prep', 'svc'] },
  }))
  const set = await yaac('config', 'init-steps', NAME, '--file', file)
  expect(set.exitCode, set.stderr).toBe(0)
  workspaceId = await create({ noSession: true })
}, 120_000)

afterAll(async () => {
  if (!CAN_RUN) return
  await server?.stop()
  await testEnv?.cleanup()
})

describe.skipIf(!CAN_RUN)('workspace steps (containerless)', () => {
  it('runs the project\'s init steps as a graph: in parallel, after their needs, skipping what a failure blocks', async () => {
    await vi.waitFor(async () => {
      expect(await stepStates(workspaceId)).toEqual({
        prep: 'succeeded 0',
        flaky: 'failed 3',
        'after-flaky': 'skipped',
        svc: 'ready',
        gated: 'succeeded 0',
      })
    }, { timeout: 60_000, interval: 500 })
    // A step's window is not a terminal tab, but the webapp can open it.
    const entry = await listed(workspaceId)
    expect(entry?.terminals?.map((t) => t.name)).toEqual([])
    expect(entry?.steps?.find((s) => s.name === 'svc')?.target).toMatch(/^window:@\d+$/)
    // Each step's output is in its log.
    const logs = await yaac('workspace', 'logs', workspaceId, 'gated')
    expect(logs.stdout).toContain('ok gated-ran')
  }, 90_000)

  it('logs a terminal opened in the workspace, and runs a step added to it once its needs are met', async () => {
    const term = await (await api(`/workspace/${workspaceId}/terminals`, { method: 'POST' })).json() as { name: string }
    terminalName = term.name
    await tmux(workspaceId, 'send-keys', '-t', `=yaac:=${term.name}`, 'echo hello-from-a-terminal', 'Enter')
    await vi.waitFor(async () => {
      expect((await yaac('workspace', 'logs', workspaceId, term.name)).stdout).toContain('hello-from-a-terminal')
    }, { timeout: 20_000, interval: 500 })

    const added = await yaac('workspace', 'step', 'add', workspaceId, '--run', 'echo "added-$((1 + 1))"', '--name', 'added', '--needs', 'gated')
    expect(added.exitCode, added.stderr).toBe(0)
    await vi.waitFor(async () => {
      expect((await stepStates(workspaceId)).added).toBe('succeeded 0')
    }, { timeout: 20_000, interval: 500 })
    expect((await yaac('workspace', 'logs', workspaceId, 'added')).stdout).toContain('added-2')
  }, 60_000)

  it('reads its steps\' logs through yaac-mama, but not a terminal\'s', async () => {
    const out = await mamaStep(workspaceId, 'mama-logs',
      'yaac-mama logs "$YAAC_WORKSPACE_ID"',
      'echo "<tail>"; yaac-mama logs "$YAAC_WORKSPACE_ID" gated --tail 1; echo "</tail>"',
      `yaac-mama logs "$YAAC_WORKSPACE_ID" ${terminalName}; echo "refused=$?"`)
    expect(out).toMatch(/^gated\s+succeeded\s+0\s+prep,svc\s+\d+ B$/m)
    expect(out).toMatch(/^svc\s+ready \(service\)\s+\d+ B$/m)
    expect(out).toMatch(/^flaky\s+failed\s+3\s+\d+ B$/m)
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
      expect(await stepStates(workspaceId)).toMatchObject({ flaky: 'succeeded 0', 'after-flaky': 'succeeded 0' })
    }, { timeout: 30_000, interval: 500 })
  }, 60_000)

  it('gives a workflow\'s run secret only on a commit a person ran it on, through the CLI and yaac-mama', async () => {
    const head = (await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim()
    const set = await runYaac(serverEnv, 'config', 'env', NAME, 'RELAY_KEY', '--run-secret', { stdin: 'relay-key-value\n' })
    expect(set.exitCode, set.stderr).toBe(0)
    expect((await yaac('config', 'env', NAME)).stdout).toMatch(/Run secrets in cl-steps:\n {2}RELAY_KEY {2}\*{8}/)

    const stepsFile = path.join(testEnv.scratchDir, 'relay-ci.json')
    await fs.writeFile(stepsFile, JSON.stringify({ check: { run: 'test "$RELAY_KEY" = "relay-key-value"' } }))
    const made = await yaac('workflow', 'create', NAME, 'relay', '--file', stepsFile, '--secret', 'RELAY_KEY')
    expect(made.exitCode, made.stderr).toBe(0)
    expect(made.stdout).toContain('workflow "relay" (check), given RELAY_KEY')
    expect((await yaac('workflow', 'list', NAME)).stdout).toMatch(/relay\s+check\s+RELAY_KEY/)
    // Secrets go only with the graph they reach.
    expect((await yaac('workflow', 'edit', NAME, 'relay', '--secret', 'RELAY_KEY')).stderr).toContain('carries its whole graph')

    // No person has run it yet, so an agent's launch is refused; the agent
    // never sees the value either way.
    const refused = await mamaStep(workspaceId, 'mama-workflow',
      'yaac-mama workflow list',
      `yaac-mama create --non-interactive --workflow relay --commit ${head}; echo "refused=$?"`,
      'echo "key=[${RELAY_KEY:-}]"')
    expect(refused).toMatch(/relay\s+steps check {2}run secrets RELAY_KEY/)
    expect(refused).toContain('no person has run it')
    expect(refused).toContain('refused=1')
    expect(refused).toContain('key=[]')

    // A person's routine at the commit approves it, and its run gets the value.
    const routine = await yaac('routine', 'create', NAME, '--name', 'Relay CI', '--cron', '@yearly',
      '--non-interactive', '--workflow', 'relay', '--commit', head)
    expect(routine.exitCode, routine.stderr).toBe(0)
    const routineId = /Created routine (\S+) /.exec(routine.stdout)![1]
    const ran = await yaac('routine', 'run', routineId)
    const runId = /Started workspace (\S+) /.exec(ran.stdout)![1]
    await vi.waitFor(async () => expect((await stopped(runId))?.stepsOutcome).toBe('succeeded'), { timeout: 60_000, interval: 500 })
    expect((await yaac('workflow', 'show', NAME, 'relay')).stdout).toContain(`approved commits   ${head.slice(0, 12)}`)

    // Now an agent may launch it there too, and a person by hand at a branch.
    const allowed = await mamaStep(workspaceId, 'mama-workflow-2',
      `yaac-mama create --non-interactive --workflow relay --commit ${head} --wait; echo "exit=$?"`)
    expect(allowed).toContain('exit=0')
    const byHand = await yaac('workspace', 'create', NAME, '--non-interactive', '--workflow', 'relay', '--wait')
    expect(byHand.exitCode, byHand.stderr).toBe(0)

    // A named workflow's steps can be added to a running workspace, and the
    // project's init steps can follow one.
    const helloFile = path.join(testEnv.scratchDir, 'hello.json')
    await fs.writeFile(helloFile, JSON.stringify({ hello: { run: 'echo hello-from-a-workflow' } }))
    expect((await yaac('workflow', 'create', NAME, 'hello', '--file', helloFile)).exitCode).toBe(0)
    expect((await yaac('workspace', 'step', 'add', workspaceId, '--workflow', 'hello')).stdout.trim()).toBe('hello')
    await vi.waitFor(async () => expect((await stepStates(workspaceId)).hello).toBe('succeeded 0'), { timeout: 30_000, interval: 500 })
    // An agent adds one through yaac-mama, from a step of its own workspace.
    const agentFile = path.join(testEnv.scratchDir, 'from-agent.json')
    await fs.writeFile(agentFile, JSON.stringify({ 'from-agent': { run: 'echo added-by-an-agent' } }))
    expect((await yaac('workflow', 'create', NAME, 'from-agent', '--file', agentFile)).exitCode).toBe(0)
    const addedByAgent = await mamaStep(workspaceId, 'mama-add-workflow',
      'yaac-mama create --workspace "$YAAC_WORKSPACE_ID" --workflow from-agent --title x; echo "refused=$?"',
      'yaac-mama create --workspace "$YAAC_WORKSPACE_ID" --workflow from-agent')
    expect(addedByAgent).toContain('does not take --title')
    expect(addedByAgent).toContain('refused=1')
    expect(addedByAgent).toMatch(/^from-agent$/m)
    await vi.waitFor(async () => expect((await stepStates(workspaceId))['from-agent']).toBe('succeeded 0'), { timeout: 30_000, interval: 500 })
    expect((await yaac('workflow', 'delete', NAME, 'from-agent')).exitCode).toBe(0)
    expect((await yaac('config', 'init-steps', NAME, '--workflow', 'hello')).stdout).toContain('are now: hello')
    const shown = await yaac('config', 'init-steps', NAME)
    expect(shown.stderr).toContain('Following workflow "hello"')
    expect(JSON.parse(shown.stdout)).toEqual({ hello: { run: ['echo hello-from-a-workflow'] } })
    expect((await yaac('workflow', 'delete', NAME, 'hello')).stderr).toContain('init steps')
    expect((await yaac('config', 'init-steps', NAME, '--file', path.join(testEnv.scratchDir, 'init-steps.json'))).exitCode).toBe(0)
    expect((await yaac('workflow', 'delete', NAME, 'hello')).exitCode).toBe(0)

    // A routine runs it, so it stays; it can lose its secrets.
    expect((await yaac('workflow', 'delete', NAME, 'relay')).stderr).toContain('is run by routine')
    expect((await yaac('workflow', 'edit', NAME, 'relay', '--no-secrets')).stdout).toContain('workflow "relay" (check).')
    expect((await yaac('routine', 'delete', routineId)).exitCode).toBe(0)
    expect((await yaac('workflow', 'delete', NAME, 'relay')).stdout).toContain('Deleted workflow "relay"')
    expect((await yaac('config', 'env', NAME, '--unset', 'RELAY_KEY')).stdout).toContain('Removed run secret RELAY_KEY')
  }, 300_000)

  it('keeps every log after the workspace stops', async () => {
    const stop = await yaac('workspace', 'stop', workspaceId)
    expect(stop.exitCode, stop.stderr).toBe(0)
    await vi.waitFor(async () => expect(await stopped(workspaceId)).toBeDefined(), { timeout: 30_000, interval: 500 })
    expect((await yaac('workspace', 'logs', workspaceId, 'prep')).stdout).toContain('prep-out')
    expect((await yaac('workspace', 'logs', workspaceId, 'after-flaky')).stdout).toContain('after-flaky-ran')
  }, 60_000)

  it('runs a non-interactive workspace untouched at a commit, records its outcome, stops it, and reruns it', async () => {
    const head = (await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim()
    const id = await create({
      nonInteractive: true,
      commit: head,
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
    expect((await yaac('workspace', 'logs', id, 'test')).stdout).toContain('ci-out')
    expect((await api('/workspace/restart', { method: 'POST', body: JSON.stringify({ workspaceId: id }) })).status).toBe(409)

    // A rerun is a new workspace at the same commit, linked to the first.
    const again = await provisioned('/workspace/rerun', { workspaceId: id })
    expect(again).not.toBe(id)
    await vi.waitFor(async () => expect((await stopped(again))?.stepsOutcome).toBe('failed'), { timeout: 60_000, interval: 500 })
    expect((await stopped(again))?.rerunOf).toBe(id)

    // An interactive rerun runs the same graph in a workspace that stays up.
    const debug = await provisioned('/workspace/rerun', { workspaceId: id, interactive: true })
    await vi.waitFor(async () => {
      expect(await stepStates(debug)).toEqual({ test: 'failed 1' })
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

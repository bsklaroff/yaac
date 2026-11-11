import fs from 'node:fs/promises'
import { namedWorkflowFor } from '#test/support/workflows'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { addSteps, assertInteractive, cancelStep, onReleaseStepChanged, reconcileSteps, rerunStep } from '#domain/workspaces/steps'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import {
  BUILT_IN_USER_ID,
  applyWorkspaceEvent,
  claimVolume,
  getWorkspaceRow,
  insertRepo,
  insertSite,
  insertVolume,
  linkProjectRepo,
  listWorkspaceSteps,
  setWorkspaceVolume,
  storeWorkflow,
  updateSite,
  type LifeWorkflow,
} from '#db'
import { createWorkflow, editWorkflow, resolveWorkflow } from '#domain/projects'
import { recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { setWorkspaceWindows, _resetWorkspaceStatusStoreForTests } from '#runtime/status/status-store'
import { _clearTerminatingForTests } from '#runtime/status/terminating'
import { cleanupTempDir, createTempDataDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver } from '#test/support/fake-driver'
import { DEMO_PROJECT_ID, seedProject } from '@yaac/test-utils/project-fixture'
import { KEEPER_WINDOW, type RuntimeHandle, type RuntimeSnapshot, type WorkspaceWindow } from '#drivers/contract'
import { terminalLogDir } from '@yaac/shared/project-paths'
import { lifeDirName, parseStepGraph } from '@yaac/shared/steps'

const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const
const WS = 'w1'
const unit: RuntimeHandle = handleFixture({ projectId: DEMO_PROJECT_ID, workspaceId: WS, jobName: `yaac-${WS}` })

let tmpDir: string
let life: Date
/** Every command the workspace ran, in order. */
let execs: string[]

const view: RuntimeSnapshot = {
  resync: false,
  takenAtMs: 0,
  workspaces: () => Promise.resolve([unit]),
  strayUnits: () => Promise.resolve([]),
}

/** The windows the workspace's watcher lists: the keeper, then these. */
function listed(...windows: Array<Omit<WorkspaceWindow, 'id'>>): void {
  setWorkspaceWindows(DEMO_PROJECT_ID, WS, [{ name: KEEPER_WINDOW, dead: false }, ...windows]
    .map((w, i) => ({ id: `@${String(i)}`, ...w })))
}

/** The step windows the workspace has been asked to open, in order. */
const opened = (): string[] => execs.flatMap((c) => [...c.matchAll(/new-window -d -t yaac -n '([^']+)'/g)].map((m) => m[1]))

const states = async (): Promise<Record<string, string>> => Object.fromEntries((await listWorkspaceSteps(WS)).map((s) =>
  [s.workflowName === '' ? s.name : `${s.workflowName}.${s.name}`, s.exitCode !== undefined ? `${s.state} ${String(s.exitCode)}` : s.state]))

/** A second repo of the demo project, in folder `api`; the first is `demo`. */
const API_REPO = '0b6f4c2e-8a1d-4e3f-9b7c-5d2a1e0f3c4b'

/** A life of the workspace starting `flows`, its own workflow the first
 *  (as a create that brought it records), with `repos` its checkouts. */
async function startFlows(
  flows: Array<{ name: string; steps: Record<string, unknown>; repos?: string[] }>,
  row: { nonInteractive?: boolean; siteId?: string; repos?: Array<{ repoId: string; path: string }> } = {},
): Promise<LifeWorkflow[]> {
  const stored = await Promise.all(flows.map(async (f) => {
    const steps = parseStepGraph(f.steps, new Set(row.siteId !== undefined ? ['volume'] : []))
    return { id: (await storeWorkflow(DEMO_PROJECT_ID, { steps, secrets: [], repos: f.repos ?? [] })).id, name: f.name, steps }
  }))
  await recordWorkspaceCreated({
    projectId: DEMO_PROJECT_ID, workspaceId: WS, workflowId: stored[0].id, workflowName: stored[0].name, ...row,
  })
  life = new Date()
  await applyWorkspaceEvent({ type: 'workspace-life-started', projectId: DEMO_PROJECT_ID, workspaceId: WS, at: life, startSteps: stored })
  return stored
}

/** A life starting one workflow, `ci`. */
async function startLife(raw: Record<string, unknown>, row: { nonInteractive?: boolean; siteId?: string } = {}): Promise<void> {
  await startFlows([{ name: 'ci', steps: raw }], row)
}

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  _resetWorkspaceStatusStoreForTests()
  // A settled non-interactive workspace's stop marks it terminating.
  _clearTerminatingForTests()
  clearAllProvisioningForTests()
  execs = []
  installFakeWorkspaceDriver({
    find: (id) => Promise.resolve(id === WS ? unit : undefined),
    findForTeardown: (id) => Promise.resolve(id === WS ? { projectId: DEMO_PROJECT_ID, workspaceId: WS, unitName: unit.jobName } : undefined),
    exec: (_job, cmd) => {
      execs.push(cmd)
      return Promise.resolve({ stdout: '', stderr: '' })
    },
  })
  await seedProject()
})

afterEach(async () => {
  vi.useRealTimers()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A release of a site with a volume, staged as its next holder. */
async function release(): Promise<{ siteId: string; volumeId: string }> {
  const volume = await insertVolume(DEMO_PROJECT_ID, 'data', '10Gi')
  const site = await insertSite({
    projectId: DEMO_PROJECT_ID, repos: [{ repo: DEMO_PROJECT_ID, branch: 'main' }], follow: false, name: 'shop',
    hostname: 'shop.example.com', port: 3000, namedWorkflowId: await namedWorkflowFor(DEMO_PROJECT_ID), volumeId: volume.id,
  })
  await startLife({
    build: { run: 'pnpm build' },
    db: { run: 'postgres -D "$YAAC_VOLUME_DIR/pg"', service: true, needs: ['volume'] },
    app: { run: 'pnpm start', service: true, needs: ['build', 'db'] },
  }, { siteId: site.id })
  await setWorkspaceVolume(WS, volume.id)
  return { siteId: site.id, volumeId: volume.id }
}

describe('reconcileSteps', () => {
  it('runs the graph: opens steps as their needs are met, records how each ends, and skips what a failure blocks', async () => {
    await startLife({
      install: { run: 'pnpm install' },
      db: { run: ['initdb', 'postgres'], service: true, ready: 'pg_isready' },
      build: { run: ['pnpm build', 'pnpm build:docs'], needs: ['install'] },
      server: { run: 'pnpm start', service: true, needs: ['build', 'db'] },
      lint: { run: 'pnpm lint', needs: ['install'] },
    })

    // Nothing opens before the create's setup has renamed the keeper.
    setWorkspaceWindows(DEMO_PROJECT_ID, WS, [])
    await reconcileSteps(view)
    expect(opened()).toEqual([])

    listed()
    await reconcileSteps(view)
    expect(opened()).toEqual(['ci.install', 'ci.db'])
    expect(await states()).toMatchObject({ 'ci.install': 'running', 'ci.db': 'running', 'ci.build': 'pending', 'ci.server': 'pending' })
    // Each step's script is written into its life's log dir under its full
    // name, which the workspace sees at its terminal log path. The script
    // keeps its own pane on exit, and no command targets its window by a
    // name holding a ".", which tmux would read as a pane.
    const dir = path.join(terminalLogDir(DEMO_PROJECT_ID, WS), lifeDirName(life))
    const script = await fs.readFile(path.join(dir, 'ci.db.sh'), 'utf8')
    expect(script).toMatch(/remain-on-exit on[\s\S]*initdb[\s\S]*until pg_isready[\s\S]*postgres/)
    expect(execs.find((c) => c.includes("-n 'ci.db'"))).toContain(`/home/yaac/.yaac-logs/${lifeDirName(life)}/ci.db.sh`)
    expect(execs.join('\n')).not.toMatch(/-t =yaac:=ci\./)

    // install exits 0 and db's ready check passes: build and lint start,
    // server still waits on build.
    listed({ name: 'ci.install', dead: true, exitStatus: 0 }, { name: 'ci.db', dead: false, ready: true })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({
      'ci.install': 'succeeded 0', 'ci.db': 'ready', 'ci.build': 'running', 'ci.lint': 'running', 'ci.server': 'pending',
    })

    // build fails, so server, which needs it, is skipped; lint is not
    // affected.
    listed({ name: 'ci.install', dead: true, exitStatus: 0 }, { name: 'ci.db', dead: false, ready: true },
      { name: 'ci.build', dead: true, exitStatus: 2 }, { name: 'ci.lint', dead: false })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ 'ci.build': 'failed 2', 'ci.server': 'skipped', 'ci.lint': 'running' })

    // A link the workspace planted where a script goes is replaced, never
    // written through.
    const victim = path.join(tmpDir, 'victim.txt')
    await fs.writeFile(victim, 'untouched')
    await fs.symlink(victim, path.join(dir, 'alias.gated.sh'))
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'alias', steps: { gated: { run: 'echo hi' } } })
    await addSteps(local, WS, { workflow: 'alias' })
    expect(await fs.readFile(victim, 'utf8')).toBe('untouched')
    expect((await fs.lstat(path.join(dir, 'alias.gated.sh'))).isSymbolicLink()).toBe(false)

    // A service that exits, even with 0, has failed.
    listed({ name: 'ci.install', dead: true, exitStatus: 0 }, { name: 'ci.db', dead: true, exitStatus: 0 },
      { name: 'ci.build', dead: true, exitStatus: 2 }, { name: 'ci.lint', dead: false })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ 'ci.db': 'failed 0' })
  })

  it('runs two workflows side by side, a step of each under its own window and log, one waiting on the other', async () => {
    await startFlows([
      { name: 'web-init', steps: { install: { run: 'pnpm install' }, serve: { run: 'pnpm dev', needs: ['install', 'api-init.migrate'] } } },
      { name: 'api-init', steps: { install: { run: 'pip install' }, migrate: { run: 'alembic upgrade', needs: ['install'] } } },
    ])
    listed()
    await reconcileSteps(view)
    expect(opened()).toEqual(['web-init.install', 'api-init.install'])
    const dir = path.join(terminalLogDir(DEMO_PROJECT_ID, WS), lifeDirName(life))
    expect(await fs.readFile(path.join(dir, 'web-init.install.sh'), 'utf8')).toContain('pnpm install')
    expect(await fs.readFile(path.join(dir, 'api-init.install.sh'), 'utf8')).toContain('pip install')

    // web's serve waits on api's migrate as well as its own install, and is
    // skipped when migrate fails.
    listed({ name: 'web-init.install', dead: true, exitStatus: 0 }, { name: 'api-init.install', dead: true, exitStatus: 0 })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ 'web-init.serve': 'pending', 'api-init.migrate': 'running' })
    listed({ name: 'web-init.install', dead: true, exitStatus: 0 }, { name: 'api-init.install', dead: true, exitStatus: 0 },
      { name: 'api-init.migrate', dead: true, exitStatus: 1 })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ 'web-init.serve': 'skipped', 'api-init.migrate': 'failed 1' })

    // A bare name addresses a step only while one workflow has it.
    await expect(rerunStep(local, WS, 'install')).rejects.toThrow('web-init.install, api-init.install')
    expect(await rerunStep(local, WS, 'migrate')).toMatchObject({ name: 'api-init.migrate', workflow: 'api-init' })
  })

  it('finds a step of a life from before steps had workflows under its bare window', async () => {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: WS })
    life = new Date()
    await applyWorkspaceEvent({
      type: 'workspace-life-started', projectId: DEMO_PROJECT_ID, workspaceId: WS, at: life,
      startSteps: [{ id: (await storeWorkflow(DEMO_PROJECT_ID, { steps: {}, secrets: [] })).id, name: '', steps: parseStepGraph({ build: { run: 'make' } }) }],
    })
    listed()
    await reconcileSteps(view)
    expect(opened()).toEqual(['build'])
    listed({ name: 'build', dead: true, exitStatus: 0 })
    await reconcileSteps(view)
    expect(await states()).toEqual({ build: 'succeeded 0' })
    // A step added beside it may need it by its bare name.
    const [step] = await addSteps(local, WS, { steps: { test: { run: 'make test', needs: ['build'] } } })
    await reconcileSteps(view)
    expect(opened()).toEqual(['build', step.name])
  })

  it('stops a non-interactive workspace once the steps that are not services settle, recording its outcome', async () => {
    await startLife({
      db: { run: 'postgres', service: true },
      test: { run: 'pnpm test', needs: ['db'] },
    }, { nonInteractive: true })
    listed()
    await reconcileSteps(view)
    listed({ name: 'ci.db', dead: false, ready: true })
    await reconcileSteps(view)
    expect(opened()).toEqual(['ci.db', 'ci.test'])
    // Nobody may change it while it runs.
    await expect(assertInteractive(WS)).rejects.toMatchObject({ code: 'CONFLICT' })

    listed({ name: 'ci.db', dead: false, ready: true }, { name: 'ci.test', dead: true, exitStatus: 0 })
    await reconcileSteps(view)
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, WS))?.stepsOutcome).toBe('succeeded')
    await expect.poll(async () => (await getWorkspaceRow(DEMO_PROJECT_ID, WS))?.stoppedAt).toBeInstanceOf(Date)
    // Settled, it is no longer locked.
    await expect(assertInteractive(WS)).resolves.toBeUndefined()
  })

  it('holds the steps that need the volume until it holds the lease, telling only them where it is', async () => {
    const { volumeId } = await release()
    listed()
    await reconcileSteps(view)
    expect(opened()).toEqual(['ci.build'])
    expect(await states()).toMatchObject({ 'ci.build': 'running', 'ci.db': 'pending', 'ci.app': 'pending' })

    await claimVolume(volumeId, WS)
    listed({ name: 'ci.build', dead: true, exitStatus: 0 })
    await reconcileSteps(view)
    expect(opened()).toEqual(['ci.build', 'ci.db'])
    const dir = path.join(terminalLogDir(DEMO_PROJECT_ID, WS), lifeDirName(life))
    expect(await fs.readFile(path.join(dir, 'ci.db.sh'), 'utf8')).toContain("export YAAC_VOLUME_DIR='/home/yaac/volume'")
    expect(await fs.readFile(path.join(dir, 'ci.build.sh'), 'utf8')).not.toContain('YAAC_VOLUME_DIR')
  })

  it('restarts the serving release\'s service that exits, after a backoff and keeping its log, and fails a deploy\'s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { siteId, volumeId } = await release()
    await claimVolume(volumeId, WS)
    await updateSite(siteId, { liveWorkspaceId: WS })
    listed()
    await reconcileSteps(view)
    listed({ name: 'ci.build', dead: true, exitStatus: 0 }, { name: 'ci.db', dead: false, ready: true })
    await reconcileSteps(view)
    listed({ name: 'ci.build', dead: true, exitStatus: 0 }, { name: 'ci.db', dead: false, ready: true }, { name: 'ci.app', dead: false, ready: true })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ 'ci.db': 'ready', 'ci.app': 'ready' })
    const dir = path.join(terminalLogDir(DEMO_PROJECT_ID, WS), lifeDirName(life))
    await fs.writeFile(path.join(dir, 'ci.db.log'), 'the crash\n')
    execs = []

    // Serving: it goes back to pending, its dependents untouched, and opens
    // again once the backoff is over, with its log kept.
    listed({ name: 'ci.build', dead: true, exitStatus: 0 }, { name: 'ci.db', dead: true, exitStatus: 1 }, { name: 'ci.app', dead: false, ready: true })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ 'ci.db': 'pending', 'ci.app': 'ready' })
    expect(opened()).toEqual([])
    vi.setSystemTime(Date.now() + 1500)
    listed({ name: 'ci.build', dead: true, exitStatus: 0 }, { name: 'ci.app', dead: false, ready: true })
    await reconcileSteps(view)
    expect(opened()).toEqual(['ci.db'])
    expect(await fs.readFile(path.join(dir, 'ci.db.log'), 'utf8')).toBe('the crash\n')

    // Not serving (a deploy's new release): a service that exits fails.
    await updateSite(siteId, { liveWorkspaceId: 'another' })
    listed({ name: 'ci.build', dead: true, exitStatus: 0 }, { name: 'ci.db', dead: true, exitStatus: 1 }, { name: 'ci.app', dead: false, ready: true })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ 'ci.db': 'failed 1' })
  })
})

describe('onReleaseStepChanged', () => {
  it("fires when a site release's step changes state, so a deploy waiting on it can flip", async () => {
    const changed = vi.fn()
    onReleaseStepChanged(changed)
    const { volumeId } = await release()
    await claimVolume(volumeId, WS)
    listed()
    await reconcileSteps(view)
    changed.mockClear()

    listed({ name: 'ci.build', dead: true, exitStatus: 0 })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ 'ci.build': 'succeeded 0' })
    expect(changed).toHaveBeenCalled()
  })

  it('stays quiet for a workspace that is not a release', async () => {
    const changed = vi.fn()
    onReleaseStepChanged(changed)
    await startLife({ install: { run: 'pnpm install' } })
    listed()
    await reconcileSteps(view)
    listed({ name: 'ci.install', dead: true, exitStatus: 0 })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ 'ci.install': 'succeeded 0' })
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('addSteps', () => {
  it('adds steps that run once, each a workflow of its own, after the steps they need, refusing a bad graph', async () => {
    await startLife({ install: { run: 'pnpm install' } })
    listed()
    await reconcileSteps(view)

    // An anonymous add is named `_added-N`, and a bare need on a step of
    // the life is stored in full.
    const [e2e] = await addSteps(local, WS, { steps: { e2e: { run: ['pnpm build', 'pnpm e2e'], needs: ['install'] } } })
    expect(e2e).toMatchObject({ name: '_added-1.e2e', workflow: '_added-1', origin: 'added', state: 'pending', spec: { needs: ['ci.install'] } })
    listed({ name: 'ci.install', dead: true, exitStatus: 0 })
    await reconcileSteps(view)
    expect(opened()).toEqual(['ci.install', e2e.name])

    // Running the same command twice is two names for one stored workflow.
    const [again] = await addSteps(local, WS, { steps: { e2e: { run: ['pnpm build', 'pnpm e2e'], needs: ['install'] } } })
    expect(again.name).toBe('_added-2.e2e')
    const rows = await listWorkspaceSteps(WS)
    expect(rows.find((r) => `${r.workflowName}.${r.name}` === again.name)?.workflowId)
      .toBe(rows.find((r) => `${r.workflowName}.${r.name}` === e2e.name)?.workflowId)

    await expect(addSteps(local, WS, { steps: { x: { run: 'y', needs: ['nope'] } } })).rejects.toThrow('"nope", which is not a step')
    await expect(addSteps(local, WS, { steps: { x: { run: 'y', needs: ['other.step'] } } })).rejects.toThrow('not a step of this workspace')
    await expect(addSteps(local, WS, { steps: {} })).rejects.toMatchObject({ code: 'VALIDATION' })

    // A named workflow's steps, under its name and recording the workflow
    // it pointed at then, which an edit to it leaves; adding it twice to
    // one life is refused.
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'lint', steps: { lint: { run: 'pnpm lint' } } })
    const lint = (await resolveWorkflow(DEMO_PROJECT_ID, 'lint')).workflow.id
    expect(await addSteps(local, WS, { workflow: 'lint' })).toMatchObject([{ name: 'lint.lint', workflow: 'lint', origin: 'added' }])
    await expect(addSteps(local, WS, { workflow: 'lint' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await editWorkflow(local, DEMO_PROJECT_ID, 'lint', { steps: { lint: { run: 'pnpm lint --fix' } } })
    expect((await listWorkspaceSteps(WS)).find((r) => r.workflowName === 'lint'))
      .toMatchObject({ workflowId: lint, name: 'lint', spec: { run: ['pnpm lint'] } })

    // A bare need on a name two workflows have is refused.
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'other', steps: { install: { run: 'pip install' } } })
    await addSteps(local, WS, { workflow: 'other' })
    await expect(addSteps(local, WS, { steps: { x: { run: 'y', needs: ['install'] } } })).rejects.toThrow('ci.install, other.install')

    // A new life reruns the start steps but not an added one; one that had
    // not settled is interrupted.
    await applyWorkspaceEvent({
      type: 'workspace-life-started', projectId: DEMO_PROJECT_ID, workspaceId: WS, at: new Date(),
      startSteps: [{ id: lint, name: 'ci', steps: parseStepGraph({ install: { run: 'pnpm install' } }) }],
    })
    const after = await listWorkspaceSteps(WS)
    expect(after.filter((s) => s.origin === 'added').every((s) => s.state === 'interrupted')).toBe(true)
    expect(after.filter((s) => s.origin === 'start').map((s) => [s.workflowName, s.name, s.state])).toEqual([['ci', 'install', 'pending']])

    // A minted name never repeats in the workspace's history: two adds at
    // once take two numbers, and a new life goes on past every earlier one.
    const twins = await Promise.all([1, 2].map(() => addSteps(local, WS, { steps: { t: { run: 'true' } } })))
    expect(twins.map(([s]) => s.name).sort()).toEqual(['_added-3.t', '_added-4.t'])
  })

  it('starts a step in its repo\'s checkout, at the root for several, in the cwd for none; refused without the repo', async () => {
    await insertRepo({ id: API_REPO, owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/o/api.git' })
    await linkProjectRepo(DEMO_PROJECT_ID, API_REPO, 'api')
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'web', steps: { pwd: { run: 'pwd' } }, repos: ['demo'] })
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'both', steps: { pwd: { run: 'pwd' } }, repos: ['demo', 'api'] })
    await startFlows([{ name: 'ci', steps: { pwd: { run: 'pwd' } } }],
      { repos: [{ repoId: DEMO_PROJECT_ID, path: 'demo' }, { repoId: API_REPO, path: 'api' }] })
    listed()
    await reconcileSteps(view)
    const [api] = await addSteps(local, WS, { steps: { pwd: { run: 'pwd' } }, repos: ['api'] })
    await addSteps(local, WS, { workflow: 'web' })
    await addSteps(local, WS, { workflow: 'both' })
    await reconcileSteps(view)
    const dir = path.join(terminalLogDir(DEMO_PROJECT_ID, WS), lifeDirName(life))
    const startsIn = async (name: string): Promise<string | undefined> =>
      /^cd (.*) \|\| exit 1$/m.exec(await fs.readFile(path.join(dir, `${name}.sh`), 'utf8'))?.[1]
    expect(await startsIn('ci.pwd')).toBe('"$(tmux display-message -p \'#{session_path}\')"')
    expect(await startsIn(api.name)).toBe("'/workspace/api'")
    expect(await startsIn('web.pwd')).toBe("'/workspace/demo'")
    expect(await startsIn('both.pwd')).toBe("'/workspace'")
  })

  it('refuses steps written for a repo the workspace lacks', async () => {
    await insertRepo({ id: API_REPO, owner: BUILT_IN_USER_ID, remoteUrl: 'https://github.com/o/api.git' })
    await linkProjectRepo(DEMO_PROJECT_ID, API_REPO, 'api')
    await createWorkflow(local, DEMO_PROJECT_ID, { name: 'api', steps: { test: { run: 'pytest' } }, repos: ['api'] })
    await startFlows([{ name: 'ci', steps: { build: { run: 'make' } } }], { repos: [{ repoId: DEMO_PROJECT_ID, path: '' }] })
    await expect(addSteps(local, WS, { steps: { t: { run: 'pytest' } }, repos: ['api'] })).rejects.toThrow('runs in api')
    await expect(addSteps(local, WS, { workflow: 'api' })).rejects.toThrow('runs in api')
  })

  it('refuses a non-interactive workspace while it runs', async () => {
    await startLife({ test: { run: 'pnpm test' } }, { nonInteractive: true })
    await expect(addSteps(local, WS, { steps: { x: { run: 'y' } } })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('rerunStep', () => {
  it('runs a finished step again, with the steps its failure skipped', async () => {
    await startLife({ build: { run: 'pnpm build' }, test: { run: 'pnpm test', needs: ['build'] } })
    listed()
    await reconcileSteps(view)
    await expect(rerunStep(local, WS, 'ci.build')).rejects.toMatchObject({ code: 'CONFLICT' })
    listed({ name: 'ci.build', dead: true, exitStatus: 1 })
    await reconcileSteps(view)
    expect(await states()).toEqual({ 'ci.build': 'failed 1', 'ci.test': 'skipped' })

    const step = await rerunStep(local, WS, 'ci.build')
    expect(step).toMatchObject({ name: 'ci.build', workflow: 'ci', state: 'running' })
    // Its dead window is found by name in the listing and killed by id,
    // and a new one opened.
    expect(execs.at(-1)).toMatch(/list-windows -t =yaac .*awk -v n='ci\.build'.*kill-window -t "\$w".*new-window -d -t yaac -n 'ci\.build'/)
    expect(await states()).toEqual({ 'ci.build': 'running', 'ci.test': 'pending' })
    await expect(rerunStep(local, WS, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('cancelStep', () => {
  it('kills an unsettled step\'s window, skipping what needs it', async () => {
    await startLife({ dev: { run: 'pnpm dev', service: true }, smoke: { run: 'curl', needs: ['dev'] } })
    listed()
    await reconcileSteps(view)
    // A bare name, while only one workflow has the step.
    await cancelStep(local, WS, 'dev')
    expect(execs.at(-1)).toMatch(/awk -v n='ci\.dev'.*kill-window -t "\$w"/)
    expect(execs.at(-1)).not.toContain('=yaac:=')
    expect(await states()).toEqual({ 'ci.dev': 'cancelled', 'ci.smoke': 'skipped' })
    await expect(cancelStep(local, WS, 'ci.dev')).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('assertInteractive', () => {
  it('passes an interactive workspace', async () => {
    await startLife({})
    await expect(assertInteractive(WS)).resolves.toBeUndefined()
  })

  it('refuses a site\'s release while it runs, which only its site manages, but for a forward', async () => {
    await release()
    await expect(assertInteractive(WS)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('yaac site') as unknown })
    // The one port a release offers is its site's admin port.
    await expect(assertInteractive(WS, { forward: true })).resolves.toBeUndefined()
  })

  it('refuses a running non-interactive workspace, forwards included', async () => {
    await startLife({ test: { run: 'pnpm test' } }, { nonInteractive: true })
    await expect(assertInteractive(WS, { forward: true })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

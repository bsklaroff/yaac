import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { addSteps, assertInteractive, cancelStep, reconcileSteps, rerunStep } from '#domain/workspaces/steps'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { BUILT_IN_USER_ID, applyWorkspaceEvent, getWorkspaceRow, listWorkspaceSteps } from '#db'
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

const states = async (): Promise<Record<string, string>> =>
  Object.fromEntries((await listWorkspaceSteps(WS)).map((s) => [s.name, s.exitCode !== undefined ? `${s.state} ${String(s.exitCode)}` : s.state]))

async function startLife(raw: Record<string, unknown>, row: { nonInteractive?: boolean } = {}): Promise<void> {
  const graph = parseStepGraph(raw)
  await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: WS, startSteps: graph, ...row })
  life = new Date()
  await applyWorkspaceEvent({ type: 'workspace-life-started', projectId: DEMO_PROJECT_ID, workspaceId: WS, at: life, startSteps: graph })
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
  await closeDb()
  await cleanupTempDir(tmpDir)
})

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
    expect(opened()).toEqual(['install', 'db'])
    expect(await states()).toMatchObject({ install: 'running', db: 'running', build: 'pending', server: 'pending' })
    // Each step's script is written into its life's log dir, which the
    // workspace sees at its terminal log path, and its window keeps its pane.
    const dir = path.join(terminalLogDir(DEMO_PROJECT_ID, WS), lifeDirName(life))
    const script = await fs.readFile(path.join(dir, 'db.sh'), 'utf8')
    expect(script).toMatch(/initdb[\s\S]*until pg_isready[\s\S]*postgres/)
    expect(execs.find((c) => c.includes("-n 'db'"))).toContain(`/home/yaac/.yaac-logs/${lifeDirName(life)}/db.sh`)
    expect(execs.find((c) => c.includes("-n 'db'"))).toContain('set-option -t =yaac:=db remain-on-exit on')

    // install exits 0 and db's ready check passes: build and lint start,
    // server still waits on build.
    listed({ name: 'install', dead: true, exitStatus: 0 }, { name: 'db', dead: false, ready: true })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ install: 'succeeded 0', db: 'ready', build: 'running', lint: 'running', server: 'pending' })

    // build fails, so server, which needs it, is skipped; lint is not
    // affected.
    listed({ name: 'install', dead: true, exitStatus: 0 }, { name: 'db', dead: false, ready: true },
      { name: 'build', dead: true, exitStatus: 2 }, { name: 'lint', dead: false })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ build: 'failed 2', server: 'skipped', lint: 'running' })

    // A link the workspace planted where a script goes is replaced, never
    // written through.
    const victim = path.join(tmpDir, 'victim.txt')
    await fs.writeFile(victim, 'untouched')
    await fs.symlink(victim, path.join(dir, 'gated-alias.sh'))
    await addSteps(local, WS, { 'gated-alias': { run: 'echo hi', needs: ['install'] } })
    expect(await fs.readFile(victim, 'utf8')).toBe('untouched')
    expect((await fs.lstat(path.join(dir, 'gated-alias.sh'))).isSymbolicLink()).toBe(false)

    // A service that exits, even with 0, has failed.
    listed({ name: 'install', dead: true, exitStatus: 0 }, { name: 'db', dead: true, exitStatus: 0 },
      { name: 'build', dead: true, exitStatus: 2 }, { name: 'lint', dead: false })
    await reconcileSteps(view)
    expect(await states()).toMatchObject({ db: 'failed 0' })
  })

  it('stops a non-interactive workspace once the steps that are not services settle, recording its outcome', async () => {
    await startLife({
      db: { run: 'postgres', service: true },
      test: { run: 'pnpm test', needs: ['db'] },
    }, { nonInteractive: true })
    listed()
    await reconcileSteps(view)
    listed({ name: 'db', dead: false, ready: true })
    await reconcileSteps(view)
    expect(opened()).toEqual(['db', 'test'])
    // Nobody may change it while it runs.
    await expect(assertInteractive(WS)).rejects.toMatchObject({ code: 'CONFLICT' })

    listed({ name: 'db', dead: false, ready: true }, { name: 'test', dead: true, exitStatus: 0 })
    await reconcileSteps(view)
    expect((await getWorkspaceRow(DEMO_PROJECT_ID, WS))?.stepsOutcome).toBe('succeeded')
    await expect.poll(async () => (await getWorkspaceRow(DEMO_PROJECT_ID, WS))?.stoppedAt).toBeInstanceOf(Date)
    // Settled, it is no longer locked.
    await expect(assertInteractive(WS)).resolves.toBeUndefined()
  })
})

describe('addSteps', () => {
  it('adds steps that run once, after the steps they need, refusing a bad graph or a taken name', async () => {
    await startLife({ install: { run: 'pnpm install' } })
    listed()
    await reconcileSteps(view)

    const added = await addSteps(local, WS, { e2e: { run: ['pnpm build', 'pnpm e2e'], needs: ['install'] } })
    expect(added).toMatchObject([{ name: 'e2e', origin: 'added', state: 'pending' }])
    listed({ name: 'install', dead: true, exitStatus: 0 })
    await reconcileSteps(view)
    expect(opened()).toEqual(['install', 'e2e'])

    await expect(addSteps(local, WS, { e2e: { run: 'again' } })).rejects.toThrow('already exists')
    await expect(addSteps(local, WS, { x: { run: 'y', needs: ['nope'] } })).rejects.toThrow('"nope", which is not a step')
    await expect(addSteps(local, WS, {})).rejects.toMatchObject({ code: 'VALIDATION' })

    // A new life reruns the start steps but not an added one; one that had
    // not settled is interrupted.
    await addSteps(local, WS, { later: { run: 'echo', needs: ['e2e'] } })
    await applyWorkspaceEvent({ type: 'workspace-life-started', projectId: DEMO_PROJECT_ID, workspaceId: WS, at: new Date(), startSteps: parseStepGraph({ install: { run: 'pnpm install' } }) })
    const rows = await listWorkspaceSteps(WS)
    expect(rows.map((s) => [s.name, s.origin, s.state])).toEqual([
      ['e2e', 'added', 'interrupted'], ['later', 'added', 'interrupted'], ['install', 'start', 'pending'],
    ])
  })

  it('refuses a non-interactive workspace while it runs', async () => {
    await startLife({ test: { run: 'pnpm test' } }, { nonInteractive: true })
    await expect(addSteps(local, WS, { x: { run: 'y' } })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('rerunStep', () => {
  it('runs a finished step again, with the steps its failure skipped', async () => {
    await startLife({ build: { run: 'pnpm build' }, test: { run: 'pnpm test', needs: ['build'] } })
    listed()
    await reconcileSteps(view)
    await expect(rerunStep(local, WS, 'build')).rejects.toMatchObject({ code: 'CONFLICT' })
    listed({ name: 'build', dead: true, exitStatus: 1 })
    await reconcileSteps(view)
    expect(await states()).toEqual({ build: 'failed 1', test: 'skipped' })

    const step = await rerunStep(local, WS, 'build')
    expect(step).toMatchObject({ name: 'build', state: 'running' })
    // Its dead window is killed and a new one opened.
    expect(execs.at(-1)).toMatch(/kill-window -t =yaac:=build 2>\/dev\/null; .*new-window -d -t yaac -n 'build'/)
    expect(await states()).toEqual({ build: 'running', test: 'pending' })
    await expect(rerunStep(local, WS, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('cancelStep', () => {
  it('kills an unsettled step\'s window, skipping what needs it', async () => {
    await startLife({ dev: { run: 'pnpm dev', service: true }, smoke: { run: 'curl', needs: ['dev'] } })
    listed()
    await reconcileSteps(view)
    await cancelStep(local, WS, 'dev')
    expect(execs.at(-1)).toContain('kill-window -t =yaac:=dev')
    expect(await states()).toEqual({ dev: 'cancelled', smoke: 'skipped' })
    await expect(cancelStep(local, WS, 'dev')).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('assertInteractive', () => {
  it('passes an interactive workspace', async () => {
    await startLife({})
    await expect(assertInteractive(WS)).resolves.toBeUndefined()
  })
})

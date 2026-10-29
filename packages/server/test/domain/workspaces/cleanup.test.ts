import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as dbModule from '#db'

const PROJ_A = '35f146e4-c6e4-40e3-8dcf-ae8471558e9f'
const PROJ_B = '59f56625-001b-4df1-8d07-9b32191dc0a0'

vi.mock('#db', async (importOriginal) => {
  const actual = await importOriginal<typeof dbModule>()
  return {
    ...actual,
    // Real, but a test can make the project list unreadable.
    listProjectRows: vi.fn(actual.listProjectRows),
  }
})
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { gcOrphanEphemeralModuleDirs, reapOrphanNodeLocal, reconcileIgnoredFileCleans } from '#domain/workspaces'
import { setDataDir, workspaceDir } from '@yaac/shared/project-paths'
import type { NodeLocalLiveSet, RuntimeSnapshot, StrayUnit, RuntimeHandle } from '#drivers/contract'
import { BUILT_IN_USER_ID, closeDb, getWorkspaceRow, listProjectRows, setProjectKeptIgnoredPaths } from '#db'
import { recordIgnoredFilesCleaned, recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { recordProject } from '#db/project-store'
import {
  claimDeletion,
  clearAllProvisioningForTests,
  provision,
  registerProvisioning,
  settleSpare,
  spawningSpares,
} from '#domain/workspaces/provisioning'
import { handleFixture, installFakeWorkspaceDriver, snapshotFixture } from '#test/support/fake-driver'

let gcDataDir: string

/** Register ids as in-flight creates in the real registry. */
function publishInFlight(provisioning: string[] = []): void {
  clearAllProvisioningForTests()
  for (const workspaceId of provisioning) {
    registerProvisioning({ workspaceId, projectId: PROJ_A, tool: 'claude', kind: 'create' })
  }
}

/** Live sets passed to the runtime's node-local reap. */
let reaped: NodeLocalLiveSet[]
/** The pass view the sweeps are handed. */
let view: RuntimeSnapshot

/** A pass view reporting these workspaces and stray units. */
function seeRunning(workspaces: RuntimeHandle[], strays: StrayUnit[] = []): void {
  view = snapshotFixture(workspaces, strays)
}

/** A pass view that cannot be read. */
function seeNothing(): void {
  view = {
    resync: true,
    takenAtMs: Date.now(),
    workspaces: () => Promise.reject(new Error('cluster offline')),
    strayUnits: () => Promise.reject(new Error('cluster offline')),
  }
}

async function setUpSweep(): Promise<void> {
  gcDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-gc-ephemeral-'))
  setDataDir(gcDataDir)
  reaped = []
  installFakeWorkspaceDriver({
    reapNodeLocal: (live) => { reaped.push(live); return Promise.resolve() },
  })
  seeRunning([])
  publishInFlight()
}

async function tearDownSweep(): Promise<void> {
  clearAllProvisioningForTests()
  await closeDb()
  await fs.rm(gcDataDir, { recursive: true, force: true })
}

// Backdated, since the sweep spares anything written around its own start
// (a create staging into it).
const STALE = new Date(Date.now() - 3_600_000)

async function seedModulesDir(projectId: string, sid: string): Promise<string> {
  const dir = path.join(gcDataDir, 'node-local', 'projects', projectId, '.cached-packages', 'modules', sid)
  await fs.mkdir(dir, { recursive: true })
  await fs.utimes(dir, STALE, STALE)
  return dir
}

async function seedWorkspacesDir(projectId: string, sid: string): Promise<string> {
  const dir = path.join(gcDataDir, 'global', 'projects', projectId, 'sessions', sid)
  await fs.mkdir(dir, { recursive: true })
  await fs.utimes(dir, STALE, STALE)
  return dir
}

describe('gcOrphanEphemeralModuleDirs', () => {
  beforeEach(setUpSweep)
  afterEach(tearDownSweep)

  it('removes orphan per-session dirs and leaves node-local ones to the runtime', async () => {
    const liveTmux = await seedWorkspacesDir(PROJ_A, 'live-1')
    const deadTmux = await seedWorkspacesDir(PROJ_A, 'dead-1')
    const deadModules = await seedModulesDir(PROJ_A, 'dead-1')

    seeRunning([handleFixture({ workspaceId: 'live-1', projectId: PROJ_A })])

    await gcOrphanEphemeralModuleDirs(view)

    await expect(fs.access(liveTmux)).resolves.toBeUndefined()
    await expect(fs.access(deadTmux)).rejects.toThrow()
    await expect(fs.access(deadModules)).resolves.toBeUndefined()
    expect(reaped).toHaveLength(0)
  })

  // On disk a dead spare's checkout and a stopped workspace's look the same,
  // and after a database restore a claimed workspace may have no row, so
  // this sweep keeps every checkout (`reapSpare` removes a spare's). A dir
  // under projects/ that is no project id (an older install's slug) is
  // still swept.
  it('keeps every checkout, with a row or without', async () => {
    const slugSession = await seedWorkspacesDir('demo', 'dead-2')
    await recordWorkspaceCreated({ projectId: PROJ_A, workspaceId: 'stopped-1' })
    const checkouts = await Promise.all(['rowless-1', 'stopped-1'].map(async (sid) => {
      const dir = workspaceDir(PROJ_A, sid)
      await fs.mkdir(dir, { recursive: true })
      await fs.utimes(dir, STALE, STALE)
      return dir
    }))

    await gcOrphanEphemeralModuleDirs(view)

    for (const dir of checkouts) await expect(fs.access(dir)).resolves.toBeUndefined()
    await expect(fs.access(slugSession)).rejects.toThrow()
  })

  it('spares a session the process is still creating, a spare included', async () => {
    // No listing shows a create until its unit exists, and a spare's dirs
    // can sit unwritten for longer than the sweep's slack while it warms;
    // sweeping either would delete dirs its pod is about to mount.
    const staging = await seedWorkspacesDir(PROJ_A, 'creating-1')
    const warming = await seedWorkspacesDir(PROJ_A, 'spare-1')
    publishInFlight(['creating-1'])
    spawningSpares.set('spare-1', PROJ_A)

    await gcOrphanEphemeralModuleDirs(view)

    await expect(fs.access(staging)).resolves.toBeUndefined()
    await expect(fs.access(warming)).resolves.toBeUndefined()
  })

  // A pass reads its listing before the pool step warms a spare, and sweeps
  // after it. A create that settles in between is in neither the listing
  // nor the registry, and its pod has already mounted these dirs.
  it('spares a session whose create settled after the listing was read', async () => {
    const spare = await seedWorkspacesDir(PROJ_A, 'spare-1')
    const created = await seedWorkspacesDir(PROJ_A, 'created-1')
    spawningSpares.set('spare-1', PROJ_A)
    const run = provision({ workspaceId: 'created-1', projectId: PROJ_A, tool: 'claude', kind: 'create' },
      () => Promise.resolve({ workspaceId: 'created-1' }))
    const before = view
    settleSpare('spare-1')
    await run()

    await gcOrphanEphemeralModuleDirs(before)
    await expect(fs.access(spare)).resolves.toBeUndefined()
    await expect(fs.access(created)).resolves.toBeUndefined()

    // A listing read after they settled would show them if they were alive.
    await new Promise((resolve) => setTimeout(resolve, 2))
    seeRunning([])
    await gcOrphanEphemeralModuleDirs(view)
    await expect(fs.access(spare)).rejects.toThrow()
    await expect(fs.access(created)).rejects.toThrow()
  })

  it('spares a dir written since the sweep took its listing', async () => {
    // A create that stages before it registers: a fresh dir is left for the
    // next sweep.
    const fresh = await seedWorkspacesDir(PROJ_A, 'staging-1')
    await fs.utimes(fresh, new Date(), new Date())

    await gcOrphanEphemeralModuleDirs(view)

    await expect(fs.access(fresh)).resolves.toBeUndefined()
  })

  // An unreadable view must not read as empty.
  it('fails without removing anything when the runtime view cannot be read', async () => {
    const dead = await seedWorkspacesDir(PROJ_A, 'would-be-removed')
    seeNothing()

    await expect(gcOrphanEphemeralModuleDirs(view)).rejects.toThrow('cluster offline')
    await expect(fs.access(dead)).resolves.toBeUndefined()
  })
})

describe('reapOrphanNodeLocal', () => {
  beforeEach(setUpSweep)
  afterEach(tearDownSweep)

  // Node-local dirs may live on another node, so the runtime removes them.
  // This layer only hands over the live set: recorded project ids,
  // workspaces, stray units and in-flight creates.
  it('hands the runtime the live project ids and workspaces, and removes no node-local dir itself', async () => {
    await recordProject({ id: PROJ_A, name: 'demo', remoteUrl: 'https://x/proj-a', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    await recordProject({ id: PROJ_B, name: 'demo', remoteUrl: 'https://x/proj-b', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
    const ids = (await listProjectRows()).map((r) => r.id)
    const live = await seedModulesDir(ids[0], 'live-1')
    const dead = await seedModulesDir(ids[0], 'dead-1')
    const strayOnly = await seedModulesDir(ids[1], 'job-only-1')
    const orphan = await seedModulesDir('removed-project', 'x')
    publishInFlight(['creating-1'])

    seeRunning(
      [handleFixture({ workspaceId: 'live-1', projectId: PROJ_A })],
      // A unit mid-recreate appears only as a stray, and its replacement is
      // about to mount its dirs.
      [{ workspaceId: 'job-only-1', unitName: 'yaac-proj-b-job-only-1', projectId: PROJ_B, createdAtMs: 0, prewarmed: false }],
    )

    await reapOrphanNodeLocal(view)

    expect(reaped).toEqual([{
      projectIds: new Set(ids),
      workspaceIds: new Set(['live-1', 'job-only-1', 'creating-1']),
    }])
    for (const dir of [live, dead, strayOnly, orphan]) {
      await expect(fs.access(dir)).resolves.toBeUndefined()
    }
  })

  // No project is live, so every node-local tree is an orphan.
  it('with no projects, hands the runtime an empty live set', async () => {
    await reapOrphanNodeLocal(view)
    expect(reaped).toEqual([{ projectIds: new Set(), workspaceIds: new Set() }])
  })

  // An empty list would make every tree look orphaned, so an unreadable
  // projects list or view fails the step instead.
  it('hands the runtime nothing when its records cannot be read', async () => {
    vi.mocked(listProjectRows).mockRejectedValueOnce(new Error('db closed'))
    await expect(reapOrphanNodeLocal(view)).rejects.toThrow('db closed')

    seeNothing()
    await expect(reapOrphanNodeLocal(view)).rejects.toThrow('cluster offline')
    expect(reaped).toHaveLength(0)
  })
})

describe('reconcileIgnoredFileCleans', () => {
  /** The checkouts the runtime was asked to run the clean on, with the
   *  paths it was told to keep. */
  let runs: Array<{ workspaceId: string; args: string[] }>
  /** Holds each run until released, when set. */
  let hold: Promise<void> | null

  beforeEach(async () => {
    await setUpSweep()
    runs = []
    hold = null
    // The runtime runs the script on the checkout for real, as the
    // containerless driver does.
    installFakeWorkspaceDriver({
      runInStoppedCheckout: async ({ projectId, workspaceId }, script, args) => {
        runs.push({ workspaceId, args })
        await hold
        await promisify(execFile)('sh', ['-c', script, 'sh', workspaceDir(projectId, workspaceId), ...args])
      },
    })
    await recordProject({ id: PROJ_A, name: 'demo', remoteUrl: 'https://x/proj-a', addedAt: '2026-01-01' }, BUILT_IN_USER_ID)
  })
  afterEach(tearDownSweep)

  /** A stopped workspace whose checkout holds an ignored, a kept and an
   *  untracked file. */
  async function stoppedWithBuildOutput(workspaceId: string): Promise<string> {
    const dir = workspaceDir(PROJ_A, workspaceId)
    await fs.mkdir(path.join(dir, 'out'), { recursive: true })
    await fs.writeFile(path.join(dir, '.gitignore'), 'out/\n.env\n')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    for (const rel of ['out/bundle.js', '.env', 'notes.txt']) await fs.writeFile(path.join(dir, rel), '')
    await recordWorkspaceCreated({ projectId: PROJ_A, workspaceId })
    await recordWorkspaceStopped(PROJ_A, workspaceId)
    return dir
  }

  const cleaned = async (workspaceId: string): Promise<boolean> =>
    (await getWorkspaceRow(PROJ_A, workspaceId))?.ignoredCleanedAt !== undefined

  it('cleans one stopped workspace per pass, one at a time, keeping its kept paths, and skips the live, the in-flight, the deleting and the cleaned', async () => {
    await setProjectKeptIgnoredPaths(PROJ_A, ['.env'])
    const dead = await stoppedWithBuildOutput('dead')
    await stoppedWithBuildOutput('gone')
    await fs.rm(workspaceDir(PROJ_A, 'gone'), { recursive: true })
    for (const id of ['stuck', 'restarting', 'deleting', 'done']) await stoppedWithBuildOutput(id)
    await recordIgnoredFilesCleaned(PROJ_A, 'done', new Date())
    registerProvisioning({ workspaceId: 'restarting', projectId: PROJ_A, tool: 'claude', kind: 'restart' })
    claimDeletion('deleting')
    seeRunning([handleFixture({ workspaceId: 'stuck', projectId: PROJ_A })])

    let release!: () => void
    hold = new Promise((resolve) => { release = resolve })
    await reconcileIgnoredFileCleans(view)
    await vi.waitFor(() => { expect(runs).toHaveLength(1) })
    await reconcileIgnoredFileCleans(view)
    expect(runs).toEqual([{ workspaceId: 'dead', args: ['.env'] }])
    release()
    await vi.waitFor(async () => { expect(await cleaned('dead')).toBe(true) }, { timeout: 30_000 })
    expect((await fs.readdir(dead)).sort()).toEqual(['.env', '.git', '.gitignore', 'notes.txt'])

    // A checkout that is gone has nothing to clean, so it is only stamped.
    await reconcileIgnoredFileCleans(view)
    await vi.waitFor(async () => { expect(await cleaned('gone')).toBe(true) }, { timeout: 30_000 })
    await reconcileIgnoredFileCleans(view)
    expect(runs.map((r) => r.workspaceId)).toEqual(['dead'])
    for (const id of ['stuck', 'restarting', 'deleting']) expect(await cleaned(id), id).toBe(false)
  })

  // The fallback runs as root on what the agent wrote, so the repository's
  // config gets no say beyond its ignore rules.
  it('runs nothing the repository\'s config names, and keeps to its work tree and its own ignore rules', async () => {
    const dir = await stoppedWithBuildOutput('hostile')
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
    const elsewhere = path.join(gcDataDir, 'elsewhere')
    const ran = path.join(gcDataDir, 'ran')
    await fs.mkdir(path.join(elsewhere, 'out'), { recursive: true })
    await fs.writeFile(path.join(elsewhere, 'out', 'victim'), '')
    await fs.writeFile(path.join(gcDataDir, 'everything'), '*\n')
    // Walking into `sub/` (it holds an untracked file) reads its
    // skip-worktree .gitignore from the index, and a missing blob would be
    // lazily fetched through the promisor remote's upload-pack.
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'sub', '.gitignore'), 'x\n')
    git('add', '.gitignore', 'sub/.gitignore')
    git('commit', '-qm', 'init')
    const blob = git('rev-parse', 'HEAD:sub/.gitignore')
    git('update-index', '--skip-worktree', 'sub/.gitignore')
    await fs.rm(path.join(dir, 'sub', '.gitignore'))
    await fs.rm(path.join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))
    await fs.writeFile(path.join(dir, 'sub', 'draft.txt'), '')
    for (const [key, value] of [
      ['core.repositoryformatversion', '1'],
      ['extensions.partialClone', 'origin'],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.url', elsewhere],
      ['remote.origin.uploadpack', `sh -c 'touch ${ran}-uploadpack' #`],
      ['core.fsmonitor', `sh -c 'touch ${ran}-fsmonitor' #`],
      ['core.worktree', elsewhere],
      ['core.excludesFile', path.join(gcDataDir, 'everything')],
    ]) git('config', key, value)

    await reconcileIgnoredFileCleans(view)
    await vi.waitFor(async () => { expect(await cleaned('hostile')).toBe(true) }, { timeout: 30_000 })

    expect((await fs.readdir(gcDataDir)).filter((n) => n.startsWith('ran'))).toEqual([])
    expect(await fs.readdir(path.join(elsewhere, 'out'))).toEqual(['victim'])
    expect((await fs.readdir(dir)).sort()).toEqual(['.git', '.gitignore', 'notes.txt', 'sub'])
  })

  it('tries a checkout it failed on again only after a wait', async () => {
    await stoppedWithBuildOutput('dead')
    hold = Promise.reject(new Error('pod failed'))
    hold.catch(() => undefined)
    await reconcileIgnoredFileCleans(view)
    await vi.waitFor(() => { expect(runs).toHaveLength(1) })
    hold = null
    await reconcileIgnoredFileCleans(view)
    expect(runs).toHaveLength(1)
    expect(await cleaned('dead')).toBe(false)

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000)
    seeRunning([])
    await reconcileIgnoredFileCleans(view)
    await vi.waitFor(async () => { expect(await cleaned('dead')).toBe(true) }, { timeout: 30_000 })
    expect(runs).toHaveLength(2)
    vi.restoreAllMocks()
  })
})

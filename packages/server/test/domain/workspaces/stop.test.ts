import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile, execFileSync } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'

/** The detached teardown scripts a stop spawned, each with the child that
 *  runs it. A child exits at once unless `holdTeardowns` is set. */
const teardowns = vi.hoisted(() => ({ spawned: [] as Array<{ script: string; child: EventEmitter }>, hold: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: ChildProcessModule.SpawnOptions) => {
      if (cmd !== 'sh') return actual.spawn(cmd, args, opts)
      const child = Object.assign(new EventEmitter(), { unref: () => { /* detached */ } })
      teardowns.spawned.push({ script: args[1], child })
      if (!teardowns.hold) setImmediate(() => child.emit('exit', 0))
      return child
    },
  }
})
import {
  listDraftWorkspaces,
  listProvisioning,
  prepareRestart,
  prepareStart,
  listQueuedWorkspaces,
  queueWorkspace,
  stopWorkspace,
} from '#domain/workspaces'
import { clearQueuedLaunchesForTests } from '#domain/workspaces/queued-workspaces'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { getQueuedWorkspaceRow } from '#db/queued-workspace-store'
import { createWorkspaceGroup, getWorkspaceRow, listWorkspaceAgentSessions, setProjectKeptIgnoredPaths, setWorkspaceGroup, setWorkspaceGroupLimit } from '#db'
import { clearWorkspaceStopped, recordWorkspaceCreated } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver, workspacePathsFixture } from '#test/support/fake-driver'
import { seedProject } from '@yaac/test-utils/project-fixture'
import { WorkspaceExecError } from '#drivers/contract'
import { BUILT_IN_USER_ID } from '#db'
import { isWorkspaceTerminating, _clearTerminatingForTests } from '#runtime/status/terminating'
import { serverLog } from '#lib/log'
import { workspaceDir } from '@yaac/shared/project-paths'
import { shellQuote } from '#lib/shell'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'

// A stop runs the (fake) driver's teardown, then creates whatever was queued
// after the stopped workspace. Both run for real, over a real project.
let tmpDir: string
/** Workspaces the driver tore down, and the ones it launched. */
let deregistered: string[]
let launched: string[]

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  await seedProject(PROJ)
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  _clearTerminatingForTests()
  teardowns.spawned = []
  teardowns.hold = false
  deregistered = []
  launched = []
  installFakeWorkspaceDriver({
    findForTeardown: (id) => Promise.resolve(id === 'parent'
      ? { workspaceId: 'parent', projectId: PROJ, unitName: 'yaac-proj-parent' }
      : undefined),
    deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
    launch: (spec) => {
      launched.push(spec.workspaceId)
      return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, projectId: PROJ }))
    },
  })
  await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'parent', baseBranch: 'dev', permissionMode: 'auto', mode: 'tui' })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** The workspace whose first conversation began with `prompt`. */
async function launchedWith(prompt: string): Promise<string | undefined> {
  for (const id of launched) {
    if ((await listWorkspaceAgentSessions(PROJ, id))[0]?.firstPrompt === prompt) return id
  }
  return undefined
}

describe('stopWorkspace', () => {
  // A stop never asks the driver for spares, so even a spare's exact id is
  // not found.
  it('does not stop an unclaimed spare, even by its exact id', async () => {
    const asked: Array<{ spares?: boolean } | undefined> = []
    installFakeWorkspaceDriver({
      findForTeardown: (id, opts) => {
        asked.push(opts)
        return Promise.resolve(id === 'spare1' && opts?.spares === true
          ? { workspaceId: 'spare1', projectId: PROJ, unitName: 'yaac-proj-spare1' }
          : undefined)
      },
    })
    await expect(stopWorkspace(local, 'spare1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(asked).toEqual([undefined])
    expect(deregistered).toEqual([])
  })

  it('tears the workspace down, then starts what was queued after it — only the top of a chain', async () => {
    const child = await queueWorkspace(local, PROJ, { parent: 'parent', prompt: 'child', tool: 'claude' }, 'user')
    const sibling = await queueWorkspace(local, PROJ, { parent: 'parent', prompt: 'sibling', tool: 'claude' }, 'user')
    const grandchild = await queueWorkspace(local, PROJ, { parent: child.id, prompt: 'grandchild' }, 'user')

    // Addressed by a prefix, which the rows expand.
    expect(await stopWorkspace(local, 'par')).toMatchObject({ workspaceId: 'parent', projectId: PROJ })
    expect(deregistered).toEqual(['parent'])

    // Both direct children start from their stored settings: the parent's
    // branch, posture and UI mode.
    await vi.waitFor(async () => {
      expect(await getQueuedWorkspaceRow(child.id)).toBeUndefined()
      expect(await getQueuedWorkspaceRow(sibling.id)).toBeUndefined()
    }, { timeout: 60_000 })
    expect(launched).toHaveLength(2)
    const becameId = await launchedWith('child')
    expect(await launchedWith('sibling')).toBeDefined()
    expect(await getWorkspaceRow(PROJ, becameId!)).toMatchObject({ baseBranch: 'dev', permissionMode: 'auto', mode: 'tui' })
    // The grandchild now waits for the child's new workspace to stop.
    const waiting = await getQueuedWorkspaceRow(grandchild.id)
    expect(waiting).toMatchObject({ parentWorkspaceId: becameId })
    expect(waiting?.releasedAt).toBeUndefined()
  })

  // docs/workspace-groups.md: a stop frees a slot in its group.
  describe('in a group with a workspace limit', () => {
    let groupId: string
    beforeEach(async () => {
      installFakeWorkspaceDriver({
        findForTeardown: (id) => Promise.resolve(['parent', 'other'].includes(id)
          ? { workspaceId: id, projectId: PROJ, unitName: `yaac-proj-${id}` }
          : undefined),
        // Their runtimes, which is what makes a member hold its slot.
        list: () => Promise.resolve(['parent', 'other'].map((id) =>
          handleFixture({ workspaceId: id, projectId: PROJ, jobName: `yaac-proj-${id}` }))),
        launch: (spec) => {
          launched.push(spec.workspaceId)
          return Promise.resolve(handleFixture({ workspaceId: spec.workspaceId, projectId: PROJ }))
        },
      })
      ;({ groupId } = await createWorkspaceGroup(PROJ, 'Workers', null))
      await setWorkspaceGroupLimit(PROJ, groupId, 1)
    })

    it('launches what was queued with no parent once a member stops', async () => {
      await setWorkspaceGroup(PROJ, 'parent', groupId)
      const waiting = await queueWorkspace(local, PROJ, { prompt: 'waiting', group: 'Workers', mode: 'tui' }, 'user')
      expect(launched).toEqual([])

      await stopWorkspace(local, 'parent')
      await vi.waitFor(async () => { expect(await launchedWith('waiting')).toBeDefined() }, { timeout: 60_000 })
      // Its record goes once the launch settles, after the prompt lands.
      await vi.waitFor(async () => { expect(await getQueuedWorkspaceRow(waiting.id)).toBeUndefined() })
    })

    it('keeps a child released into a full group waiting for room, not for its parent, until any member stops', async () => {
      await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'other', groupId })
      const child = await queueWorkspace(local, PROJ, { parent: 'parent', prompt: 'child', group: groupId }, 'user')

      await stopWorkspace(local, 'parent')
      const released = await getQueuedWorkspaceRow(child.id)
      expect(released).toMatchObject({ parentWorkspaceId: 'parent' })
      expect(released?.releasedAt).toBeInstanceOf(Date)
      expect(released?.launchWorkspaceId).toBeUndefined()
      expect((await listQueuedWorkspaces()).find((e) => e.id === child.id)).toMatchObject({ waitingForRoom: true })

      // The parent coming back does not put it back to waiting on its stop.
      await clearWorkspaceStopped(PROJ, 'parent')
      await stopWorkspace(local, 'other')
      await vi.waitFor(async () => { expect(await launchedWith('child')).toBeDefined() }, { timeout: 60_000 })
      expect(launched).toHaveLength(1)
    })
  })

  /**
   * The teardown runs detached, so the stop returns at once: routing stops
   * in-process, then the runtime's teardown and this layer's dirs go in one
   * script, once anything the workspace holds has been salvaged.
   */
  describe('the teardown it schedules', () => {
    const TEARDOWN = 'runtime-teardown-here'
    /** What the runtime was asked, in order. */
    let calls: string[]

    /** A workspace whose commands run for real, in its checkout. */
    const inCheckout = (cmd: string, opts?: { stdin?: string }): Promise<{ stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = execFile('sh', ['-c', cmd], { cwd: workspaceDir(PROJ, 'parent') }, (err, stdout, stderr) => {
          // As streamd words it: the exit and the command's stderr.
          const code = typeof err?.code === 'number' ? err.code : -1
          if (err) reject(new WorkspaceExecError(`command exited ${String(code)}: ${stderr.trim()}`, code, stdout, stderr))
          else resolve({ stdout, stderr })
        })
        child.stdin?.end(opts?.stdin ?? '')
      })

    function installTeardown(
      salvage: () => Promise<void> = () => Promise.resolve(),
      exec: typeof inCheckout = () => Promise.resolve({ stdout: '', stderr: '' }),
    ): void {
      installFakeWorkspaceDriver({
        findForTeardown: (id) => Promise.resolve(id === 'parent'
          ? { workspaceId: 'parent', projectId: PROJ, unitName: 'yaac-proj-parent' }
          : undefined),
        deregisterWorkspace: (id) => { calls.push(`deregister ${id}`); return Promise.resolve() },
        salvageImages: (target) => { calls.push(`salvage ${target.unitName}`); return salvage() },
        workspacePaths: () => workspacePathsFixture({ workspaceDir: workspaceDir(PROJ, 'parent') }),
        exec: (_job, cmd, opts) => exec(cmd, opts),
        detachedTeardownCommand: () => TEARDOWN,
      })
    }

    beforeEach(() => {
      calls = []
      installTeardown()
    })

    it('records the stop and marks it terminating, deregisters, then runs the runtime teardown ahead of the dirs this layer owns', async () => {
      const modules = path.join(workspaceDir(PROJ, 'parent'), 'node_modules')
      await fs.mkdir(modules, { recursive: true })
      let release!: () => void
      installTeardown(() => new Promise((resolve) => { release = resolve }))
      vi.mocked(serverLog).mockClear()

      await stopWorkspace(local, 'parent')

      expect(isWorkspaceTerminating('parent')).toBe(true)
      expect((await getWorkspaceRow(PROJ, 'parent'))?.stoppedAt).toBeInstanceOf(Date)
      // Routing stops in-process, and the salvage reads from the workspace,
      // so nothing is spawned until both are done.
      expect(calls).toEqual(['deregister parent', 'salvage yaac-proj-parent'])
      expect(teardowns.spawned).toEqual([])
      // The detached script's output is discarded, so the teardown is
      // logged here.
      const logged = vi.mocked(serverLog).mock.calls.map(([m]) => m).join('\n')
      expect(logged).toContain(`session teardown: session=parent job=yaac-proj-parent project=${PROJ}`)
      expect(logged).not.toContain('cause=')

      release()
      await vi.waitFor(() => { expect(teardowns.spawned).toHaveLength(1) })
      const { script } = teardowns.spawned[0]
      expect(script.startsWith(TEARDOWN)).toBe(true)
      expect(script).toContain(`rm -rf '${modules}'`)
      expect(script.indexOf(TEARDOWN)).toBeLessThan(script.indexOf('rm -rf'))
    })

    it('spawns the teardown even when the salvage fails and the workspace cannot be reached', async () => {
      installTeardown(() => Promise.reject(new Error('registry down')), () => Promise.reject(new Error('pod gone')))
      await stopWorkspace(local, 'parent')
      await vi.waitFor(() => { expect(teardowns.spawned).toHaveLength(1) })
      // Left for the fallback, which looks for stopped rows without a clean.
      expect((await getWorkspaceRow(PROJ, 'parent'))?.ignoredCleanedAt).toBeUndefined()
    })

    it('first removes the ignored files, by every .gitignore, keeping untracked files, kept paths and nested repositories\' own untracked files', async () => {
      const checkout = workspaceDir(PROJ, 'parent')
      const git = (cwd: string, ...args: string[]): void => {
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' })
      }
      const files: Record<string, string> = {
        '.gitignore': 'node_modules/\ntarget/\n.env\n*.log\nvendor/\n',
        'pkg/.gitignore': 'gen/\n',
        'vendor/lib/.gitignore': 'build/\n',
      }
      for (const [rel, text] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(checkout, rel)), { recursive: true })
        await fs.writeFile(path.join(checkout, rel), text)
      }
      git(path.join(checkout, 'vendor/lib'), 'init', '-q')
      git(path.join(checkout, 'vendor/lib'), 'add', '.')
      git(path.join(checkout, 'vendor/lib'), 'commit', '-qm', 'lib')
      git(checkout, 'init', '-q')
      git(checkout, 'add', '.gitignore', 'pkg/.gitignore')
      git(checkout, 'commit', '-qm', 'init')
      const removed = ['app.log', 'target/debug/b', 'pkg/gen/o', 'vendor/junk', 'vendor/lib/build/o', 'node_modules/x/a.log']
      const kept = ['notes.txt', 'vendor/lib/new.txt', '.env', 'target/release/bin', 'target/release/deps/x.log']
      for (const rel of [...removed, ...kept]) {
        await fs.mkdir(path.dirname(path.join(checkout, rel)), { recursive: true })
        await fs.writeFile(path.join(checkout, rel), '')
      }
      await setProjectKeptIgnoredPaths(PROJ, ['.env', 'target/release'])
      installTeardown(undefined, inCheckout)

      await stopWorkspace(local, 'parent')
      // The clean runs real git first.
      await vi.waitFor(() => { expect(teardowns.spawned).toHaveLength(1) }, { timeout: 30_000 })

      const exists = (rel: string): Promise<boolean> => fs.access(path.join(checkout, rel)).then(() => true, () => false)
      expect(Object.fromEntries(await Promise.all([...removed, ...kept].map(async (rel) => [rel, await exists(rel)]))))
        .toEqual(Object.fromEntries([...removed.map((rel) => [rel, false]), ...kept.map((rel) => [rel, true])]))
      expect((await getWorkspaceRow(PROJ, 'parent'))?.ignoredCleanedAt).toBeInstanceOf(Date)
    })

    // A `sudo npm install` leaves thousands of files the workspace's user
    // cannot remove; the fallback removes them as root.
    it('leaves a clean that could not remove everything to the fallback, logging only its tail', async () => {
      const checkout = workspaceDir(PROJ, 'parent')
      const locked = path.join(checkout, 'out', 'locked')
      await fs.mkdir(locked, { recursive: true })
      await fs.writeFile(path.join(checkout, '.gitignore'), 'out/\n')
      for (let i = 0; i < 200; i++) await fs.writeFile(path.join(locked, `f${String(i)}`), '')
      execFileSync('git', ['init', '-q'], { cwd: checkout })
      await fs.chmod(locked, 0o555)
      vi.mocked(serverLog).mockClear()
      installTeardown(undefined, inCheckout)
      try {
        await stopWorkspace(local, 'parent')
        await vi.waitFor(() => { expect(teardowns.spawned).toHaveLength(1) }, { timeout: 30_000 })
      } finally {
        await fs.chmod(locked, 0o755)
      }

      expect((await getWorkspaceRow(PROJ, 'parent'))?.ignoredCleanedAt).toBeUndefined()
      const logged = vi.mocked(serverLog).mock.calls.map(([m]) => m).find((m) => m.includes('ignored-file clean'))
      expect(logged).toContain('with 200 lines of errors')
      // The count's line, then the last 10.
      expect(logged?.split('\n')).toHaveLength(11)
    })

    // A pod's module dirs and cache volumes are mounts into the checkout; a
    // cache volume's contents are shared with other workspaces. The clean
    // finds them from the kernel, so a user namespace stands in for the pod.
    it.runIf(process.platform === 'linux')('keeps everything mounted under the checkout, whatever the project config says', async () => {
      const checkout = workspaceDir(PROJ, 'parent')
      const shared = path.join(tmpDir, 'shared-cache')
      await fs.mkdir(path.join(checkout, 'cache'), { recursive: true })
      await fs.mkdir(shared)
      await fs.writeFile(path.join(shared, 'entry.log'), '')
      await fs.writeFile(path.join(checkout, '.gitignore'), 'cache/\n*.log\n')
      await fs.writeFile(path.join(checkout, 'app.log'), '')
      execFileSync('git', ['init', '-q'], { cwd: checkout })
      installTeardown(undefined, (cmd, opts) => inCheckout(
        `unshare -rm sh -c 'mount --bind "$1" "$2" && exec sh -c "$3"' sh ${shellQuote(shared)} ${shellQuote(path.join(checkout, 'cache'))} ${shellQuote(cmd)}`,
        opts,
      ))

      await stopWorkspace(local, 'parent')
      await vi.waitFor(() => { expect(teardowns.spawned).toHaveLength(1) }, { timeout: 30_000 })

      expect(await fs.readdir(shared)).toEqual(['entry.log'])
      await expect(fs.access(path.join(checkout, 'app.log'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  describe('a workspace still being created', () => {
    /** Start creating workspace `new` (or restarting `parent`) the way the
     *  routes do, with the driver's `assertCanLaunch`, `awaitReady` and `exec`
     *  as given, recording what it tears down. */
    function startCreate(driver: {
      assertCanLaunch?: () => Promise<void>
      prepareImage?: () => Promise<string>
      awaitReady?: () => Promise<void>
      exec?: (cmd: string) => Promise<void>
    }, kind: 'create' | 'restart' = 'create'): {
      create: Promise<unknown>
      destroyed: string[]
      deregistered: string[]
    } {
      const id = kind === 'create' ? 'new' : 'parent'
      const destroyed: string[] = []
      const deregistered: string[] = []
      installFakeWorkspaceDriver({
        deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
        ...(driver.assertCanLaunch !== undefined ? { assertCanLaunch: driver.assertCanLaunch } : {}),
        ...(driver.prepareImage !== undefined ? { prepareImage: driver.prepareImage } : {}),
        launch: (spec) => {
          launched.push(spec.workspaceId)
          return Promise.resolve(handleFixture({ workspaceId: id, projectId: PROJ, jobName: `yaac-proj-${id}` }))
        },
        ...(driver.awaitReady !== undefined ? { awaitReady: driver.awaitReady } : {}),
        exec: async (_job, cmd) => {
          await driver.exec?.(cmd)
          return { stdout: '', stderr: '' }
        },
        findForTeardown: (asked) => Promise.resolve(asked === id
          ? { workspaceId: id, projectId: PROJ, unitName: `yaac-proj-${id}` }
          : undefined),
        destroy: (target) => {
          destroyed.push(target.unitName)
          return Promise.resolve(true)
        },
      })
      const create = (kind === 'restart'
        ? prepareRestart(local, id)
        : prepareStart(local, {
          projectId: PROJ,
          workspaceId: 'new',
          tool: 'claude',
          mode: 'tui',
          permissionMode: 'plan',
          prompt: 'build it',
          title: 'Build',
          rememberDefaults: false,
          claimSpare: false,
          draft: {},
        })).then((run) => run())
      create.catch(() => { /* asserted by the test */ })
      return { create, destroyed, deregistered }
    }

    // Stopped while its pod boots: the agent never starts, the create rolls
    // back, and the prompt survives as a draft with the create's settings.
    it('rolls it back before its agent starts and keeps its prompt as a draft', async () => {
      let boot!: () => void
      const booted = new Promise<void>((resolve) => { boot = resolve })
      const execs: string[] = []
      const { create, destroyed } = startCreate({
        awaitReady: () => booted,
        exec: (cmd) => { execs.push(cmd); return Promise.resolve() },
      })
      await vi.waitFor(() => expect(launched).toEqual(['new']), { timeout: 30_000 })

      expect(await stopWorkspace(local, 'new')).toEqual({ workspaceId: 'new', projectId: PROJ, provisioning: true })
      expect(listProvisioning()).toEqual([
        expect.objectContaining({ workspaceId: 'new', stopping: true, message: 'Stopping…' }),
      ])
      boot()

      await expect(create).rejects.toThrow('kept as a draft')
      expect(execs.some((cmd) => cmd.includes('respawn-window'))).toBe(false)
      expect(destroyed).toEqual(['yaac-proj-new'])
      // Dropped, not left as a failed row.
      expect(listProvisioning()).toEqual([])
      await vi.waitFor(async () => expect(await getWorkspaceRow(PROJ, 'new')).toBeUndefined())
      expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({
        projectId: PROJ, prompt: 'build it', title: 'Build', tool: 'claude', mode: 'tui', permissionMode: 'plan',
      })])
    })

    // Stopped before its row exists, by a prefix: nothing was made, so only
    // the draft is left.
    it('finds it by prefix before its row exists', async () => {
      let allow!: () => void
      const allowed = new Promise<void>((resolve) => { allow = resolve })
      let asked!: () => void
      const checking = new Promise<void>((resolve) => { asked = resolve })
      const { create } = startCreate({ assertCanLaunch: () => { asked(); return allowed } })
      await checking
      expect(await getWorkspaceRow(PROJ, 'new')).toBeUndefined()

      expect(await stopWorkspace(local, 'ne')).toEqual({ workspaceId: 'new', projectId: PROJ, provisioning: true })
      allow()

      await expect(create).rejects.toThrow('kept as a draft')
      expect(launched).toEqual([])
      expect(await getWorkspaceRow(PROJ, 'new')).toBeUndefined()
      expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({ prompt: 'build it' })])
    })

    // Stopped during an image build that then fails: the build's error is
    // the outcome, not a rollback, so no draft joins whatever it left.
    it('keeps the failure, and makes no draft, when the create fails on its own', async () => {
      let fail!: (err: Error) => void
      let building!: () => void
      const started = new Promise<void>((resolve) => { building = resolve })
      const { create } = startCreate({
        prepareImage: () => new Promise((_, reject) => { fail = reject; building() }),
      })
      await started

      expect(await stopWorkspace(local, 'new')).toMatchObject({ provisioning: true })
      fail(new Error('image build failed'))

      await expect(create).rejects.toThrow('image build failed')
      expect(launched).toEqual([])
      expect(listProvisioning()).toEqual([])
      expect(await listDraftWorkspaces()).toEqual([])
    })

    // Stopped (twice) once its agent is starting: too late to roll back, so
    // the create or restart finishes and is then stopped, once, like any
    // running workspace. The agent-alive probe then finds the agent gone,
    // which is the stop's doing and not a failed launch.
    it.each(['create', 'restart'] as const)('stops a %s past its last checkpoint once it is up', async (kind) => {
      const id = kind === 'create' ? 'new' : 'parent'
      /** Teardowns before the stop's own (a restart tears down first). */
      let before = 0
      let agentStarting!: () => void
      const starting = new Promise<void>((resolve) => { agentStarting = resolve })
      let release!: () => void
      const released = new Promise<void>((resolve) => { release = resolve })
      let probed!: () => void
      const probeFailed = new Promise<void>((resolve) => { probed = resolve })
      const { create, destroyed, deregistered } = startCreate({
        exec: async (cmd) => {
          if (cmd.includes('list-windows -t =yaac')) {
            await vi.waitFor(() => expect(deregistered.length).toBeGreaterThan(before), { timeout: 30_000 })
            probed()
            throw new WorkspaceExecError('probe', 1, '', 'no server running')
          }
          if (!cmd.includes('respawn-window')) return
          before = deregistered.length
          agentStarting()
          await released
        },
      }, kind)
      await starting

      expect(await stopWorkspace(local, id)).toMatchObject({ provisioning: true })
      expect(await stopWorkspace(local, id)).toMatchObject({ provisioning: true })
      release()

      await expect(create).resolves.toMatchObject({ workspaceId: id })
      await probeFailed
      await vi.waitFor(async () => expect((await getWorkspaceRow(PROJ, id))?.stoppedAt).toBeDefined())
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(listProvisioning()).toEqual([])
      expect(deregistered.slice(before)).toEqual([id])
      expect(destroyed).toEqual([])
      expect(await listDraftWorkspaces()).toEqual([])
    })
  })

  it('refuses a workspace with nothing running', async () => {
    await expect(stopWorkspace(local, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

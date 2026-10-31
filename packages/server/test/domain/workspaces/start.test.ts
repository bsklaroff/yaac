import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as childProcessModule from 'node:child_process'

/** While set, a `git fetch` never answers: an origin too slow to wait on. */
const slowOrigin = vi.hoisted(() => ({ hang: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  const execFile = (...args: Parameters<typeof actual.execFile>): ReturnType<typeof actual.execFile> => {
    const [file, argv] = args as unknown as [string, string[] | undefined]
    if (slowOrigin.hang && file === 'git' && argv?.includes('fetch')) return {} as ReturnType<typeof actual.execFile>
    return actual.execFile(...args)
  }
  return { ...actual, execFile }
})
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  listDraftWorkspaces,
  listProvisioning,
  listQueuedWorkspaces,
  prepareStart,
  queueWorkspace,
  reconcilePrewarmPool,
  saveDraftWorkspace,
  stopWorkspace,
} from '#domain/workspaces'
import { _clearTerminatingForTests } from '#runtime/status/terminating'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { clearPrewarmStateForTests, refreshing } from '#domain/workspaces/prewarm'
import { setWorkspaceBinDir } from '#domain/workspaces/workspace-bin'
import type { StartWorkspaceRequest } from '#domain/workspaces/start'
import type { WorkspaceCreateResult } from '#domain/workspaces/create'
import { setScratchDirs, setProjectEnvVar } from '#domain/projects'
import { _clearTmuxAliveCacheForTests } from '#runtime/status/liveness'
import { _resetAcpRegistryForTests, registerAcpConversation } from '#runtime/agents/acp-registry'
import type { AcpConversation } from '#runtime/agents'
import { serverLog } from '#lib/log'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { DEMO_PROJECT_ID, recordTestProject, seedProject } from '@yaac/test-utils/project-fixture'
import {
  handleFixture,
  installFakeWorkspaceDriver,
  resetWorkspaceDriver,
  snapshotFixture,
  substrateFixture,
} from '#test/support/fake-driver'
import {
  cachedPackagesDir,
  claudeDir,
  codexDir,
  opencodeCheckpointDir,
  opencodeConfigDir,
  opencodeDataDir,
  piDir,
  repoDir,
  workspaceDir,
  workspaceStateDir,
} from '@yaac/shared/project-paths'
import { CONTAINER_TMUX_DIR, projectConfigDir } from '@yaac/shared/paths'
import {
  PLACEHOLDER_API_KEY, PLACEHOLDER_GH_TOKEN, PLACEHOLDER_OPENCODE_API_KEY, PLACEHOLDER_PI_API_KEY,
} from '@yaac/shared/tool-auth'
import { closeDb } from '#db/client'
import {
  BUILT_IN_USER_ID,
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  getWorkspaceRow,
  insertGitCredential,
  listWorkspaceConversations,
  listWorkspaceGroupRows,
  listWorkspaceSessions,
  setGitIdentity,
  setProjectEgressAllowlist,
  setProjectGitCredential,
  setTimeZone,
  setWorkspaceGroupLimit,
  seeTailnetUser,
  setToolCredential,
  type SessionRow,
  type WorkspaceRow,
} from '#db'
import { getProjectRow, recordProject, recordProjectCreate } from '#db/project-store'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import { EFFORTS } from '@yaac/shared/tool-providers.generated'
import { ServerError } from '@yaac/shared/errors'
import {
  KEEPER_STARTING,
  KEEPER_WINDOW,
  WorkspaceExecError,
  type RuntimeHandle,
  type WorkspaceDriver,
  type WorkspaceRegistration,
  type WorkspaceSpec,
} from '#drivers/contract'
import type { AgentTool, YaacConfig } from '@yaac/shared/types'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

/** Store the built-in user's api key for a tool, with its provider where
 *  the tool needs one. */
async function saveToolAuth(tool: AgentTool, apiKey: string, provider?: string): Promise<void> {
  if (tool === 'opencode' || tool === 'pi') {
    await setToolCredential(BUILT_IN_USER_ID, tool, { kind: 'api-key', provider: provider as never, savedAt: 'x', apiKey })
  } else {
    await setToolCredential(BUILT_IN_USER_ID, tool, { kind: 'api-key', savedAt: 'x', apiKey })
  }
}

/**
 * Starts run to completion against a fake runtime over a real project
 * (`seedProject`) and a real database. The assertions land on what reaches
 * the runtime (the launch spec, the commands run in the workspace, the
 * registrations) and on the rows.
 *
 * The fake runtime keeps the units it launched, so a spare the pool warms
 * is listed, claimed and torn down like a real one.
 */
describe('prepareStart', () => {
  let tmpDir: string
  let specs: WorkspaceSpec[]
  let execs: Array<{ jobName: string; cmd: string }>
  /** Each teardown's `unitOnly`: true keeps the prepared substrate. */
  let destroys: boolean[]
  let deregistered: string[]
  let registrations: WorkspaceRegistration[]
  let units: RuntimeHandle[]
  let claims: string[]
  /** What `rev-parse HEAD` reads in a workspace; origin's main unless a case
   *  moves it. */
  let head: string

  /** The conversation an acp agent brings up, for cases about other things. */
  const upConversation = { whenReady: () => Promise.resolve(), prompt: () => Promise.resolve() } as unknown as AcpConversation

  /** Install the fake runtime; `overrides` replace verbs for one case. */
  function installDriver(overrides: Partial<WorkspaceDriver> = {}): void {
    installFakeWorkspaceDriver({
      launch: (spec) => {
        specs.push(spec)
        spec.onProgress?.('launching')
        const unit = handleFixture({
          workspaceId: spec.workspaceId,
          projectId: spec.projectId,
          jobName: `yaac-demo-${spec.workspaceId}`,
          prewarmed: spec.prewarm,
          createdAtMs: Date.now(),
        })
        units.push(unit)
        return Promise.resolve(unit)
      },
      list: (projectId) => Promise.resolve(units.filter((u) => projectId === undefined || u.projectId === projectId)),
      find: (id) => Promise.resolve(units.find((u) => u.workspaceId === id)),
      findForTeardown: (id) => {
        const u = units.find((x) => x.workspaceId === id)
        return Promise.resolve(u && { workspaceId: u.workspaceId, projectId: u.projectId, unitName: u.jobName })
      },
      exec: (jobName, cmd) => {
        execs.push({ jobName, cmd })
        // An acp agent's conversation is up as soon as a create looks for it,
        // so the create's watch on its window settles.
        const window = /display-message -p -t yaac:(\S+) '#\{pane_pid\}'/.exec(cmd)?.[1]
        if (window !== undefined) {
          const workspaceId = jobName.slice('yaac-demo-'.length)
          registerAcpConversation(DEMO_PROJECT_ID, workspaceId, { handle: window, conversationId: `acp-${workspaceId}`, panePid: '42' }, upConversation)
          return Promise.resolve({ stdout: '42\n', stderr: '' })
        }
        const stdout = cmd.includes('rev-parse -q --verify HEAD') ? `${head}\n` : ''
        return Promise.resolve({ stdout, stderr: '' })
      },
      registerWorkspace: (registration) => { registrations.push(registration); return Promise.resolve() },
      claimSpare: (id) => {
        claims.push(id)
        const unit = units.find((u) => u.workspaceId === id)
        if (unit) Object.assign(unit, { prewarmed: false })
        return Promise.resolve()
      },
      destroy: (target, opts) => {
        destroys.push(opts?.unitOnly === true)
        units = units.filter((u) => u.workspaceId !== target.workspaceId)
        return Promise.resolve(true)
      },
      deregisterWorkspace: (id) => { deregistered.push(id); return Promise.resolve() },
      ...overrides,
    })
  }

  /** A start as the create route makes one, with no spare unless asked. */
  async function start(
    over: Partial<StartWorkspaceRequest> & { onProgress?: (message: string) => void } = {},
  ): Promise<WorkspaceCreateResult> {
    const { onProgress, ...request } = over
    const run = await prepareStart(local, {
      projectId: DEMO_PROJECT_ID,
      workspaceId: randomUUID(),
      mode: 'tui',
      rememberDefaults: false,
      claimSpare: false,
      ...request,
    })
    return await run(onProgress)
  }

  /** A member of `groupId` the runtime runs, as a create leaves one. */
  async function running(groupId: string): Promise<void> {
    await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'running', groupId })
    units.push(handleFixture({ workspaceId: 'running', projectId: DEMO_PROJECT_ID, jobName: 'yaac-demo-running' }))
  }

  const env = (): string[] => specs.at(-1)!.env
  const cmds = (): string[] => execs.map((e) => e.cmd)
  const execOf = (needle: string): string | undefined => cmds().find((c) => c.includes(needle))
  /** The command that opened a session's window. */
  const SESSION_WINDOW = / -n (claude|codex|opencode|pi)-[0-9a-f]{8} /
  const sessionExec = (): string | undefined => cmds().find((c) => SESSION_WINDOW.test(c))

  async function writeConfig(config: YaacConfig): Promise<void> {
    await fs.mkdir(projectConfigDir(DEMO_PROJECT_ID), { recursive: true })
    await fs.writeFile(path.join(projectConfigDir(DEMO_PROJECT_ID), 'yaac-config.json'), JSON.stringify(config))
  }

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await seedProject()
    head = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'origin/main'])).trim()
    specs = []
    execs = []
    destroys = []
    deregistered = []
    registrations = []
    units = []
    claims = []
    clearAllProvisioningForTests()
    clearPrewarmStateForTests()
    _clearTmuxAliveCacheForTests()
    _resetAcpRegistryForTests()
    installDriver()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    setWorkspaceBinDir(null)
    clearAllProvisioningForTests()
    resetWorkspaceDriver()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  /**
   * Each setting is the request's, else what the project last used for
   * that agent, else the fallback. No credentials are stored, so the model
   * falls back to the tool's default.
   */
  describe('settings', () => {
    /** What a start resolved to, as its session records it. The create
     *  stops at its first runtime call after opening the session. */
    const settled = async (
      over: Partial<StartWorkspaceRequest> = {},
      driver: Partial<WorkspaceDriver> = {},
    ): Promise<SessionRow> => {
      const workspaceId = randomUUID()
      let opened: SessionRow | undefined
      const stop = async (): Promise<never> => {
        opened = (await listWorkspaceSessions(workspaceId))[0]
        throw new Error('stop here')
      }
      installDriver({ ...driver, prepareImage: stop, prepareSubstrate: stop })
      await expect(start({ ...over, workspaceId })).rejects.toThrow('stop here')
      return opened!
    }

    it('falls back per field when nothing is remembered, the posture from the driver', async () => {
      expect(await settled({ mode: undefined })).toMatchObject({
        tool: 'claude',
        model: FALLBACK_MODELS.claude,
        permissionMode: 'bypass',
        effort: EFFORTS.claude[FALLBACK_MODELS.claude].default,
        mode: 'acp',
      })
      // In a container, prompting protects nothing. Containerless runs as
      // the user on their machine, so shells and out-of-tree writes ask; pi
      // has no permission system, so it is always bypass.
      expect(await settled({ tool: 'codex' }, { kind: 'containerless' })).toMatchObject({
        model: FALLBACK_MODELS.codex, permissionMode: 'accept-edits',
      })
      expect((await settled({ tool: 'pi' }, { kind: 'containerless' })).permissionMode).toBe('bypass')
    })

    it('reopens on the last agent and what it was last created with, the request first', async () => {
      await recordProjectCreate(DEMO_PROJECT_ID, 'claude', { model: 'claude-sonnet-5', permissionMode: 'plan' })
      await recordProjectCreate(DEMO_PROJECT_ID, 'codex', { model: 'gpt-5.5', permissionMode: 'plan', mode: 'tui' })

      // codex lacks `plan`, so the nearest stricter mode, `read-only`, is used.
      expect(await settled({ mode: undefined })).toMatchObject({
        tool: 'codex', model: 'gpt-5.5', permissionMode: 'read-only', effort: EFFORTS.codex['gpt-5.5'].default, mode: 'tui',
      })
      // Each agent has its own remembered settings.
      expect(await settled({ tool: 'claude' })).toMatchObject({ model: 'claude-sonnet-5', permissionMode: 'plan' })
      expect(await settled({ tool: 'claude', model: 'claude-opus-5', permissionMode: 'manual' }))
        .toMatchObject({ model: 'claude-opus-5', permissionMode: 'manual' })
      // Only a person's create is remembered.
      expect((await getProjectRow(DEMO_PROJECT_ID))?.createDefaults.claude)
        .toEqual({ model: 'claude-sonnet-5', permissionMode: 'plan' })
    })

    // docs/effort-levels.md. One level name means the same across a tool's
    // models, so a remembered effort carries to any model that has it.
    it('resolves effort per model: named if it has it, else remembered if it has it, else its default', async () => {
      await recordProjectCreate(DEMO_PROJECT_ID, 'claude', { effort: 'max' })
      expect((await settled({ tool: 'claude', model: 'claude-opus-4-6' })).effort).toBe('max')
      await recordProjectCreate(DEMO_PROJECT_ID, 'claude', { effort: 'xhigh' })
      // opus-4-6 has no xhigh: its own default instead.
      expect((await settled({ tool: 'claude', model: 'claude-opus-4-6' })).effort).toBe('high')
      // Claude Code offers opus-4-5 no effort at all.
      expect((await settled({ tool: 'claude', model: 'claude-opus-4-5' })).effort).toBeUndefined()

      expect((await settled({ tool: 'claude', model: 'claude-opus-4-6', effort: 'low' })).effort).toBe('low')
      // A model outside the catalog is the tool's to judge, like the model.
      expect((await settled({ tool: 'claude', model: 'opus', effort: 'ultra' })).effort).toBe('ultra')

      // Refused before anything shows.
      const shown = listProvisioning().length
      await expect(start({ tool: 'claude', model: 'claude-opus-4-6', effort: 'xhigh' }))
        .rejects.toThrow(/no "xhigh" effort; it supports: low, medium, high, max/)
      await expect(start({ tool: 'claude', model: 'claude-opus-4-5', effort: 'low' }))
        .rejects.toThrow(/has no effort setting/)
      expect(listProvisioning()).toHaveLength(shown)
    })

    it('refuses a named posture the agent lacks, under either UI, naming the ones it has', async () => {
      await expect(start({ tool: 'pi', permissionMode: 'plan' }))
        .rejects.toThrow(/pi has no "plan" permission mode; it supports: bypass/)
      await expect(start({ tool: 'codex', permissionMode: 'plan', mode: 'acp' }))
        .rejects.toThrow(/codex has no "plan"/)
      // opencode lacks `auto` but has the other modes.
      await expect(start({ tool: 'opencode', permissionMode: 'auto' })).rejects.toThrow(/no "auto"/)
      expect(listProvisioning()).toEqual([])
      expect((await settled({ tool: 'opencode', permissionMode: 'plan' })).permissionMode).toBe('plan')
    })

    it('remembers what a person named, and only that, with the branch', async () => {
      await start({ tool: 'codex', permissionMode: 'accept-edits', branch: 'dev', rememberDefaults: true })
      expect(await getProjectRow(DEMO_PROJECT_ID)).toMatchObject({
        lastTool: 'codex',
        lastBranch: 'dev',
        createDefaults: { codex: { permissionMode: 'accept-edits', mode: 'tui' } },
      })
    })

    it('files the workspace by group name, creating the group only for a start that checks out', async () => {
      await expect(start({ tool: 'pi', permissionMode: 'plan', group: 'Reviews' })).rejects.toThrow()
      expect(await listWorkspaceGroupRows(DEMO_PROJECT_ID)).toEqual([])

      const { workspaceId } = await start({ group: 'Reviews', title: 'Port the lexer' })
      const [group] = await listWorkspaceGroupRows(DEMO_PROJECT_ID)
      expect(group).toMatchObject({ name: 'Reviews' })
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, workspaceId)).toMatchObject({
        groupId: group.groupId, title: 'Port the lexer',
      })
      // An id names the same group.
      const again = await start({ group: group.groupId })
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, again.workspaceId))?.groupId).toBe(group.groupId)
    })

    // A queued entry files under the group it was queued into, which may be
    // deleted just before its launch. Resolving the id as a name would make
    // a stray group named after it; the workspace lands ungrouped instead.
    it('files under a given group id as is, never creating one', async () => {
      const { workspaceId } = await start({ groupId: 'deleted-group' })
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, workspaceId))?.groupId).toBeUndefined()
      expect(await listWorkspaceGroupRows(DEMO_PROJECT_ID)).toEqual([])
    })

    it('refuses an id still provisioning before making its group or remembering defaults', async () => {
      const workspaceId = randomUUID()
      const request = { projectId: DEMO_PROJECT_ID, workspaceId, mode: 'tui', claimSpare: false } as const
      await prepareStart(local, { ...request, rememberDefaults: false })
      await expect(prepareStart(local, { ...request, tool: 'codex', group: 'Dupes', rememberDefaults: true }))
        .rejects.toMatchObject({ code: 'CONFLICT' })
      expect(await listWorkspaceGroupRows(DEMO_PROJECT_ID)).toEqual([])
      expect((await getProjectRow(DEMO_PROJECT_ID))?.lastTool).toBeUndefined()
    })
  })

  // docs/workspace-groups.md
  describe('into a group with a workspace limit', () => {
    async function limited(limit: number): Promise<string> {
      const { groupId } = await createWorkspaceGroup(DEMO_PROJECT_ID, 'Workers', null)
      await setWorkspaceGroupLimit(DEMO_PROJECT_ID, groupId, limit)
      return groupId
    }
    const prepare = (groupId: string, over: Partial<StartWorkspaceRequest> = {}) => prepareStart(local, {
      projectId: DEMO_PROJECT_ID, workspaceId: randomUUID(), mode: 'tui', rememberDefaults: false, claimSpare: false,
      groupId, ...over,
    })

    it('counts running members and creates in flight, not stopped members, and frees a failed create\'s slot at once', async () => {
      const groupId = await limited(3)
      await running(groupId)
      await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'stopped', groupId })
      await recordWorkspaceStopped(DEMO_PROJECT_ID, 'stopped')
      await prepare(groupId)
      const failing = await prepare(groupId)
      const shown = listProvisioning().length

      await expect(prepare(groupId, { tool: 'codex', rememberDefaults: true })).rejects.toMatchObject({
        code: 'CONFLICT', message: expect.stringMatching(/group "Workers" is at its workspace limit of 3 \(running or starting\)/) as string,
      })
      // Refused before anything shows or is remembered.
      expect(listProvisioning()).toHaveLength(shown)
      expect((await getProjectRow(DEMO_PROJECT_ID))?.lastTool).toBeUndefined()

      // The failure frees its slot, and what waits for room takes it.
      const waiting = await queueWorkspace(local, DEMO_PROJECT_ID, { prompt: 'waiting', group: groupId, mode: 'tui' }, 'user')
      installDriver({ prepareImage: () => { installDriver(); throw new Error('no image') } })
      await expect(failing()).rejects.toThrow('no image')
      await vi.waitFor(async () => { expect((await listQueuedWorkspaces()).map((e) => e.id)).not.toContain(waiting.id) })
      await vi.waitFor(() => { expect(listProvisioning().some((p) => p.prompt === 'waiting')).toBe(false) }, { timeout: 30_000 })
    })

    it('lets only one of two concurrent creates take the last free slot', async () => {
      const groupId = await limited(2)
      await running(groupId)
      const outcomes = await Promise.allSettled([prepare(groupId), prepare(groupId), prepare(groupId)])
      expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected', 'rejected'])
      expect(listProvisioning().filter((p) => p.groupId === groupId)).toHaveLength(1)
    })
  })

  describe('a cold create', () => {
    it('checks out the requested branch, records the row and conversation, and launches the agent', async () => {
      // What the driver reports while it prepares reaches the caller too.
      let row: ReturnType<typeof listProvisioning>[number] | undefined
      installDriver({
        prepareImage: (o) => {
          row = listProvisioning()[0]
          o.onProgress?.('image ready')
          return Promise.resolve('img')
        },
        prepareSubstrate: (i) => { i.onProgress?.('substrate ready'); return Promise.resolve(substrateFixture()) },
      })
      const progress: string[] = []
      const result = await start({
        tool: 'codex', branch: 'dev', model: 'gpt-6-sol', prompt: 'ship it',
        onProgress: (m) => progress.push(m),
      })
      const { workspaceId } = result

      const [session] = await listWorkspaceSessions(workspaceId)
      expect(result).toEqual({ workspaceId, jobName: `yaac-demo-${workspaceId}`, forwardedPorts: [], sessionId: session.id })
      // The row names what is coming up before any agent has answered, and
      // goes once the workspace is up.
      expect(row).toMatchObject({ workspaceId, kind: 'create', tool: 'codex', prompt: 'ship it', model: 'gpt-6-sol' })
      expect(listProvisioning()).toEqual([])
      expect(await git(workspaceDir(DEMO_PROJECT_ID, workspaceId), ['rev-parse', '--abbrev-ref', 'HEAD']))
        .toBe(`agent/${workspaceId}\n`)
      // Stored up front: a workspace queued while this one boots defaults to
      // its branch. The session keeps the user's choices for a restart.
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, workspaceId))?.baseBranch).toBe('dev')
      expect(session).toMatchObject({
        tool: 'codex', mode: 'tui', permissionMode: 'bypass', model: 'gpt-6-sol', firstPrompt: 'ship it',
      })
      expect((await listWorkspaceSessions(workspaceId))[0]?.launchedAt).toBeInstanceOf(Date)
      expect(progress).toEqual(expect.arrayContaining([
        'image ready', 'substrate ready', 'launching', 'Creating workspace from dev...', 'Starting Codex...',
        'Sending initial prompt...',
      ]))
      // No spare was looked for.
      expect(claims).toEqual([])

      // The clone borrows from the main clone at the path the server sees it
      // at, mounted read-only there. The checkout wrote that itself, so
      // nothing relinks it, and a pod's file cache is warmed in the command
      // that starts the agent.
      expect(await fs.readFile(path.join(workspaceDir(DEMO_PROJECT_ID, workspaceId), '.git', 'objects', 'info', 'alternates'), 'utf8'))
        .toBe(`${repoDir(DEMO_PROJECT_ID)}/.git/objects\n`)
      expect(execOf('objects/info/alternates')).toBeUndefined()
      expect(sessionExec()).toContain('--no-optional-locks status')
      const { mounts, postStartExec, preStopExec } = specs[0]
      expect(mounts).toContainEqual({
        source: { kind: 'hostPath', path: `${repoDir(DEMO_PROJECT_ID)}/.git` },
        mountPath: `${repoDir(DEMO_PROJECT_ID)}/.git`,
        readOnly: true,
      })
      // The tmux socket needs no host dir: every client reaches it in-pod.
      expect(mounts).toContainEqual({ source: { kind: 'emptyDir' }, mountPath: CONTAINER_TMUX_DIR })
      // claude names its presence files by pid, and claudes in different
      // pods often get the same pid, so each pod gets a sessions/ of its own
      // over the project's claude home, made server-owned before launch.
      const claudeSessions = path.join(workspaceStateDir(DEMO_PROJECT_ID, workspaceId), 'claude-sessions')
      expect(mounts).toContainEqual({
        source: { kind: 'hostPath', path: claudeSessions }, mountPath: '/home/yaac/.claude/sessions',
      })
      expect((await fs.stat(claudeSessions)).isDirectory()).toBe(true)
      expect((await fs.stat(path.join(claudeDir(DEMO_PROJECT_ID), 'sessions'))).isDirectory()).toBe(true)
      expect(postStartExec).toEqual(['/usr/local/bin/yaac-workspace-init'])
      // The shipped helper commands are mounted where the agent finds them.
      const helpers = mounts.map((m) => m.mountPath).filter((p) => p.startsWith('/usr/local/bin/'))
      expect(helpers).toEqual(expect.arrayContaining(['/usr/local/bin/yaac-mama', '/usr/local/bin/yaac-watch-prs']))
      expect(preStopExec).toEqual(['/usr/local/bin/yaac-opencode-checkpoint', 'stop'])
      // Every tool's home is mounted whatever the tool, since spares are
      // retoolable. A package tree shared by every pod would be a channel
      // between them, so the project's package cache is not.
      const sources = mounts.flatMap((m) => (m.source.kind === 'hostPath' ? [m.source.path] : []))
      expect(sources).toEqual(expect.arrayContaining([
        claudeDir(DEMO_PROJECT_ID), codexDir(DEMO_PROJECT_ID), opencodeConfigDir(DEMO_PROJECT_ID), piDir(DEMO_PROJECT_ID),
        opencodeCheckpointDir(DEMO_PROJECT_ID, workspaceId), opencodeDataDir(DEMO_PROJECT_ID, workspaceId),
      ]))
      expect(sources).not.toContain(cachedPackagesDir(DEMO_PROJECT_ID))
      expect(env()).toEqual(expect.arrayContaining([
        `YAAC_WORKSPACE_ID=${workspaceId}`, 'YAAC_GIT_NAME=Ada', 'YAAC_GIT_EMAIL=ada@example.com',
        `YAAC_STATUS_RIGHT= ${workspaceId.slice(0, 8)} `,
      ]))
      expect(sessionExec()).toMatch(/ -n codex-[0-9a-f]{8} [^']*'[^']*exec codex .* --yolo --model gpt-6-sol'/)
      // The workspace runs as the server's uid, so a chown would only corrupt
      // host-side ownership.
      expect(cmds().some((c) => c.includes('chown') || c.startsWith('sudo '))).toBe(false)
      // Onboarding state is seeded whatever the tool, since spares are
      // retoolable.
      const claudeJson = JSON.parse(
        await fs.readFile(path.join(claudeDir(DEMO_PROJECT_ID), '.claude.json'), 'utf8'),
      ) as { hasCompletedOnboarding?: boolean }
      expect(claudeJson.hasCompletedOnboarding).toBe(true)
    })

    it('spends the project owner\'s credentials: its egress registration names the owner, and no other user\'s key is seeded', async () => {
      const owners: string[] = []
      installDriver({ prepareSubstrate: (i) => { owners.push(i.owner); return Promise.resolve(substrateFixture()) } })
      await setToolCredential(await seeTailnetUser('bob@example.com', 'Bob'), 'claude', { kind: 'api-key', savedAt: 'x', apiKey: 'sk-bob' })

      await start({ tool: 'claude' })

      // The built-in user's credentials are filed under `install`.
      expect(owners).toEqual(['install'])
      expect(env().map((e) => e.split('=')[0])).not.toContain('ANTHROPIC_API_KEY')
    })

    // Every credentialed tool's key is seeded on any workspace (a spare may be
    // retooled at claim), as a placeholder the proxy swaps. opencode and pi
    // each read theirs from a variable of their own, so neither collides with
    // claude's or codex's.
    it.each<{ name: string; tool: AgentTool; key: string; kind: 'api-key' | 'oauth'; provider?: string; want: Record<string, string>; not: string[] }>([
      { name: 'claude api key', tool: 'claude', key: 'sk-ant', kind: 'api-key', want: { ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY }, not: [] },
      { name: 'opencode on openrouter', tool: 'opencode', key: 'sk-or', kind: 'api-key', provider: 'openrouter', want: { YAAC_OPENCODE_KEY_OPENROUTER: PLACEHOLDER_OPENCODE_API_KEY, OPENCODE_CONFIG: '/home/yaac/.config/opencode/yaac-keys/openrouter.json' }, not: ['OPENROUTER_API_KEY'] },
      { name: 'opencode on neuralwatt', tool: 'opencode', key: 'nw', kind: 'api-key', provider: 'neuralwatt', want: { YAAC_OPENCODE_KEY_NEURALWATT: PLACEHOLDER_OPENCODE_API_KEY }, not: ['NEURALWATT_API_KEY', 'YAAC_OPENCODE_KEY_OPENROUTER'] },
      { name: 'pi on anthropic', tool: 'pi', key: 'sk-ant', kind: 'api-key', provider: 'anthropic', want: { YAAC_PI_KEY_ANTHROPIC: PLACEHOLDER_PI_API_KEY }, not: ['ANTHROPIC_API_KEY'] },
      { name: 'codex api key', tool: 'codex', key: 'sk-oai', kind: 'api-key', want: { OPENAI_API_KEY: PLACEHOLDER_API_KEY }, not: [] },
      // Under codex OAuth this var would switch it into api-key mode.
      { name: 'codex OAuth', tool: 'codex', key: 'access', kind: 'oauth', want: {}, not: ['OPENAI_API_KEY'] },
    ])('seeds the env a $name credential needs, on a workspace of any tool', async ({ tool, key, kind, provider, want, not }) => {
      if (kind === 'oauth') {
        await setToolCredential(BUILT_IN_USER_ID, 'codex', { kind: 'oauth', savedAt: 'x', codexOauth: {
          accessToken: key, refreshToken: 'r', idTokenRawJwt: 'h.p.s', expiresAt: 0, lastRefresh: '2026-01-01T00:00:00.000Z',
        } })
      } else {
        await saveToolAuth(tool, key, provider)
      }
      await start({ tool: 'claude' })

      expect(env()).toEqual(expect.arrayContaining(Object.entries(want).map(([name, value]) => `${name}=${value}`)))
      expect(specs[0].secretEnvKeys).toEqual(expect.arrayContaining(Object.keys(want).filter((n) => n !== 'OPENCODE_CONFIG')))
      const names = env().map((e) => e.split('=')[0])
      for (const name of not) expect(names).not.toContain(name)
      expect(env()).toEqual(expect.arrayContaining([
        'OPENCODE_DISABLE_AUTOUPDATE=1', 'PI_CODING_AGENT_SESSION_DIR=/home/yaac/.yaac-pi-sessions', 'PI_SKIP_VERSION_CHECK=1',
      ]))
    })

    it('gives opencode and pi each their own key for one provider, in the config each tool reads', async () => {
      installDriver({ kind: 'containerless' })
      await saveToolAuth('opencode', 'sk-or-oc', 'openrouter')
      await saveToolAuth('pi', 'sk-or-pi', 'openrouter')
      // A user's own pi config is kept.
      const models = path.join(piDir(DEMO_PROJECT_ID), 'agent', 'models.json')
      await fs.mkdir(path.dirname(models), { recursive: true })
      await fs.writeFile(models, JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }))

      await start({ tool: 'claude' })

      expect(env()).toEqual(expect.arrayContaining([
        'YAAC_OPENCODE_KEY_OPENROUTER=sk-or-oc', 'YAAC_PI_KEY_OPENROUTER=sk-or-pi',
      ]))
      expect(env().map((e) => e.split('=')[0])).not.toContain('OPENROUTER_API_KEY')
      expect(JSON.parse(await fs.readFile(path.join(opencodeConfigDir(DEMO_PROJECT_ID), 'yaac-keys', 'openrouter.json'), 'utf8')))
        .toEqual({ provider: { openrouter: { env: ['YAAC_OPENCODE_KEY_OPENROUTER', 'OPENROUTER_API_KEY'] } } })
      expect(JSON.parse(await fs.readFile(models, 'utf8'))).toEqual({ providers: {
        ollama: { baseUrl: 'http://localhost:11434/v1' },
        openrouter: { apiKey: '!printenv YAAC_PI_KEY_OPENROUTER || printenv OPENROUTER_API_KEY' },
      } })
    })

    it('lets a project override TZ and OPENCODE_CONFIG, takes a variable matching yaac\'s, and refuses one that conflicts', async () => {
      await setTimeZone(BUILT_IN_USER_ID, 'Asia/Tokyo', false)
      await saveToolAuth('opencode', 'sk-or', 'openrouter')
      await setProjectEnvVar(local, DEMO_PROJECT_ID, { name: 'TZ', value: 'Europe/Paris' })
      await setProjectEnvVar(local, DEMO_PROJECT_ID, { name: 'OPENCODE_CONFIG', value: '/workspace/opencode.json' })
      await setProjectEnvVar(local, DEMO_PROJECT_ID, { name: 'OPENCODE_DISABLE_AUTOUPDATE', value: '1' })
      await start()
      expect(env().filter((e) => e.startsWith('TZ='))).toEqual(['TZ=Europe/Paris'])
      expect(env().filter((e) => e.startsWith('OPENCODE_CONFIG='))).toEqual(['OPENCODE_CONFIG=/workspace/opencode.json'])

      await setProjectEnvVar(local, DEMO_PROJECT_ID, { name: 'PI_SKIP_VERSION_CHECK', value: '0' })
      await expect(start()).rejects.toThrow(
        "the project's environment variable PI_SKIP_VERSION_CHECK conflicts with the value yaac sets for it",
      )
      // Refused before anything launched.
      expect(specs).toHaveLength(1)
    })

    // `gh` is logged in with the git token for a GitHub HTTPS remote, unless
    // the project wires a GitHub token of its own.
    it.each<{ name: string; remote?: string; plain?: string; secret?: string; want: string | undefined }>([
      { name: 'a github.com remote', want: PLACEHOLDER_GH_TOKEN },
      { name: 'a non-GitHub remote', remote: 'https://gitlab.com/o/r.git', want: undefined },
      { name: 'a project GH_TOKEN', plain: 'GH_TOKEN', want: 'ghp_user' },
      { name: 'a proxied GITHUB_TOKEN secret', secret: 'GITHUB_TOKEN', want: undefined },
    ])('seeds GH_TOKEN as it should for $name', async ({ remote, plain, secret, want }) => {
      if (remote !== undefined) await recordProject({ id: DEMO_PROJECT_ID, name: 'demo', remoteUrl: remote, addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
      if (plain !== undefined) await setProjectEnvVar(local, DEMO_PROJECT_ID, { name: plain, value: 'ghp_user' })
      if (secret !== undefined) {
        await setProjectEnvVar(local, DEMO_PROJECT_ID, { name: secret, value: 'sekrit', secret: true, rule: { hosts: ['api.github.com'] } })
      }

      await start()

      expect(env().find((e) => e.startsWith('GH_TOKEN='))?.slice('GH_TOKEN='.length)).toBe(want)
    })

    // The server setting is the only source. There is no fallback to the
    // server host's `git config --global`: only someone with a shell there
    // could change it, and under k8s the server pod's `$HOME` is ephemeral.
    it('refuses without a git identity, naming where a client can set one', async () => {
      await setGitIdentity(BUILT_IN_USER_ID, { name: ' ', email: ' ' })
      await expect(start()).rejects.toThrow(/owner has no git identity set.*Settings/)
      expect(specs).toEqual([])
    })

    it('seeds claude\'s config and settings, keeping what claude itself wrote', async () => {
      const home = claudeDir(DEMO_PROJECT_ID)
      const readJson = async (name: string): Promise<Record<string, unknown>> =>
        JSON.parse(await fs.readFile(path.join(home, name), 'utf8')) as Record<string, unknown>
      await fs.mkdir(home, { recursive: true })
      await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({
        oauthAccount: { uuid: 'x' },
        customApiKeyResponses: { approved: ['other-key'], rejected: ['nope'] },
      }))
      // A pod can plant a link in its tool home; following it would let every
      // create rewrite the file it names.
      const target = path.join(tmpDir, 'elsewhere')
      await fs.writeFile(target, 'not yours')
      await fs.symlink(target, path.join(home, 'settings.json'))

      await start()

      const config = await readJson('.claude.json')
      expect(config).toMatchObject({
        oauthAccount: { uuid: 'x' },
        hasCompletedOnboarding: true,
        projects: { '/workspace': { hasTrustDialogAccepted: true } },
        customApiKeyResponses: { approved: ['other-key', PLACEHOLDER_API_KEY], rejected: ['nope'] },
      })
      expect(typeof config.lastOnboardingVersion).toBe('string')
      expect(await fs.readFile(target, 'utf8')).toBe('not yours')
      expect((await fs.lstat(path.join(home, 'settings.json'))).isFile()).toBe(true)
      // Transcripts are kept for 100 years rather than claude's 30 days, and
      // worktrees, whose installs would land on the shared tier, are denied.
      const worktreeDeny = ['EnterWorktree', 'Agent(isolation:worktree)']
      expect(await readJson('settings.json')).toMatchObject({
        skipDangerousModePermissionPrompt: true, cleanupPeriodDays: 36500, permissions: { deny: worktreeDeny },
      })

      // An unreadable config starts over; settings keep their own keys.
      await fs.writeFile(path.join(home, '.claude.json'), 'not json{')
      await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({
        theme: 'dark', cleanupPeriodDays: 30, permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm *)', 'EnterWorktree'] },
      }))
      await start()
      expect(await readJson('.claude.json')).toMatchObject({ hasCompletedOnboarding: true })
      expect(await readJson('settings.json')).toMatchObject({
        theme: 'dark', cleanupPeriodDays: 36500,
        permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm *)', ...worktreeDeny] },
      })
    })

    it('trusts each containerless checkout where it is, keeping every root when creates run at once', async () => {
      // A containerless agent runs in the real checkout, so a `/workspace`
      // entry would match nothing. The project's workspaces share one
      // claude.json, and a lost entry opens claude's trust dialog. Asked for
      // a spare, it creates cold: containerless keeps no pool.
      const list = vi.fn(() => Promise.resolve([]))
      installDriver({ kind: 'containerless', list })
      const created = await Promise.all([1, 2, 3].map(() => start({ claimSpare: true })))
      expect(list).not.toHaveBeenCalled()
      const config = JSON.parse(await fs.readFile(path.join(claudeDir(DEMO_PROJECT_ID), '.claude.json'), 'utf8')) as {
        projects: Record<string, unknown>
      }
      for (const { workspaceId } of created) {
        expect(config.projects[await fs.realpath(workspaceDir(DEMO_PROJECT_ID, workspaceId))]).toEqual({ hasTrustDialogAccepted: true })
      }
      expect(config.projects['/workspace']).toBeUndefined()
      // A worktree's own install is cheap on local disk, so worktrees stay.
      const settings = JSON.parse(await fs.readFile(path.join(claudeDir(DEMO_PROJECT_ID), 'settings.json'), 'utf8')) as object
      expect(settings).not.toHaveProperty('permissions')
    })

    it('stages the helper commands each launch, mounting each read-only onto /usr/local/bin', async () => {
      const src = path.join(tmpDir, 'workspace-bin')
      await fs.mkdir(path.join(src, 'subdir'), { recursive: true })
      for (const name of ['yaac-workspace-init', 'a-tool', '.hidden']) {
        await fs.writeFile(path.join(src, name), '#!/bin/sh\n', { mode: 0o600 })
      }
      setWorkspaceBinDir(src)
      const helpers = (): WorkspaceSpec['mounts'] =>
        specs.at(-1)!.mounts.filter((m) => m.mountPath.startsWith('/usr/local/bin/'))

      await start({ workspaceId: 'wt-bin' })

      // Regular files only, executable.
      expect(helpers().map((m) => m.mountPath)).toEqual(['/usr/local/bin/a-tool', '/usr/local/bin/yaac-workspace-init'])
      for (const { source, readOnly } of helpers()) {
        expect(source).toMatchObject({ kind: 'hostPath', type: 'File' })
        expect(readOnly).toBe(true)
        expect((await fs.stat((source as { path: string }).path)).mode & 0o777).toBe(0o755)
      }

      await fs.rm(path.join(src, 'a-tool'))
      await start({ workspaceId: 'wt-bin-2' })
      expect(helpers().map((m) => m.mountPath)).toEqual(['/usr/local/bin/yaac-workspace-init'])
    })

    // The window probe is not awaited, so a dead agent's verdict can land
    // after the create resolved. It waits for the create's run and then
    // files a failed row, which leaves the workspace to the reaper.
    it('reports an agent that died right after launch as a failed row, once the create has settled', async () => {
      // The create is held at its prompt delivery, after the probe fired.
      let probed = false
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      installDriver({
        exec: async (_jobName, cmd) => {
          if (cmd.includes('list-windows -t =yaac')) {
            probed = true
            throw new WorkspaceExecError('probe', 1, '', 'codex')
          }
          if (cmd.includes('.yaac-prompt-')) await held
          return { stdout: '', stderr: '' }
        },
      })

      const run = start({ workspaceId: 'wt-dead', tool: 'codex', prompt: 'go' })
      // Filed now, the verdict would be erased by the create's success.
      await vi.waitFor(() => { expect(probed).toBe(true) }, { timeout: 30_000 })
      await new Promise((r) => setTimeout(r, 50))
      expect(listProvisioning()[0]?.error).toBeUndefined()
      release()
      await run

      await vi.waitFor(() => {
        expect(listProvisioning()).toMatchObject([{ workspaceId: 'wt-dead', kind: 'create' }])
        expect(listProvisioning()[0]?.error).toMatch(/agent "codex-[0-9a-f]{8}" exited right after launch/)
      }, { timeout: 30_000 })
    })

    // A fresh chat conversation has no id until its agent answers
    // `session/new`, so a chat create returns without waiting for it and
    // leaves its prompt on the row, held before the agent starts so no sweep
    // can find the conversation first. The sweep that records the
    // conversation sends it (conversation-registry.test.ts).
    it('holds a chat workspace\'s prompt from before its agent starts, and returns without waiting for it', async () => {
      let heldAtLaunch: string | undefined
      let released!: () => void
      const agentUp = new Promise<void>((resolve) => { released = resolve })
      installDriver({
        exec: async (jobName, cmd) => {
          execs.push({ jobName, cmd })
          if (SESSION_WINDOW.test(cmd)) heldAtLaunch = (await listWorkspaceSessions('wt-chat'))[0]?.pendingPrompt
          const window = /display-message -p -t yaac:(\S+) '#\{pane_pid\}'/.exec(cmd)?.[1]
          if (window !== undefined) {
            void agentUp.then(() => registerAcpConversation(
              DEMO_PROJECT_ID, 'wt-chat', { handle: window, conversationId: 'minted', panePid: '42' }, upConversation,
            ))
            return { stdout: '42\n', stderr: '' }
          }
          return { stdout: '', stderr: '' }
        },
      })
      const progress: string[] = []
      expect(await start({ workspaceId: 'wt-chat', mode: 'acp', prompt: 'go', onProgress: (m) => progress.push(m) }))
        .toMatchObject({ workspaceId: 'wt-chat' })
      expect(heldAtLaunch).toBe('go')
      expect((await listWorkspaceSessions('wt-chat'))[0]?.pendingPrompt).toBe('go')
      expect(progress).not.toContain('Connecting to Claude Code...')
      released()
    })

    // The adapter can die after the create has returned, up to its
    // handshake (claude's fails at `session/new` on a bad login). That is
    // reported as a terminal agent's death is, naming the adapter, with the
    // prompt beside it.
    it('reports a chat agent whose adapter dies before its handshake as a failed create', async () => {
      installDriver({
        kind: 'containerless',
        exec: (jobName, cmd) => {
          execs.push({ jobName, cmd })
          return cmd.includes('list-windows -t =yaac')
            ? Promise.reject(new WorkspaceExecError('probe', 1, '', 'claude'))
            : Promise.resolve({ stdout: '', stderr: '' })
        },
      })
      expect(await start({ workspaceId: 'wt-acp-dead', mode: 'acp', prompt: 'go' })).toMatchObject({ workspaceId: 'wt-acp-dead' })
      await vi.waitFor(() => {
        expect(listProvisioning()).toMatchObject([{ workspaceId: 'wt-acp-dead', kind: 'create', prompt: 'go' }])
        expect(listProvisioning()[0]?.error).toMatch(/acp agent "claude-[0-9a-f]{8}" exited .*before its handshake.*@agentclientprotocol\/claude-agent-acp@/)
      }, { timeout: 30_000 })
    })

    // The user's stop takes the agent's window down too, and its teardown
    // mark is gone before the watch next looks, so the stop is read off the
    // row. Filed, it would show a stopped workspace as a failed create.
    it('does not report a chat agent the user stopped before its handshake', async () => {
      let stopped = false
      installDriver({
        kind: 'containerless',
        exec: (jobName, cmd) => {
          execs.push({ jobName, cmd })
          // A process no conversation comes up on.
          if (cmd.includes('#{pane_pid}')) return Promise.resolve({ stdout: '44\n', stderr: '' })
          return stopped && cmd.includes('list-windows -t =yaac')
            ? Promise.reject(new WorkspaceExecError('probe', 1, '', 'claude'))
            : Promise.resolve({ stdout: '', stderr: '' })
        },
      })
      await start({ workspaceId: 'wt-acp-stopped', mode: 'acp', prompt: 'go' })
      await stopWorkspace(local, 'wt-acp-stopped')
      stopped = true
      _clearTerminatingForTests()
      vi.mocked(serverLog).mockClear()

      await vi.waitFor(() => {
        expect(vi.mocked(serverLog).mock.calls.map(([m]) => m).join('\n')).toMatch(/wt-acp-stopped.*before its handshake/)
      }, { timeout: 10_000 })
      await new Promise((r) => setTimeout(r, 200))
      expect(listProvisioning()).toEqual([])
    })

    it('opens the init windows and declares the forwards before the agent starts', async () => {
      await writeConfig({
        initCommands: [
          { name: 'backend', commands: ['pnpm dev:backend'] },
          { name: 'frontend', commands: ['pnpm install', "echo 'hi'"], hidePane: true },
        ],
        portForward: [{ containerPort: 3000, hostPortStart: 3000 }],
      })

      const result = await start({ tool: 'claude', model: 'claude-opus-4-5' })

      // Clients bind the ports (docs/port-forward-tunnel.md); the create only
      // declares them.
      expect(result.forwardedPorts).toEqual([{ containerPort: 3000, hostPort: 3000 }])
      // Init windows and the agent respawn go in one exec. Only windows
      // without hidePane keep remain-on-exit.
      const windows = execOf('new-window')!
      expect(windows).toContain("-n backend \"${SHELL:-/bin/sh}\" -c 'cd /workspace && pnpm dev:backend'")
      expect(windows).toContain("-n frontend \"${SHELL:-/bin/sh}\" -c 'cd /workspace && pnpm install && echo '\\''hi'\\'''")
      expect(windows).toContain('set-option -t =yaac:=backend remain-on-exit on')
      expect(windows).not.toContain('=yaac:=frontend remain-on-exit on')
      expect(windows).toContain(`claude --permission-mode bypassPermissions --model claude-opus-4-5 --session-id ${result.sessionId}`)
    })

    it('starts a containerless chat agent alongside its checkout, holding its conversation until the checkout lands', async () => {
      await writeConfig({ initCommands: [{ name: 'backend', commands: ['pnpm dev:backend'] }] })
      installDriver({ kind: 'containerless' })
      await start({ workspaceId: 'wt-early', mode: 'acp' })

      // The agent's command goes first, on its own; acpd holds the
      // conversation until `.git` exists. The init windows read the
      // checkout, so they follow it.
      const agents = execs.findIndex(({ cmd }) => SESSION_WINDOW.test(cmd))
      const windows = execs.findIndex(({ cmd }) => cmd.includes('-n backend'))
      expect(execs[agents].cmd).toContain('--wait-for /workspace/.git --')
      expect(execs[agents].cmd).not.toContain('backend')
      expect(windows).toBeGreaterThan(agents)
      expect(execs[windows].cmd).not.toMatch(SESSION_WINDOW)

      // A terminal agent reads the checkout as it starts, so it waits for it.
      execs.length = 0
      await start({ workspaceId: 'wt-tui', mode: 'tui' })
      const tui = sessionExec()!
      expect(tui).toContain('-n backend')
      expect(tui).not.toContain('--wait-for')
    })

    it('refuses an init window named after any agent tool, before provisioning', async () => {
      // A retooled spare renames the agent window, so every tool name is
      // taken, not just the one launching.
      for (const name of ['claude', 'codex']) {
        await writeConfig({ initCommands: [{ name, commands: ['echo hi'] }] })
        await expect(start({ tool: 'claude' })).rejects.toThrow(`"${name}" is reserved`)
      }
      expect(specs).toEqual([])
    })

    it('fails fast, rolling the row back, when origin cannot be fetched', async () => {
      // Nothing listens on this host's 443, so the fetch fails at once.
      vi.stubEnv('YAAC_E2E_SKIP_FETCH', '')
      await recordTestProject(DEMO_PROJECT_ID, { remoteUrl: 'https://127.0.0.1/o/r.git' })
      await setProjectEgressAllowlist(DEMO_PROJECT_ID, { hosts: ['127.0.0.1'], defaults: true })

      await expect(start({ workspaceId: 'wt-nofetch' })).rejects.toThrow(/could not fetch from remote/)

      // A bad input is not retried.
      expect(specs).toHaveLength(1)
      await vi.waitFor(async () => {
        expect(await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-nofetch')).toBeUndefined()
      }, { timeout: 30_000 })
    })

    it('hands an SSH remote the host key it was assigned with, and no GH_TOKEN', async () => {
      await recordTestProject(DEMO_PROJECT_ID, { remoteUrl: 'git@github.com:o/r.git' })
      const key = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'key', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac' })
      await setProjectGitCredential(DEMO_PROJECT_ID, key.id, 'github.com ssh-ed25519 AAAAC3')

      await start()

      // How the key and tunnel reach the workspace is the driver's concern.
      expect(await fs.readFile(specs[0].ssh!.knownHostsFile, 'utf8')).toBe('github.com ssh-ed25519 AAAAC3\n')
      expect(env().filter((e) => e.startsWith('GH_TOKEN='))).toEqual([])
    })

    it('refuses a branch missing from origin, tearing its launch down', async () => {
      await expect(start({ branch: 'ghost', workspaceId: 'wt-ghost' }))
        .rejects.toThrow(/branch "ghost" not found on origin/)
      expect(specs).toHaveLength(1)
      expect(destroys).toEqual([false])
    })

    it('refuses a taken id before provisioning anything', async () => {
      await start({ workspaceId: 'wt-taken' })
      await expect(start({ workspaceId: 'wt-taken' })).rejects.toThrow()
      expect(specs).toHaveLength(1)
    })

    it('fails on its first failed launch, rolls a fresh create back entirely, and keeps a failed row', async () => {
      installDriver({ awaitReady: () => Promise.reject(new Error('pod never became ready')) })

      await expect(start({ workspaceId: 'wt-fail' })).rejects.toThrow('pod never became ready')

      // One launch, and a fresh create drops its substrate too, since its row
      // is about to go.
      expect(specs).toHaveLength(1)
      expect(destroys).toEqual([false])
      expect(deregistered).toEqual(['wt-fail'])
      expect(listProvisioning()).toEqual([expect.objectContaining({ workspaceId: 'wt-fail', error: 'pod never became ready' })])
      // The rollback is not awaited, so it lands after the rejection.
      await vi.waitFor(async () => {
        expect(await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-fail')).toBeUndefined()
      }, { timeout: 30_000 })
      await expect(fs.access(workspaceDir(DEMO_PROJECT_ID, 'wt-fail'))).rejects.toThrow()
    })

    it('records the branch it forks from with the row, before anything is provisioned', async () => {
      // A workspace queued after this one defaults to this branch and may be
      // queued mid-provisioning, so it is recorded up front: the requested
      // branch, else the clone's default.
      const rowAtImage = async (workspaceId: string, branch?: string): Promise<WorkspaceRow | undefined> => {
        let row: WorkspaceRow | undefined
        installDriver({
          prepareImage: async () => {
            row = await getWorkspaceRow(DEMO_PROJECT_ID, workspaceId)
            throw new Error('stop here')
          },
        })
        await expect(start({ workspaceId, ...(branch !== undefined ? { branch } : {}) }))
          .rejects.toThrow('stop here')
        return row
      }
      expect((await rowAtImage('wt-1', 'dev'))?.baseBranch).toBe('dev')
      expect((await rowAtImage('wt-2'))?.baseBranch).toBe('main')
    })

    it('makes each of the project\'s scratch dirs a scratch dir, recording the ones origin tracks', async () => {
      // Tracked at the base branch, or at the workspace's own pushed branch.
      const repo = repoDir(DEMO_PROJECT_ID)
      const commitTo = async (ref: string, file: string): Promise<void> => {
        await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true })
        await fs.writeFile(path.join(repo, file), 'built\n')
        await git(repo, ['add', '-A'])
        await git(repo, ['commit', '-qm', file])
        await git(repo, ['update-ref', ref, 'HEAD'])
      }
      await git(repo, ['checkout', '-qb', 'tracked'])
      await commitTo('refs/remotes/origin/tracked', 'target/out.bin')
      await commitTo('refs/remotes/origin/agent/wt-tracked', 'web/node_modules/pkg/index.js')
      await git(repo, ['checkout', '-q', 'main'])
      await setScratchDirs(local, DEMO_PROJECT_ID, {
        dirs: [{ path: 'node_modules', sizeGiB: 8 }, { path: 'target', sizeGiB: 32 }, { path: 'web/node_modules', sizeGiB: 2 }],
      })

      await start({ workspaceId: 'wt-tracked', branch: 'tracked' })
      // Each with its own cap.
      const GIB = 1024 ** 3
      expect(specs[0].scratchDirs).toEqual([
        { path: '/workspace/node_modules', sizeBytes: 8 * GIB },
        { path: '/workspace/target', sizeBytes: 32 * GIB },
        { path: '/workspace/web/node_modules', sizeBytes: 2 * GIB },
      ])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-tracked')).toMatchObject({
        // What its stop removes, whatever the project lists by then.
        scratchDirs: ['node_modules', 'target', 'web/node_modules'],
        trackedScratchDirs: ['target', 'web/node_modules'],
      })
      // Nothing tracked on main.
      const plain = await start()
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, plain.workspaceId))?.trackedScratchDirs).toEqual([])
    })

    it('launches in the time zone clients report, and records it', async () => {
      // A pod would otherwise run in UTC, whatever zone the user is in.
      const before = await start()
      expect(env().filter((e) => e.startsWith('TZ='))).toEqual([])
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, before.workspaceId))?.timeZone).toBeUndefined()

      await setTimeZone(BUILT_IN_USER_ID, 'Asia/Tokyo', false)
      const after = await start()
      expect(env()).toContain('TZ=Asia/Tokyo')
      // Recorded, so a spare claim can tell which zone it launched in.
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, after.workspaceId))?.timeZone).toBe('Asia/Tokyo')
    })
  })

  // A failed create rolls back. Its prompt survives as a draft, updating
  // the one it came from, only for a caller that asked; the error is the
  // create's own, so its code stands.
  it('keeps a failed create\'s prompt as a draft only when asked, leaving no workspace', async () => {
    // One error for every launch, as concurrent creates sharing a build or
    // install see; neither create may change what the other reports.
    const shared = new ServerError('VALIDATION', 'pod never became ready')
    installDriver({ awaitReady: () => Promise.reject(shared) })
    const draft = await saveDraftWorkspace(local, DEMO_PROJECT_ID, { prompt: 'old', tool: 'claude', mode: 'tui', permissionMode: 'plan' })
    const failing = (workspaceId: string, onFailure: boolean): Promise<unknown> => start({
      workspaceId,
      tool: 'codex',
      permissionMode: 'accept-edits',
      prompt: 'fix the build',
      title: 'Build',
      draft: { id: draft.id, ...(onFailure ? { onFailure } : {}) },
    })

    await expect(failing('wt-plain', false)).rejects.toMatchObject({ message: 'pod never became ready' })
    expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({ id: draft.id, prompt: 'old' })])

    await expect(failing('wt-fail', true)).rejects.toMatchObject({
      code: 'VALIDATION', message: 'pod never became ready; its prompt is kept as a draft',
    })
    expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({
      id: draft.id, prompt: 'fix the build', title: 'Build', tool: 'codex', permissionMode: 'accept-edits',
    })])
    expect(shared.message).toBe('pod never became ready')
    // The failed row carries what the caller is told.
    expect(listProvisioning()).toContainEqual(expect.objectContaining({
      workspaceId: 'wt-fail', error: 'pod never became ready; its prompt is kept as a draft',
    }))
    await vi.waitFor(async () => expect(await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-fail')).toBeUndefined(), { timeout: 30_000 })
  })

  /**
   * A spare is warmed by the pool (`reconcilePrewarmPool`) with no
   * session. A claim hands it over under its own id, moving its checkout to
   * another branch or a newer tip, and opens the create's session in it.
   * Anything that goes wrong falls back to a cold create under the
   * requested id.
   */
  describe('claiming a prewarmed spare', () => {
    /** A running workspace of the project, which is what makes the pool
     *  warm a spare for it. */
    const user = handleFixture({ workspaceId: 'user-ws', projectId: DEMO_PROJECT_ID, jobName: 'yaac-demo-user-ws' })

    /** Whether `unit` finished its warm, which ends by renaming its keeper. */
    const warmed = (unit: RuntimeHandle): boolean =>
      execs.some((x) => x.jobName === unit.jobName && x.cmd.includes(`rename-window -t =yaac:=${KEEPER_STARTING} ${KEEPER_WINDOW}`))

    /** Warm one spare as the pool does, and wait until it is up. */
    async function warm(): Promise<RuntimeHandle> {
      await reconcilePrewarmPool(snapshotFixture([user, ...units]))
      let spare: RuntimeHandle | undefined
      await vi.waitFor(() => {
        spare = units.find((u) => u.prewarmed && warmed(u))
        expect(spare).toBeDefined()
      }, { timeout: 30_000 })
      // The pool's spawn settles after its create returns.
      await new Promise((r) => setTimeout(r, 20))
      execs = []
      return spare!
    }

    /** Commands run in `unit` since the spare was warmed. */
    const ranIn = (unit: RuntimeHandle): string[] =>
      execs.filter((e) => e.jobName === unit.jobName).map((e) => e.cmd)

    beforeEach(async () => {
      vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '1')
      await recordProjectCreate(DEMO_PROJECT_ID, 'claude', { mode: 'tui' })
    })

    it('warms a spare with no row or session, then hands it over under its own id, opening the create\'s session in it', async () => {
      const spare = await warm()
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, spare.workspaceId)).toBeUndefined()
      expect(await listWorkspaceSessions(spare.workspaceId, { all: true })).toEqual([])
      expect(specs.at(-1)?.prewarm).toBe(true)
      registrations = []

      const group = await createWorkspaceGroup(DEMO_PROJECT_ID, 'Reviews', null)
      const result = await start({
        workspaceId: 'req', claimSpare: true, prompt: 'fix the bug', title: 'Bug fix', group: group.groupId,
      })

      const [session] = await listWorkspaceSessions(spare.workspaceId)
      expect(result).toEqual({ workspaceId: spare.workspaceId, jobName: spare.jobName, forwardedPorts: [], sessionId: session.id })
      expect(claims).toEqual([spare.workspaceId])
      expect(specs.filter((s) => !s.prewarm)).toEqual([])
      // Re-registered from the project as it is now, and given the current
      // git identity.
      expect(registrations).toEqual([expect.objectContaining({
        workspaceId: spare.workspaceId, projectId: DEMO_PROJECT_ID, owner: 'install',
      })])
      expect(ranIn(spare)).toContain("git config --global user.name 'Ada' && git config --global user.email 'ada@example.com'")
      // Recorded as a cold create records it: filed, titled, its session
      // holding the prompt, which is pasted into the agent of the window it
      // opens.
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, spare.workspaceId)).toMatchObject({
        groupId: group.groupId, title: 'Bug fix', baseBranch: 'main',
      })
      expect(session).toMatchObject({ tool: 'claude', mode: 'tui', permissionMode: 'bypass', firstPrompt: 'fix the bug' })
      expect(session.launchedAt).toBeInstanceOf(Date)
      expect(ranIn(spare)).toContainEqual(expect.stringContaining(`new-window -d -t yaac -n ${session.window} `))
      expect(ranIn(spare).some((c) => c.includes(`.yaac-prompt-_yaac__${session.window}.sh`))).toBe(true)
      expect(listProvisioning()).toEqual([])
    })

    it('leaves the spare alone for a create into a group at its workspace limit', async () => {
      const spare = await warm()
      const { groupId } = await createWorkspaceGroup(DEMO_PROJECT_ID, 'Workers', null)
      await setWorkspaceGroupLimit(DEMO_PROJECT_ID, groupId, 1)
      await running(groupId)

      await expect(start({ claimSpare: true, group: 'Workers' })).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(claims).toEqual([])
      expect(units.find((u) => u.workspaceId === spare.workspaceId)?.prewarmed).toBe(true)
    })

    // A pass lists pods before it plans, so a claim can finish in between.
    // The pass then sees a spare with no warm-time settings and no claim in
    // progress, the only workspace of its project: stale and idle twice
    // over. It must leave the user's workspace running.
    it('keeps a claimed spare that a pass listed before the claim', async () => {
      const spare = await warm()
      const listedBefore = snapshotFixture([{ ...spare }])

      await start({ claimSpare: true, prompt: 'fix the bug' })
      await reconcilePrewarmPool(listedBefore)
      await new Promise((r) => setTimeout(r, 50))

      expect(destroys).toEqual([])
      expect(units.map((u) => u.workspaceId)).toContain(spare.workspaceId)
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, spare.workspaceId))?.stoppedAt).toBeUndefined()
    })

    it('opens a session of any tool and posture in a spare, and moves its checkout to another branch', async () => {
      const spare = await warm()
      await saveToolAuth('codex', 'sk-oai')

      const result = await start({ claimSpare: true, tool: 'codex', permissionMode: 'read-only', branch: 'dev' })

      expect(result).toMatchObject({ workspaceId: spare.workspaceId })
      expect(claims).toEqual([spare.workspaceId])
      const ran = ranIn(spare)
      // The checkout is reset to dev's tip, keeping mount points, and the
      // branch becomes its upstream.
      const tip = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'origin/dev'])).trim()
      expect(ran).toContainEqual(expect.stringMatching(new RegExp(`reset --hard ${tip} && git -C /workspace clean -fd -e 'node_modules'`)))
      expect(ran).toContainEqual(expect.stringContaining("update-ref 'refs/remotes/origin/dev'"))
      const [session] = await listWorkspaceSessions(spare.workspaceId)
      expect(session).toMatchObject({ tool: 'codex', permissionMode: 'read-only', model: FALLBACK_MODELS.codex })
      expect(ran.filter((c) => SESSION_WINDOW.test(c))).toEqual([
        expect.stringMatching(new RegExp(`-n ${session.window} [^']*'[^']*exec codex .*--sandbox read-only`)),
      ])
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, spare.workspaceId))?.baseBranch).toBe('dev')
    })

    // A chat session's conversation has no id until its agent answers, so
    // the claim leaves the prompt on the session for the sweep to send.
    it('holds a claimed chat session\'s prompt for its conversation', async () => {
      const spare = await warm()
      expect(await start({ claimSpare: true, mode: 'acp', prompt: 'go' })).toMatchObject({ workspaceId: spare.workspaceId })
      const [session] = await listWorkspaceSessions(spare.workspaceId)
      expect(session).toMatchObject({ mode: 'acp', pendingPrompt: 'go' })
      expect(ranIn(spare).some((c) => c.includes('.yaac-prompt-'))).toBe(false)
    })

    it('opens a pi session in a spare on the owner\'s pi provider', async () => {
      const spare = await warm()
      await saveToolAuth('pi', 'sk-or', 'openrouter')

      expect(await start({ claimSpare: true, tool: 'pi' })).toMatchObject({ workspaceId: spare.workspaceId })
      expect(ranIn(spare).find((c) => SESSION_WINDOW.test(c))).toMatch(/ -n pi-[0-9a-f]{8} [^']*'.*openrouter/)
    })

    /** Settle `claim` with fake time, which has to pass while the claim also
     *  waits on real disk and git work. */
    async function settleWithFakeTime<T>(claim: Promise<T>): Promise<T> {
      let done = false
      void claim.finally(() => { done = true }).catch(() => {})
      for (let i = 0; i < 200 && !done; i++) {
        await vi.advanceTimersByTimeAsync(250)
        await new Promise((r) => setImmediate(r))
      }
      return await claim
    }

    // A refresh is only worth it while cheap: a slow origin leaves the
    // spare on the commit it was warmed at rather than holding the user.
    it('hands a spare over on its warmed base when the fetch outlasts the wait', async () => {
      const spare = await warm()
      head = 'an-older-commit'
      vi.stubEnv('YAAC_E2E_SKIP_FETCH', '')
      slowOrigin.hang = true
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        expect((await settleWithFakeTime(start({ claimSpare: true }))).workspaceId).toBe(spare.workspaceId)
      } finally {
        vi.useRealTimers()
        slowOrigin.hang = false
      }
      expect(ranIn(spare).some((c) => c.includes('reset --hard'))).toBe(false)
    })

    // A background refresh can take minutes (a slow reset, init windows);
    // a cold create beats waiting that long.
    it('creates cold rather than wait out a refresh that outlasts the wait', async () => {
      const spare = await warm()
      head = 'an-older-commit'
      installDriver({
        exec: (jobName, cmd) => {
          execs.push({ jobName, cmd })
          // The pool's refresh never finishes its reset.
          if (cmd.includes('reset --hard')) return new Promise(() => { /* held */ })
          return Promise.resolve({ stdout: cmd.includes('rev-parse -q --verify HEAD') ? `${head}\n` : '', stderr: '' })
        },
      })
      await reconcilePrewarmPool(snapshotFixture([user, ...units]))
      await vi.waitFor(() => { expect(ranIn(spare).some((c) => c.includes('reset --hard'))).toBe(true) })

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      let result: WorkspaceCreateResult
      try {
        result = await settleWithFakeTime(start({ claimSpare: true }))
      } finally {
        vi.useRealTimers()
      }
      expect(result.workspaceId).not.toBe(spare.workspaceId)
      expect(claims).toEqual([])
    })

    it('brings a spare whose branch moved on origin up to its tip before opening the session there', async () => {
      const spare = await warm()
      head = 'an-older-commit'
      await writeConfig({ initCommands: [{ name: 'backend', commands: ['pnpm dev'] }] })

      expect((await start({ claimSpare: true })).workspaceId).toBe(spare.workspaceId)

      const ran = ranIn(spare)
      const reset = ran.findIndex((c) => c.includes('reset --hard'))
      expect(reset).toBeGreaterThanOrEqual(0)
      // Each init window is recreated in one exec with its kill, then the
      // session opened last.
      const after = ran.slice(reset)
      expect(after).toContainEqual(expect.stringMatching(/kill-window -t =yaac:=backend 2>\/dev\/null; .*new-window -d -t yaac -n backend/))
      expect(after.findIndex((c) => SESSION_WINDOW.test(c)))
        .toBeGreaterThan(after.findIndex((c) => c.includes('kill-window -t =yaac:=backend')))
    })

    it('waits out a background refresh, then claims the refreshed spare', async () => {
      const spare = await warm()
      head = 'an-older-commit'
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      installDriver({
        exec: async (jobName, cmd) => {
          execs.push({ jobName, cmd })
          if (cmd.includes('reset --hard')) {
            await held
            head = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'origin/main'])).trim()
          }
          return { stdout: cmd.includes('rev-parse -q --verify HEAD') ? `${head}\n` : '', stderr: '' }
        },
      })
      // The pool starts moving the spare to the tip in the background.
      await reconcilePrewarmPool(snapshotFixture([user, ...units]))
      await vi.waitFor(() => { expect(ranIn(spare).some((c) => c.includes('reset --hard'))).toBe(true) })

      let claimed = false
      const claim = start({ claimSpare: true }).finally(() => { claimed = true })
      await new Promise((r) => setTimeout(r, 50))
      expect(claimed).toBe(false)
      release()

      expect((await claim).workspaceId).toBe(spare.workspaceId)
      // Already current, so the claim reset it no further.
      expect(ranIn(spare).filter((c) => c.includes('reset --hard'))).toHaveLength(1)
    })

    it('refuses a branch missing from origin, putting the spare back untouched', async () => {
      const spare = await warm()

      await expect(start({ workspaceId: 'req', claimSpare: true, branch: 'ghost' }))
        .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('branch "ghost" not found') as unknown })

      // No cold create was tried, and the spare is a spare again, with no
      // row.
      expect(specs.filter((s) => !s.prewarm)).toEqual([])
      expect(claims).toEqual([])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, spare.workspaceId)).toBeUndefined()
      expect(await listWorkspaceConversations(DEMO_PROJECT_ID, spare.workspaceId)).toEqual([])
      expect(listProvisioning()).toEqual([expect.objectContaining({ workspaceId: 'req', error: expect.stringContaining('ghost') as unknown })])
      // The next claim takes it.
      expect((await start({ claimSpare: true })).workspaceId).toBe(spare.workspaceId)
    })

    it('reaps a spare a failed rebranch or commit left half-changed, and creates cold instead', async () => {
      const spare = await warm()
      installDriver({
        exec: (jobName, cmd) => {
          execs.push({ jobName, cmd })
          if (cmd.includes('reset --hard') && jobName === spare.jobName) {
            return Promise.reject(new WorkspaceExecError('reset', 1, '', 'disk full'))
          }
          return Promise.resolve({ stdout: cmd.includes('rev-parse -q --verify HEAD') ? `${head}\n` : '', stderr: '' })
        },
      })

      const result = await start({ workspaceId: 'req', claimSpare: true, branch: 'dev' })

      expect(result).toMatchObject({ workspaceId: 'req' })
      expect(specs.filter((s) => !s.prewarm).map((s) => s.workspaceId)).toEqual(['req'])
      // Torn down whole: the claim's row, then the pod, checkout and Job.
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, spare.workspaceId)).toBeUndefined()
      await vi.waitFor(async () => {
        expect(destroys).toEqual([false, false])
        await expect(fs.access(workspaceDir(DEMO_PROJECT_ID, spare.workspaceId))).rejects.toThrow()
      }, { timeout: 30_000 })
      expect(units.some((u) => u.workspaceId === spare.workspaceId)).toBe(false)

      // A commit that lost a race looks like one whose response was lost
      // after it landed, so that spare is reaped too.
      installDriver({ claimSpare: () => Promise.reject(new Error('already claimed')) })
      const next = await warm()
      expect((await start({ claimSpare: true })).workspaceId).not.toBe(next.workspaceId)
      await vi.waitFor(() => { expect(units.some((u) => u.workspaceId === next.workspaceId)).toBe(false) })
    })

    it('passes over a spare it cannot use, creating cold', async () => {
      const spare = await warm()
      const cold = async (over: Partial<StartWorkspaceRequest> = {}): Promise<void> => {
        const result = await start({ claimSpare: true, ...over })
        expect(result.workspaceId).not.toBe(spare.workspaceId)
        expect(claims).toEqual([])
        expect(await getWorkspaceRow(DEMO_PROJECT_ID, spare.workspaceId)).toBeUndefined()
      }

      // Its agent transport never answers: left alone, before any change.
      installDriver({ awaitAgentTransport: (jobName) => jobName === spare.jobName
        ? Promise.reject(new Error('no transport'))
        : Promise.resolve() })
      await cold()
      _clearTmuxAliveCacheForTests()
      // Its tmux is gone.
      installDriver({ exec: (jobName, cmd) => {
        execs.push({ jobName, cmd })
        return jobName === spare.jobName && cmd.includes('has-session')
          ? Promise.reject(new WorkspaceExecError('probe', 1, '', 'no server'))
          : Promise.resolve({ stdout: '', stderr: '' })
      } })
      await cold()
      _clearTmuxAliveCacheForTests()
      // An image the project no longer builds (its Dockerfile was edited).
      installDriver({ currentImage: () => Promise.resolve('registry.test/fake-image:edited') })
      await cold()
      installDriver()
      // A zone the user has left, which `TZ` fixed at warm time.
      await setTimeZone(BUILT_IN_USER_ID, 'Asia/Tokyo', false)
      await cold()
    })

    // The workspace is already usable, so neither is worth burning the spare.
    it('hands a spare over even when its git identity or group cannot be re-applied', async () => {
      const spare = await warm()
      const group = await createWorkspaceGroup(DEMO_PROJECT_ID, 'Gone soon', null)
      installDriver({
        // The group goes after the start resolved it, before the claim
        // records the row.
        awaitAgentTransport: async () => { await deleteWorkspaceGroup(DEMO_PROJECT_ID, group.groupId) },
        exec: (jobName, cmd) => cmd.includes('git config --global')
          ? Promise.reject(new WorkspaceExecError('identity', 1, '', 'read-only home'))
          : Promise.resolve({ stdout: cmd.includes('rev-parse -q --verify HEAD') ? `${head}\n` : '', stderr: '' }),
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect((await start({ claimSpare: true, group: group.groupId })).workspaceId).toBe(spare.workspaceId)

      expect((await getWorkspaceRow(DEMO_PROJECT_ID, spare.workspaceId))?.groupId).toBeUndefined()
      expect(warn.mock.calls.map(([m]) => String(m)).join('\n')).toContain('not applied')
      warn.mockRestore()
    })

    // A refresh is only worth it while cheap.
    it('hands a spare over on its warmed base when the fetch of origin fails', async () => {
      const spare = await warm()
      head = 'an-older-commit'
      // Nothing listens on this host's 443, so the fetch fails at once.
      vi.stubEnv('YAAC_E2E_SKIP_FETCH', '')
      await recordTestProject(DEMO_PROJECT_ID, { remoteUrl: 'https://127.0.0.1/o/r.git' })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect((await start({ claimSpare: true })).workspaceId).toBe(spare.workspaceId)

      expect(ranIn(spare).some((c) => c.includes('reset --hard'))).toBe(false)
      expect(warn.mock.calls.map(([m]) => String(m)).join('\n')).toContain('kept its warmed base')
      warn.mockRestore()
    })

    // A claim that waits (here, out a refresh) can find its first choice
    // taken by a claim that started and finished meanwhile. It moves on to
    // the next spare rather than reserving a workspace that is no longer a
    // spare and falling back to a cold create.
    it('claims the newest of several spares that match, passing over one another claim took meanwhile', async () => {
      vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '2')
      await reconcilePrewarmPool(snapshotFixture([user]))
      await vi.waitFor(() => {
        expect(units.filter((u) => u.prewarmed && warmed(u))).toHaveLength(2)
      }, { timeout: 30_000 })
      await new Promise((r) => setTimeout(r, 20))
      const [newest, older] = [...units].sort((a, b) => b.createdAtMs - a.createdAtMs)

      // The waiting claim subscribes to the refresh; the refresh then ends
      // as far as later claims can see, but not yet for the waiting one.
      let finishRefresh = (): void => {}
      const refreshed = new Promise<void>((r) => { finishRefresh = r })
      let waiting = false
      refreshing.set(newest.jobName, {
        then: (onDone: () => unknown) => { waiting = true; return refreshed.then(onDone) },
      } as unknown as Promise<void>)
      const late = start({ claimSpare: true })
      await vi.waitFor(() => { expect(waiting).toBe(true) })
      refreshing.delete(newest.jobName)

      expect((await start({ claimSpare: true })).workspaceId).toBe(newest.workspaceId)
      finishRefresh()
      expect((await late).workspaceId).toBe(older.workspaceId)
      expect(specs.filter((s) => !s.prewarm)).toEqual([])
    })

    // Nothing else records a spare once its unit is gone, so a failed warm
    // collects its own checkout, like a failed cold create.
    it('tears down a spare that failed to warm, checkout and all, and never claims it', async () => {
      installDriver({
        awaitReady: (handle) => handle.prewarmed ? Promise.reject(new Error('pod never became ready')) : Promise.resolve(),
      })
      await reconcilePrewarmPool(snapshotFixture([user]))
      const spareId = await vi.waitFor(() => {
        expect(destroys).toEqual([false])
        return specs[0].workspaceId
      }, { timeout: 30_000 })

      await vi.waitFor(async () => {
        await expect(fs.access(workspaceDir(DEMO_PROJECT_ID, spareId))).rejects.toThrow()
      })
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, spareId)).toBeUndefined()
      expect((await start({ claimSpare: true })).workspaceId).not.toBe(spareId)
    })

    it('lets only one of two concurrent claims have the single spare', async () => {
      const spare = await warm()
      const results = await Promise.all([start({ claimSpare: true }), start({ claimSpare: true })])
      expect(results.filter((r) => r.workspaceId === spare.workspaceId)).toHaveLength(1)
      expect(claims).toEqual([spare.workspaceId])
    })
  })
})

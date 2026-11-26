import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile, type default as childProcessModule } from 'node:child_process'

/** While `hold` answers a promise for a `git fetch`'s arguments, that fetch
 *  starts only once it resolves: an origin a case keeps slow. */
const slowOrigin = vi.hoisted(() => ({ hold: undefined as ((argv: string[]) => Promise<void> | undefined) | undefined }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcessModule>()
  const execFile = (...args: Parameters<typeof actual.execFile>): ReturnType<typeof actual.execFile> => {
    const [file, argv] = args as unknown as [string, string[] | undefined]
    const held = file === 'git' && argv?.includes('fetch') === true ? slowOrigin.hold?.(argv) : undefined
    if (held === undefined) return actual.execFile(...args)
    void held.then(() => actual.execFile(...args))
    return {} as ReturnType<typeof actual.execFile>
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
  startOf,
  createVolume,
  saveDraftWorkspace,
  stopWorkspace,
} from '#domain/workspaces'
import { MAX_DELEGATE_LAUNCHES } from '#domain/workspaces/start'
import { _clearTerminatingForTests } from '#runtime/status/terminating'
import { clearAllProvisioningForTests } from '#domain/workspaces/provisioning'
import { clearPrewarmStateForTests } from '#domain/workspaces/prewarm'
import { setWorkspaceBinDir } from '#domain/workspaces/workspace-bin'
import type { StartWorkspaceRequest } from '#domain/workspaces/start'
import type { WorkspaceCreateResult } from '#domain/workspaces/create'
import { createWorkflow, resolveWorkflow, setProjectEnvVar, setRunSecret, setScratchDirs, showWorkflow } from '#domain/projects'
import { _clearTmuxAliveCacheForTests } from '#runtime/status/liveness'
import { _resetAcpRegistryForTests, registerAcpConversation } from '#runtime/agents/acp-registry'
import type { AcpConversation } from '#runtime/agents'
import { serverLog } from '#lib/log'
import { createTempDataDir, cleanupTempDir, createTestRepo } from '@yaac/test-utils/setup'
import { git } from '@yaac/test-utils/git'
import { DEMO_PROJECT_ID, recordTestProject, seedProject } from '@yaac/test-utils/project-fixture'
import {
  handleFixture,
  installFakeWorkspaceDriver,
  resetWorkspaceDriver,
  substrateFixture,
  workspacePathsFixture,
} from '#test/support/fake-driver'
import {
  agentHistoryDir,
  cachedPackagesDir,
  claudeDir,
  codexDir,
  opencodeCheckpointDir,
  opencodeConfigDir,
  opencodeDataDir,
  hostedRepoDir,
  ompDir,
  piDir,
  repoDir,
  workspaceDir,
  workspaceStateDir,
} from '@yaac/shared/project-paths'
import { CONTAINER_TMUX_DIR } from '@yaac/shared/paths'
import {
  ghTokenPlaceholder, PLACEHOLDER_API_KEY, PLACEHOLDER_OMP_API_KEY, PLACEHOLDER_OPENCODE_API_KEY, PLACEHOLDER_PI_API_KEY,
} from '@yaac/shared/tool-auth'
import { eq } from 'drizzle-orm'
import { closeDb, getDb } from '#db/client'
import { repos } from '#db/schema'
import { getRepo, insertRepo, linkProjectRepo, listWorkspaceRepos, type WorkspaceRepoRow } from '#db/repo-store'
import { cloneRepo, initHostedRepo } from '#domain/git'
import {
  BUILT_IN_USER_ID,
  createWorkspaceGroup,
  getWorkspaceRow,
  insertGitCredential,
  listWorkspaceGroupRows,
  listWorkspaceSessions,
  setGitIdentity,
  setProjectEgressAllowlist,
  setRepoGitCredential,
  setTimeZone,
  setWorkspaceGroupLimit,
  seeTailnetUser,
  setToolCredential,
  insertSession,
  type SessionRow,
} from '#db'
import { getProjectRow, recordProjectCreate, setProjectConfig } from '#db/project-store'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { listWorkspaceSteps } from '#db/step-store'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import { EFFORTS } from '@yaac/shared/tool-providers.generated'
import { ServerError } from '@yaac/shared/errors'
import {
  KEEPER_STARTING,
  WorkspaceExecError,
  type RuntimeHandle,
  type WorkspaceDriver,
  type WorkspaceSpec,
} from '#drivers/contract'
import { STOCK_IMAGE_ID, type AgentTool } from '@yaac/shared/types'
import type { Actor } from '#domain/access'
import { workspaceDelegate } from '#test/support/delegate'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

/** A workspace's one checkout, as its row records it. */
const checkout = async (workspaceId: string): Promise<WorkspaceRepoRow | undefined> =>
  (await listWorkspaceRepos(workspaceId))[0]

/**
 * A second repo of the demo project's owner, linked into it under `dir`
 * with the demo repo's credential, its main clone holding `origin/main` and
 * `origin/dev` like the first's. Answers its id.
 */
async function seedSecondRepo(dir: string): Promise<string> {
  const id = randomUUID()
  const clone = repoDir(id)
  await createTestRepo(clone)
  // A commit of its own, so its tip never matches the first repo's, as two
  // repos made from one template in the same second otherwise would.
  await git(clone, ['commit', '--allow-empty', '-m', dir])
  await git(clone, ['branch', '-M', 'main'])
  for (const branch of ['main', 'dev']) await git(clone, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'])
  await git(clone, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  await insertRepo({ id, owner: BUILT_IN_USER_ID, remoteUrl: `https://github.com/o/${dir}.git` })
  await setRepoGitCredential(id, (await getRepo(DEMO_PROJECT_ID))?.gitCredentialId as string, null)
  await linkProjectRepo(DEMO_PROJECT_ID, id, dir)
  return id
}

/** Point the demo project's repo at another remote. */
async function setRemote(remoteUrl: string): Promise<void> {
  await (await getDb()).update(repos).set({ remoteUrl }).where(eq(repos.id, DEMO_PROJECT_ID))
}

/** Store the built-in user's api key for a tool, with its provider where
 *  the tool needs one. */
async function saveToolAuth(tool: AgentTool, apiKey: string, provider?: string): Promise<void> {
  if (tool === 'opencode' || tool === 'pi' || tool === 'omp') {
    await setToolCredential(BUILT_IN_USER_ID, tool, { kind: 'api-key', provider: provider as never, savedAt: 'x', apiKey })
  } else {
    await setToolCredential(BUILT_IN_USER_ID, tool, { kind: 'api-key', savedAt: 'x', apiKey })
  }
}

/**
 * Starts run to completion against a fake runtime over a real project
 * (`seedProject`) and a real database. The assertions land on what reaches
 * the runtime (the launch spec, the commands run in the workspace) and on
 * the rows.
 *
 * The fake runtime keeps the units it launched, and offers the spares in
 * `offered` to a take.
 */
describe('prepareStart', () => {
  let tmpDir: string
  let specs: WorkspaceSpec[]
  let execs: Array<{ jobName: string; cmd: string; stdin?: string }>
  /** Each teardown's `unitOnly`: true keeps the prepared substrate. */
  let destroys: boolean[]
  let deregistered: string[]
  let units: RuntimeHandle[]
  /** Spares a take may have, each for one image and scratch size. */
  let offered: Array<{ id: string; image: string; scratchBytes: number }>
  /** What each take asked for. */
  let takes: Array<{ image: string; scratchBytes: number }>
  /** Spares reaped. */
  let reaped: string[]
  /** What `rev-parse HEAD` reads in a workspace; origin's main unless a case
   *  moves it. */
  let head: string
  /** Where a move leaves its checkout, for a case in which it does not
   *  reach its target. */
  let stuck: string | undefined

  /**
   * What a command prints in a workspace of the fake runtime. A move
   * (`./origin-catch-up`) leaves its checkout at its target, as a
   * fast-forward does, and says so; anything else that reads HEAD gets it.
   */
  function answer(cmd: string): string {
    const targets = [...cmd.matchAll(/merge --ff-only (\w+)/g)].map((m) => m[1])
    if (targets.length === 0) return cmd.includes('rev-parse -q --verify HEAD') ? `${head}\n` : ''
    if (stuck === undefined) head = targets[targets.length - 1]
    return targets.map((t) => `yaac-at:${stuck ?? t}\n`).join('')
  }

  /** What the server has logged, one message a line. */
  const logged = (): string => vi.mocked(serverLog).mock.calls.map(([m]) => m).join('\n')

  /**
   * Give a repo an origin a fetch really reads: it becomes one the server
   * hosts, whose bare repository on disk holds the main clone's `main` and
   * a `dev` beside it. Fetches run from here on, and `hold` keeps this
   * repo's back until the function it answers is called.
   */
  async function slowRealOrigin(repoId = DEMO_PROJECT_ID): Promise<{ origin: string; hold: () => () => void }> {
    const origin = hostedRepoDir(repoId)
    await fs.mkdir(path.dirname(origin), { recursive: true })
    await git(tmpDir, ['clone', '-q', '--bare', repoDir(repoId), origin])
    await git(origin, ['branch', 'dev', 'main'])
    await (await getDb()).update(repos).set({ remoteUrl: `http://yaac.internal/${repoId}.git`, hosted: true }).where(eq(repos.id, repoId))
    vi.stubEnv('YAAC_E2E_SKIP_FETCH', '')
    let held: Promise<void> | undefined
    const others = slowOrigin.hold
    slowOrigin.hold = (argv) => (argv.includes(origin) ? held : others?.(argv))
    return {
      origin,
      hold: () => {
        let release = (): void => {}
        held = new Promise<void>((r) => { release = r })
        return release
      },
    }
  }

  /** Commit `file` to a branch of `origin`: on its tip, or with `rewrite`
   *  in place of it, as a force-push leaves it. Answers the new tip. */
  async function pushTo(origin: string, branch: string, file: string, opts: { rewrite?: boolean } = {}): Promise<string> {
    const work = path.join(tmpDir, `push-${randomUUID()}`)
    await git(tmpDir, ['clone', '-q', '-b', branch, origin, work])
    await fs.writeFile(path.join(work, file), `${file}\n`)
    await git(work, ['add', '-A'])
    await git(work, ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', ...(opts.rewrite === true ? ['--amend'] : []), '-m', file])
    await git(work, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`])
    return (await git(work, ['rev-parse', 'HEAD'])).trim()
  }

  /** Resolves once a main clone has `commit` as `origin/<branch>`. */
  const fetched = (branch: string, commit: string, repoId = DEMO_PROJECT_ID): Promise<void> => vi.waitFor(async () => {
    expect((await git(repoDir(repoId), ['rev-parse', `origin/${branch}`])).trim()).toBe(commit)
  }, { timeout: 30_000 })

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
      exec: (jobName, cmd, opts) => {
        execs.push({ jobName, cmd, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) })
        // An acp agent's conversation is up as soon as a create looks for it,
        // so the create's watch on its window settles.
        const window = /display-message -p -t yaac:(\S+) '#\{pane_pid\}'/.exec(cmd)?.[1]
        if (window !== undefined) {
          const workspaceId = jobName.slice('yaac-demo-'.length)
          registerAcpConversation(DEMO_PROJECT_ID, workspaceId, { handle: window, conversationId: `acp-${workspaceId}`, panePid: '42' }, upConversation)
          return Promise.resolve({ stdout: '42\n', stderr: '' })
        }
        return Promise.resolve({ stdout: answer(cmd), stderr: '' })
      },
      takeSpare: (args) => {
        takes.push(args)
        const i = offered.findIndex((s) => s.image === args.image && s.scratchBytes === args.scratchBytes)
        return Promise.resolve(i < 0 ? undefined : offered.splice(i, 1)[0].id)
      },
      reapSpare: (id) => { reaped.push(id); return Promise.resolve() },
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
    over: Partial<StartWorkspaceRequest> & { onProgress?: (message: string) => void; actor?: Actor } = {},
  ): Promise<WorkspaceCreateResult> {
    const { onProgress, actor = local, ...request } = over
    const run = await prepareStart(actor, {
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

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    await seedProject()
    head = (await git(repoDir(DEMO_PROJECT_ID), ['rev-parse', 'origin/main'])).trim()
    stuck = undefined
    specs = []
    execs = []
    destroys = []
    deregistered = []
    units = []
    offered = []
    takes = []
    reaped = []
    clearAllProvisioningForTests()
    clearPrewarmStateForTests()
    _clearTmuxAliveCacheForTests()
    _resetAcpRegistryForTests()
    installDriver()
  })

  afterEach(async () => {
    slowOrigin.hold = undefined
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
  describe('startOf', () => {
    it('answers what a workspace started with, each repo at its start commit or base branch, in its layout', async () => {
      const web = await seedSecondRepo('web')
      const both = await start({ noSession: true, repos: [{ repo: 'demo', commit: head }, { repo: 'web', branch: 'dev' }], cwd: 'web' })
      const row = (await getWorkspaceRow(DEMO_PROJECT_ID, both.workspaceId))!
      const webStart = (await listWorkspaceRepos(both.workspaceId)).find((c) => c.repoId === web)?.startCommit
      expect(await startOf(row, 'commit')).toEqual({
        repos: [{ repo: DEMO_PROJECT_ID, commit: head }, { repo: web, commit: webStart }], nested: true, cwd: web,
      })
      expect(await startOf(row, 'branch')).toEqual({
        repos: [{ repo: DEMO_PROJECT_ID, commit: head }, { repo: web, branch: 'dev' }], nested: true, cwd: web,
      })
    })
  })

  describe('settings', () => {
    /** What a start resolved to, as its session records it. The create
     *  stops at its first runtime call after opening the session. */
    const settled = async (
      over: Partial<StartWorkspaceRequest> & { actor?: Actor } = {},
      driver: Partial<WorkspaceDriver> = {},
    ): Promise<SessionRow> => {
      const workspaceId = randomUUID()
      let opened: SessionRow | undefined
      const stop = async (): Promise<never> => {
        opened = (await listWorkspaceSessions(workspaceId))[0]
        throw new Error('stop here')
      }
      installDriver({ ...driver, resolveImageChain: stop, prepareSubstrate: stop })
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
        .toEqual({ model: 'claude-sonnet-5', permissionMode: 'plan', efforts: {}, agentOptions: {} })
    })

    // docs/effort-levels.md. A level is remembered for the model it was
    // picked on, so it never carries to another.
    it('resolves effort per model: named if it has it, else the last picked for that model, else its default', async () => {
      await settled({ tool: 'claude', model: 'claude-opus-4-6', effort: 'max', rememberDefaults: true })
      expect((await settled({ tool: 'claude', model: 'claude-opus-4-6' })).effort).toBe('max')
      // opus-4-7 has max too, but no pick of its own: its default.
      expect((await settled({ tool: 'claude', model: 'claude-opus-4-7' })).effort).toBe('xhigh')
      await recordProjectCreate(DEMO_PROJECT_ID, 'claude', { efforts: { 'claude-opus-4-7': 'low' } })
      expect((await getProjectRow(DEMO_PROJECT_ID))?.createDefaults.claude?.efforts)
        .toEqual({ 'claude-opus-4-6': 'max', 'claude-opus-4-7': 'low' })
      expect((await settled({ tool: 'claude', model: 'claude-opus-4-7' })).effort).toBe('low')
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

    // docs/permission-modes.md "A spawned workspace's posture".
    it("holds a delegate's start to its ceiling, taking after its calling session, and refuses a tool no one signed in to", async () => {
      await recordProjectCreate(DEMO_PROJECT_ID, 'claude', { permissionMode: 'bypass', mode: 'acp', agentOptions: { idleCompaction: false } })
      await recordProjectCreate(DEMO_PROJECT_ID, 'codex', { efforts: { 'gpt-5.2': 'xhigh' } })
      await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'caller' })
      await insertSession(DEMO_PROJECT_ID, 'caller', { cwd: '', tool: 'codex', mode: 'tui', model: 'gpt-5.5', permissionMode: 'auto', effort: 'low' })
      await saveToolAuth('codex', 'k')
      await saveToolAuth('claude', 'k')
      const agent = workspaceDelegate(BUILT_IN_USER_ID, 'caller', { projectId: DEMO_PROJECT_ID, ceiling: 'auto' })
      // Unnamed, the calling session's tool, model, agent mode and effort,
      // and the ceiling rather than the project's remembered posture.
      expect(await settled({ actor: agent, mode: undefined }))
        .toMatchObject({ tool: 'codex', model: 'gpt-5.5', mode: 'tui', permissionMode: 'auto', effort: 'low' })
      // Its effort only on its own model: gpt-5.2 has `low` too, but takes
      // the level last picked for it, and gpt-5.3-codex its default.
      expect((await settled({ actor: agent, model: 'gpt-5.2' })).effort).toBe('xhigh')
      expect((await settled({ actor: agent, model: 'gpt-5.3-codex' })).effort).toBe(EFFORTS.codex['gpt-5.3-codex'].default)
      expect((await settled({ actor: agent, effort: 'high' })).effort).toBe('high')
      // A caller's agent options carry to its own tool only.
      await recordWorkspaceCreated({ projectId: DEMO_PROJECT_ID, workspaceId: 'claude-caller' })
      await insertSession(DEMO_PROJECT_ID, 'claude-caller', {
        cwd: '', tool: 'claude', mode: 'acp', permissionMode: 'auto', agentOptions: { idleCompaction: true },
      })
      const claudeAgent = workspaceDelegate(BUILT_IN_USER_ID, 'claude-caller', { projectId: DEMO_PROJECT_ID, ceiling: 'auto' })
      expect((await settled({ actor: claudeAgent })).agentOptions).toEqual({ idleCompaction: true })
      expect((await settled({ actor: agent, tool: 'claude' })).agentOptions).toEqual({ idleCompaction: false })
      // Another tool takes the ceiling, stepped down to what the tool has.
      expect(await settled({ actor: agent, tool: 'claude' })).toMatchObject({ tool: 'claude', permissionMode: 'auto' })
      expect(await settled({ actor: { ...agent, ceiling: 'plan' }, tool: 'codex' })).toMatchObject({ permissionMode: 'read-only' })
      await expect(start({ actor: agent, tool: 'claude', permissionMode: 'bypass' }))
        .rejects.toThrow(/permission mode 'bypass' is more permissive than the caller's ceiling \('auto'\)/)
      await expect(start({ actor: agent, tool: 'opencode' })).rejects.toThrow(/opencode is not signed in for this project's owner/)
      // Its settings are never remembered as the project's.
      await settled({ actor: agent, tool: 'claude', permissionMode: 'manual', rememberDefaults: true })
      expect((await getProjectRow(DEMO_PROJECT_ID))?.createDefaults.claude?.permissionMode).toBe('bypass')
    })

    // A delegate's start takes after its caller's checkout, not the
    // project's last create, but at origin's default branches.
    it("starts a delegate's workspace with its caller's repos, layout and session cwd where it names none", async () => {
      const web = await seedSecondRepo('web')
      await start({ repos: [{ repo: 'demo' }], nested: false, rememberDefaults: true })
      await saveToolAuth('claude', 'k')
      await recordWorkspaceCreated({
        projectId: DEMO_PROJECT_ID, workspaceId: 'caller', cwd: 'demo',
        repos: [{ repoId: DEMO_PROJECT_ID, path: 'demo', baseBranch: 'dev' }, { repoId: web, path: 'web', baseBranch: 'main' }],
      })
      const { id: sessionId } = await insertSession(DEMO_PROJECT_ID, 'caller', { cwd: 'web', tool: 'claude', mode: 'tui', permissionMode: 'bypass' })
      const as = (claimed?: string): Actor => workspaceDelegate(BUILT_IN_USER_ID, 'caller', {
        projectId: DEMO_PROJECT_ID, ...(claimed !== undefined ? { sessionId: claimed } : {}),
      })
      const checkouts = async (workspaceId: string): Promise<Array<[string, string, string | undefined]>> =>
        (await listWorkspaceRepos(workspaceId)).map((c) => [c.repoId, c.path, c.baseBranch])

      const both = await start({ actor: as(sessionId) })
      expect(await checkouts(both.workspaceId)).toEqual([[DEMO_PROJECT_ID, 'demo', 'main'], [web, 'web', 'main']])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, both.workspaceId)).toMatchObject({ cwd: 'web' })
      // Outside any session, the workspace's own cwd.
      const unclaimed = await start({ actor: as() })
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, unclaimed.workspaceId)).toMatchObject({ cwd: 'demo' })
      // Named repos take nothing from the caller, the layout included; a
      // branch alone needs one repo.
      const named = await start({ actor: as(sessionId), repos: [{ repo: 'web' }] })
      expect(await checkouts(named.workspaceId)).toEqual([[web, '', 'main']])
      await expect(start({ actor: as(sessionId), branch: 'dev' })).rejects.toThrow(/names the start of exactly one repo/)
    })

    it('starts a workspace on steps of a delegate\'s own only at bypass, its own project only', async () => {
      const steps = { build: { run: 'make' } }
      await expect(start({ actor: workspaceDelegate(BUILT_IN_USER_ID, 'caller', { ceiling: 'accept-edits' }), steps }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining("run commands as the workspace does: permission mode 'bypass'") as string })
      await expect(start({ actor: workspaceDelegate(BUILT_IN_USER_ID, 'caller', { projectId: 'elsewhere' }) }))
        .rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(listProvisioning()).toEqual([])
    })

    it("caps a delegate's launches in flight, against concurrent requests, giving a slot back as each settles", async () => {
      const agent = workspaceDelegate(BUILT_IN_USER_ID, 'caller')
      const prepare = (actor: Actor = agent): Promise<unknown> => prepareStart(actor, {
        projectId: DEMO_PROJECT_ID, workspaceId: randomUUID(), noSession: true, rememberDefaults: false, claimSpare: false,
      })
      const runs = await Promise.allSettled(Array.from({ length: MAX_DELEGATE_LAUNCHES + 2 }, () => prepare()))
      expect(runs.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_DELEGATE_LAUNCHES)
      expect(runs.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT', message: expect.stringContaining('workspace caller') as string } })
      // A person, and another delegate, have their own.
      await expect(prepare(local)).resolves.toBeTypeOf('function')
      await expect(prepare(workspaceDelegate(BUILT_IN_USER_ID, 'other'))).resolves.toBeTypeOf('function')
      // A run that settles gives its slot back, failed or not.
      installDriver({ resolveImageChain: () => Promise.reject(new Error('stop here')) })
      const [first] = runs as Array<PromiseFulfilledResult<(p?: unknown) => Promise<unknown>>>
      await expect(first.value()).rejects.toThrow('stop here')
      await expect(prepare()).resolves.toBeTypeOf('function')
      await expect(prepare()).rejects.toMatchObject({ code: 'CONFLICT' })
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

    it('remembers what a person named, and only that, with what the workspace started with', async () => {
      await start({ tool: 'codex', permissionMode: 'accept-edits', branch: 'dev', rememberDefaults: true })
      expect(await getProjectRow(DEMO_PROJECT_ID)).toMatchObject({
        lastTool: 'codex',
        lastNested: false,
        lastCwd: DEMO_PROJECT_ID,
        repos: [{ dir: 'demo', lastIncluded: true, lastBranch: 'dev' }],
        createDefaults: { codex: { permissionMode: 'accept-edits', mode: 'tui' } },
      })
    })

    // What a workspace starts with is a create setting like the rest: named
    // or else as the project's last create had it (docs/project-repos.md).
    it('starts with the repos named, each in its folder at its branch, the agent in the cwd named, and the next create takes the same', async () => {
      const web = await seedSecondRepo('web')
      const checkouts = async (workspaceId: string): Promise<Array<[string, string, string | undefined]>> =>
        (await listWorkspaceRepos(workspaceId)).map((c) => [c.repoId, c.path, c.baseBranch])
      const checkedOut = async (workspaceId: string): Promise<string[]> =>
        (await fs.readdir(workspaceDir(DEMO_PROJECT_ID, workspaceId), { recursive: true }))
          .filter((f) => path.basename(f) === '.git').map((f) => path.dirname(f)).sort()

      const both = await start({ repos: [{ repo: 'demo', branch: 'dev' }, { repo: web }], cwd: 'web', rememberDefaults: true })
      expect(await checkouts(both.workspaceId)).toEqual([[DEMO_PROJECT_ID, 'demo', 'dev'], [web, 'web', 'main']])
      expect(await checkedOut(both.workspaceId)).toEqual(['demo', 'web'])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, both.workspaceId)).toMatchObject({ cwd: 'web' })
      expect((await listWorkspaceSessions(both.workspaceId))[0]).toMatchObject({ cwd: 'web' })
      expect(specs.at(-1)).toMatchObject({ cwd: 'web' })

      // Unnamed, each is as that create had it: both repos (at their
      // default branches), in folders, the agent in `web`.
      const same = await start()
      expect(await checkouts(same.workspaceId)).toEqual([[DEMO_PROJECT_ID, 'demo', 'main'], [web, 'web', 'main']])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, same.workspaceId)).toMatchObject({ cwd: 'web' })
      // A branch on its own names the start of one repo, which this is not.
      await expect(start({ branch: 'dev' })).rejects.toThrow(/names the start of exactly one repo/)
      await expect(start({ repos: [{ repo: 'demo' }, { repo: 'web' }], nested: false })).rejects.toThrow(/always sit in folders/)
      await expect(start({ repos: [{ repo: 'nope' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(start({ repos: [{ repo: 'web' }], cwd: 'demo' })).rejects.toThrow(/not "\." or a repo this workspace starts with/)
      // Nor does it add to a repo's own start, or start anything of no repos.
      await expect(start({ repos: [{ repo: 'web', branch: 'main' }], branch: 'dev' })).rejects.toThrow(/names the start of exactly one repo/)
      await expect(start({ repos: [], branch: 'dev' })).rejects.toThrow(/names the start of exactly one repo/)
      await expect(start({ repos: [], cwd: 'web' })).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(start({ repos: [{ repo: 'web' }, { repo: web }] })).rejects.toThrow(/selected twice/)
      await expect(start({ repos: [{ repo: 'web', branch: 'dev', commit: head }] })).rejects.toThrow(/a branch or a commit, not both/)
      await expect(start({ repos: [{ repo: 'web', branch: 'bad..name' }] })).rejects.toThrow(/"bad\.\.name" is not a branch name/)

      // One repo sits at the root unless asked into its folder, and the
      // remembered cwd, its repo, is then the root.
      const flat = await start({ repos: [{ repo: 'web' }], nested: false })
      expect(await checkouts(flat.workspaceId)).toEqual([[web, '', 'main']])
      expect(await checkedOut(flat.workspaceId)).toEqual(['.'])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, flat.workspaceId)).toMatchObject({ cwd: '' })
      // With no layout named it sits as the last create's did, in its
      // folder, and the agent there, since the remembered repo is not in it.
      const lone = await start({ repos: [{ repo: 'demo' }] })
      expect(await checkouts(lone.workspaceId)).toEqual([[DEMO_PROJECT_ID, 'demo', 'main']])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, lone.workspaceId)).toMatchObject({ cwd: 'demo' })
      // A remembered root stays the root.
      const nested = await start({ repos: [{ repo: 'web' }], nested: true, cwd: '.', rememberDefaults: true })
      expect(await checkouts(nested.workspaceId)).toEqual([[web, 'web', 'main']])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, nested.workspaceId)).toMatchObject({ cwd: '' })
      const rooted = await start({ repos: [{ repo: 'demo' }] })
      expect(await checkouts(rooted.workspaceId)).toEqual([[DEMO_PROJECT_ID, 'demo', 'main']])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, rooted.workspaceId)).toMatchObject({ cwd: '' })

      // A branch on its own starts a selection of one repo, and a cwd
      // naming a repo at the root is the root.
      const short = await start({ repos: [{ repo: 'web' }], nested: false, branch: 'dev', cwd: 'web' })
      expect(await checkouts(short.workspaceId)).toEqual([[web, '', 'dev']])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, short.workspaceId)).toMatchObject({ cwd: '' })
      // Each repo of several names its own start, a commit included, and
      // the cwd may name its repo by id. Each `.git` is assembled beside
      // the workspace dir, never inside it.
      const pinned = await start({ repos: [{ repo: 'demo', commit: head }, { repo: 'web', branch: 'dev' }], cwd: web })
      expect(await listWorkspaceRepos(pinned.workspaceId)).toEqual([
        { workspaceId: pinned.workspaceId, repoId: DEMO_PROJECT_ID, path: 'demo', startCommit: head },
        expect.objectContaining({ repoId: web, path: 'web', baseBranch: 'dev' }),
      ])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, pinned.workspaceId)).toMatchObject({ cwd: 'web' })
      const pinnedDir = workspaceDir(DEMO_PROJECT_ID, pinned.workspaceId)
      expect((await git(path.join(pinnedDir, 'demo'), ['rev-parse', 'HEAD'])).trim()).toBe(head)
      await expect(git(path.join(pinnedDir, 'demo'), ['rev-parse', '--abbrev-ref', '@{u}'])).rejects.toThrow()
      expect((await git(path.join(pinnedDir, 'web'), ['rev-parse', '--abbrev-ref', '@{u}'])).trim()).toBe('origin/dev')
      expect((await fs.readdir(path.dirname(pinnedDir))).filter((name) => name.startsWith('.staging-'))).toEqual([])

      // None is an empty workspace dir, with no credential or fetch needed,
      // and no layout to speak of.
      const none = await start({ repos: [], nested: true, rememberDefaults: true })
      expect(await checkouts(none.workspaceId)).toEqual([])
      expect(await fs.readdir(workspaceDir(DEMO_PROJECT_ID, none.workspaceId))).toEqual([])
      expect(await getProjectRow(DEMO_PROJECT_ID)).toMatchObject({
        lastNested: false, lastCwd: '.', repos: [{ dir: 'demo', lastIncluded: false, lastBranch: 'dev' }, { dir: 'web', lastIncluded: false }],
      })
      expect(await checkouts((await start()).workspaceId)).toEqual([])
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
      const waiting = await queueWorkspace(local, DEMO_PROJECT_ID, { prompt: 'waiting', group: groupId, mode: 'tui' })
      installDriver({ missingImageLayers: () => { installDriver(); throw new Error('no image') } })
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

    it('checks the last slot after taking a spare, so creates that each take one still fit, giving back the refused ones\' spares', async () => {
      const groupId = await limited(2)
      await running(groupId)
      offered = ['spare-1', 'spare-2', 'spare-3'].map((id) => ({ id, image: 'registry.test/fake-tools:t', scratchBytes: 32 * 1024 ** 3 }))
      const outcomes = await Promise.allSettled([1, 2, 3].map(() => prepare(groupId, { claimSpare: true })))
      expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected', 'rejected'])
      expect(listProvisioning().filter((p) => p.groupId === groupId)).toHaveLength(1)
      expect(takes).toHaveLength(3)
      await vi.waitFor(() => { expect(reaped).toHaveLength(2) })
    })
  })

  describe('a cold create', () => {
    it('checks out the requested branch, records the row and conversation, and launches the agent', async () => {
      // What the driver reports while it prepares reaches the caller too.
      let row: ReturnType<typeof listProvisioning>[number] | undefined
      installDriver({
        missingImageLayers: () => {
          row = listProvisioning()[0]
          return Promise.resolve([])
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
      // The stock image, all present, so nothing is built; the row records
      // what it launched, which a restart asks for again.
      expect(result).toEqual({
        workspaceId, jobName: `yaac-demo-${workspaceId}`, forwardedPorts: [], sessionId: session.id, image: 'registry.test/fake-tools:t',
      })
      expect(specs[0].image).toBe('registry.test/fake-tools:t')
      const launchedRow = await getWorkspaceRow(DEMO_PROJECT_ID, workspaceId)
      expect([launchedRow?.imageTag, launchedRow?.imageId]).toEqual(['fake-tools:t', undefined])
      // The row names what is coming up before any agent has answered, and
      // goes once the workspace is up.
      expect(row).toMatchObject({ workspaceId, kind: 'create', tool: 'codex', prompt: 'ship it', model: 'gpt-6-sol' })
      expect(listProvisioning()).toEqual([])
      expect(await git(workspaceDir(DEMO_PROJECT_ID, workspaceId), ['rev-parse', '--abbrev-ref', 'HEAD']))
        .toBe(`agent/${workspaceId}\n`)
      // Stored up front: a workspace queued while this one boots defaults to
      // its branch. The session keeps the user's choices for a restart.
      expect((await checkout(workspaceId))?.baseBranch).toBe('dev')
      expect(session).toMatchObject({
        tool: 'codex', mode: 'tui', permissionMode: 'bypass', model: 'gpt-6-sol', firstPrompt: 'ship it',
      })
      expect((await listWorkspaceSessions(workspaceId))[0]?.launchedAt).toBeInstanceOf(Date)
      // The stock chain is already built, so no build is reported.
      expect(progress).not.toContain('Building image yaac...')
      expect(progress).toEqual(expect.arrayContaining([
        'substrate ready', 'launching', 'Creating workspace from dev...', 'Starting Codex...',
      ]))
      // No spare was looked for.
      expect(takes).toEqual([])

      // The clone borrows from the main clone at the path the server sees it
      // at, mounted read-only there. The checkout wrote that itself, so
      // nothing relinks it, and a pod's file cache is warmed in the command
      // that starts the agent.
      expect(await fs.readFile(path.join(workspaceDir(DEMO_PROJECT_ID, workspaceId), '.git', 'objects', 'info', 'alternates'), 'utf8'))
        .toBe(`${repoDir(DEMO_PROJECT_ID)}/.git/objects\n`)
      expect(execOf('objects/info/alternates')).toBeUndefined()
      expect(sessionExec()).toContain('--no-optional-locks status')
      const { mounts } = specs[0]
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
      // omp's acp server loads conversations only from its agent dir's
      // sessions/, so the workspace's history goes there.
      expect(mounts).toContainEqual({
        source: { kind: 'hostPath', path: agentHistoryDir(DEMO_PROJECT_ID, workspaceId, 'omp') },
        mountPath: '/home/yaac/.omp/agent/sessions',
      })
      expect((await fs.stat(path.join(ompDir(DEMO_PROJECT_ID), 'agent', 'sessions'))).isDirectory()).toBe(true)
      // The shipped helper commands are mounted where the agent finds them,
      // read-only from the server build's folder, which every pod it makes
      // shares, a spare's included.
      const helpers = mounts.filter((m) => m.mountPath.startsWith('/usr/local/bin/'))
      expect(helpers.map((m) => m.mountPath)).toEqual(expect.arrayContaining(['/usr/local/bin/yaac-mama', '/usr/local/bin/yaac-watch-prs']))
      for (const { source, readOnly } of helpers) {
        expect(readOnly).toBe(true)
        expect(source).toMatchObject({ kind: 'hostPath', path: expect.stringMatching(/\/run\/helpers\/[^/]+\/bin\/[^/]+$/) as string })
      }
      // Every tool's home is mounted whatever the tool, since an agent of
      // any tool may start in it. A package tree shared by every pod would be a channel
      // between them, so the project's package cache is not.
      const sources = mounts.flatMap((m) => (m.source.kind === 'hostPath' ? [m.source.path] : []))
      expect(sources).toEqual(expect.arrayContaining([
        claudeDir(DEMO_PROJECT_ID), codexDir(DEMO_PROJECT_ID), opencodeConfigDir(DEMO_PROJECT_ID), piDir(DEMO_PROJECT_ID),
        ompDir(DEMO_PROJECT_ID), opencodeCheckpointDir(DEMO_PROJECT_ID, workspaceId), opencodeDataDir(DEMO_PROJECT_ID, workspaceId),
      ]))
      expect(sources).not.toContain(cachedPackagesDir(DEMO_PROJECT_ID))
      expect(env()).toEqual(expect.arrayContaining([
        `YAAC_WORKSPACE_ID=${workspaceId}`, 'YAAC_GIT_NAME=Ada', 'YAAC_GIT_EMAIL=ada@example.com',
        `YAAC_STATUS_RIGHT= ${workspaceId.slice(0, 8)} `,
      ]))
      // The opening message is left for the agent before its window opens,
      // and the agent is launched with it.
      const opening = `/tmp/.yaac-opening-${session.window}`
      const write = execs.findIndex((e) => e.cmd.startsWith(`cat > ${opening} `))
      expect(execs[write]?.stdin).toBe('ship it')
      expect(write).toBeLessThan(execs.findIndex((e) => SESSION_WINDOW.test(e.cmd)))
      expect(sessionExec()).toContain(`'export YAAC_SESSION_ID=${session.id}; `)
      expect(sessionExec()).toContain(' exec codex -C ')
      expect(sessionExec()).toContain(` --yolo --model gpt-6-sol -- "$(cat ${opening}; rm -f ${opening})"'`)
      // The workspace runs as the server's uid, so a chown would only corrupt
      // host-side ownership.
      expect(cmds().some((c) => c.includes('chown') || c.startsWith('sudo '))).toBe(false)
      // Onboarding state is seeded whatever the tool.
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

    // Every credentialed tool's key is seeded on any workspace (an agent of
    // any tool may start in it), as a placeholder the proxy swaps. opencode and pi
    // each read theirs from a variable of their own, so neither collides with
    // claude's or codex's.
    it.each<{ name: string; tool: AgentTool; key: string; kind: 'api-key' | 'oauth'; provider?: string; want: Record<string, string>; not: string[] }>([
      { name: 'claude api key', tool: 'claude', key: 'sk-ant', kind: 'api-key', want: { ANTHROPIC_API_KEY: PLACEHOLDER_API_KEY }, not: [] },
      { name: 'opencode on openrouter', tool: 'opencode', key: 'sk-or', kind: 'api-key', provider: 'openrouter', want: { YAAC_OPENCODE_KEY_OPENROUTER: PLACEHOLDER_OPENCODE_API_KEY, OPENCODE_CONFIG: '/home/yaac/.config/opencode/yaac-keys/openrouter.json' }, not: ['OPENROUTER_API_KEY'] },
      { name: 'opencode on neuralwatt', tool: 'opencode', key: 'nw', kind: 'api-key', provider: 'neuralwatt', want: { YAAC_OPENCODE_KEY_NEURALWATT: PLACEHOLDER_OPENCODE_API_KEY }, not: ['NEURALWATT_API_KEY', 'YAAC_OPENCODE_KEY_OPENROUTER'] },
      { name: 'pi on anthropic', tool: 'pi', key: 'sk-ant', kind: 'api-key', provider: 'anthropic', want: { YAAC_PI_KEY_ANTHROPIC: PLACEHOLDER_PI_API_KEY }, not: ['ANTHROPIC_API_KEY'] },
      { name: 'omp on anthropic', tool: 'omp', key: 'sk-ant', kind: 'api-key', provider: 'anthropic', want: { YAAC_OMP_KEY_ANTHROPIC: PLACEHOLDER_OMP_API_KEY }, not: ['ANTHROPIC_API_KEY', 'YAAC_PI_KEY_ANTHROPIC'] },
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
        'YAAC_OMP_AGENT_DIR=/home/yaac/.omp/agent',
      ]))
    })

    it('runs a workflow\'s revision, its run secrets named on the spec and only for a non-interactive start', async () => {
      const pushed: Array<Record<string, string>> = []
      installDriver({ syncProjectSecrets: (_p, _v, run) => { pushed.push(run); return Promise.resolve() } })
      await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' })
      await createWorkflow(local, DEMO_PROJECT_ID, { name: 'relay', steps: { t: { run: 'true' } }, secrets: ['P8_KEY'] })
      const ci = { nonInteractive: true, noSession: true, commit: head, workflow: 'relay' }
      const { workspaceId } = await start(ci)
      // The runtime holds the value, current as of this launch; the spec
      // only names it, and mounts nothing an agent could have written.
      expect(specs[0].runSecrets).toEqual(['P8_KEY'])
      expect(pushed.at(-1)).toEqual({ P8_KEY: 'pem' })
      expect(env().join('\n')).not.toContain('pem')
      expect(specs[0].mounts.map((m) => m.mountPath)).not.toContain('/home/yaac/.claude')
      const row = await getWorkspaceRow(DEMO_PROJECT_ID, workspaceId)
      expect(row?.workflowId).toBe((await resolveWorkflow(DEMO_PROJECT_ID, 'relay')).workflow.id)
      expect(row?.workflowName).toBe('relay')
      expect(row?.title).toBe(`relay @ ${head.slice(0, 8)}`)
      // Naming no group, it goes in the workflow's own.
      expect((await listWorkspaceGroupRows(DEMO_PROJECT_ID)).find((g) => g.groupId === row?.groupId))
        .toMatchObject({ name: 'relay', ownerKind: 'workflow' })

      installDriver({ kind: 'containerless' })
      await start(ci)
      expect(specs[1].runSecrets).toBeUndefined()
      expect(specs[1].env).toContain('P8_KEY=pem')
      expect(specs[1].secretEnvKeys).toContain('P8_KEY')

      // Interactive, it opens without them, where its create puts it; steps
      // beside it are refused.
      const open = await start({ noSession: true, workflow: 'relay' })
      expect(specs[2].env.join('\n')).not.toContain('P8_KEY')
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, open.workspaceId))?.groupId).toBeUndefined()
      await expect(start({ ...ci, steps: { t: { run: 'true' } } })).rejects.toThrow('not both')
    })

    it('pins every repo of a secret-bearing start to the commit it was approved at', async () => {
      const web = await seedSecondRepo('web')
      await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' })
      await createWorkflow(local, DEMO_PROJECT_ID, { name: 'relay', steps: { t: { run: 'true' } }, secrets: ['P8_KEY'] })
      const webHead = (await git(repoDir(web), ['rev-parse', 'origin/dev'])).trim()
      // A person's launch at branches resolves each tip and approves it.
      const { workspaceId } = await start({
        nonInteractive: true, noSession: true, workflow: 'relay', repos: [{ repo: 'demo', branch: 'main' }, { repo: 'web', branch: 'dev' }],
      })
      expect((await listWorkspaceRepos(workspaceId)).map((c) => [c.repoId, c.startCommit, c.baseBranch])).toEqual([
        [DEMO_PROJECT_ID, head, undefined], [web, webHead, undefined],
      ])
      // The second repo is seeded as a copy, so the two may share a commit,
      // which is approved once.
      expect((await showWorkflow(DEMO_PROJECT_ID, 'relay')).approvedCommits.sort()).toEqual([...new Set([head, webHead])].sort())
    })

    it('gives opencode, pi and omp each their own key for one provider, in the config each tool reads', async () => {
      installDriver({ kind: 'containerless' })
      await saveToolAuth('opencode', 'sk-or-oc', 'openrouter')
      await saveToolAuth('pi', 'sk-or-pi', 'openrouter')
      await saveToolAuth('omp', 'sk-or-omp', 'openrouter')
      // A user's own pi config is kept.
      const models = path.join(piDir(DEMO_PROJECT_ID), 'agent', 'models.json')
      await fs.mkdir(path.dirname(models), { recursive: true })
      await fs.writeFile(models, JSON.stringify({ providers: { ollama: { baseUrl: 'http://localhost:11434/v1' } } }))

      await start({ tool: 'claude' })

      expect(env()).toEqual(expect.arrayContaining([
        'YAAC_OPENCODE_KEY_OPENROUTER=sk-or-oc', 'YAAC_PI_KEY_OPENROUTER=sk-or-pi', 'YAAC_OMP_KEY_OPENROUTER=sk-or-omp',
      ]))
      expect(env().map((e) => e.split('=')[0])).not.toContain('OPENROUTER_API_KEY')
      expect(JSON.parse(await fs.readFile(path.join(opencodeConfigDir(DEMO_PROJECT_ID), 'yaac-keys', 'openrouter.json'), 'utf8')))
        .toEqual({ provider: { openrouter: { env: ['YAAC_OPENCODE_KEY_OPENROUTER', 'OPENROUTER_API_KEY'] } } })
      expect(JSON.parse(await fs.readFile(models, 'utf8'))).toEqual({ providers: {
        ollama: { baseUrl: 'http://localhost:11434/v1' },
        openrouter: { apiKey: '!printenv YAAC_PI_KEY_OPENROUTER || printenv OPENROUTER_API_KEY' },
      } })
      // omp gets its key entry, its launch overlays, yaac's extension and
      // yaac's skills in its own home.
      const ompAgent = path.join(ompDir(DEMO_PROJECT_ID), 'agent')
      expect(await fs.readFile(path.join(ompAgent, 'models.yml'), 'utf8'))
        .toBe('providers:\n  openrouter:\n    apiKey: "!printenv YAAC_OMP_KEY_OPENROUTER || printenv OPENROUTER_API_KEY"\n')
      expect((await fs.readdir(ompAgent)).sort()).toEqual(['extensions', 'models.yml', 'skills', 'yaac.yml'])
      expect(await fs.readFile(path.join(ompAgent, 'extensions', 'yaac-report.ts'), 'utf8')).toContain("'omp', session")
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
      { name: 'a github.com remote', want: ghTokenPlaceholder(DEMO_PROJECT_ID) },
      { name: 'a non-GitHub remote', remote: 'https://gitlab.com/o/r.git', want: undefined },
      { name: 'a project GH_TOKEN', plain: 'GH_TOKEN', want: 'ghp_user' },
      { name: 'a proxied GITHUB_TOKEN secret', secret: 'GITHUB_TOKEN', want: undefined },
    ])('seeds GH_TOKEN as it should for $name', async ({ remote, plain, secret, want }) => {
      if (remote !== undefined) await setRemote(remote)
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
      installDriver({ kind: 'containerless' })
      const created = await Promise.all([1, 2, 3].map(() => start({ claimSpare: true })))
      expect(takes).toEqual([])
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

    // A pod mounts its server build's folder, staged once
    // (docs/generic-workspace-pods.md "The pod"); a containerless workspace
    // copies them each launch.
    it('stages the helper commands each containerless launch, mounting each read-only onto /usr/local/bin', async () => {
      installDriver({ kind: 'containerless' })
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
    // before or after the create resolved. It waits for the create's run,
    // whose success would erase it, and then files a failed row, which
    // leaves the workspace to the reaper.
    it('reports an agent that died right after launch as a failed row, once the create has settled', async () => {
      installDriver({
        exec: (_jobName, cmd) => {
          if (cmd.includes('list-windows -t =yaac')) return Promise.reject(new WorkspaceExecError('probe', 1, '', 'codex'))
          return Promise.resolve({ stdout: '', stderr: '' })
        },
      })

      await start({ workspaceId: 'wt-dead', tool: 'codex', prompt: 'go' })

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
    // Under the session id the client minted, which its provisioning row
    // names from the start.
    it('holds a chat workspace\'s prompt from before its agent starts, and returns without waiting for it', async () => {
      const sessionId = randomUUID()
      let heldAtLaunch: string | undefined
      let rows: ReturnType<typeof listProvisioning> | undefined
      let released!: () => void
      const agentUp = new Promise<void>((resolve) => { released = resolve })
      installDriver({
        exec: async (jobName, cmd) => {
          execs.push({ jobName, cmd })
          if (SESSION_WINDOW.test(cmd)) heldAtLaunch = (await listWorkspaceSessions('wt-chat'))[0]?.pendingPrompt
          rows ??= listProvisioning()
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
      expect(await start({ workspaceId: 'wt-chat', sessionId, mode: 'acp', prompt: 'go', onProgress: (m) => progress.push(m) }))
        .toMatchObject({ workspaceId: 'wt-chat', sessionId })
      expect(rows).toEqual([expect.objectContaining({ workspaceId: 'wt-chat', sessionId, prompt: 'go' })])
      expect(heldAtLaunch).toBe('go')
      expect((await listWorkspaceSessions('wt-chat'))[0]).toMatchObject({ id: sessionId, pendingPrompt: 'go' })
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

    it('starts its life with the project\'s init workflows and log hooks, and declares the forwards, before the agent', async () => {
      await setProjectConfig(DEMO_PROJECT_ID, { portForwards: [{ containerPort: 3000, hostPortStart: 3000 }] })
      await createWorkflow(local, DEMO_PROJECT_ID, { name: 'init', init: true, steps: {
        install: { run: 'pnpm install' },
        dev: { run: 'pnpm dev', service: true, needs: ['install'] },
      } })

      const result = await start({ tool: 'claude', model: 'claude-opus-4-5' })

      // Clients bind the ports (docs/port-forward-tunnel.md); the create only
      // declares them.
      expect(result.forwardedPorts).toEqual([{ containerPort: 3000, hostPort: 3000 }])
      // The life's hooks are sourced in the setup exec, before the agent's
      // window opens; its steps wait, pending, for the step reconcile.
      const setup = execOf('new-window')!
      expect(setup).toMatch(/source-file '\/home\/yaac\/\.yaac-logs\/[\dT.-]+Z\/hooks\.conf' \\; new-window/)
      expect(setup).toContain('claude --permission-mode bypassPermissions --model claude-opus-4-5 '
        + `--settings "{\\"idleCompaction\\":false}" --session-id ${result.sessionId}`)
      const steps = await listWorkspaceSteps(result.workspaceId)
      expect(steps.map((s) => [s.workflowName, s.name, s.origin, s.state])).toEqual([
        ['init', 'install', 'start', 'pending'], ['init', 'dev', 'start', 'pending'],
      ])
      // A create bringing its own graph replaces them, named `_steps` for
      // every life; one with none, none.
      const own = await start({ noSession: true, steps: { lint: { run: ['pnpm lint', 'pnpm test'] } } })
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, own.workspaceId))?.workflowName).toBe('_steps')
      expect((await listWorkspaceSteps(own.workspaceId)).map((s) => [s.workflowName, s.name, s.spec.run]))
        .toEqual([['_steps', 'lint', ['pnpm lint', 'pnpm test']]])
      const none = await start({ noSession: true, steps: null })
      expect(await listWorkspaceSteps(none.workspaceId)).toEqual([])
    })

    it('starts each init workflow whose repos the workspace has, saying which it skips', async () => {
      await seedSecondRepo('api')
      await createWorkflow(local, DEMO_PROJECT_ID, { name: 'web-init', init: true, repos: ['demo'], steps: {
        install: { run: 'pnpm install' },
        serve: { run: 'pnpm dev', service: true, needs: ['install', 'api-init.migrate'] },
      } })
      await createWorkflow(local, DEMO_PROJECT_ID, { name: 'api-init', init: true, repos: ['api'], steps: {
        install: { run: 'pip install' },
        migrate: { run: 'alembic upgrade', needs: ['install'] },
      } })
      // A workspace of both starts both graphs, a step of the same name in each.
      const both = await start({ noSession: true, repos: [{ repo: 'demo' }, { repo: 'api' }] })
      expect((await listWorkspaceSteps(both.workspaceId)).map((s) => `${s.workflowName}.${s.name}`).sort())
        .toEqual(['api-init.install', 'api-init.migrate', 'web-init.install', 'web-init.serve'])
      // A workspace of one starts only its own, and says the other was skipped.
      const progress: string[] = []
      const web = await start({ noSession: true, repos: [{ repo: 'demo' }], onProgress: (m) => progress.push(m) })
      expect((await listWorkspaceSteps(web.workspaceId)).map((s) => `${s.workflowName}.${s.name}`))
        .toEqual(['web-init.install', 'web-init.serve'])
      expect(progress).toContain('Init workflow "api-init" skipped: this workspace has no api')
      // A named launch without the repo its workflow names is refused.
      await expect(start({ noSession: true, repos: [{ repo: 'demo' }], workflow: 'api-init' }))
        .rejects.toThrow('workflow "api-init" runs in api, which this start does not include')
    })

    it('starts a containerless chat agent alongside its checkout, holding its conversation until the checkout lands', async () => {
      installDriver({ kind: 'containerless' })
      await start({ workspaceId: 'wt-early', mode: 'acp' })

      // The agent's command goes first, after only the life's log hooks
      // its window is logged under; acpd holds the conversation until
      // `.git` exists. The setup that reads the checkout follows it.
      const agents = execs.findIndex(({ cmd }) => SESSION_WINDOW.test(cmd))
      const setup = execs.findIndex(({ cmd }) => cmd.includes(`rename-window -t =yaac:=${KEEPER_STARTING}`))
      expect(execs[agents].cmd).toMatch(/hooks\.conf' \\; new-window.*--wait-for \/workspace\/\.git --/)
      expect(setup).toBeGreaterThan(agents)
      expect(execs[setup].cmd).not.toMatch(SESSION_WINDOW)
      expect(execs[setup].cmd).not.toContain('hooks.conf')

      // A terminal agent reads the checkout as it starts, so it waits for it.
      execs.length = 0
      await start({ workspaceId: 'wt-tui', mode: 'tui' })
      const tui = sessionExec()!
      expect(tui).toContain('hooks.conf')
      expect(tui).not.toContain('--wait-for')
    })

    it('refuses a bad start, before provisioning', async () => {
      await expect(start({ noSession: true, steps: { 'a.b': { run: 'echo hi' } } })).rejects.toThrow('step "a.b": a name is')
      // Nothing runs beside a start's own graph, so a need on another
      // workflow's step names nothing.
      await expect(start({ noSession: true, steps: { t: { run: 'true', needs: ['other.build'] } } })).rejects.toThrow('not a step of this workspace')
      await expect(start({ branch: 'main', commit: 'a'.repeat(40) })).rejects.toThrow('not both')
      await expect(start({ commit: 'abc123' })).rejects.toThrow('not a full commit id')
      // A non-interactive workspace brings a graph that ends, and no session.
      await expect(start({ nonInteractive: true, noSession: true })).rejects.toThrow('needs its own steps')
      await expect(start({ nonInteractive: true, noSession: true, steps: { db: { run: 'pg', service: true } } }))
        .rejects.toThrow('needs its own steps')
      await expect(start({ nonInteractive: true, steps: { t: { run: 'pnpm test' } } })).rejects.toThrow('starts no agent')
      expect(specs).toEqual([])
    })

    it('creates at a commit, with no base branch, recording the commit it started at', async () => {
      const result = await start({ noSession: true, commit: head })
      const row = await checkout(result.workspaceId)
      expect(row?.baseBranch).toBeUndefined()
      expect(row?.startCommit).toBe(head)
      // A branch create records its tip too.
      const branched = await start({ noSession: true })
      expect((await checkout(branched.workspaceId))?.startCommit).toBe(head)
      // A commit origin cannot serve is refused.
      await expect(start({ noSession: true, commit: 'f'.repeat(40) })).rejects.toThrow(/origin has no commit/)
    })

    // A start never waits on the network for a branch the main clone has.
    it('starts from the last commit fetched when origin cannot be reached, saying so', async () => {
      // Nothing listens on this host's 443, so the fetch fails at once.
      vi.stubEnv('YAAC_E2E_SKIP_FETCH', '')
      await setRemote('https://127.0.0.1/o/r.git')
      await setProjectEgressAllowlist(DEMO_PROJECT_ID, { hosts: ['127.0.0.1'], defaults: true })

      await start({ workspaceId: 'wt-nofetch' })

      expect((await checkout('wt-nofetch'))?.startCommit).toBe(head)
      await vi.waitFor(() => {
        expect(logged()).toMatch(/wt-nofetch: the checkout starts from the last commit fetched: .*could not fetch from https:\/\/127\.0\.0\.1\/o\/r\.git/)
      }, { timeout: 30_000 })
      // A branch the clone has never seen needs the fetch, and fails with it.
      await expect(start({ workspaceId: 'wt-unseen', branch: 'unseen' })).rejects.toThrow(/could not fetch from/)
    })

    it('hands an SSH remote the host key it was assigned with, and no GH_TOKEN', async () => {
      await setRemote('git@github.com:o/r.git')
      const key = await insertGitCredential({ owner: BUILT_IN_USER_ID, name: 'key', kind: 'ssh', secret: 'c2VlZA==', publicKey: 'ssh-ed25519 AAAA yaac' })
      await setRepoGitCredential(DEMO_PROJECT_ID, key.id, 'github.com ssh-ed25519 AAAAC3')

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

    // Pushing to an empty origin changes the remote, so it waits for every
    // check that can refuse the create; the next create still seeds it.
    it('gives an empty origin its default branch only once the create\'s checks pass', async () => {
      const hosted = '6c4f3a5d-2e1b-4c0a-9d8e-3b4c5d6e7f80'
      await recordTestProject(hosted, { name: 'fresh', remoteUrl: `http://yaac.internal/${hosted}.git`, hosted: true })
      await fs.mkdir(path.dirname(hostedRepoDir(hosted)), { recursive: true })
      await initHostedRepo(hostedRepoDir(hosted))
      await cloneRepo(hostedRepoDir(hosted), repoDir(hosted), { kind: 'hosted' })
      const branches = async (): Promise<string> => git(hostedRepoDir(hosted), ['for-each-ref', '--format=%(refname) %(subject)', 'refs/heads'])

      installDriver({ assertCanLaunch: async () => {
        await new Promise((r) => setTimeout(r, 500))
        throw new Error('no claude here')
      } })
      await expect(start({ projectId: hosted })).rejects.toThrow('no claude here')
      expect(await branches()).toBe('')

      installDriver()
      await start({ projectId: hosted, noSession: true })
      expect(await branches()).toBe('refs/heads/main Initial commit\n')
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
      const rowAtImage = async (workspaceId: string, branch?: string): Promise<WorkspaceRepoRow | undefined> => {
        let row: WorkspaceRepoRow | undefined
        installDriver({
          resolveImageChain: async () => {
            row = await checkout(workspaceId)
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
        dirs: [{ path: 'node_modules' }, { path: 'target' }, { path: 'web/node_modules' }],
        sizeGiB: 42,
      })

      await start({ workspaceId: 'wt-tracked', branch: 'tracked' })
      // All of them share the project's size.
      expect(specs[0].scratchDirs).toEqual(['/workspace/node_modules', '/workspace/target', '/workspace/web/node_modules'])
      expect(specs[0].scratchBytes).toBe(42 * 1024 ** 3)
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
      expect((await getWorkspaceRow(DEMO_PROJECT_ID, after.workspaceId))?.timeZone).toBe('Asia/Tokyo')
    })
  })

  // A failed create rolls back. Its prompt survives as a draft, updating
  // the one it came from, only for a caller that asked; the error is the
  // create's own, so its code stands.
  /**
   * A start does not wait for its fetch of origin: it begins at the commit
   * the main clone has and catches up once the fetch lands. Origin here is
   * a real repository whose fetch a case holds back, and the runtime's
   * workspaces are their real checkouts, in which it runs each move.
   */
  describe('catching up with origin', () => {
    let origin: string
    let hold: () => () => void
    let release: () => void
    const dirOf = (id: string, repo = ''): string => path.join(workspaceDir(DEMO_PROJECT_ID, id), repo)
    const rev = async (dir: string, what = 'HEAD'): Promise<string> => (await git(dir, ['rev-parse', what])).trim()
    const moves = (): string[] => cmds().filter((c) => c.includes('merge --ff-only'))
    /** Wait for a start's timing line to say what its catch-up did. */
    const caughtUp = (id: string, facts: string): Promise<void> => vi.waitFor(() => {
      expect(logged()).toMatch(new RegExp(`\\[timing\\] ${id} create ok .* ${facts}$`, 'm'))
    }, { timeout: 30_000 })

    function installRealCheckouts(overrides: Partial<WorkspaceDriver> = {}): void {
      installDriver({
        kind: 'containerless',
        workspacePaths: (jobName) => workspacePathsFixture({ workspaceDir: dirOf(jobName.slice('yaac-demo-'.length)) }),
        exec: async (jobName, cmd) => {
          execs.push({ jobName, cmd })
          let stdout = ''
          for (const move of cmd.match(/\{ yaac_how=skipped; git -C \S+ update-ref .*?echo "yaac-at:[^"]*"; \}/g) ?? []) {
            stdout += await new Promise<string>((resolve, reject) => {
              execFile('sh', ['-c', move], (err, out) => { if (err) reject(new Error(err.message)); else resolve(out) })
            })
          }
          return { stdout, stderr: '' }
        },
        ...overrides,
      })
    }

    beforeEach(async () => {
      ({ origin, hold } = await slowRealOrigin())
      release = hold()
      installRealCheckouts()
    })
    afterEach(() => { release() })

    it('launches the agent on the commit the main clone has, then fast-forwards its checkout when the fetch lands', async () => {
      const tip = await pushTo(origin, 'main', 'late.txt')

      const { workspaceId } = await start({ workspaceId: 'wt-late' })

      // The agent's window is open, and the fetch has not answered.
      const dir = dirOf(workspaceId)
      expect(sessionExec()).toBeDefined()
      expect(await rev(dir)).toBe(head)
      expect((await checkout(workspaceId))?.startCommit).toBe(head)
      expect(moves()).toEqual([])
      // What the agent did meanwhile, where the incoming commits change
      // nothing, stays. A hook of its repo is not run on the server's say-so.
      await fs.writeFile(path.join(dir, 'README.md'), 'edited\n')
      await fs.writeFile(path.join(dir, 'notes.txt'), 'mine\n')
      await fs.mkdir(path.join(dir, '.git', 'hooks'), { recursive: true })
      await fs.writeFile(path.join(dir, '.git', 'hooks', 'post-merge'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o755 })

      release()
      await vi.waitFor(async () => { expect((await checkout(workspaceId))?.startCommit).toBe(tip) }, { timeout: 30_000 })
      expect(await rev(dir)).toBe(tip)
      expect(await rev(dir, 'origin/main')).toBe(tip)
      expect((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD', '@{u}'])).trim().split('\n')).toEqual([`agent/${workspaceId}`, 'origin/main'])
      expect(await fs.readFile(path.join(dir, 'README.md'), 'utf8')).toBe('edited\n')
      expect((await fs.readdir(dir)).sort()).toEqual(['.git', 'README.md', 'late.txt', 'node_modules', 'notes.txt', 'target'])
      await caughtUp(workspaceId, 'catchup=ff')
    })

    it('catches up ahead of the agent when the fetch has landed by the time its window opens, and runs nothing for a tip that has not moved', async () => {
      const tip = await pushTo(origin, 'main', 'early.txt')
      // The runtime comes up only after the checkout is made and the fetch
      // has then landed.
      installRealCheckouts({
        awaitReady: async (unit) => {
          await vi.waitFor(() => fs.access(path.join(dirOf(unit.workspaceId), '.git')), { timeout: 30_000 })
          release()
          await fetched('main', tip)
        },
      })

      const { workspaceId } = await start({ workspaceId: 'wt-early' })

      const launch = sessionExec() ?? ''
      expect(launch.indexOf(`merge --ff-only ${tip}`)).toBeGreaterThanOrEqual(0)
      expect(launch.indexOf(`merge --ff-only ${tip}`)).toBeLessThan(launch.search(SESSION_WINDOW))
      expect(await rev(dirOf(workspaceId))).toBe(tip)
      expect((await checkout(workspaceId))?.startCommit).toBe(tip)

      // The next start picks that tip, and its fetch brings nothing newer.
      execs = []
      const next = await start()
      await new Promise((r) => setTimeout(r, 300))
      expect(await rev(dirOf(next.workspaceId))).toBe(tip)
      expect(moves()).toEqual([])
    })

    // Nothing runs in a workspace before its windows open, so a checkout
    // that cannot be fast-forwarded can be reset there without losing a
    // write.
    it('resets a checkout to a force-pushed branch only ahead of the agent, and never one whose agent opened early', async () => {
      /** A runtime that comes up once the checkout is made and the fetch,
       *  released then, has landed. */
      const upAfterFetch = (tip: string): Partial<WorkspaceDriver> => ({
        awaitReady: async (unit) => {
          await vi.waitFor(() => fs.access(path.join(dirOf(unit.workspaceId), '.git')), { timeout: 30_000 })
          release()
          await fetched('main', tip)
        },
      })
      const rewritten = await pushTo(origin, 'main', 'rewritten.txt', { rewrite: true })
      installRealCheckouts(upAfterFetch(rewritten))

      await start({ workspaceId: 'wt-forced-early' })

      // The untouched test is one no git config can narrow, and removes
      // nothing: with nothing untracked there is nothing to clean.
      const launch = sessionExec() ?? ''
      expect(launch).toContain('status --porcelain --untracked-files=all --ignore-submodules=none')
      expect(launch).not.toContain('clean -fd')
      expect(launch.indexOf(`reset --hard ${rewritten}`)).toBeLessThan(launch.search(SESSION_WINDOW))
      expect(await rev(dirOf('wt-forced-early'))).toBe(rewritten)
      expect(await git(dirOf('wt-forced-early'), ['status', '--porcelain'])).toBe('')
      expect((await checkout('wt-forced-early'))?.startCommit).toBe(rewritten)
      await caughtUp('wt-forced-early', 'catchup=reset')

      // A chat agent of a containerless workspace opens before its checkout
      // lands, so by this command it may be at work: fast-forward only.
      release = hold()
      const again = await pushTo(origin, 'main', 'again.txt', { rewrite: true })
      installDriver({ kind: 'containerless', ...upAfterFetch(again) })
      execs = []
      await start({ workspaceId: 'wt-chat', mode: 'acp' })
      const [move] = moves()
      expect(move).toContain(`merge --ff-only ${again} `)
      expect(move).not.toContain('reset --hard')
    })

    it('leaves a workspace behind origin when the fetch outlasts the wait after its launch', async () => {
      const tip = await pushTo(origin, 'main', 'too-late.txt')
      await start({ workspaceId: 'wt-slow' })
      await vi.waitFor(() => {
        expect(logged()).toMatch(/wt-slow: the checkout is left behind origin\/main: the fetch took longer than 5s/)
      }, { timeout: 30_000 })
      release()
      await fetched('main', tip)
      await new Promise((r) => setTimeout(r, 300))
      expect(await rev(dirOf('wt-slow'))).toBe(head)
      expect(moves()).toEqual([])
      await caughtUp('wt-slow', 'catchup=late')
    })

    it('leaves alone, once its agent is running, a checkout with work of its own or one git cannot fast-forward', async () => {
      /** Start a workspace while the fetch is held, let its agent act in
       *  the checkout, then let the fetch land. */
      const startThen = async (id: string, agent: (dir: string) => Promise<unknown>): Promise<string> => {
        release()
        release = hold()
        await start({ workspaceId: id })
        await agent(dirOf(id))
        release()
        return dirOf(id)
      }
      const leftAlone = (id: string): Promise<void> => vi.waitFor(() => {
        expect(logged()).toMatch(new RegExp(`${id}: the checkout is left at \\w{12}, behind origin/main: it could not be moved there safely`))
      }, { timeout: 30_000 })

      // The agent committed: git cannot fast-forward, and the checkout is
      // not where it started.
      const first = await pushTo(origin, 'main', 'a.txt')
      const committed = await startThen('wt-committed', (dir) =>
        git(dir, ['-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-q', '--allow-empty', '-m', 'mine']))
      await leftAlone('wt-committed')
      expect(await git(committed, ['log', '-1', '--format=%s'])).toBe('mine\n')
      // Its `origin/main` is origin's all the same, and its row keeps the
      // commit it started at.
      expect(await rev(committed, 'origin/main')).toBe(first)
      expect((await checkout('wt-committed'))?.startCommit).toBe(head)

      // The agent changed a file the incoming commits change: git refuses.
      await fetched('main', first)
      const second = await pushTo(origin, 'main', 'README.md')
      const edited = await startThen('wt-edited', (dir) => fs.writeFile(path.join(dir, 'README.md'), 'mine\n'))
      await leftAlone('wt-edited')
      expect(await rev(edited)).toBe(first)
      expect(await fs.readFile(path.join(edited, 'README.md'), 'utf8')).toBe('mine\n')

      // Origin's branch was rewritten. The agent is running, and a reset
      // could lose what it writes meanwhile, so even an untouched checkout
      // stays where it is.
      await fetched('main', second)
      const rewritten = await pushTo(origin, 'main', 'b.txt', { rewrite: true })
      const forced = await startThen('wt-forced', () => Promise.resolve())
      await leftAlone('wt-forced')
      expect(await rev(forced)).toBe(second)
      expect(await rev(forced, 'origin/main')).toBe(rewritten)
      expect(moves().every((c) => !c.includes('reset --hard'))).toBe(true)
      for (const id of ['wt-committed', 'wt-edited', 'wt-forced']) await caughtUp(id, 'catchup=skipped')
    })

    it('starts a named branch the main clone has at once, waits for the fetch only for one it lacks, and refuses one origin lacks too', async () => {
      // `dev` is in the main clone, so its start does not wait.
      expect((await checkout((await start({ branch: 'dev' })).workspaceId))?.baseBranch).toBe('dev')

      // `fresh` is only on origin: the start waits for the fetch to bring it.
      const fresh = await pushTo(origin, 'dev', 'fresh.txt')
      await git(origin, ['branch', 'fresh', fresh])
      await git(origin, ['update-ref', 'refs/heads/dev', head])
      let started = false
      const waiting = start({ workspaceId: 'wt-fresh', branch: 'fresh' }).finally(() => { started = true })
      await new Promise((r) => setTimeout(r, 300))
      expect(started).toBe(false)
      release()
      await waiting
      expect(await rev(dirOf('wt-fresh'))).toBe(fresh)
      expect(await checkout('wt-fresh')).toMatchObject({ baseBranch: 'fresh', startCommit: fresh })

      // `ghost` is on neither.
      await expect(start({ branch: 'ghost' })).rejects.toThrow(/branch "ghost" not found on origin/)

      // `dev` is gone from origin but still in the main clone: it starts,
      // and stays on the branch once the fetch says so.
      await git(origin, ['branch', '-D', 'dev'])
      release = hold()
      await start({ workspaceId: 'wt-gone', branch: 'dev' })
      release()
      await vi.waitFor(() => {
        expect(logged()).toMatch(/wt-gone: the checkout stays on dev, which origin no longer has/)
      }, { timeout: 30_000 })
      expect(await rev(dirOf('wt-gone'))).toBe(head)
    })

    // Nothing may change such a run once it starts, so it never begins on
    // an older commit to be moved later.
    it('holds a non-interactive run for its fetch, starting it at origin\'s tip', async () => {
      const tip = await pushTo(origin, 'main', 'ci.txt')
      let started = false
      const run = start({ workspaceId: 'wt-ci', nonInteractive: true, noSession: true, steps: { t: { run: 'true' } } })
        .finally(() => { started = true })
      await new Promise((r) => setTimeout(r, 300))
      expect(started).toBe(false)
      release()
      await run
      expect(await rev(dirOf('wt-ci'))).toBe(tip)
      expect((await checkout('wt-ci'))?.startCommit).toBe(tip)
      await new Promise((r) => setTimeout(r, 300))
      expect(moves()).toEqual([])
    })

    it('catches each checkout up on its own repo\'s fetch', async () => {
      const web = await seedSecondRepo('web')
      const other = await slowRealOrigin(web)
      const releaseWeb = other.hold()
      const tip = await pushTo(origin, 'main', 'demo.txt')
      const webTip = await pushTo(other.origin, 'main', 'web.txt')

      const { workspaceId } = await start({ repos: [{ repo: 'demo' }, { repo: 'web' }] })

      // The demo repo's fetch lands first: only its checkout moves.
      release()
      await vi.waitFor(async () => { expect(await rev(dirOf(workspaceId, 'demo'))).toBe(tip) }, { timeout: 30_000 })
      expect(await fs.readdir(dirOf(workspaceId, 'web'))).not.toContain('web.txt')
      releaseWeb()
      await vi.waitFor(async () => { expect(await rev(dirOf(workspaceId, 'web'))).toBe(webTip) }, { timeout: 30_000 })
      await caughtUp(workspaceId, 'catchup.demo=ff catchup.web=ff')
      await vi.waitFor(async () => {
        expect((await listWorkspaceRepos(workspaceId)).map((c) => c.startCommit).sort()).toEqual([tip, webTip].sort())
      })
    })
  })

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
      imageId: STOCK_IMAGE_ID,
      draft: { id: draft.id, ...(onFailure ? { onFailure } : {}) },
    })

    await expect(failing('wt-plain', false)).rejects.toMatchObject({ message: 'pod never became ready' })
    expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({ id: draft.id, prompt: 'old' })])

    await expect(failing('wt-fail', true)).rejects.toMatchObject({
      code: 'VALIDATION', message: 'pod never became ready; its prompt is kept as a draft',
    })
    expect(await listDraftWorkspaces()).toEqual([expect.objectContaining({
      id: draft.id, prompt: 'fix the build', title: 'Build', tool: 'codex', permissionMode: 'accept-edits', imageId: STOCK_IMAGE_ID,
    })])
    expect(shared.message).toBe('pod never became ready')
    // The failed row carries what the caller is told.
    expect(listProvisioning()).toContainEqual(expect.objectContaining({
      workspaceId: 'wt-fail', error: 'pod never became ready; its prompt is kept as a draft',
    }))
    await vi.waitFor(async () => expect(await getWorkspaceRow(DEMO_PROJECT_ID, 'wt-fail')).toBeUndefined(), { timeout: 30_000 })
  })

  /**
   * A create takes a spare of its image and scratch size, when one waits,
   * before it names its workspace: the workspace then has the spare's id,
   * and its provisioning row names it as `claimedId`. The launch is the
   * same as a cold one's; a spare cannot carry what only a pod made on
   * demand has (docs/generic-workspace-pods.md "A claim").
   */
  describe('taking a spare', () => {
    const GIB = 1024 ** 3
    const STOCK = 'registry.test/fake-tools:t'

    it('takes one of the project\'s image and scratch size, and the workspace has its id', async () => {
      await setScratchDirs(local, DEMO_PROJECT_ID, { sizeGiB: 8 })
      offered = [{ id: 'spare-1', image: STOCK, scratchBytes: 8 * GIB }]
      let row: ReturnType<typeof listProvisioning>[number] | undefined
      installDriver({
        missingImageLayers: () => {
          row = listProvisioning()[0]
          return Promise.resolve([])
        },
      })
      const progress: string[] = []

      const result = await start({ workspaceId: 'asked-1', claimSpare: true, prompt: 'go', onProgress: (m) => progress.push(m) })

      expect(takes).toEqual([{ image: STOCK, scratchBytes: 8 * GIB, madeSince: expect.any(Number) as number }])
      expect(result.workspaceId).toBe('spare-1')
      expect(row).toMatchObject({ workspaceId: 'asked-1', claimedId: 'spare-1', prompt: 'go' })
      expect(progress).toContain('Using a prewarmed workspace...')
      expect(specs.map((s) => [s.workspaceId, s.image, s.scratchBytes])).toEqual([['spare-1', STOCK, 8 * GIB]])
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, 'spare-1')).toBeDefined()
      expect(await getWorkspaceRow(DEMO_PROJECT_ID, 'asked-1')).toBeUndefined()
      expect(reaped).toEqual([])
      // With none left, the next create launches under its own id.
      expect((await start({ workspaceId: 'asked-2', claimSpare: true })).workspaceId).toBe('asked-2')
      expect(takes).toHaveLength(2)
    })

    it('lets only one of two concurrent creates have a single spare, the other launching under its own id', async () => {
      offered = [{ id: 'spare-1', image: STOCK, scratchBytes: 32 * GIB }]
      const results = await Promise.all(['asked-1', 'asked-2'].map((workspaceId) => start({ workspaceId, claimSpare: true })))
      const ids = results.map((r) => r.workspaceId)
      expect(ids.filter((id) => id === 'spare-1')).toHaveLength(1)
      expect(ids.filter((id) => id.startsWith('asked-'))).toHaveLength(1)
    })

    // Its launch never adopted it, or adopted it and failed after.
    it('reaps the spare a failed create took', async () => {
      offered = [{ id: 'spare-1', image: STOCK, scratchBytes: 32 * GIB }]
      installDriver({ awaitReady: () => Promise.reject(new Error('pod never became ready')) })

      await expect(start({ claimSpare: true })).rejects.toThrow('pod never became ready')

      expect(takes).toHaveLength(1)
      expect(reaped).toEqual(['spare-1'])
    })

    // The user stops it by the id it was asked under, while it runs under
    // the spare's.
    it('rolls back a create the user stops while it runs in a spare, reaping the spare', async () => {
      offered = [{ id: 'spare-1', image: STOCK, scratchBytes: 32 * GIB }]
      // The take asks the registry too, whether the pool's image is built;
      // the stop lands once the spare is held.
      installDriver({
        missingImageLayers: async () => {
          if (offered.length === 0) await stopWorkspace(local, 'asked-1')
          return []
        },
      })

      await expect(start({ workspaceId: 'asked-1', claimSpare: true })).rejects.toMatchObject({ code: 'CONFLICT' })

      expect(specs).toEqual([])
      expect(reaped).toEqual(['spare-1'])

      // Or by the spare's id, which a yaac-mama create prints.
      offered = [{ id: 'spare-2', image: STOCK, scratchBytes: 32 * GIB }]
      installDriver({
        missingImageLayers: async () => {
          if (offered.length === 0) expect(await stopWorkspace(local, 'spare-2')).toMatchObject({ provisioning: true })
          return []
        },
      })
      await expect(start({ workspaceId: 'asked-2', claimSpare: true })).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(specs).toEqual([])
      expect(reaped).toEqual(['spare-1', 'spare-2'])
    })

    // A byo volume's claim, a run's secret variables and a build not yet
    // made are in a pod's spec from its creation, and a named image is no
    // pool's.
    it('takes none for a create a spare cannot carry, or when pools are off', async () => {
      offered = [{ id: 'spare-1', image: STOCK, scratchBytes: 32 * GIB }]
      await createVolume(local, DEMO_PROJECT_ID, 'queue')
      await setRunSecret(local, DEMO_PROJECT_ID, { name: 'P8_KEY', value: 'pem' })
      await createWorkflow(local, DEMO_PROJECT_ID, { name: 'relay', steps: { t: { run: 'true' } }, secrets: ['P8_KEY'] })

      await start({ claimSpare: true, volume: 'queue' })
      await start({ claimSpare: true, nonInteractive: true, noSession: true, commit: head, workflow: 'relay' })
      await start({ claimSpare: true, awaitBuild: true })
      await start({ claimSpare: true, image: STOCK })
      vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '0')
      await start({ claimSpare: true })
      vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '1')
      // Refused for a full group before its run, so before any take.
      const { groupId } = await createWorkspaceGroup(DEMO_PROJECT_ID, 'Full', null)
      await setWorkspaceGroupLimit(DEMO_PROJECT_ID, groupId, 1)
      await running(groupId)
      await expect(start({ claimSpare: true, groupId })).rejects.toMatchObject({ code: 'CONFLICT' })

      expect(takes).toEqual([])
      expect(offered).toHaveLength(1)
    })

    // The create route asks for one for every caller, so a delegate's
    // workspace has the spare's id too, which the result hands back.
    it('takes one for a delegate\'s create too', async () => {
      offered = [{ id: 'spare-1', image: STOCK, scratchBytes: 32 * GIB }]
      await saveToolAuth('claude', 'k')
      const agent = workspaceDelegate(BUILT_IN_USER_ID, 'spare-caller', { projectId: DEMO_PROJECT_ID })

      expect((await start({ actor: agent, claimSpare: true })).workspaceId).toBe('spare-1')
    })
  })
})

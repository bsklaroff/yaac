import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as dbModule from '#db'
// The git identity a claim applies to the checkout, read through #db.
const mockGitIdentity = vi.hoisted(() => vi.fn())

vi.mock('#db', async (importOriginal) => ({
  ...(await importOriginal<typeof dbModule>()),
  applyWorkspaceEvent: vi.fn(),
  claimSpareWorkspace: vi.fn(),
  restoreSpareWorkspace: vi.fn(),
  getWorkspaceRow: vi.fn(),
  listActiveAgentSessions: vi.fn(),
  setWorkspaceGroup: vi.fn(),
  setWorkspaceTitle: vi.fn(),
  getGitIdentity: mockGitIdentity,
  getTimeZone: vi.fn(),
  getProjectRow: vi.fn(),
}))

vi.mock('#domain/workspaces/spare-pool', () => ({
  retoolSpare: vi.fn(),
  rebranchSpare: vi.fn(),
}))
vi.mock('#domain/workspaces/cleanup', () => ({
  cleanupWorkspace: vi.fn(),
  deleteWorkspaceState: vi.fn(),
}))
vi.mock('#runtime/status/liveness', () => ({
  isTmuxSessionAlive: vi.fn(),
}))
vi.mock('#domain/git', () => ({
  fetchOrigin: vi.fn(),
  getDefaultBranch: vi.fn(),
  maintainRepo: vi.fn(() => Promise.resolve()),
  remoteBranchExists: vi.fn(),
  // Given its value at construction, so it survives resetAllMocks.
  resolveRemoteRef: vi.fn(() => Promise.resolve('cafebabe1234')),
}))
vi.mock('#domain/projects/config', () => ({ resolveProjectConfig: vi.fn() }))
vi.mock('#domain/projects/credentials', () => ({ resolveProjectCredential: vi.fn() }))
vi.mock('#domain/projects/env', () => ({ resolveProjectEnv: vi.fn() }))
vi.mock('#domain/projects/detail', async (importOriginal) => ({
  ...await importOriginal<object>(),
  projectRemoteUrl: vi.fn(() => Promise.resolve('https://example.com/p.git')),
}))

import {
  tryClaimPrewarmed,
  // Claim state, read to assert what a claim reserved and released.
  claiming,
  inFlight,
  reaping,
  refreshing,
  clearPrewarmStateForTests,
} from '#domain/workspaces/prewarm'
import {
  clearAllProvisioningForTests, listProvisioning, registerProvisioning,
} from '#domain/workspaces/provisioning'
import { cleanupWorkspace, deleteWorkspaceState } from '#domain/workspaces/cleanup'
import { isTmuxSessionAlive } from '#runtime/status/liveness'
import { rebranchSpare, retoolSpare } from '#domain/workspaces/spare-pool'
import {
  fetchOrigin,
  getDefaultBranch,
  remoteBranchExists,
  resolveRemoteRef,
} from '#domain/git'
import { resolveProjectConfig } from '#domain/projects/config'
import { resolveProjectEnv } from '#domain/projects/env'
import { ServerError } from '@yaac/shared/errors'
import type { WorkspaceEvent } from '#db'
import {
  BUILT_IN_USER_ID,
  applyWorkspaceEvent,
  claimSpareWorkspace,
  getProjectRow,
  getTimeZone,
  getWorkspaceRow,
  restoreSpareWorkspace,
  setWorkspaceGroup,
  setWorkspaceTitle,
  type ProjectRow,
  type WorkspaceRow,
} from '#db'
import type { CreateSetup } from '#domain/workspaces/create'
import {
  _resetAcpRegistryForTests,
  registerAcpConversation,
} from '#runtime/agents/acp-registry'
import type { AcpConversation } from '#runtime/agents/acp-client'
import { handleFixture, installFakeWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import type { RuntimeHandle, WorkspaceRegistration } from '#drivers/contract'
import type { AgentTool } from '@yaac/shared/types'

// The runtime verbs the claim calls. The fake driver installed below just
// delegates to these.
const mockList = vi.fn<(projectId?: string) => Promise<RuntimeHandle[]>>()
const mockClaimSpare = vi.fn<(workspaceId: string, tool: AgentTool) => Promise<void>>()
const mockExec = vi.fn<(jobName: string, cmd: string) => Promise<{ stdout: string; stderr: string }>>()
/** The spare checkout's HEAD: origin's tip unless a case moves it. Kept
 *  separate from `mockExec`, whose calls cases count. */
const mockHead = vi.fn<(jobName: string) => Promise<string>>()
const mockAwaitTransport = vi.fn<(jobName: string, opts?: { timeoutMs?: number }) => Promise<void>>()
const mockRegister = vi.fn<(reg: WorkspaceRegistration) => Promise<void>>()

const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockRetool = vi.mocked(retoolSpare)
const mockRebranch = vi.mocked(rebranchSpare)
const mockCleanup = vi.mocked(cleanupWorkspace)
const mockDeleteState = vi.mocked(deleteWorkspaceState)
const mockFetchOrigin = vi.mocked(fetchOrigin)
const mockDefaultBranch = vi.mocked(getDefaultBranch)
const mockRemoteBranchExists = vi.mocked(remoteBranchExists)
const mockResolveConfig = vi.mocked(resolveProjectConfig)

/** Let a burned claim's unawaited teardown chain finish. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const emit = vi.fn()

function spare(o: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return handleFixture({
    jobName: 'yaac-p-spare',
    workspaceId: 'spare1',
    projectId: 'p',
    tool: 'claude',
    declaredTool: 'claude',
    createdAtMs: 1_000,
    prewarmed: true,
    ...o,
  })
}

/** A resolved create setup: tui, bypass, no model unless given. This matches
 *  what `launched()` warms spares as by default. */
function setup(tool: AgentTool = 'claude', o: Partial<CreateSetup> = {}): CreateSetup {
  return { tool, permissionMode: 'bypass', mode: 'tui', ...o }
}

/** Stub the spare's row as warming left it, from `main` unless given. */
function launched(o: Partial<WorkspaceRow> = {}): void {
  vi.mocked(getWorkspaceRow).mockImplementation((projectId, workspaceId) => Promise.resolve({
    projectId, workspaceId, permissionMode: 'bypass', mode: 'tui', baseBranch: 'main', ...o,
  } as WorkspaceRow))
}

const appliedEvents: WorkspaceEvent[] = []

describe('tryClaimPrewarmed', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearPrewarmStateForTests()
    _resetAcpRegistryForTests()
    clearAllProvisioningForTests()
    // The create's provisioning row, which the claim points at its spare.
    registerProvisioning({ workspaceId: 'req', projectId: 'p', tool: 'claude', kind: 'create' })
    // The claim reports events instead of writing rows; they are captured
    // here and asserted.
    appliedEvents.length = 0
    vi.mocked(applyWorkspaceEvent).mockImplementation((event) => {
      appliedEvents.push(event)
      return Promise.resolve()
    })
    mockTmuxAlive.mockResolvedValue(true)
    mockList.mockResolvedValue([])
    mockClaimSpare.mockResolvedValue(undefined)
    mockExec.mockResolvedValue({ stdout: '', stderr: '' })
    mockHead.mockResolvedValue('cafebabe1234')
    mockAwaitTransport.mockResolvedValue(undefined)
    mockRegister.mockResolvedValue(undefined)
    installFakeWorkspaceDriver({
      list: mockList,
      claimSpare: mockClaimSpare,
      // The fetch's fan-out to other workspaces is not counted.
      exec: async (jobName, cmd) => cmd.includes('rev-parse -q --verify HEAD')
        ? { stdout: `${await mockHead(jobName)}\n`, stderr: '' }
        : cmd.includes('--no-write-fetch-head') ? { stdout: '', stderr: '' } : mockExec(jobName, cmd),
      awaitAgentTransport: mockAwaitTransport,
      registerWorkspace: mockRegister,
    })
    vi.mocked(resolveProjectEnv).mockResolvedValue({ plain: {}, secrets: {} })
    mockRetool.mockResolvedValue(undefined)
    mockRebranch.mockResolvedValue(undefined)
    vi.mocked(setWorkspaceGroup).mockResolvedValue(undefined)
    mockCleanup.mockResolvedValue(true)
    mockDeleteState.mockResolvedValue(true)
    // Spare warmed from main and no configured default, so no re-branch
    // unless a test asks.
    mockResolveConfig.mockResolvedValue({})
    mockDefaultBranch.mockResolvedValue('main')
    mockRemoteBranchExists.mockResolvedValue(true)
    mockFetchOrigin.mockResolvedValue(undefined)
    mockGitIdentity.mockResolvedValue({ name: 'A B', email: 'a@b.co' })
    vi.mocked(getTimeZone).mockResolvedValue({ timeZone: null, pinned: false })
    vi.mocked(getProjectRow).mockResolvedValue({ owner: BUILT_IN_USER_ID } as ProjectRow)
    launched()
  })

  it('claims a ready spare, re-applies identity, and returns its id', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit)
    expect(result).toEqual({ workspaceId: 'spare1', jobName: 'yaac-p-spare', tool: 'claude', mode: 'tui', forwardedPorts: [] })
    expect(mockClaimSpare).toHaveBeenCalledWith('spare1', 'claude')
    // The create's row names the spare until the create resolves.
    expect(listProvisioning()).toMatchObject([{ workspaceId: 'req', claimedId: 'spare1' }])
    // One exec carries both identity settings.
    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(mockExec.mock.calls[0][1]).toBe(
      "git config --global user.name 'A B' && git config --global user.email 'a@b.co'",
    )
    expect(claiming.size).toBe(0) // released in finally
  })

  // A spare is registered when warmed. Allowlist or secret edits since then
  // must reach it at claim time, as they would a cold create.
  it('re-registers the spare from the project as it is at claim time', async () => {
    mockList.mockResolvedValue([spare()])
    mockResolveConfig.mockResolvedValue({ setAllowedUrls: ['*'] })
    vi.mocked(resolveProjectEnv).mockResolvedValue({
      plain: {},
      secrets: { API_KEY: { value: 'v', rule: { hosts: ['api.example.com'] } } },
    })

    await tryClaimPrewarmed('p', 'req', setup('claude'), emit)

    expect(mockRegister).toHaveBeenCalledWith({
      workspaceId: 'spare1',
      projectId: 'p',
      owner: 'install',
      tool: 'claude',
      config: { setAllowedUrls: ['*'] },
      remoteUrl: 'https://example.com/p.git',
      proxySecretRules: { API_KEY: { hosts: ['api.example.com'] } },
    })
    expect(mockRetool).not.toHaveBeenCalled()
    // Before the commit, so the workspace is never handed over with the old
    // registration.
    expect(mockRegister.mock.invocationCallOrder[0])
      .toBeLessThan(mockClaimSpare.mock.invocationCallOrder[0])
  })

  // Under its own tool the spare's registration is still consistent, so it
  // returns to the pool; retooled, it may not match its agent and is reaped.
  it('releases a spare whose re-registration failed under its own tool, reaps one retooled', async () => {
    mockRegister.mockRejectedValue(new Error('apiserver down'))

    mockList.mockResolvedValue([spare()])
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    await flush()
    expect(mockCleanup).not.toHaveBeenCalled()
    expect(vi.mocked(restoreSpareWorkspace))
      .toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p', workspaceId: 'spare1' }))
    expect(claiming.size).toBe(0)

    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    await flush()
    expect(mockCleanup).toHaveBeenCalledTimes(1)
    // The proxy injects credentials only for the registered tool, so no
    // respawn starts until the registration has landed.
    expect(mockRetool).not.toHaveBeenCalled()
  })

  it('reports the workspace and its first conversation, warmed-from branch and all', async () => {
    mockList.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'req', setup('claude'), emit)

    // The spare's id is the first conversation, which records its tool. No
    // re-branch means no second branch report.
    expect(vi.mocked(claimSpareWorkspace)).toHaveBeenCalledWith('p', 'spare1', {
      permissionMode: 'bypass', mode: 'tui',
    })
    expect(appliedEvents).toEqual([
      {
        type: 'sessions-launched',
        projectId: 'p',
        workspaceId: 'spare1',
        sessions: [{ tool: 'claude', agentSessionId: 'spare1' }],
      },
    ])
  })

  it('reports the branch a re-branched claim ended on, not the one it was warmed from', async () => {
    mockList.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'req', setup('claude'), emit, { branch: 'dev' })

    expect(appliedEvents.filter((e) => e.type === 'base-branch-resolved')).toEqual([
      {
        type: 'base-branch-resolved', projectId: 'p', workspaceId: 'spare1', baseBranch: 'dev',
      },
    ])
  })

  // A claim that gave up after reporting must remove the spare entirely;
  // the caller will cold-create instead. The claim already cleared the
  // `spare` flag, so the dead-spare sweep would not collect the checkout.
  it('collects the burned spare whole — runtime, then checkout, then row', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockRetool.mockRejectedValue(new Error('retool blew up'))

    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    await flush()

    expect(mockDeleteState).toHaveBeenCalledWith('p', 'spare1')
    expect(appliedEvents.at(-1)).toEqual({
      type: 'workspace-create-failed', projectId: 'p', workspaceId: 'spare1',
    })
    // The awaited teardown runs first, so the checkout is never removed under
    // a mounted workspace. The row goes last, so a partial failure leaves
    // something the stale reaper can still see.
    expect(mockCleanup.mock.invocationCallOrder[0])
      .toBeLessThan(mockDeleteState.mock.invocationCallOrder[0])
    expect(mockDeleteState.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(applyWorkspaceEvent).mock.invocationCallOrder.at(-1)!)
  })

  // Each step removes what the previous one relied on, so each runs only if
  // the previous succeeded.
  it('keeps the checkout, and its row, when the teardown cannot confirm the runtime is gone', async () => {
    // An unconfirmed teardown may still be writing to /workspace.
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockRetool.mockRejectedValue(new Error('retool blew up'))
    mockCleanup.mockResolvedValue(false)

    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    await flush()
    expect(mockDeleteState).not.toHaveBeenCalled()
    expect(appliedEvents.some((e) => e.type === 'workspace-create-failed')).toBe(false)
  })

  it('keeps the row when the checkout could not be removed', async () => {
    // Deleting the row after a failed rm would orphan the checkout for good.
    // What survives shows up as an ordinary stopped workspace.
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockRetool.mockRejectedValue(new Error('retool blew up'))
    mockDeleteState.mockResolvedValue(false)

    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    await flush()
    expect(mockDeleteState).toHaveBeenCalledWith('p', 'spare1')
    expect(appliedEvents.some((e) => e.type === 'workspace-create-failed')).toBe(false)
  })

  it('returns undefined when there is no spare', async () => {
    mockList.mockResolvedValue([])
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    expect(mockClaimSpare).not.toHaveBeenCalled()
  })

  it('retools a spare booted with a different tool, then commits for the claimed tool', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit)

    expect(result).toEqual({ workspaceId: 'spare1', jobName: 'yaac-p-spare', tool: 'claude', mode: 'tui', forwardedPorts: [] })
    expect(mockRetool).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare' }), setup('claude'))
    expect(mockClaimSpare).toHaveBeenCalledWith('spare1', 'claude')
    expect(emit).toHaveBeenCalledWith('Switching prewarmed session to claude...')
    expect(claiming.size).toBe(0)
  })

  it('does not retool when the spare already matches', async () => {
    mockList.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'req', setup('claude'), emit)
    expect(mockRetool).not.toHaveBeenCalled()
  })

  it('prefers a matching-tool spare over a newer mismatched one', async () => {
    mockList.mockResolvedValue([
      spare({ jobName: 'yaac-p-codex', workspaceId: 'sc', tool: 'codex', declaredTool: 'codex', createdAtMs: 9_000 }),
      spare({ createdAtMs: 1_000 }),
    ])
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit)
    expect(result?.workspaceId).toBe('spare1')
    expect(mockRetool).not.toHaveBeenCalled()
  })

  it('reaps the tainted spare and falls back to cold create when the retool fails', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    let claimedDuringRetool: string | undefined
    mockRetool.mockImplementation(() => {
      claimedDuringRetool = listProvisioning()[0].claimedId
      return Promise.reject(new Error('respawn failed'))
    })

    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    // The row named the spare during the claim, then drops it for the cold
    // create under the row's own id.
    expect(claimedDuringRetool).toBe('spare1')
    expect(listProvisioning()[0].claimedId).toBeUndefined()
    expect(mockCleanup).toHaveBeenCalledWith({
      jobName: 'yaac-p-spare', projectId: 'p', workspaceId: 'spare1',
    })
    // The reservation is kept so a concurrent claim cannot take the dying
    // spare.
    expect(claiming.has('yaac-p-spare')).toBe(true)
  })

  it('reaps the spare when the commit fails after a retool', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockClaimSpare.mockRejectedValue(new Error('pod gone'))

    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    expect(mockCleanup).toHaveBeenCalledTimes(1)
  })

  // The reap deletes the Job and checkout once its salvage finishes, so a
  // claim landing first would lose the user's new workspace.
  it('passes over a spare the reconciler is reaping', async () => {
    mockList.mockResolvedValue([spare()])
    reaping.add('spare1')
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    expect(mockClaimSpare).not.toHaveBeenCalled()
    expect(claiming.size).toBe(0)
  })

  it('releases and skips a spare whose tmux is dead', async () => {
    mockList.mockResolvedValue([spare()])
    mockTmuxAlive.mockResolvedValue(false)
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    expect(mockClaimSpare).not.toHaveBeenCalled()
    expect(claiming.size).toBe(0)
  })

  it('gates on the agent transport before the first mutation, and leaves the spare alone if it never answers', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockAwaitTransport.mockRejectedValue(new Error('agent transport not reachable after 10000ms'))

    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    expect(mockAwaitTransport).toHaveBeenCalledWith('yaac-p-spare', { timeoutMs: 10_000 })
    // Nothing ran inside the spare, so it is untouched: the claim falls back
    // to a cold create and the spare stays in the pool.
    expect(mockRetool).not.toHaveBeenCalled()
    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockClaimSpare).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
    await flush()
    expect(mockDeleteState).not.toHaveBeenCalled()
    expect(claiming.size).toBe(0)
  })

  it('falls through (undefined) and clears the reservation if the commit fails', async () => {
    mockList.mockResolvedValue([spare()])
    mockClaimSpare.mockRejectedValue(new Error('pod gone'))
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    expect(claiming.size).toBe(0)
  })

  it('keeps the claimed session when the identity re-apply fails', async () => {
    // This step is past the commit point and optional, so a transport error
    // must not reap a good session.
    mockList.mockResolvedValue([spare()])
    mockExec.mockRejectedValue(new Error('transport dial: timeout'))

    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit)
    expect(result?.workspaceId).toBe('spare1')
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  // A spare's git identity is set at warm time, so every claim reapplies the
  // current setting. Otherwise a changed identity would silently keep the
  // old one on claimed workspaces.
  it('re-keys a claimed spare from the identity the setting holds now', async () => {
    mockGitIdentity.mockResolvedValue({ name: 'New Name', email: 'new@example.com' })
    mockList.mockResolvedValue([spare()])

    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit)

    expect(result?.workspaceId).toBe('spare1')
    expect(mockExec.mock.calls[0][1]).toBe(
      "git config --global user.name 'New Name'"
      + " && git config --global user.email 'new@example.com'",
    )
  })

  it('execs nothing when the server has no identity, and still claims', async () => {
    // With no identity set, the spare keeps its warm-time identity and the
    // claim succeeds.
    mockGitIdentity.mockResolvedValue(null)
    mockList.mockResolvedValue([spare()])

    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit)
    expect(result?.workspaceId).toBe('spare1')
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('lets only one of two concurrent claims win the single spare', async () => {
    mockList.mockResolvedValue([spare()])
    const [a, b] = await Promise.all([
      tryClaimPrewarmed('p', 'req', setup('claude'), emit),
      tryClaimPrewarmed('p', 'req', setup('claude'), emit),
    ])
    const claimed = [a, b].filter(Boolean)
    expect(claimed).toHaveLength(1)
    expect(mockClaimSpare).toHaveBeenCalledTimes(1)
    expect(claiming.size).toBe(0)
  })

  it('returns undefined (cold create) if the workspace listing throws', async () => {
    mockList.mockRejectedValue(new Error('cluster down'))
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    expect(inFlight.size).toBe(0)
  })

  it('re-branches a spare when the requested branch differs, then commits the claim', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit, { branch: 'dev' })

    expect(result?.workspaceId).toBe('spare1')
    expect(mockFetchOrigin).toHaveBeenCalledTimes(1)
    expect(mockRebranch).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }),
      'dev',
      'cafebabe1234',
      setup('claude'), // matches as warmed; the re-branch respawns the agent
    )
    expect(mockClaimSpare).toHaveBeenCalledWith('spare1', 'claude')
    expect(emit).toHaveBeenCalledWith('Switching prewarmed session to branch dev...')
    expect(claiming.size).toBe(0)
  })

  it('skips re-branch prep entirely when the spare already matches the request', async () => {
    mockList.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'req', setup('claude'), emit, { branch: 'main' })
    // Fetched once to check whether origin moved.
    expect(mockFetchOrigin).toHaveBeenCalledTimes(1)
    expect(mockRebranch).not.toHaveBeenCalled()
  })

  it('brings a spare whose branch moved on origin up to its tip before the hand-over', async () => {
    mockList.mockResolvedValue([spare()])
    mockHead.mockResolvedValue('0ldbase')
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit, { prompt: 'go' })

    expect(result?.workspaceId).toBe('spare1')
    // Same prep as a re-branch, onto the same branch, so the agent restarts
    // on the updated checkout before any prompt.
    expect(mockRebranch).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }), 'main', 'cafebabe1234', setup('claude'),
    )
    expect(mockHead).toHaveBeenCalledWith('yaac-p-spare')
    expect(mockRebranch.mock.invocationCallOrder[0])
      .toBeLessThan(mockClaimSpare.mock.invocationCallOrder[0])
    expect(emit).toHaveBeenCalledWith('Updating prewarmed session to the latest main...')
    // Same branch as warmed, so no second branch report.
    expect(appliedEvents.some((e) => e.type === 'base-branch-resolved')).toBe(false)
  })

  it('hands a spare over as warmed when its fetch fails or outlasts the wait', async () => {
    mockList.mockResolvedValue([spare()])
    mockHead.mockResolvedValue('0ldbase')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mockFetchOrigin.mockRejectedValue(new Error('remote unreachable'))
    expect((await tryClaimPrewarmed('p', 'req', setup('claude'), emit))?.workspaceId).toBe('spare1')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('remote unreachable'))

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      mockFetchOrigin.mockReturnValue(new Promise<void>(() => { /* never lands */ }))
      const claim = tryClaimPrewarmed('p', 'req', setup('claude'), emit)
      await vi.advanceTimersByTimeAsync(5_000)
      expect((await claim)?.workspaceId).toBe('spare1')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fetch still running'))
    } finally {
      vi.useRealTimers()
    }

    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('hands the agent respawn to the retool when tool and branch both differ', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit, { branch: 'dev' })
    expect(result?.tool).toBe('claude')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'dev', 'cafebabe1234', null)
    expect(mockRetool).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare' }), setup('claude'))
  })

  it('a model override retools a spare whose tool already matches (agent must respawn with --model)', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'req', setup('claude', { model: 'claude-opus-4-8' }), emit)
    expect(result?.workspaceId).toBe('spare1')
    expect(mockRetool).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }), setup('claude', { model: 'claude-opus-4-8' }),
    )
    // Same tool: no retool message, and the commit names the claimed tool.
    expect(emit).not.toHaveBeenCalledWith('Switching prewarmed session to claude...')
    expect(mockClaimSpare).toHaveBeenCalledWith('spare1', 'claude')
  })

  it('a model override on a re-branched claim skips the rebranch respawn (retool respawns with --model)', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'req', setup('claude', { model: 'claude-opus-4-8' }), emit, { branch: 'dev' })
    expect(result?.workspaceId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'dev', 'cafebabe1234', null)
    expect(mockRetool).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }), setup('claude', { model: 'claude-opus-4-8' }),
    )
  })

  it('propagates VALIDATION for an unknown branch and releases the spare untouched', async () => {
    mockList.mockResolvedValue([spare()])
    mockRemoteBranchExists.mockResolvedValue(false)

    await expect(tryClaimPrewarmed('p', 'req', setup('claude', { permissionMode: 'plan' }), emit, { branch: 'nope' }))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled() // nothing ran in the spare yet
    expect(claiming.size).toBe(0) // released for the next claim
    // The row is claimed before the branch is validated, so the error path
    // must restore it. Otherwise the pooled spare's row would say it is a
    // user's workspace, and a later reap would leave a phantom stopped row.
    expect(vi.mocked(claimSpareWorkspace)).toHaveBeenCalledWith('p', 'spare1', expect.objectContaining({ permissionMode: 'plan' }))
    // Restored to its warm-time launch settings, which the next claim reads
    // to decide whether to respawn the agent.
    expect(vi.mocked(restoreSpareWorkspace)).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p', workspaceId: 'spare1', permissionMode: 'bypass',
    }))
  })

  it('reaps the tainted spare and falls back to cold create when the re-branch fails', async () => {
    mockList.mockResolvedValue([spare()])
    mockRebranch.mockRejectedValue(new Error('reset failed'))

    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit, { branch: 'dev' })).toBeUndefined()
    expect(mockCleanup).toHaveBeenCalledWith({
      jobName: 'yaac-p-spare', projectId: 'p', workspaceId: 'spare1',
    })
    expect(claiming.has('yaac-p-spare')).toBe(true)
  })

  it('does not swallow a mid-mutation VALIDATION-shaped failure into a throw', async () => {
    // Any error after the spare was modified falls back to a cold create and
    // reaps the spare instead of propagating.
    mockList.mockResolvedValue([spare()])
    mockRebranch.mockRejectedValue(new ServerError('VALIDATION', 'weird in-pod failure'))
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit, { branch: 'dev' })).toBeUndefined()
    expect(mockCleanup).toHaveBeenCalledTimes(1)
  })

  it('re-branches onto an explicitly requested branch', async () => {
    // Spare warmed from develop; the caller asked for another branch.
    mockList.mockResolvedValue([spare()])
    launched({ baseBranch: 'develop' })
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit, { branch: 'dev' })
    expect(result?.workspaceId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'dev', 'cafebabe1234', setup('claude'))
  })

  it('re-branches a spare warmed off the default branch back to it on a bare create', async () => {
    // Spare warmed from develop; a bare create wants the repo default.
    mockList.mockResolvedValue([spare()])
    launched({ baseBranch: 'develop' })
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit)
    expect(result?.workspaceId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'main', 'cafebabe1234', setup('claude'))
  })

  // Spares are warmed with the project's default settings, so a usual claim
  // matches and the agent is handed over without a respawn.
  it('hands over a spare warmed with the requested model and posture untouched', async () => {
    mockList.mockResolvedValue([spare()])
    launched({ model: 'claude-opus-5-5', permissionMode: 'plan' })
    const want = setup('claude', { model: 'claude-opus-5-5', permissionMode: 'plan' })

    expect((await tryClaimPrewarmed('p', 'req', want, emit))?.workspaceId).toBe('spare1')
    expect(mockRetool).not.toHaveBeenCalled()
    // The permission mode, agent mode and model are recorded, and the
    // conversation is named before the agent answers.
    expect(vi.mocked(claimSpareWorkspace)).toHaveBeenCalledWith('p', 'spare1', expect.objectContaining({
      permissionMode: 'plan', mode: 'tui', model: 'claude-opus-5-5',
    }))
    expect(appliedEvents).toContainEqual(expect.objectContaining({
      type: 'sessions-launched',
      sessions: [{ tool: 'claude', agentSessionId: 'spare1', model: 'claude-opus-5-5' }],
    }))
  })

  it('respawns a spare warmed in another posture into the requested one', async () => {
    mockList.mockResolvedValue([spare()])
    const want = setup('claude', { permissionMode: 'plan' })

    expect((await tryClaimPrewarmed('p', 'req', want, emit))?.workspaceId).toBe('spare1')
    expect(mockRetool).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare' }), want)
  })

  // Effort is launch state like the model, so a spare warmed at another
  // level is respawned, and the claim records the one asked for.
  it('respawns a spare warmed at another effort, recording the requested one', async () => {
    mockList.mockResolvedValue([spare()])
    launched({ model: 'claude-opus-5-5', effort: 'medium' })
    const want = setup('claude', { model: 'claude-opus-5-5', effort: 'max' })

    expect((await tryClaimPrewarmed('p', 'req', want, emit))?.workspaceId).toBe('spare1')
    expect(mockRetool).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare' }), want)
    expect(vi.mocked(claimSpareWorkspace)).toHaveBeenCalledWith('p', 'spare1', expect.objectContaining({ effort: 'max' }))
  })

  it('prefers a spare warmed as asked over a newer one that would need a respawn', async () => {
    mockList.mockResolvedValue([
      spare({ jobName: 'yaac-p-new', workspaceId: 'new', createdAtMs: 9_000 }),
      spare({ createdAtMs: 1_000 }),
    ])
    vi.mocked(getWorkspaceRow).mockImplementation((_projectId, id) => Promise.resolve({
      permissionMode: 'bypass', mode: 'tui', ...(id === 'spare1' ? { model: 'claude-opus-5-5' } : {}),
    } as WorkspaceRow))

    const result = await tryClaimPrewarmed('p', 'req', setup('claude', { model: 'claude-opus-5-5' }), emit)
    expect(result?.workspaceId).toBe('spare1')
    expect(mockRetool).not.toHaveBeenCalled()
  })

  // An `acp` pod has acpd's mount and a `tui` pod does not; the pod spec is
  // fixed at warm time, so no respawn can convert between them.
  it('passes over a spare warmed in the other agent mode', async () => {
    mockList.mockResolvedValue([spare()])
    expect(await tryClaimPrewarmed('p', 'req', setup('claude', { mode: 'acp' }), emit)).toBeUndefined()
    // A row with no mode is passed over too.
    launched({ mode: undefined })
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    expect(mockClaimSpare).not.toHaveBeenCalled()
  })

  // `TZ` is fixed at launch, so a spare warmed before the user's zone was
  // known, or in another one, would hand out the wrong clock.
  it('passes over a spare warmed in a zone other than the user\'s current one', async () => {
    mockList.mockResolvedValue([spare()])
    vi.mocked(getTimeZone).mockResolvedValue({ timeZone: 'Asia/Tokyo', pinned: false })
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    launched({ timeZone: 'Europe/Paris' })
    expect(await tryClaimPrewarmed('p', 'req', setup('claude'), emit)).toBeUndefined()
    expect(mockClaimSpare).not.toHaveBeenCalled()

    launched({ timeZone: 'Asia/Tokyo' })
    expect((await tryClaimPrewarmed('p', 'req', setup('claude'), emit))?.workspaceId).toBe('spare1')
  })

  // A chat spare's conversation is booted while it is warmed, so a claim
  // hands over the one already named; a spare still mid-handshake is waited
  // for. The registry records the conversation, not the claim.
  it('hands a chat spare over on its warm conversation, waiting for one still booting', async () => {
    mockList.mockResolvedValue([spare()])
    launched({ mode: 'acp', model: 'claude-opus-5-5' })
    const want = setup('claude', { mode: 'acp', model: 'claude-opus-5-5' })
    let claimed = false
    const claim = tryClaimPrewarmed('p', 'req', want, emit).finally(() => { claimed = true })
    await new Promise((r) => setTimeout(r, 50))
    expect(claimed).toBe(false)

    registerAcpConversation('p', 'spare1', { handle: 'claude', agentSessionId: 'minted' }, { whenReady: () => Promise.resolve() } as unknown as AcpConversation)
    expect(await claim).toMatchObject({ workspaceId: 'spare1', mode: 'acp' })
    // Already named, so a second claim of it is handed over at once.
    expect(await tryClaimPrewarmed('p', 'req', want, emit)).toMatchObject({ workspaceId: 'spare1' })
    expect(mockRetool).not.toHaveBeenCalled()
    expect(appliedEvents.some((e) => e.type === 'sessions-launched')).toBe(false)
  })

  // A spare mid-refresh is seconds from current, which beats a cold create;
  // reserving it before the refresh ends would race its reset.
  it('waits out a spare\'s background refresh, then claims it', async () => {
    mockList.mockResolvedValue([spare()])
    let finish = (): void => {}
    // As `refreshSpares` does, the entry goes when the refresh ends.
    refreshing.set('yaac-p-spare', new Promise<void>((resolve) => { finish = resolve })
      .finally(() => { refreshing.delete('yaac-p-spare') }))
    let claimed = false
    const claim = tryClaimPrewarmed('p', 'req', setup('claude'), emit).finally(() => { claimed = true })
    await flush()
    expect(claimed).toBe(false)
    expect(claiming.size).toBe(0)

    finish()
    expect((await claim)?.workspaceId).toBe('spare1')
  })

  it('never reserves a spare whose refresh began during the wait', async () => {
    mockList.mockResolvedValue([spare()])
    let finish = (): void => {}
    const refresh = new Promise<void>((resolve) => { finish = resolve })
      .finally(() => { refreshing.delete('yaac-p-spare') })
    vi.mocked(getTimeZone).mockImplementation(() => {
      const p = Promise.resolve({ timeZone: null, pinned: false })
      // Lands after the claim's wait, before its reservation check.
      void p.then(() => queueMicrotask(() => { refreshing.set('yaac-p-spare', refresh) }))
      return p
    })
    let reservedDuringRefresh = false
    mockTmuxAlive.mockImplementation(() => {
      reservedDuringRefresh ||= refreshing.has('yaac-p-spare') && claiming.has('yaac-p-spare')
      return Promise.resolve(true)
    })
    const claim = tryClaimPrewarmed('p', 'req', setup('claude'), emit)
    await flush()
    finish()
    expect((await claim)?.workspaceId).toBe('spare1')
    expect(reservedDuringRefresh).toBe(false)
  })

  // A refresh can take minutes (a slow reset, init windows); a cold create
  // beats waiting that long.
  it('gives up on a refresh that outlasts the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      mockList.mockResolvedValue([spare()])
      refreshing.set('yaac-p-spare', new Promise<void>(() => { /* never ends */ }))
      const claim = tryClaimPrewarmed('p', 'req', setup('claude'), emit)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await claim).toBeUndefined()
      expect(mockClaimSpare).not.toHaveBeenCalled()
      expect(claiming.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // A respawn replaces the warm conversation, which stays registered until
  // its stream is seen closing; handing it over would send the prompt to a
  // dead agent.
  it('hands a respawned chat spare over on its new conversation, not the warm one', async () => {
    mockList.mockResolvedValue([spare()])
    launched({ mode: 'acp' })
    const warmPrompt = vi.fn(() => Promise.resolve())
    const freshPrompt = vi.fn(() => Promise.resolve())
    const conversation = (prompt: () => Promise<void>): AcpConversation =>
      ({ whenReady: () => Promise.resolve(), prompt }) as unknown as AcpConversation
    registerAcpConversation('p', 'spare1', { handle: 'claude', agentSessionId: 'warm', panePid: '10' }, conversation(warmPrompt))
    const fresh = conversation(freshPrompt)
    // The window's process after the respawn.
    mockExec.mockImplementation((_job, cmd) => Promise.resolve({
      stdout: cmd.includes('#{pane_pid}') ? '11\n' : '', stderr: '',
    }))
    mockRetool.mockImplementation(() => {
      setTimeout(() => {
        // The old conversation's close is seen only after the hand-over
        // begins waiting.
        registerAcpConversation('p', 'spare1', { handle: 'claude', agentSessionId: 'fresh', panePid: '11' }, fresh)
      }, 20)
      return Promise.resolve()
    })

    const want = setup('claude', { mode: 'acp', permissionMode: 'plan' })
    expect(await tryClaimPrewarmed('p', 'req', want, emit, { prompt: 'go' })).toMatchObject({ workspaceId: 'spare1' })
    expect(mockRetool).toHaveBeenCalledTimes(1)
    expect(freshPrompt).toHaveBeenCalledWith('go')
    expect(warmPrompt).not.toHaveBeenCalled()
  })

  // As in a cold create: group and title before the workspace shows, then
  // the initial prompt.
  it('files and titles the claimed workspace and gives its agent the prompt', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit, {
      prompt: 'fix the bug', title: 'Bug fix', groupId: 'g1',
    })
    expect(result?.workspaceId).toBe('spare1')
    expect(vi.mocked(setWorkspaceGroup)).toHaveBeenCalledWith('p', 'spare1', 'g1')
    expect(vi.mocked(setWorkspaceTitle)).toHaveBeenCalledWith('p', 'spare1', 'Bug fix')
    // The paste script and prompt are base64-encoded, so decode to read.
    const pasted = mockExec.mock.calls.flatMap(([jobName, cmd]) => {
      const b64 = /printf %s (\S+) \| base64 -d/.exec(cmd)?.[1]
      return b64 !== undefined ? [{ jobName, script: Buffer.from(b64, 'base64').toString() }] : []
    })
    expect(pasted).toHaveLength(1)
    expect(pasted[0].jobName).toBe('yaac-p-spare')
    expect(pasted[0].script).toContain(Buffer.from('fix the bug').toString('base64'))
    // Recorded as the workspace's first prompt, as a cold create does.
    expect(appliedEvents).toContainEqual(expect.objectContaining({
      type: 'sessions-launched',
      sessions: [{ tool: 'claude', agentSessionId: 'spare1', firstPrompt: 'fix the bug' }],
    }))
  })

  // A group deleted after the route resolved it would fail a cold create
  // too, so the spare is not burned over it.
  it('hands a claimed workspace over ungrouped when filing it fails', async () => {
    mockList.mockResolvedValue([spare()])
    vi.mocked(setWorkspaceGroup).mockRejectedValue(new ServerError('NOT_FOUND', 'No such workspace group'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit, { groupId: 'gone' })
    expect(result?.workspaceId).toBe('spare1')
    await flush()
    expect(mockCleanup).not.toHaveBeenCalled()
    expect(appliedEvents.some((e) => e.type === 'workspace-create-failed')).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No such workspace group'))
    warn.mockRestore()
  })

  it('treats a spare whose row records no branch as warmed from the default branch', async () => {
    mockList.mockResolvedValue([spare()])
    launched({ baseBranch: undefined })
    mockDefaultBranch.mockResolvedValue('trunk')
    const result = await tryClaimPrewarmed('p', 'req', setup('claude'), emit)
    expect(result?.workspaceId).toBe('spare1')
    expect(mockRebranch).not.toHaveBeenCalled()
    // The spare is checked against that branch's tip.
    expect(vi.mocked(resolveRemoteRef)).toHaveBeenCalledWith(expect.any(String), 'trunk')
  })
})

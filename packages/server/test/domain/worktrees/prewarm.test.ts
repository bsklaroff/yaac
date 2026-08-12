import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as dbModule from '#db'

vi.mock('#db', async (importOriginal) => ({
  ...(await importOriginal<typeof dbModule>()),
  applyWorktreeEvent: vi.fn(),
  claimSpareWorktree: vi.fn(),
  restoreSpareWorktree: vi.fn(),
}))

vi.mock('#runtime/agents/agent-command', () => ({
  shellEscape: (s: string) => s.replace(/'/g, "'\\''"),
}))
vi.mock('#domain/worktrees/spare-pool', () => ({
  retoolSpare: vi.fn(),
  rebranchSpare: vi.fn(),
}))
vi.mock('#domain/worktrees/cleanup', () => ({
  cleanupWorktree: vi.fn(),
  deleteWorktreeState: vi.fn(),
}))
vi.mock('#runtime/status/liveness', () => ({
  isTmuxSessionAlive: vi.fn(),
}))
vi.mock('#domain/git', () => ({
  fetchOrigin: vi.fn(),
  getDefaultBranch: vi.fn(),
  // The value simple-git's mock used to answer for this, now that the
  // `get-url origin` read has a verb of its own.
  originRemoteUrl: vi.fn().mockResolvedValue('https://example.com/p.git'),
  remoteBranchExists: vi.fn(),
  worktreeUpstreamBranch: vi.fn(),
}))
vi.mock('#domain/projects/config', () => ({ resolveProjectConfig: vi.fn() }))
vi.mock('#domain/projects/credentials', () => ({ resolveCredentialForUrl: vi.fn() }))
vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    remote: vi.fn().mockResolvedValue('https://example.com/p.git\n'),
    revparse: vi.fn().mockResolvedValue('cafebabe1234\n'),
  })),
}))

import {
  tryClaimPrewarmed,
  // Shared claim state, read to assert what a claim reserved and released.
  claiming,
  inFlight,
  clearPrewarmStateForTests,
} from '#domain/worktrees/prewarm'
import { cleanupWorktree, deleteWorktreeState } from '#domain/worktrees/cleanup'
import { isTmuxSessionAlive } from '#runtime/status/liveness'
import { rebranchSpare, retoolSpare } from '#domain/worktrees/spare-pool'
import { fetchOrigin, getDefaultBranch, remoteBranchExists, worktreeUpstreamBranch } from '#domain/git'
import { resolveProjectConfig } from '#domain/projects/config'
import { ServerError } from '@yaac/shared/errors'
import type { WorktreeEvent } from '#db'
import { applyWorktreeEvent, claimSpareWorktree, restoreSpareWorktree } from '#db'
import { handleFixture, installFakeWorktreeRuntime } from '@yaac/test-utils/fake-runtime'
import type { RuntimeHandle } from '#runtime/contract'
import type { AgentTool } from '@yaac/shared/types'

// The runtime verbs the claim drives, as mocks — the fake runtime installed
// below is nothing but a shell over these, so a test configures and asserts
// them exactly as it would any other boundary.
const mockList = vi.fn<(projectSlug?: string) => Promise<RuntimeHandle[]>>()
const mockClaimSpare = vi.fn<(workspaceId: string, tool: AgentTool) => Promise<void>>()
const mockExec = vi.fn<(jobName: string, cmd: string) => Promise<{ stdout: string; stderr: string }>>()
const mockAwaitTransport = vi.fn<(jobName: string, opts?: { timeoutMs?: number }) => Promise<void>>()

const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockRetool = vi.mocked(retoolSpare)
const mockRebranch = vi.mocked(rebranchSpare)
const mockCleanup = vi.mocked(cleanupWorktree)
const mockDeleteState = vi.mocked(deleteWorktreeState)
const mockFetchOrigin = vi.mocked(fetchOrigin)
const mockDefaultBranch = vi.mocked(getDefaultBranch)
const mockRemoteBranchExists = vi.mocked(remoteBranchExists)
const mockWorktreeUpstream = vi.mocked(worktreeUpstreamBranch)
const mockResolveConfig = vi.mocked(resolveProjectConfig)

/** Let the teardown chain a burned claim starts — deliberately unawaited, so
 *  the caller falls straight through to a cold create — run to completion. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const GIT_USER = { name: 'A B', email: 'a@b.co' }
const emit = vi.fn()

function spare(o: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return handleFixture({
    jobName: 'yaac-p-spare',
    workspaceId: 'spare1',
    projectSlug: 'p',
    tool: 'claude',
    declaredTool: 'claude',
    createdAtMs: 1_000,
    prewarmed: true,
    ...o,
  })
}

const appliedEvents: WorktreeEvent[] = []

describe('tryClaimPrewarmed', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearPrewarmStateForTests()
    // The claim reports what it recorded rather than writing rows, so a stub
    // link stands in for the server: no DB is opened, and what a claim tells
    // it is asserted directly.
    appliedEvents.length = 0
    vi.mocked(applyWorktreeEvent).mockImplementation((event) => {
      appliedEvents.push(event)
      return Promise.resolve()
    })
    mockTmuxAlive.mockResolvedValue(true)
    mockList.mockResolvedValue([])
    mockClaimSpare.mockResolvedValue(undefined)
    mockExec.mockResolvedValue({ stdout: '', stderr: '' })
    mockAwaitTransport.mockResolvedValue(undefined)
    installFakeWorktreeRuntime({
      list: mockList,
      claimSpare: mockClaimSpare,
      exec: mockExec,
      awaitAgentTransport: mockAwaitTransport,
    })
    mockRetool.mockResolvedValue(undefined)
    mockRebranch.mockResolvedValue(undefined)
    mockCleanup.mockResolvedValue(true)
    mockDeleteState.mockResolvedValue(true)
    // Branch defaults: spare warmed from main, config sets no default —
    // so no re-branch prep unless a test asks for one.
    mockResolveConfig.mockResolvedValue({})
    mockWorktreeUpstream.mockResolvedValue('main')
    mockDefaultBranch.mockResolvedValue('main')
    mockRemoteBranchExists.mockResolvedValue(true)
    mockFetchOrigin.mockResolvedValue(undefined)
  })

  it('claims a ready spare, re-applies identity, and returns its id', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result).toEqual({ worktreeId: 'spare1', jobName: 'yaac-p-spare', tool: 'claude', mode: 'tui', forwardedPorts: [] })
    expect(mockClaimSpare).toHaveBeenCalledWith('spare1', 'claude')
    // One exec carries both identity settings.
    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(mockExec.mock.calls[0][1]).toBe(
      "git config --global user.name 'A B' && git config --global user.email 'a@b.co'",
    )
    expect(claiming.size).toBe(0) // released in finally
  })

  it('reports the worktree and its first conversation, warmed-from branch and all', async () => {
    mockList.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)

    // The spare's own id is the worktree's first conversation — that is
    // where its tool is read from — and no re-branch means no second
    // branch report.
    expect(appliedEvents).toEqual([
      {
        type: 'worktree-created', projectSlug: 'p', worktreeId: 'spare1', baseBranch: 'main',
      },
      {
        type: 'sessions-launched',
        projectSlug: 'p',
        worktreeId: 'spare1',
        sessions: [{ tool: 'claude', agentSessionId: 'spare1' }],
      },
    ])
  })

  it('reports the branch a re-branched claim ended on, not the one it was warmed from', async () => {
    mockList.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')

    expect(appliedEvents.filter((e) => e.type === 'base-branch-resolved')).toEqual([
      {
        type: 'base-branch-resolved', projectSlug: 'p', worktreeId: 'spare1', baseBranch: 'dev',
      },
    ])
  })

  // A claim that gave up after reporting describes a session that never
  // existed; the caller is about to cold-create a different one. The checkout
  // has to go with it: the claim cleared the `spare` flag before it mutated
  // anything, so the sweep that collects a dead spare's checkout on the
  // strength of that flag can no longer see this one, and erasing the row
  // takes the last name anything had for it.
  it('collects the burned spare whole — runtime, then checkout, then row', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockRetool.mockRejectedValue(new Error('retool blew up'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    await flush()

    expect(mockDeleteState).toHaveBeenCalledWith('p', 'spare1')
    expect(appliedEvents.at(-1)).toEqual({
      type: 'worktree-create-failed', projectSlug: 'p', worktreeId: 'spare1',
    })
    // Order is the whole safety argument. The AWAITED teardown runs first, so
    // the checkout is never removed under a workspace still mounting it;
    // the row goes last, so a teardown that dies partway leaves something the
    // stale reaper can still see rather than a checkout nothing can name.
    expect(mockCleanup.mock.invocationCallOrder[0])
      .toBeLessThan(mockDeleteState.mock.invocationCallOrder[0])
    expect(mockDeleteState.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(applyWorktreeEvent).mock.invocationCallOrder.at(-1)!)
  })

  // Each step of that chain destroys the evidence the one before it relied
  // on, so each gates the next on having actually happened.
  it('keeps the checkout, and its row, when the teardown cannot confirm the runtime is gone', async () => {
    // A teardown the runtime could not confirm leaves something still
    // shutting down, and still writing to /workspace.
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockRetool.mockRejectedValue(new Error('retool blew up'))
    mockCleanup.mockResolvedValue(false)

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    await flush()
    expect(mockDeleteState).not.toHaveBeenCalled()
    expect(appliedEvents.some((e) => e.type === 'worktree-create-failed')).toBe(false)
  })

  it('keeps the row when the checkout could not be removed', async () => {
    // The row is the last name those bytes have — erasing it over a failed rm
    // is exactly how a retryable leftover becomes a permanent one. What
    // survives reaches the user as an ordinary stopped worktree.
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockRetool.mockRejectedValue(new Error('retool blew up'))
    mockDeleteState.mockResolvedValue(false)

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    await flush()
    expect(mockDeleteState).toHaveBeenCalledWith('p', 'spare1')
    expect(appliedEvents.some((e) => e.type === 'worktree-create-failed')).toBe(false)
  })

  it('returns undefined when there is no spare', async () => {
    mockList.mockResolvedValue([])
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockClaimSpare).not.toHaveBeenCalled()
  })

  it('retools a spare booted with a different tool, then commits for the claimed tool', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)

    expect(result).toEqual({ worktreeId: 'spare1', jobName: 'yaac-p-spare', tool: 'claude', mode: 'tui', forwardedPorts: [] })
    expect(mockRetool).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare' }), 'claude', undefined)
    expect(mockClaimSpare).toHaveBeenCalledWith('spare1', 'claude')
    expect(emit).toHaveBeenCalledWith('Switching prewarmed session to claude...')
    expect(claiming.size).toBe(0)
  })

  it('does not retool when the spare already matches', async () => {
    mockList.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(mockRetool).not.toHaveBeenCalled()
  })

  it('prefers a matching-tool spare over a newer mismatched one', async () => {
    mockList.mockResolvedValue([
      spare({ jobName: 'yaac-p-codex', workspaceId: 'sc', tool: 'codex', declaredTool: 'codex', createdAtMs: 9_000 }),
      spare({ createdAtMs: 1_000 }),
    ])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRetool).not.toHaveBeenCalled()
  })

  it('reaps the tainted spare and falls back to cold create when the retool fails', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockRetool.mockRejectedValue(new Error('respawn failed'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockCleanup).toHaveBeenCalledWith({
      jobName: 'yaac-p-spare', projectSlug: 'p', worktreeId: 'spare1',
    })
    // The reservation is kept so a concurrent claim can't grab the dying spare.
    expect(claiming.has('yaac-p-spare')).toBe(true)
  })

  it('reaps the spare when the commit fails after a retool', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockClaimSpare.mockRejectedValue(new Error('pod gone'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockCleanup).toHaveBeenCalledTimes(1)
  })

  it('releases and skips a spare whose tmux is dead', async () => {
    mockList.mockResolvedValue([spare()])
    mockTmuxAlive.mockResolvedValue(false)
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockClaimSpare).not.toHaveBeenCalled()
    expect(claiming.size).toBe(0)
  })

  it('gates on the agent transport before the first mutation, and leaves the spare alone if it never answers', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    mockAwaitTransport.mockRejectedValue(new Error('agent transport not reachable after 10000ms'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockAwaitTransport).toHaveBeenCalledWith('yaac-p-spare', { timeoutMs: 10_000 })
    // Nothing ran inside the spare, so it is untainted: no retool, no
    // commit, and no reap — the claim just degrades to a cold create, and
    // the spare keeps the checkout it is still going to serve from.
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
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(claiming.size).toBe(0)
  })

  it('keeps the claimed session when the identity re-apply fails', async () => {
    // It runs past the commit point over a step the no-identity path skips
    // outright, so a transport hiccup must not reap a whole good session.
    mockList.mockResolvedValue([spare()])
    mockExec.mockRejectedValue(new Error('transport dial: timeout'))

    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockCleanup).not.toHaveBeenCalled()
  })

  it('skips the git-config execs when no identity is supplied', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', undefined, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('lets only one of two concurrent claims win the single spare', async () => {
    mockList.mockResolvedValue([spare()])
    const [a, b] = await Promise.all([
      tryClaimPrewarmed('p', 'claude', GIT_USER, emit),
      tryClaimPrewarmed('p', 'claude', GIT_USER, emit),
    ])
    const claimed = [a, b].filter(Boolean)
    expect(claimed).toHaveLength(1)
    expect(mockClaimSpare).toHaveBeenCalledTimes(1)
    expect(claiming.size).toBe(0)
  })

  it('returns undefined (cold create) if the workspace listing throws', async () => {
    mockList.mockRejectedValue(new Error('cluster down'))
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(inFlight.size).toBe(0)
  })

  it('re-branches a spare when the requested branch differs, then commits the claim', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')

    expect(result?.worktreeId).toBe('spare1')
    expect(mockFetchOrigin).toHaveBeenCalledTimes(1)
    expect(mockRebranch).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }),
      'dev',
      'cafebabe1234',
      true, // same tool — the re-branch owns the agent respawn
    )
    expect(mockClaimSpare).toHaveBeenCalledWith('spare1', 'claude')
    expect(emit).toHaveBeenCalledWith('Switching prewarmed session to branch dev...')
    expect(claiming.size).toBe(0)
  })

  it('skips re-branch prep entirely when the spare already matches the request', async () => {
    mockList.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'main')
    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockFetchOrigin).not.toHaveBeenCalled()
  })

  it('re-branches a stale spare on a bare create after the config default changed', async () => {
    // Spare warmed from main; the project default is now develop.
    mockList.mockResolvedValue([spare()])
    mockResolveConfig.mockResolvedValue({ referenceBranch: 'develop' })
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'develop', 'cafebabe1234', true)
  })

  it('hands the agent respawn to the retool when tool and branch both differ', async () => {
    mockList.mockResolvedValue([spare({ tool: 'codex', declaredTool: 'codex' })])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')
    expect(result?.tool).toBe('claude')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'dev', 'cafebabe1234', false)
    expect(mockRetool).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare' }), 'claude', undefined)
  })

  it('a model override retools a spare whose tool already matches (agent must respawn with --model)', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, undefined, 'claude-opus-4-8')
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRetool).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }), 'claude', 'claude-opus-4-8',
    )
    // Same tool: no retool announcement, and the commit still names the
    // tool the workspace was claimed for.
    expect(emit).not.toHaveBeenCalledWith('Switching prewarmed session to claude...')
    expect(mockClaimSpare).toHaveBeenCalledWith('spare1', 'claude')
  })

  it('a model override on a re-branched claim skips the rebranch respawn (retool respawns with --model)', async () => {
    mockList.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev', 'claude-opus-4-8')
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'dev', 'cafebabe1234', false)
    expect(mockRetool).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }), 'claude', 'claude-opus-4-8',
    )
  })

  it('propagates VALIDATION for an unknown branch and releases the spare untouched', async () => {
    mockList.mockResolvedValue([spare()])
    mockRemoteBranchExists.mockResolvedValue(false)

    await expect(tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'nope'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled() // pre-mutation: not tainted
    expect(claiming.size).toBe(0) // released for the next claim
    // The row is claimed before the branch is validated, so propagating has
    // to undo it first. Left flagged claimed, the spare would still be
    // pooled and claimable while its row says it is somebody's
    // worktree: `deleteSpareWorktreeRow` no-ops on the flag guard when the
    // pool reaps it, the checkout goes, and the stale reaper later stamps a
    // phantom `never-started` stop whose restart resolves into nothing.
    expect(vi.mocked(claimSpareWorktree)).toHaveBeenCalledWith('p', 'spare1', 'main')
    expect(vi.mocked(restoreSpareWorktree)).toHaveBeenCalledWith('p', 'spare1')
  })

  it('reaps the tainted spare and falls back to cold create when the re-branch fails', async () => {
    mockList.mockResolvedValue([spare()])
    mockRebranch.mockRejectedValue(new Error('reset failed'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')).toBeUndefined()
    expect(mockCleanup).toHaveBeenCalledWith({
      jobName: 'yaac-p-spare', projectSlug: 'p', worktreeId: 'spare1',
    })
    expect(claiming.has('yaac-p-spare')).toBe(true)
  })

  it('does not swallow a mid-mutation VALIDATION-shaped failure into a throw', async () => {
    // Post-mutation errors — whatever their shape — must degrade to a cold
    // create with the tainted spare reaped, not propagate.
    mockList.mockResolvedValue([spare()])
    mockRebranch.mockRejectedValue(new ServerError('VALIDATION', 'weird in-pod failure'))
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')).toBeUndefined()
    expect(mockCleanup).toHaveBeenCalledTimes(1)
  })

  it('lets an explicit branch request win over the project default', async () => {
    // Spare warmed from the project default; the caller asked for another
    // branch, so the request — not the config — is the re-branch target.
    mockList.mockResolvedValue([spare()])
    mockResolveConfig.mockResolvedValue({ referenceBranch: 'develop' })
    mockWorktreeUpstream.mockResolvedValue('develop')
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'dev', 'cafebabe1234', true)
  })

  it('re-branches back to the default branch when the config default is cleared', async () => {
    // Spare warmed from develop; the project no longer pins a reference
    // branch, so a bare create wants the repo default again.
    mockList.mockResolvedValue([spare()])
    mockWorktreeUpstream.mockResolvedValue('develop')
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'main', 'cafebabe1234', true)
  })

  it('treats a spare with no recorded upstream as warmed from the default branch', async () => {
    mockList.mockResolvedValue([spare()])
    mockWorktreeUpstream.mockResolvedValue(null)
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockFetchOrigin).not.toHaveBeenCalled()
  })
})

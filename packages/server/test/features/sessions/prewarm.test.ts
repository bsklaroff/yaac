import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#features/agents/agent-command', () => ({
  shellEscape: (s: string) => s.replace(/'/g, "'\\''"),
}))
vi.mock('#features/sessions/spare-pool', () => ({
  retoolSpare: vi.fn(),
  rebranchSpare: vi.fn(),
}))
vi.mock('#features/sessions/cleanup', () => ({
  cleanupSessionDetached: vi.fn(),
}))
vi.mock('#features/status/liveness', () => ({
  isTmuxSessionAlive: vi.fn(),
}))
// execFileAsync/kubectlApply are read at module-eval time by the cluster
// registry service, which `#features/projects` now reaches transitively.
vi.mock('#platform/k8s/kubectl', () => ({
  isKubectlAbsentError: vi.fn(() => false),
  kubectlErrorSummary: vi.fn((e: unknown) => String(e)),
  kubectlWithRetry: vi.fn(),
  k8sNamespace: () => 'ns',
  execFileAsync: vi.fn(),
  kubectlApply: vi.fn(),
}))
vi.mock('#platform/k8s/stream-relay', () => ({
  sessionExec: vi.fn(),
  waitForStreamd: vi.fn(),
}))
vi.mock('#platform/k8s/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listSessionPods: vi.fn(),
}))
vi.mock('#platform/git', () => ({
  fetchOrigin: vi.fn(),
  getDefaultBranch: vi.fn(),
  remoteBranchExists: vi.fn(),
  worktreeUpstreamBranch: vi.fn(),
}))
vi.mock('#features/projects/config', () => ({ resolveProjectConfig: vi.fn() }))
vi.mock('#features/projects/credentials', () => ({ resolveCredentialForUrl: vi.fn() }))
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
} from '#features/sessions/prewarm'
import { LABEL_PREWARMED, LABEL_TOOL, listSessionPods, type SessionPod } from '#platform/k8s/pods'
import type * as podsModule from '#platform/k8s/pods'
import { cleanupSessionDetached } from '#features/sessions/cleanup'
import { isTmuxSessionAlive } from '#features/status/liveness'
import { kubectlWithRetry } from '#platform/k8s/kubectl'
import { sessionExec, waitForStreamd } from '#platform/k8s/stream-relay'
import { rebranchSpare, retoolSpare } from '#features/sessions/spare-pool'
import { fetchOrigin, getDefaultBranch, remoteBranchExists, worktreeUpstreamBranch } from '#platform/git'
import { resolveProjectConfig } from '#features/projects/config'
import { ServerError } from '@yaac/shared/errors'
import { _setServerLinkForTests } from '#server-link'
import type { HerdEvent } from '@yaac/shared/herd'

const mockListPods = vi.mocked(listSessionPods)
const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockKubectl = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(sessionExec)
const mockWaitForStreamd = vi.mocked(waitForStreamd)
const mockRetool = vi.mocked(retoolSpare)
const mockRebranch = vi.mocked(rebranchSpare)
const mockCleanupDetached = vi.mocked(cleanupSessionDetached)
const mockFetchOrigin = vi.mocked(fetchOrigin)
const mockDefaultBranch = vi.mocked(getDefaultBranch)
const mockRemoteBranchExists = vi.mocked(remoteBranchExists)
const mockWorktreeUpstream = vi.mocked(worktreeUpstreamBranch)
const mockResolveConfig = vi.mocked(resolveProjectConfig)

const GIT_USER = { name: 'A B', email: 'a@b.co' }
const emit = vi.fn()

function spare(o: Partial<SessionPod> = {}): SessionPod {
  return {
    jobName: 'yaac-p-spare',
    podName: 'yaac-p-spare-x',
    sessionId: 'spare1',
    projectSlug: 'p',
    tool: 'claude',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 1_000,
    labels: { [LABEL_PREWARMED]: 'true' },
    ...o,
  }
}

const herdEvents: HerdEvent[] = []

describe('tryClaimPrewarmed', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearPrewarmStateForTests()
    // The claim reports what it recorded rather than writing rows, so a stub
    // link stands in for the server: no DB is opened, and what a claim tells
    // it is asserted directly.
    herdEvents.length = 0
    _setServerLinkForTests({
      workspaceEvent: (event) => {
        herdEvents.push(event)
        return Promise.resolve()
      },
    })
    mockTmuxAlive.mockResolvedValue(true)
    mockKubectl.mockResolvedValue(undefined as never)
    mockExec.mockResolvedValue(undefined as never)
    mockWaitForStreamd.mockResolvedValue(undefined)
    mockRetool.mockResolvedValue(undefined)
    mockRebranch.mockResolvedValue(undefined)
    mockCleanupDetached.mockResolvedValue(undefined)
    // Branch defaults: spare warmed from main, config sets no default —
    // so no re-branch prep unless a test asks for one.
    mockResolveConfig.mockResolvedValue({})
    mockWorktreeUpstream.mockResolvedValue('main')
    mockDefaultBranch.mockResolvedValue('main')
    mockRemoteBranchExists.mockResolvedValue(true)
    mockFetchOrigin.mockResolvedValue(undefined)
  })

  it('claims a ready spare: removes the label, re-applies identity, returns its id', async () => {
    mockListPods.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result).toEqual({ worktreeId: 'spare1', jobName: 'yaac-p-spare', tool: 'claude', mode: 'tui', forwardedPorts: [] })
    expect(mockKubectl).toHaveBeenCalledWith(
      ['label', 'pod', 'yaac-p-spare-x', '-n', 'ns', `${LABEL_PREWARMED}-`],
    )
    // One exec carries both identity settings.
    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(mockExec.mock.calls[0][1]).toBe(
      "git config --global user.name 'A B' && git config --global user.email 'a@b.co'",
    )
    expect(claiming.size).toBe(0) // released in finally
  })

  it('reports the worktree and its first conversation, warmed-from branch and all', async () => {
    mockListPods.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)

    // The spare's own id is the worktree's first conversation — that is
    // where its tool is read from — and no re-branch means no second
    // branch report.
    expect(herdEvents).toEqual([
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
    mockListPods.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')

    expect(herdEvents.filter((e) => e.type === 'base-branch-resolved')).toEqual([
      {
        type: 'base-branch-resolved', projectSlug: 'p', worktreeId: 'spare1', baseBranch: 'dev',
      },
    ])
  })

  // A claim that gave up after reporting describes a session that never
  // existed; the caller is about to cold-create a different one.
  it('reports the create failed when a claim gives up after reporting the worktree', async () => {
    mockListPods.mockResolvedValue([spare({ tool: 'codex' })])
    mockRetool.mockRejectedValue(new Error('retool blew up'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(herdEvents.at(-1)).toEqual({
      type: 'worktree-create-failed', projectSlug: 'p', worktreeId: 'spare1',
    })
  })

  it('returns undefined when there is no spare', async () => {
    mockListPods.mockResolvedValue([])
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockKubectl).not.toHaveBeenCalled()
  })

  it('retools a spare booted with a different tool, stamping the new tool label on commit', async () => {
    mockListPods.mockResolvedValue([spare({ tool: 'codex' })])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)

    expect(result).toEqual({ worktreeId: 'spare1', jobName: 'yaac-p-spare', tool: 'claude', mode: 'tui', forwardedPorts: [] })
    expect(mockRetool).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare' }), 'claude', undefined)
    expect(mockKubectl).toHaveBeenCalledWith([
      'label', 'pod', 'yaac-p-spare-x', '-n', 'ns',
      `${LABEL_PREWARMED}-`, `${LABEL_TOOL}=claude`, '--overwrite',
    ])
    expect(emit).toHaveBeenCalledWith('Switching prewarmed session to claude...')
    expect(claiming.size).toBe(0)
  })

  it('does not retool (or overwrite the tool label) when the spare already matches', async () => {
    mockListPods.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(mockRetool).not.toHaveBeenCalled()
  })

  it('prefers a matching-tool spare over a newer mismatched one', async () => {
    mockListPods.mockResolvedValue([
      spare({ jobName: 'yaac-p-codex', podName: 'yaac-p-codex-x', sessionId: 'sc', tool: 'codex', createdAtMs: 9_000 }),
      spare({ createdAtMs: 1_000 }),
    ])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRetool).not.toHaveBeenCalled()
  })

  it('reaps the tainted spare and falls back to cold create when the retool fails', async () => {
    mockListPods.mockResolvedValue([spare({ tool: 'codex' })])
    mockRetool.mockRejectedValue(new Error('respawn failed'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      jobName: 'yaac-p-spare', projectSlug: 'p', sessionId: 'spare1',
    })
    // The reservation is kept so a concurrent claim can't grab the dying pod.
    expect(claiming.has('yaac-p-spare')).toBe(true)
  })

  it('reaps the spare when the commit relabel fails after a retool', async () => {
    mockListPods.mockResolvedValue([spare({ tool: 'codex' })])
    mockKubectl.mockRejectedValue(new Error('pod gone'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockCleanupDetached).toHaveBeenCalledTimes(1)
  })

  it('releases and skips a spare whose tmux is dead', async () => {
    mockListPods.mockResolvedValue([spare()])
    mockTmuxAlive.mockResolvedValue(false)
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockKubectl).not.toHaveBeenCalled()
    expect(claiming.size).toBe(0)
  })

  it('gates on streamd before the first mutation, and leaves the spare alone if it never answers', async () => {
    mockListPods.mockResolvedValue([spare({ tool: 'codex' })])
    mockWaitForStreamd.mockRejectedValue(new Error('streamd not reachable after 10000ms'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockWaitForStreamd).toHaveBeenCalledWith('yaac-p-spare', { timeoutMs: 10_000 })
    // Nothing ran against the pod, so the spare is untainted: no retool, no
    // relabel, and no reap — the claim just degrades to a cold create.
    expect(mockRetool).not.toHaveBeenCalled()
    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockKubectl).not.toHaveBeenCalled()
    expect(mockCleanupDetached).not.toHaveBeenCalled()
    expect(claiming.size).toBe(0)
  })

  it('falls through (undefined) and clears the reservation if the relabel fails', async () => {
    mockListPods.mockResolvedValue([spare()])
    mockKubectl.mockRejectedValue(new Error('pod gone'))
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(claiming.size).toBe(0)
  })

  it('keeps the claimed session when the identity re-apply fails', async () => {
    // It runs past the commit point over a step the no-identity path skips
    // outright, so a relay hiccup must not reap a whole good session.
    mockListPods.mockResolvedValue([spare()])
    mockExec.mockRejectedValue(new Error('stream relay dial: timeout'))

    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('skips the git-config execs when no identity is supplied', async () => {
    mockListPods.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', undefined, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('lets only one of two concurrent claims win the single spare', async () => {
    mockListPods.mockResolvedValue([spare()])
    const [a, b] = await Promise.all([
      tryClaimPrewarmed('p', 'claude', GIT_USER, emit),
      tryClaimPrewarmed('p', 'claude', GIT_USER, emit),
    ])
    const claimed = [a, b].filter(Boolean)
    expect(claimed).toHaveLength(1)
    expect(mockKubectl).toHaveBeenCalledTimes(1)
    expect(claiming.size).toBe(0)
  })

  it('returns undefined (cold create) if listing pods throws', async () => {
    mockListPods.mockRejectedValue(new Error('cluster down'))
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(inFlight.size).toBe(0)
  })

  it('re-branches a spare when the requested branch differs, then commits the claim', async () => {
    mockListPods.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')

    expect(result?.worktreeId).toBe('spare1')
    expect(mockFetchOrigin).toHaveBeenCalledTimes(1)
    expect(mockRebranch).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }),
      'dev',
      'cafebabe1234',
      true, // same tool — the re-branch owns the agent respawn
    )
    expect(mockKubectl).toHaveBeenCalledWith(
      ['label', 'pod', 'yaac-p-spare-x', '-n', 'ns', `${LABEL_PREWARMED}-`],
    )
    expect(emit).toHaveBeenCalledWith('Switching prewarmed session to branch dev...')
    expect(claiming.size).toBe(0)
  })

  it('skips re-branch prep entirely when the spare already matches the request', async () => {
    mockListPods.mockResolvedValue([spare()])
    await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'main')
    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockFetchOrigin).not.toHaveBeenCalled()
  })

  it('re-branches a stale spare on a bare create after the config default changed', async () => {
    // Spare warmed from main; the project default is now develop.
    mockListPods.mockResolvedValue([spare()])
    mockResolveConfig.mockResolvedValue({ referenceBranch: 'develop' })
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'develop', 'cafebabe1234', true)
  })

  it('hands the agent respawn to the retool when tool and branch both differ', async () => {
    mockListPods.mockResolvedValue([spare({ tool: 'codex' })])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')
    expect(result?.tool).toBe('claude')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'dev', 'cafebabe1234', false)
    expect(mockRetool).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare' }), 'claude', undefined)
  })

  it('a model override retools a spare whose tool already matches (agent must respawn with --model)', async () => {
    mockListPods.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, undefined, 'claude-opus-4-8')
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRetool).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }), 'claude', 'claude-opus-4-8',
    )
    // Same tool: no retool announcement, and the commit keeps the plain
    // label-removal shape (no tool-label overwrite).
    expect(emit).not.toHaveBeenCalledWith('Switching prewarmed session to claude...')
    expect(mockKubectl).toHaveBeenCalledWith(
      ['label', 'pod', 'yaac-p-spare-x', '-n', 'ns', `${LABEL_PREWARMED}-`],
    )
  })

  it('a model override on a re-branched claim skips the rebranch respawn (retool respawns with --model)', async () => {
    mockListPods.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev', 'claude-opus-4-8')
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'dev', 'cafebabe1234', false)
    expect(mockRetool).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'yaac-p-spare' }), 'claude', 'claude-opus-4-8',
    )
  })

  it('propagates VALIDATION for an unknown branch and releases the spare untouched', async () => {
    mockListPods.mockResolvedValue([spare()])
    mockRemoteBranchExists.mockResolvedValue(false)

    await expect(tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'nope'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockCleanupDetached).not.toHaveBeenCalled() // pre-mutation: not tainted
    expect(claiming.size).toBe(0) // released for the next claim
  })

  it('reaps the tainted spare and falls back to cold create when the re-branch fails', async () => {
    mockListPods.mockResolvedValue([spare()])
    mockRebranch.mockRejectedValue(new Error('reset failed'))

    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')).toBeUndefined()
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      jobName: 'yaac-p-spare', projectSlug: 'p', sessionId: 'spare1',
    })
    expect(claiming.has('yaac-p-spare')).toBe(true)
  })

  it('does not swallow a mid-mutation VALIDATION-shaped failure into a throw', async () => {
    // Post-mutation errors — whatever their shape — must degrade to a cold
    // create with the tainted spare reaped, not propagate.
    mockListPods.mockResolvedValue([spare()])
    mockRebranch.mockRejectedValue(new ServerError('VALIDATION', 'weird in-pod failure'))
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')).toBeUndefined()
    expect(mockCleanupDetached).toHaveBeenCalledTimes(1)
  })

  it('lets an explicit branch request win over the project default', async () => {
    // Spare warmed from the project default; the caller asked for another
    // branch, so the request — not the config — is the re-branch target.
    mockListPods.mockResolvedValue([spare()])
    mockResolveConfig.mockResolvedValue({ referenceBranch: 'develop' })
    mockWorktreeUpstream.mockResolvedValue('develop')
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit, 'dev')
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'dev', 'cafebabe1234', true)
  })

  it('re-branches back to the default branch when the config default is cleared', async () => {
    // Spare warmed from develop; the project no longer pins a reference
    // branch, so a bare create wants the repo default again.
    mockListPods.mockResolvedValue([spare()])
    mockWorktreeUpstream.mockResolvedValue('develop')
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).toHaveBeenCalledWith(expect.anything(), 'main', 'cafebabe1234', true)
  })

  it('treats a spare with no recorded upstream as warmed from the default branch', async () => {
    mockListPods.mockResolvedValue([spare()])
    mockWorktreeUpstream.mockResolvedValue(null)
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)
    expect(result?.worktreeId).toBe('spare1')
    expect(mockRebranch).not.toHaveBeenCalled()
    expect(mockFetchOrigin).not.toHaveBeenCalled()
  })
})

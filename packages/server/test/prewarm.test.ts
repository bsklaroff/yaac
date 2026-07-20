import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('#session-create', () => ({
  shellEscape: (s: string) => s.replace(/'/g, "'\\''"),
  retoolSpare: vi.fn(),
  rebranchSpare: vi.fn(),
}))
vi.mock('#lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn(),
  cleanupSessionDetached: vi.fn(),
}))
vi.mock('#lib/k8s/kubectl', () => ({ kubectlWithRetry: vi.fn(), k8sNamespace: () => 'ns' }))
vi.mock('#lib/k8s/exec', () => ({ containerExec: vi.fn() }))
vi.mock('#lib/k8s/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listSessionPods: vi.fn(),
}))
vi.mock('#lib/git', () => ({
  fetchOrigin: vi.fn(),
  getDefaultBranch: vi.fn(),
  remoteBranchExists: vi.fn(),
  worktreeUpstreamBranch: vi.fn(),
}))
vi.mock('#lib/project/config', () => ({ resolveProjectConfig: vi.fn() }))
vi.mock('#lib/project/credentials', () => ({ resolveCredentialForUrl: vi.fn() }))
vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    remote: vi.fn().mockResolvedValue('https://example.com/p.git\n'),
    revparse: vi.fn().mockResolvedValue('cafebabe1234\n'),
  })),
}))

import {
  tryClaimPrewarmed,
  resolveRebranchTarget,
  claiming,
  inFlight,
  clearPrewarmStateForTests,
} from '#prewarm'
import { LABEL_PREWARMED, LABEL_TOOL, listSessionPods, type SessionPod } from '#lib/k8s/pods'
import type * as podsModule from '#lib/k8s/pods'
import { cleanupSessionDetached, isTmuxSessionAlive } from '#lib/session/cleanup'
import { kubectlWithRetry } from '#lib/k8s/kubectl'
import { containerExec } from '#lib/k8s/exec'
import { rebranchSpare, retoolSpare } from '#session-create'
import { fetchOrigin, getDefaultBranch, remoteBranchExists, worktreeUpstreamBranch } from '#lib/git'
import { resolveProjectConfig } from '#lib/project/config'
import { ServerError } from '@yaac/shared/errors'

const mockListPods = vi.mocked(listSessionPods)
const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockKubectl = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(containerExec)
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

describe('tryClaimPrewarmed', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearPrewarmStateForTests()
    mockTmuxAlive.mockResolvedValue(true)
    mockKubectl.mockResolvedValue(undefined as never)
    mockExec.mockResolvedValue(undefined as never)
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
    expect(result).toEqual({ sessionId: 'spare1', jobName: 'yaac-p-spare', tool: 'claude', forwardedPorts: [] })
    expect(mockKubectl).toHaveBeenCalledWith(
      ['label', 'pod', 'yaac-p-spare-x', '-n', 'ns', `${LABEL_PREWARMED}-`],
    )
    expect(mockExec).toHaveBeenCalledTimes(2) // user.name + user.email
    expect(claiming.size).toBe(0) // released in finally
  })

  it('returns undefined when there is no spare', async () => {
    mockListPods.mockResolvedValue([])
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockKubectl).not.toHaveBeenCalled()
  })

  it('retools a spare booted with a different tool, stamping the new tool label on commit', async () => {
    mockListPods.mockResolvedValue([spare({ tool: 'codex' })])
    const result = await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)

    expect(result).toEqual({ sessionId: 'spare1', jobName: 'yaac-p-spare', tool: 'claude', forwardedPorts: [] })
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
    expect(result?.sessionId).toBe('spare1')
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

  it('falls through (undefined) and clears the reservation if the relabel fails', async () => {
    mockListPods.mockResolvedValue([spare()])
    mockKubectl.mockRejectedValue(new Error('pod gone'))
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(claiming.size).toBe(0)
  })

  it('skips the git-config execs when no identity is supplied', async () => {
    mockListPods.mockResolvedValue([spare()])
    const result = await tryClaimPrewarmed('p', 'claude', undefined, emit)
    expect(result?.sessionId).toBe('spare1')
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

    expect(result?.sessionId).toBe('spare1')
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
    expect(result?.sessionId).toBe('spare1')
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
    expect(result?.sessionId).toBe('spare1')
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
    expect(result?.sessionId).toBe('spare1')
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
})

describe('resolveRebranchTarget', () => {
  it('no request, no config, spare on default → no prep', () => {
    expect(resolveRebranchTarget({
      requestedBranch: undefined,
      configReferenceBranch: undefined,
      spareUpstreamBranch: 'main',
      defaultBranch: 'main',
    })).toBeNull()
  })

  it('request matches the spare → no prep', () => {
    expect(resolveRebranchTarget({
      requestedBranch: 'dev',
      configReferenceBranch: undefined,
      spareUpstreamBranch: 'dev',
      defaultBranch: 'main',
    })).toBeNull()
  })

  it('request differs from the spare → prep to the request', () => {
    expect(resolveRebranchTarget({
      requestedBranch: 'dev',
      configReferenceBranch: 'develop',
      spareUpstreamBranch: 'develop',
      defaultBranch: 'main',
    })).toBe('dev')
  })

  it('config default differs from the spare (warm-time default changed) → prep', () => {
    expect(resolveRebranchTarget({
      requestedBranch: undefined,
      configReferenceBranch: 'develop',
      spareUpstreamBranch: 'main',
      defaultBranch: 'main',
    })).toBe('develop')
  })

  it('config default cleared after warming → prep back to the default branch', () => {
    expect(resolveRebranchTarget({
      requestedBranch: undefined,
      configReferenceBranch: undefined,
      spareUpstreamBranch: 'develop',
      defaultBranch: 'main',
    })).toBe('main')
  })

  it('missing upstream record counts as warmed from the default branch', () => {
    expect(resolveRebranchTarget({
      requestedBranch: undefined,
      configReferenceBranch: undefined,
      spareUpstreamBranch: null,
      defaultBranch: 'main',
    })).toBeNull()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/daemon/session-create', () => ({
  shellEscape: (s: string) => s.replace(/'/g, "'\\''"),
  retoolSpare: vi.fn(),
}))
vi.mock('@/lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn(),
  cleanupSessionDetached: vi.fn(),
}))
vi.mock('@/lib/k8s/kubectl', () => ({ kubectlWithRetry: vi.fn(), k8sNamespace: () => 'ns' }))
vi.mock('@/lib/k8s/exec', () => ({ containerExec: vi.fn() }))
vi.mock('@/lib/k8s/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listSessionPods: vi.fn(),
}))

import {
  tryClaimPrewarmed,
  claiming,
  inFlight,
  clearPrewarmStateForTests,
} from '@/daemon/prewarm'
import { LABEL_PREWARMED, LABEL_TOOL, listSessionPods, type SessionPod } from '@/lib/k8s/pods'
import type * as podsModule from '@/lib/k8s/pods'
import { cleanupSessionDetached, isTmuxSessionAlive } from '@/lib/session/cleanup'
import { kubectlWithRetry } from '@/lib/k8s/kubectl'
import { containerExec } from '@/lib/k8s/exec'
import { retoolSpare } from '@/daemon/session-create'

const mockListPods = vi.mocked(listSessionPods)
const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockKubectl = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(containerExec)
const mockRetool = vi.mocked(retoolSpare)
const mockCleanupDetached = vi.mocked(cleanupSessionDetached)

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
    mockCleanupDetached.mockResolvedValue(undefined)
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
    expect(mockRetool).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'yaac-p-spare' }), 'claude')
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
})

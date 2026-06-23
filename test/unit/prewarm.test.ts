import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/daemon/session-create', () => ({ shellEscape: (s: string) => s.replace(/'/g, "'\\''") }))
vi.mock('@/lib/session/cleanup', () => ({ isTmuxSessionAlive: vi.fn() }))
vi.mock('@/lib/k8s/kubectl', () => ({ kubectlWithRetry: vi.fn(), k8sNamespace: () => 'ns' }))
vi.mock('@/lib/k8s/exec', () => ({ containerExec: vi.fn() }))
vi.mock('@/lib/k8s/pods', async (importOriginal) => ({
  ...await importOriginal<typeof podsModule>(),
  listSessionPods: vi.fn(),
}))

import {
  tryClaimPrewarmed,
  resolvePrewarmPoolSize,
  claiming,
  inFlight,
  clearPrewarmStateForTests,
  DEFAULT_PREWARM_POOL_SIZE,
} from '@/daemon/prewarm'
import { LABEL_PREWARMED, listSessionPods, type SessionPod } from '@/lib/k8s/pods'
import type * as podsModule from '@/lib/k8s/pods'
import { isTmuxSessionAlive } from '@/lib/session/cleanup'
import { kubectlWithRetry } from '@/lib/k8s/kubectl'
import { containerExec } from '@/lib/k8s/exec'

const mockListPods = vi.mocked(listSessionPods)
const mockTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockKubectl = vi.mocked(kubectlWithRetry)
const mockExec = vi.mocked(containerExec)

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

describe('resolvePrewarmPoolSize', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to 1 when unset or blank', () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '')
    expect(resolvePrewarmPoolSize()).toBe(DEFAULT_PREWARM_POOL_SIZE)
    expect(DEFAULT_PREWARM_POOL_SIZE).toBe(1)
  })

  it('parses non-negative integers (0 disables)', () => {
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '0')
    expect(resolvePrewarmPoolSize()).toBe(0)
    vi.stubEnv('YAAC_PREWARM_POOL_SIZE', '3')
    expect(resolvePrewarmPoolSize()).toBe(3)
  })

  it('falls back to the default for garbage / negative / non-integer values', () => {
    for (const v of ['abc', '-2', '2.5']) {
      vi.stubEnv('YAAC_PREWARM_POOL_SIZE', v)
      expect(resolvePrewarmPoolSize()).toBe(DEFAULT_PREWARM_POOL_SIZE)
    }
  })
})

describe('tryClaimPrewarmed', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    clearPrewarmStateForTests()
    mockTmuxAlive.mockResolvedValue(true)
    mockKubectl.mockResolvedValue(undefined as never)
    mockExec.mockResolvedValue(undefined as never)
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

  it('skips a spare of the wrong tool', async () => {
    mockListPods.mockResolvedValue([spare({ tool: 'codex' })])
    expect(await tryClaimPrewarmed('p', 'claude', GIT_USER, emit)).toBeUndefined()
    expect(mockKubectl).not.toHaveBeenCalled()
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

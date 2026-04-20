import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { sessionAttach } from '@/commands/session-attach'
import { resolveContainerAnyState } from '@/lib/container/resolve'
import { getPrewarmSession, clearPrewarmSession } from '@/lib/prewarm'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('@/lib/container/resolve', () => ({
  resolveContainerAnyState: vi.fn(),
}))

vi.mock('@/lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn().mockReturnValue(true),
  cleanupSessionDetached: vi.fn(),
}))

vi.mock('@/lib/prewarm', () => ({
  getPrewarmSession: vi.fn().mockResolvedValue(null),
  clearPrewarmSession: vi.fn().mockResolvedValue(undefined),
}))

describe('sessionAttach', () => {
  beforeEach(() => {
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
  })

  it('clears prewarm state when attaching to the tracked prewarm session', async () => {
    vi.mocked(resolveContainerAnyState).mockResolvedValue({
      name: 'yaac-demo-prewarm',
      sessionId: 'prewarm-session',
      projectSlug: 'demo',
      state: 'running',
    })
    vi.mocked(getPrewarmSession).mockResolvedValue({
      sessionId: 'prewarm-session',
      containerName: 'yaac-demo-prewarm',
      fingerprint: 'fp',
      state: 'ready',
      verifiedAt: Date.now(),
    })

    await sessionAttach('prewarm-session')

    expect(clearPrewarmSession).toHaveBeenCalledWith('demo')
    expect(execSync).toHaveBeenCalledWith(
      'podman exec -it yaac-demo-prewarm tmux attach-session -t yaac',
      { stdio: 'inherit' },
    )
  })

  it('does not clear prewarm state when attaching to another session in the same project', async () => {
    vi.mocked(resolveContainerAnyState).mockResolvedValue({
      name: 'yaac-demo-active',
      sessionId: 'active-session',
      projectSlug: 'demo',
      state: 'running',
    })
    vi.mocked(getPrewarmSession).mockResolvedValue({
      sessionId: 'prewarm-session',
      containerName: 'yaac-demo-prewarm',
      fingerprint: 'fp',
      state: 'ready',
      verifiedAt: Date.now(),
    })

    await sessionAttach('active-session')

    expect(clearPrewarmSession).not.toHaveBeenCalled()
  })

  it('returns an error for non-running containers without touching prewarm state', async () => {
    vi.mocked(resolveContainerAnyState).mockResolvedValue({
      name: 'yaac-demo-exited',
      sessionId: 'dead-session',
      projectSlug: 'demo',
      state: 'exited',
    })

    await sessionAttach('dead-session')

    expect(getPrewarmSession).not.toHaveBeenCalled()
    expect(clearPrewarmSession).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})

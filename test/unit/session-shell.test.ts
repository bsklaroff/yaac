import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionShell } from '@/commands/session-shell'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('@/lib/container/resolve', () => ({
  resolveContainerAnyState: vi.fn(),
}))

describe('sessionShell', () => {
  beforeEach(() => {
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.clearAllMocks()
    process.exitCode = undefined
  })

  it('execs zsh interactively inside a running container', async () => {
    const { execSync } = await import('node:child_process')
    const { resolveContainerAnyState } = await import('@/lib/container/resolve')

    vi.mocked(resolveContainerAnyState).mockResolvedValue({
      name: 'yaac-demo-abc',
      sessionId: 'abc',
      projectSlug: 'demo',
      state: 'running',
    })

    await sessionShell('abc')

    expect(execSync).toHaveBeenCalledWith(
      'podman exec -it yaac-demo-abc zsh',
      { stdio: 'inherit' },
    )
    expect(process.exitCode).toBeUndefined()
  })

  it('returns an error for non-running containers without execing', async () => {
    const { execSync } = await import('node:child_process')
    const { resolveContainerAnyState } = await import('@/lib/container/resolve')

    vi.mocked(resolveContainerAnyState).mockResolvedValue({
      name: 'yaac-demo-dead',
      sessionId: 'dead',
      projectSlug: 'demo',
      state: 'exited',
    })

    await sessionShell('dead')

    expect(execSync).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('does nothing when the container cannot be resolved', async () => {
    const { execSync } = await import('node:child_process')
    const { resolveContainerAnyState } = await import('@/lib/container/resolve')

    vi.mocked(resolveContainerAnyState).mockResolvedValue(null)

    await sessionShell('missing')

    expect(execSync).not.toHaveBeenCalled()
  })

  it('swallows execSync errors (shell exited non-zero)', async () => {
    const { execSync } = await import('node:child_process')
    const { resolveContainerAnyState } = await import('@/lib/container/resolve')

    vi.mocked(resolveContainerAnyState).mockResolvedValue({
      name: 'yaac-demo-abc',
      sessionId: 'abc',
      projectSlug: 'demo',
      state: 'running',
    })
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('exit 130')
    })

    await expect(sessionShell('abc')).resolves.toBeUndefined()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeAttachedSession } from '@/lib/session/finalize-attached-session'

vi.mock('@/lib/session/cleanup', () => ({
  isTmuxSessionAlive: vi.fn(),
  cleanupSessionDetached: vi.fn(),
}))

vi.mock('@/lib/session/status', () => ({
  getSessionFirstMessage: vi.fn(),
}))

import { isTmuxSessionAlive, cleanupSessionDetached } from '@/lib/session/cleanup'
import { getSessionFirstMessage } from '@/lib/session/status'

const mockIsTmuxAlive = vi.mocked(isTmuxSessionAlive)
const mockCleanupDetached = vi.mocked(cleanupSessionDetached)
const mockGetFirstMessage = vi.mocked(getSessionFirstMessage)

describe('finalizeAttachedSession', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns detached without cleanup when tmux is still alive', async () => {
    mockIsTmuxAlive.mockReturnValue(true)

    const result = await finalizeAttachedSession({
      containerName: 'yaac-demo-abc',
      projectSlug: 'demo',
      sessionId: 'abc',
      tool: 'claude',
    })

    expect(result).toBe('detached')
    expect(mockGetFirstMessage).not.toHaveBeenCalled()
    expect(mockCleanupDetached).not.toHaveBeenCalled()
  })

  it('cleans up and reports closed_prompted when the attached session died with a prompt', async () => {
    mockIsTmuxAlive.mockReturnValue(false)
    mockGetFirstMessage.mockResolvedValue('fix the bug')
    const cleaning = new Set<string>()

    const result = await finalizeAttachedSession({
      containerName: 'yaac-demo-abc',
      projectSlug: 'demo',
      sessionId: 'abc',
      tool: 'codex',
      cleaning,
    })

    expect(result).toBe('closed_prompted')
    expect(cleaning.has('abc')).toBe(true)
    expect(mockGetFirstMessage).toHaveBeenCalledWith('demo', 'abc', 'codex')
    expect(mockCleanupDetached).toHaveBeenCalledWith({
      containerName: 'yaac-demo-abc',
      projectSlug: 'demo',
      sessionId: 'abc',
    })
  })
})

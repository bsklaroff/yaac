import { describe, it, expect, vi, beforeEach } from 'vitest'
import { worktreeShell } from '#commands/worktree-shell'
import { attachSessionPty } from '#commands/ws-terminal'

vi.mock('#commands/ws-terminal', () => ({
  attachSessionPty: vi.fn().mockResolvedValue(undefined),
}))

describe('worktreeShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens a raw shell over the server PTY WebSocket', async () => {
    await worktreeShell('abc')
    expect(attachSessionPty).toHaveBeenCalledWith('abc', 'shell')
  })

  it('propagates transport failures', async () => {
    vi.mocked(attachSessionPty).mockRejectedValue(new Error('terminal connection failed: nope'))
    await expect(worktreeShell('abc')).rejects.toThrow(/terminal connection failed/)
  })
})

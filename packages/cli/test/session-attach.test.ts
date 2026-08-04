import { describe, it, expect, vi, beforeEach } from 'vitest'
import { worktreeAttach } from '#commands/worktree-attach'
import { attachSessionPty } from '#commands/ws-terminal'

vi.mock('#commands/ws-terminal', () => ({
  attachSessionPty: vi.fn().mockResolvedValue(undefined),
}))

describe('worktreeAttach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('attaches over the server PTY WebSocket with the native target', async () => {
    await worktreeAttach('abc')
    expect(attachSessionPty).toHaveBeenCalledWith('abc', 'native')
  })

  it('propagates transport failures', async () => {
    vi.mocked(attachSessionPty).mockRejectedValue(new Error('terminal connection failed: nope'))
    await expect(worktreeAttach('abc')).rejects.toThrow(/terminal connection failed/)
  })
})

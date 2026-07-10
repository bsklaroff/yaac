import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sessionAttach } from '#commands/session-attach'
import { attachSessionPty } from '#commands/ws-terminal'

vi.mock('#commands/ws-terminal', () => ({
  attachSessionPty: vi.fn().mockResolvedValue(undefined),
}))

describe('sessionAttach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('attaches over the server PTY WebSocket with the native target', async () => {
    await sessionAttach('abc')
    expect(attachSessionPty).toHaveBeenCalledWith('abc', 'native')
  })

  it('propagates transport failures', async () => {
    vi.mocked(attachSessionPty).mockRejectedValue(new Error('terminal connection failed: nope'))
    await expect(sessionAttach('abc')).rejects.toThrow(/terminal connection failed/)
  })
})

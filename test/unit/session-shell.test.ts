import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sessionShell } from '@yaac/cli/commands/session-shell'
import { attachSessionPty } from '@yaac/cli/commands/ws-terminal'

vi.mock('@yaac/cli/commands/ws-terminal', () => ({
  attachSessionPty: vi.fn().mockResolvedValue(undefined),
}))

describe('sessionShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens a raw shell over the server PTY WebSocket', async () => {
    await sessionShell('abc')
    expect(attachSessionPty).toHaveBeenCalledWith('abc', 'shell')
  })

  it('propagates transport failures', async () => {
    vi.mocked(attachSessionPty).mockRejectedValue(new Error('terminal connection failed: nope'))
    await expect(sessionShell('abc')).rejects.toThrow(/terminal connection failed/)
  })
})

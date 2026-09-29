import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSpy = vi.hoisted(() => vi.fn())
vi.mock('#commands/api', () => ({ api: { worktree: { ':id': { $get: getSpy } } } }))
vi.mock('#commands/ws-terminal', () => ({
  attachWorktreePty: vi.fn().mockResolvedValue(undefined),
}))

import { worktreeAttach } from '#commands/worktree-attach'
import { attachWorktreePty } from '#commands/ws-terminal'

describe('worktreeAttach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSpy.mockResolvedValue({ worktreeId: 'abc123def456' })
  })

  // The socket takes an exact id only, so what was typed — a prefix here —
  // is resolved by the server first.
  it('attaches over the server PTY WebSocket with the native target, by the id the server resolved', async () => {
    await worktreeAttach('abc')
    expect(getSpy).toHaveBeenCalledWith({ param: { id: 'abc' } })
    expect(attachWorktreePty).toHaveBeenCalledWith('abc123def456', 'native')
  })

  it('opens no socket when the id does not resolve', async () => {
    getSpy.mockRejectedValue(new Error('Ambiguous worktree prefix: abc'))
    await expect(worktreeAttach('abc')).rejects.toThrow(/Ambiguous/)
    expect(attachWorktreePty).not.toHaveBeenCalled()
  })

  it('propagates transport failures', async () => {
    vi.mocked(attachWorktreePty).mockRejectedValue(new Error('terminal connection failed: nope'))
    await expect(worktreeAttach('abc')).rejects.toThrow(/terminal connection failed/)
  })
})

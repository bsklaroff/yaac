import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSpy = vi.hoisted(() => vi.fn())
vi.mock('#commands/api', () => ({ api: { worktree: { ':id': { $get: getSpy } } } }))
vi.mock('#commands/ws-terminal', () => ({
  attachWorktreePty: vi.fn().mockResolvedValue(undefined),
}))

import { worktreeShell } from '#commands/worktree-shell'
import { attachWorktreePty } from '#commands/ws-terminal'

describe('worktreeShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSpy.mockResolvedValue({ worktreeId: 'abc123def456' })
  })

  // The socket takes an exact id only, so what was typed — a prefix here —
  // is resolved by the server first.
  it('opens a raw shell over the server PTY WebSocket, by the id the server resolved', async () => {
    await worktreeShell('abc')
    expect(getSpy).toHaveBeenCalledWith({ param: { id: 'abc' } })
    expect(attachWorktreePty).toHaveBeenCalledWith('abc123def456', 'shell')
  })

  it('opens no socket when the id does not resolve', async () => {
    getSpy.mockRejectedValue(new Error('Ambiguous worktree prefix: abc'))
    await expect(worktreeShell('abc')).rejects.toThrow(/Ambiguous/)
    expect(attachWorktreePty).not.toHaveBeenCalled()
  })

  it('propagates transport failures', async () => {
    vi.mocked(attachWorktreePty).mockRejectedValue(new Error('terminal connection failed: nope'))
    await expect(worktreeShell('abc')).rejects.toThrow(/terminal connection failed/)
  })
})

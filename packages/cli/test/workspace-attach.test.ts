import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSpy = vi.hoisted(() => vi.fn())
vi.mock('#commands/api', () => ({ api: { workspace: { ':id': { $get: getSpy } } } }))
vi.mock('#commands/ws-terminal', () => ({
  attachWorkspacePty: vi.fn().mockResolvedValue(undefined),
}))

import { workspaceAttach } from '#commands/workspace-attach'
import { attachWorkspacePty } from '#commands/ws-terminal'

describe('workspaceAttach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSpy.mockResolvedValue({ workspaceId: 'abc123def456' })
  })

  // The socket takes an exact id only, so what was typed — a prefix here —
  // is resolved by the server first.
  it('attaches over the server PTY WebSocket with the native target, by the id the server resolved', async () => {
    await workspaceAttach('abc')
    expect(getSpy).toHaveBeenCalledWith({ param: { id: 'abc' } })
    expect(attachWorkspacePty).toHaveBeenCalledWith('abc123def456', 'native')
  })

  it('opens no socket when the id does not resolve', async () => {
    getSpy.mockRejectedValue(new Error('Ambiguous workspace prefix: abc'))
    await expect(workspaceAttach('abc')).rejects.toThrow(/Ambiguous/)
    expect(attachWorkspacePty).not.toHaveBeenCalled()
  })

  it('propagates transport failures', async () => {
    vi.mocked(attachWorkspacePty).mockRejectedValue(new Error('terminal connection failed: nope'))
    await expect(workspaceAttach('abc')).rejects.toThrow(/terminal connection failed/)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSpy = vi.hoisted(() => vi.fn())
vi.mock('#commands/api', () => ({ api: { workspace: { ':id': { $get: getSpy } } } }))
vi.mock('#commands/ws-terminal', () => ({
  attachWorkspacePty: vi.fn().mockResolvedValue(undefined),
}))

import { workspaceShell } from '#commands/workspace-shell'
import { attachWorkspacePty } from '#commands/ws-terminal'

describe('workspaceShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSpy.mockResolvedValue({ workspaceId: 'abc123def456' })
  })

  // The socket takes only an exact id, so the prefix is resolved first.
  it('opens a raw shell over the server PTY WebSocket, by the id the server resolved', async () => {
    await workspaceShell('abc')
    expect(getSpy).toHaveBeenCalledWith({ param: { id: 'abc' } })
    expect(attachWorkspacePty).toHaveBeenCalledWith('abc123def456', 'shell')
  })

  it('opens no socket when the id does not resolve', async () => {
    getSpy.mockRejectedValue(new Error('Ambiguous workspace prefix: abc'))
    await expect(workspaceShell('abc')).rejects.toThrow(/Ambiguous/)
    expect(attachWorkspacePty).not.toHaveBeenCalled()
  })

  it('propagates transport failures', async () => {
    vi.mocked(attachWorkspacePty).mockRejectedValue(new Error('terminal connection failed: nope'))
    await expect(workspaceShell('abc')).rejects.toThrow(/terminal connection failed/)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { attachSpy, postSpy, consumeSpy } = vi.hoisted(() => ({
  attachSpy: vi.fn().mockResolvedValue(undefined),
  postSpy: vi.fn().mockResolvedValue({}),
  consumeSpy: vi.fn(),
}))
vi.mock('#commands/ws-terminal', () => ({ attachWorkspacePty: attachSpy }))
vi.mock('#commands/api', () => ({ api: { workspace: { restart: { $post: postSpy } } } }))
vi.mock('@yaac/shared/ndjson', () => ({ consumeNdjsonStream: consumeSpy }))
import { workspaceRestart } from '#commands/workspace-restart'

describe('workspaceRestart', () => {
  beforeEach(() => {
    attachSpy.mockClear()
    postSpy.mockClear()
  })

  it('attaches a terminal to a restarted tui workspace', async () => {
    consumeSpy.mockResolvedValueOnce({ workspaceId: 'w1', mode: 'tui' })
    await workspaceRestart('w1')
    expect(attachSpy).toHaveBeenCalledWith('w1', 'native')
  })

  it('does not attach a terminal to a restarted acp workspace', async () => {
    // Its tmux window only runs acpd; attaching would hang, as on create.
    consumeSpy.mockResolvedValueOnce({ workspaceId: 'w2', mode: 'acp' })
    await workspaceRestart('w2')
    expect(attachSpy).not.toHaveBeenCalled()
  })
})

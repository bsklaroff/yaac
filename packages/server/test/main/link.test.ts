import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The link is four delegations, and each one is a place where the herd stops
// and the server decides. What it delegates TO is tested where that lives
// (apply-herd-event, spawn, the agent-session store); what this file pins is
// that the splice is wired to the right thing at all — the failure mode
// otherwise is silent, since only an e2e would notice.
vi.mock('#features/records', () => ({
  applyHerdEvent: vi.fn(),
  listActiveAgentSessions: vi.fn(),
}))
vi.mock('#notify', () => ({ notifyWorktreeListChanged: vi.fn() }))
vi.mock('#main/spawn', () => ({ decideSpawn: vi.fn() }))

import { applyHerdEvent, listActiveAgentSessions } from '#features/records'
import { notifyWorktreeListChanged } from '#notify'
import { decideSpawn } from '#main/spawn'
import { createServerLink } from '#main/link'
import type { HerdEvent } from '@yaac/shared/herd'

const mockApply = vi.mocked(applyHerdEvent)
const mockLinks = vi.mocked(listActiveAgentSessions)
const mockNotify = vi.mocked(notifyWorktreeListChanged)
const mockDecide = vi.mocked(decideSpawn)

beforeEach(() => { vi.resetAllMocks() })
afterEach(() => { vi.resetAllMocks() })

describe('createServerLink', () => {
  it('persists a reported event, and resolves only once the row is written', async () => {
    let written = false
    mockApply.mockImplementation(async () => {
      await Promise.resolve()
      written = true
    })
    const event: HerdEvent = { type: 'worktree-stopped', projectSlug: 'p', worktreeId: 'w' }

    await createServerLink().workspaceEvent(event)

    expect(mockApply).toHaveBeenCalledWith(event)
    expect(written).toBe(true)
  })

  it('lets a failed write through to the reporter', async () => {
    mockApply.mockRejectedValue(new Error('db is gone'))
    await expect(
      createServerLink().workspaceEvent({ type: 'worktree-stopped', projectSlug: 'p', worktreeId: 'w' }),
    ).rejects.toThrow('db is gone')
  })

  it('turns a change report into a snapshot push', () => {
    createServerLink().workspacesChanged()
    expect(mockNotify).toHaveBeenCalledTimes(1)
  })

  // The splice the review flagged as the one that would hurt silently: a herd
  // that drained a spawn must reach the server's policy, not a stub.
  it('hands a drained spawn to the server’s policy and relays its decision', async () => {
    mockDecide.mockResolvedValue({ ok: true, workspaceId: 'minted' })
    const request = {
      requestId: 'r1',
      callerWorkspaceId: 'caller',
      callerProjectSlug: 'proj',
      prompt: 'go',
    }

    expect(await createServerLink().spawnRequested(request)).toEqual({
      ok: true, workspaceId: 'minted',
    })
    expect(mockDecide).toHaveBeenCalledWith(request)
  })

  // Keyed by the driver's handle, and only conversations that are on one:
  // the herd re-addresses a live agent by handle, so a link with no pane id
  // names nothing it could attach to.
  it('reports only the recorded conversations that sit on a handle', async () => {
    mockLinks.mockResolvedValue([
      { agentSessionId: 'a', paneId: '%0' },
      { agentSessionId: 'b' },
      { agentSessionId: 'c', paneId: '%2' },
    ] as unknown as Awaited<ReturnType<typeof listActiveAgentSessions>>)

    expect(await createServerLink().recordedConversations({
      projectSlug: 'proj', workspaceId: 'w1',
    })).toEqual([
      { handle: '%0', agentSessionId: 'a' },
      { handle: '%2', agentSessionId: 'c' },
    ])
    expect(mockLinks).toHaveBeenCalledWith('proj', 'w1')
  })

  // A watcher starting against an unreadable database must attach with no
  // history rather than fail the whole workspace's status stream.
  it('reports nothing when the rows cannot be read', async () => {
    mockLinks.mockRejectedValue(new Error('db is gone'))
    expect(await createServerLink().recordedConversations({
      projectSlug: 'proj', workspaceId: 'w1',
    })).toEqual([])
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  _resetServerLinkForTests,
  _setServerLinkForTests,
  serverLink,
} from '#server-link'
import { serverLog } from '#log'
import type { HerdEvent } from '@yaac/shared/herd'

vi.mock('#log', () => ({ serverLog: vi.fn() }))

afterEach(() => {
  _resetServerLinkForTests()
  vi.mocked(serverLog).mockClear()
})

const stopped: HerdEvent = {
  type: 'worktree-stopped',
  projectSlug: 'proj',
  worktreeId: 'wt-1',
}

describe('serverLink', () => {
  it('delivers each event to the installed link', async () => {
    const seen: HerdEvent[] = []
    _setServerLinkForTests({
      workspaceEvent: (e) => {
        seen.push(e)
        return Promise.resolve()
      },
    })

    await serverLink().workspaceEvent(stopped)
    await serverLink().workspaceEvent({ ...stopped, worktreeId: 'wt-2' })

    expect(seen.map((e) => e.worktreeId)).toEqual(['wt-1', 'wt-2'])
  })

  // The report is what a caller tearing a session down awaits: a listing
  // between the report and the write would show the worktree as neither
  // running nor stopped.
  it('resolves only once the server has applied the event', async () => {
    let applied = false
    let release = (): void => {}
    _setServerLinkForTests({
      workspaceEvent: async () => {
        await new Promise<void>((resolve) => { release = resolve })
        applied = true
      },
    })

    const reported = serverLink().workspaceEvent(stopped)
    let settled = false
    void reported.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await reported
    expect(applied).toBe(true)
  })

  it('propagates a failure to the reporter', async () => {
    _setServerLinkForTests({ workspaceEvent: () => Promise.reject(new Error('db is gone')) })
    await expect(serverLink().workspaceEvent(stopped)).rejects.toThrow('db is gone')
  })

  it('last installation wins', async () => {
    const first = vi.fn().mockResolvedValue(undefined)
    const second = vi.fn().mockResolvedValue(undefined)
    _setServerLinkForTests({ workspaceEvent: first })
    _setServerLinkForTests({ workspaceEvent: second })

    await serverLink().workspaceEvent(stopped)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(stopped)
  })

  // Detached is normal in a unit test that is not exercising the server half,
  // and a bug anywhere else — so a dropped event must not pass silently.
  it('logs rather than throws when no link is installed', async () => {
    await expect(serverLink().workspaceEvent(stopped)).resolves.toBeUndefined()
    expect(vi.mocked(serverLog).mock.calls[0]?.[0]).toContain('worktree-stopped')
  })

  // A herd with no server to ask cannot invent an id for the pod waiting on
  // one, so the request is refused rather than answered with a guess.
  it('refuses a spawn while detached', async () => {
    const decision = await serverLink().spawnRequested({
      requestId: 'r1',
      callerWorkspaceId: 'wt-1',
      callerProjectSlug: 'proj',
      prompt: 'go',
    })
    expect(decision).toEqual({ ok: false, error: 'server link unavailable' })
  })
})

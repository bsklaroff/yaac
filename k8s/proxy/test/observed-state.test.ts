import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProxyState } from 'yaac-proxy-sidecar/objects'
import { ObservedState } from 'yaac-proxy-sidecar/observed-state'

/** An ObservedState whose writes are recorded, with time under test control. */
function observed(): { state: ObservedState; writes: ProxyState[]; flush: () => Promise<void> } {
  const writes: ProxyState[] = []
  const state = new ObservedState((s) => { writes.push(s); return Promise.resolve() })
  return { state, writes, flush: async () => { await vi.runAllTimersAsync() } }
}

const FETCH = '/acme/repo.git/info/refs?service=git-upload-pack'

describe('ObservedState', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('records a rejected git credential per project and clears it on a later success', async () => {
    const { state, writes, flush } = observed()
    state.noteGitUpstreamStatus('demo', 'github.com', FETCH, 401)
    // Repeats, other paths, statuses that prove nothing and unattributed
    // requests change nothing.
    state.noteGitUpstreamStatus('demo', 'github.com', FETCH, 403)
    state.noteGitUpstreamStatus('demo', 'github.com', '/api/v3/user', 401)
    state.noteGitUpstreamStatus('demo', 'gitlab.com', '/acme/repo.git/git-receive-pack', 500)
    state.noteGitUpstreamStatus(undefined, 'github.com', FETCH, 401)
    state.noteGitUpstreamStatus('other', 'gitlab.com', '/acme/repo.git/git-upload-pack', 403)
    await flush()
    expect(writes).toHaveLength(1)
    expect(writes[0].gitAuthFailures).toEqual({
      demo: [{ host: 'github.com', status: 401, atMs: expect.any(Number) as number }],
      other: [{ host: 'gitlab.com', status: 403, atMs: expect.any(Number) as number }],
    })

    state.noteGitUpstreamStatus('demo', 'github.com', FETCH, 200)
    // A success with nothing recorded writes nothing.
    state.noteGitUpstreamStatus('demo', 'gitlab.com', FETCH, 200)
    await flush()
    expect(writes).toHaveLength(2)
    expect(Object.keys(writes[1].gitAuthFailures)).toEqual(['other'])
  })

  it('records blocked hosts, prunes the ones a registration now allows, and seeds from a previous pod', async () => {
    const { state, writes, flush } = observed()
    state.seed({ blockedHosts: { ws: ['a.com'] }, gitAuthFailures: {} })
    state.recordBlockedHost('ws', 'b.com')
    state.recordBlockedHost('ws', 'b.com')
    state.recordBlockedHost('gone', 'c.com')
    await flush()
    expect(writes).toHaveLength(1)
    expect(writes[0].blockedHosts).toEqual({ ws: ['a.com', 'b.com'], gone: ['c.com'] })

    state.pruneBlocked('ws', (host) => host === 'a.com')
    state.pruneBlocked('gone', null)
    await flush()
    expect(writes.at(-1)!.blockedHosts).toEqual({ ws: ['b.com'] })
  })

  it('retries a failed write', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('conflict')).mockResolvedValue(undefined)
    const state = new ObservedState(write)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    state.recordBlockedHost('ws', 'a.com')
    await vi.runAllTimersAsync()
    expect(write).toHaveBeenCalledTimes(2)
  })
})

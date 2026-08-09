import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { _resetServerLinkForTests, _setServerLinkForTests } from '#server-link'
import type { SpawnDecision, SpawnRequest } from '#server-link'
import type { PendingSpawn, SpawnResultWire } from '#features/egress/proxy-client'
import type { SessionPod } from '#platform/k8s/pods'
import type { TickSnapshot } from '#platform/k8s/tick-snapshot'
import { reconcileSpawnRequests } from '#features/sessions/spawn-reconcile'

function makePod(over: Partial<SessionPod> = {}): SessionPod {
  return {
    jobName: 'yaac-proj-caller',
    podName: 'yaac-proj-caller-abc12',
    sessionId: 'caller-session',
    projectSlug: 'proj',
    tool: 'codex',
    phase: 'Running',
    running: true,
    terminating: false,
    createdAtMs: 0,
    labels: {},
    ...over,
  }
}

function makeReq(over: Partial<PendingSpawn> = {}): PendingSpawn {
  return {
    requestId: 'req-1',
    sessionId: 'caller-session',
    prompt: 'write the report',
    ...over,
  }
}

/** The reports the herd made, and what the server answered. Nothing about a
 *  spawn's MEANING is decided on this side, so the link is the whole of what
 *  these tests assert against. */
const reports: SpawnRequest[] = []
let answer: SpawnDecision = { ok: true, workspaceId: 'minted-id' }

beforeEach(() => {
  reports.length = 0
  answer = { ok: true, workspaceId: 'minted-id' }
  _setServerLinkForTests({
    spawnRequested: (request) => {
      reports.push(request)
      return Promise.resolve(answer)
    },
  })
})

afterEach(() => {
  _resetServerLinkForTests()
})

/** Drain exactly one request and hand back what was posted for it. The
 *  per-request path has no barrel entry of its own — a drain is the only way
 *  in, which is also the only way the proxy reaches it. */
async function drainOne(
  req: PendingSpawn,
  pods: () => Promise<SessionPod[]>,
): Promise<SpawnResultWire> {
  const posted: SpawnResultWire[][] = []
  await reconcileSpawnRequests({
    listSessionPodsFn: pods,
    attachIfRunningFn: () => Promise.resolve(true),
    fetchPendingFn: () => Promise.resolve([req]),
    postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
  })
  return posted[0][0]
}

describe('reconcileSpawnRequests', () => {
  it('reports the caller resolved from its pod and relays the minted id', async () => {
    const result = await drainOne(makeReq(), () => Promise.resolve([makePod()]))
    expect(result).toEqual({ requestId: 'req-1', ok: true, sessionId: 'minted-id' })
    expect(reports).toEqual([{
      requestId: 'req-1',
      callerWorkspaceId: 'caller-session',
      callerProjectSlug: 'proj',
      callerTool: 'codex',
      prompt: 'write the report',
    }])
  })

  it('passes an explicit tool and model through without judging them', async () => {
    await drainOne(
      makeReq({ tool: 'not-a-tool', model: "opus'; rm -rf /" }),
      () => Promise.resolve([makePod()]),
    )
    expect(reports[0]).toMatchObject({ tool: 'not-a-tool', model: "opus'; rm -rf /" })
  })

  // A label that is not a tool yaac knows says nothing about what the spawned
  // workspace should run, and reporting a guess would outrank the server's
  // own configured default.
  it('omits the caller tool when the pod is labelled with something else', async () => {
    await drainOne(makeReq(), () => Promise.resolve([makePod({ tool: 'bogus' })]))
    expect(reports[0].callerTool).toBeUndefined()
  })

  it('relays the server’s refusal back to the proxy', async () => {
    answer = { ok: false, error: 'too many concurrent spawns' }
    const result = await drainOne(makeReq(), () => Promise.resolve([makePod()]))
    expect(result).toEqual({
      requestId: 'req-1', ok: false, error: 'too many concurrent spawns',
    })
  })

  // The one judgement this side makes, and it is a substrate one: a request
  // from a session no pod matches cannot be attributed to a project.
  it('rejects a caller with no live session pod, without reporting it', async () => {
    const result = await drainOne(makeReq(), () => Promise.resolve([]))
    expect(result).toEqual({ requestId: 'req-1', ok: false, error: 'calling session not found' })
    expect(reports).toEqual([])
  })

  it('fails soft when pod listing throws', async () => {
    const result = await drainOne(makeReq(), () => Promise.reject(new Error('apiserver down')))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('apiserver down')
    expect(reports).toEqual([])
  })

  it('does nothing when the proxy is not attachable', async () => {
    const fetchPendingFn = vi.fn()
    await reconcileSpawnRequests({
      attachIfRunningFn: () => Promise.resolve(false),
      fetchPendingFn,
    })
    expect(fetchPendingFn).not.toHaveBeenCalled()
  })

  it('drains, reports, and posts one result per request', async () => {
    const posted: SpawnResultWire[][] = []
    await reconcileSpawnRequests({
      listSessionPodsFn: () => Promise.resolve([makePod()]),
      attachIfRunningFn: () => Promise.resolve(true),
      fetchPendingFn: () => Promise.resolve([
        makeReq({ requestId: 'a' }),
        makeReq({ requestId: 'b', sessionId: 'nobody' }),
      ]),
      postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toEqual([
      { requestId: 'a', ok: true, sessionId: 'minted-id' },
      { requestId: 'b', ok: false, error: 'calling session not found' },
    ])
  })

  it('lists session pods once per drain, not once per request', async () => {
    const listSessionPodsFn = vi.fn(() => Promise.resolve([makePod()]))
    await reconcileSpawnRequests({
      listSessionPodsFn,
      attachIfRunningFn: () => Promise.resolve(true),
      fetchPendingFn: () => Promise.resolve([
        makeReq({ requestId: 'a', sessionId: 'nobody-1' }),
        makeReq({ requestId: 'b', sessionId: 'nobody-2' }),
        makeReq({ requestId: 'c', sessionId: 'nobody-3' }),
      ]),
      postResultsFn: () => Promise.resolve(),
    })
    expect(listSessionPodsFn).toHaveBeenCalledTimes(1)
  })

  it('resolves callers from the tick snapshot when one is given', async () => {
    const pods = vi.fn(() => Promise.resolve([makePod()]))
    const posted: SpawnResultWire[][] = []
    await reconcileSpawnRequests({
      // No listSessionPodsFn: the snapshot wins over the module-level list,
      // so a leaked direct listing would fail the caller lookup.
      attachIfRunningFn: () => Promise.resolve(true),
      fetchPendingFn: () => Promise.resolve([makeReq(), makeReq({ requestId: 'r2' })]),
      postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
    }, { resync: true, pods } as unknown as TickSnapshot)
    expect(pods).toHaveBeenCalledTimes(1)
    expect(posted[0].every((r) => r.ok)).toBe(true)
  })

  it('skips the post when nothing is pending', async () => {
    const postResultsFn = vi.fn()
    await reconcileSpawnRequests({
      attachIfRunningFn: () => Promise.resolve(true),
      fetchPendingFn: () => Promise.resolve([]),
      postResultsFn,
    })
    expect(postResultsFn).not.toHaveBeenCalled()
  })

  it('never throws when the proxy fetch fails', async () => {
    await expect(reconcileSpawnRequests({
      attachIfRunningFn: () => Promise.resolve(true),
      fetchPendingFn: () => Promise.reject(new Error('tunnel down')),
    })).resolves.toBeUndefined()
  })
})

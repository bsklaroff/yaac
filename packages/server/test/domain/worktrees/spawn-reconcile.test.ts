import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SpawnDecision, SpawnRequest } from '#domain/worktrees/spawn-policy'

vi.mock('#domain/worktrees/spawn-policy', () => ({ decideSpawn: vi.fn() }))
import { decideSpawn } from '#domain/worktrees/spawn-policy'
import type { PendingSpawn, SpawnResultWire } from '@yaac/shared/types'
import type { RuntimeHandle } from '#runtime/contract'
import { handleFixture, snapshotFixture } from '@yaac/test-utils/fake-runtime'
import { reconcileSpawnRequests } from '#domain/worktrees/spawn-reconcile'

function makeCaller(over: Partial<RuntimeHandle> = {}): RuntimeHandle {
  return handleFixture({
    jobName: 'yaac-proj-caller',
    workspaceId: 'caller-session',
    projectSlug: 'proj',
    tool: 'codex',
    declaredTool: 'codex',
    ...over,
  })
}

function makeReq(over: Partial<PendingSpawn> = {}): PendingSpawn {
  return {
    requestId: 'req-1',
    worktreeId: 'caller-session',
    prompt: 'write the report',
    ...over,
  }
}

/** What the drain handed to the policy, and what the policy answered.
 *  Nothing about a spawn's MEANING is decided on this side, so the policy
 *  seam is the whole of what these tests assert against. */
const reports: SpawnRequest[] = []
let answer: SpawnDecision = { ok: true, workspaceId: 'minted-id' }

beforeEach(() => {
  reports.length = 0
  answer = { ok: true, workspaceId: 'minted-id' }
  vi.mocked(decideSpawn).mockImplementation((request) => {
    reports.push(request)
    return Promise.resolve(answer)
  })
})

/** Drain exactly one request and hand back what was posted for it. The
 *  per-request path has no entry point of its own — a drain is the only way
 *  in, which is also the only way a request reaches it. */
async function drainOne(
  req: PendingSpawn,
  pods: () => Promise<RuntimeHandle[]>,
): Promise<SpawnResultWire> {
  const posted: SpawnResultWire[][] = []
  await reconcileSpawnRequests({
    listWorkspacesFn: pods,
    fetchPendingFn: () => Promise.resolve([req]),
    postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
  })
  return posted[0][0]
}

describe('reconcileSpawnRequests', () => {
  it('reports the caller resolved from the listing and relays the minted id', async () => {
    const result = await drainOne(makeReq(), () => Promise.resolve([makeCaller()]))
    expect(result).toEqual({
      requestId: 'req-1', ok: true, worktreeId: 'minted-id', sessionId: 'minted-id',
    })
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
      () => Promise.resolve([makeCaller()]),
    )
    expect(reports[0]).toMatchObject({ tool: 'not-a-tool', model: "opus'; rm -rf /" })
  })

  // A caller running something yaac does not know says nothing about what
  // the spawned workspace should run, and reporting a guess would outrank
  // the server's own configured default.
  it('omits the caller tool when the caller declares something else', async () => {
    const caller = makeCaller()
    delete caller.declaredTool
    await drainOne(makeReq(), () => Promise.resolve([caller]))
    expect(reports[0].callerTool).toBeUndefined()
  })

  it('relays the server’s refusal back to the caller', async () => {
    answer = { ok: false, error: 'too many concurrent spawns' }
    const result = await drainOne(makeReq(), () => Promise.resolve([makeCaller()]))
    expect(result).toEqual({
      requestId: 'req-1', ok: false, error: 'too many concurrent spawns',
    })
  })

  // The one judgement this side makes: a request from a worktree the runtime
  // does not report cannot be attributed to a project.
  it('rejects a caller the runtime does not report, without reporting it', async () => {
    const result = await drainOne(makeReq(), () => Promise.resolve([]))
    expect(result).toEqual({ requestId: 'req-1', ok: false, error: 'calling worktree not found' })
    expect(reports).toEqual([])
  })

  it('fails soft when the workspace listing throws', async () => {
    const result = await drainOne(makeReq(), () => Promise.reject(new Error('apiserver down')))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('apiserver down')
    expect(reports).toEqual([])
  })

  it('drains, reports, and posts one result per request', async () => {
    const posted: SpawnResultWire[][] = []
    await reconcileSpawnRequests({
      listWorkspacesFn: () => Promise.resolve([makeCaller()]),
      fetchPendingFn: () => Promise.resolve([
        makeReq({ requestId: 'a' }),
        makeReq({ requestId: 'b', worktreeId: 'nobody' }),
      ]),
      postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toEqual([
      { requestId: 'a', ok: true, worktreeId: 'minted-id', sessionId: 'minted-id' },
      { requestId: 'b', ok: false, error: 'calling worktree not found' },
    ])
  })

  it('lists workspaces once per drain, not once per request', async () => {
    const listWorkspacesFn = vi.fn(() => Promise.resolve([makeCaller()]))
    await reconcileSpawnRequests({
      listWorkspacesFn,
      fetchPendingFn: () => Promise.resolve([
        makeReq({ requestId: 'a', worktreeId: 'nobody-1' }),
        makeReq({ requestId: 'b', worktreeId: 'nobody-2' }),
        makeReq({ requestId: 'c', worktreeId: 'nobody-3' }),
      ]),
      postResultsFn: () => Promise.resolve(),
    })
    expect(listWorkspacesFn).toHaveBeenCalledTimes(1)
  })

  it('resolves callers from the pass view when one is given', async () => {
    const workspaces = vi.fn(() => Promise.resolve([makeCaller()]))
    const posted: SpawnResultWire[][] = []
    await reconcileSpawnRequests({
      // No listWorkspacesFn: the pass view wins over a view of its own, so
      // a leaked second listing would fail the caller lookup.
      fetchPendingFn: () => Promise.resolve([makeReq(), makeReq({ requestId: 'r2' })]),
      postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
    }, { ...snapshotFixture(), workspaces })
    expect(workspaces).toHaveBeenCalledTimes(1)
    expect(posted[0].every((r) => r.ok)).toBe(true)
  })

  it('skips the post when nothing is pending', async () => {
    const postResultsFn = vi.fn()
    await reconcileSpawnRequests({
      fetchPendingFn: () => Promise.resolve([]),
      postResultsFn,
    })
    expect(postResultsFn).not.toHaveBeenCalled()
  })

  it('never throws when the proxy fetch fails', async () => {
    await expect(reconcileSpawnRequests({
      fetchPendingFn: () => Promise.reject(new Error('tunnel down')),
    })).resolves.toBeUndefined()
  })
})

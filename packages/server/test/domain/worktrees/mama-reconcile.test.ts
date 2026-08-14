import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MamaCaller, MamaOutcome, MamaRequestInput } from '#domain/worktrees/mama'

vi.mock('#domain/worktrees/mama', () => ({ runMamaCommand: vi.fn() }))
import { runMamaCommand } from '#domain/worktrees/mama'
import type { PendingMamaRequest, MamaResultWire } from '@yaac/shared/types'
import type { RuntimeHandle } from '#drivers/contract'
import { handleFixture, snapshotFixture } from '@yaac/test-utils/fake-driver'
import { reconcileMamaRequests } from '#domain/worktrees/mama-reconcile'

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

function makeReq(over: Partial<PendingMamaRequest> = {}): PendingMamaRequest {
  return {
    requestId: 'req-1',
    worktreeId: 'caller-session',
    command: 'create',
    args: {},
    body: 'write the report',
    ...over,
  }
}

/** Who the drain said was calling, and what it handed over. Nothing about a
 *  command's MEANING is decided on this side, so the handler seam is the
 *  whole of what these tests assert against. */
const handled: Array<{ caller: MamaCaller; request: MamaRequestInput }> = []
let answer: MamaOutcome = { ok: true, output: 'minted-id' }

beforeEach(() => {
  handled.length = 0
  answer = { ok: true, output: 'minted-id' }
  vi.mocked(runMamaCommand).mockImplementation((caller, request) => {
    handled.push({ caller, request })
    return Promise.resolve(answer)
  })
})

/** Drain exactly one request and hand back what was posted for it. The
 *  per-request path has no entry point of its own — a drain is the only way
 *  in, which is also the only way a request reaches it. */
async function drainOne(
  req: PendingMamaRequest,
  pods: () => Promise<RuntimeHandle[]>,
): Promise<MamaResultWire> {
  const posted: MamaResultWire[][] = []
  await reconcileMamaRequests({
    listWorkspacesFn: pods,
    fetchPendingFn: () => Promise.resolve([req]),
    postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
  })
  return posted[0][0]
}

describe('reconcileMamaRequests', () => {
  it('hands over the caller resolved from the listing and relays the output', async () => {
    const result = await drainOne(makeReq(), () => Promise.resolve([makeCaller()]))
    expect(result).toEqual({ requestId: 'req-1', ok: true, output: 'minted-id' })
    expect(handled).toEqual([{
      caller: {
        workspaceId: 'caller-session',
        projectSlug: 'proj',
        tool: 'codex',
      },
      request: { command: 'create', args: {}, body: 'write the report' },
    }])
  })

  it('passes the command and its options through without judging them', async () => {
    // Which commands exist at all is the handler's; the drain carries
    // whatever arrived, so an unknown one reaches the one place that refuses
    // it rather than being silently dropped here.
    await drainOne(
      makeReq({ command: 'not-a-command', args: { tool: 'not-a-tool' } }),
      () => Promise.resolve([makeCaller()]),
    )
    expect(handled[0].request).toMatchObject({
      command: 'not-a-command',
      args: { tool: 'not-a-tool' },
    })
  })

  it('tolerates an envelope missing its optional halves', async () => {
    // Off a wire, so args/body can be absent however the type reads.
    const bare = { requestId: 'req-1', worktreeId: 'caller-session', command: 'list' }
    await drainOne(bare as PendingMamaRequest, () => Promise.resolve([makeCaller()]))
    expect(handled[0].request).toEqual({ command: 'list', args: {}, body: '' })
  })

  // A caller running something yaac does not know says nothing about what a
  // spawned workspace should run, and reporting a guess would outrank the
  // server's own configured default.
  it('omits the caller tool when the caller declares something else', async () => {
    const caller = makeCaller()
    delete caller.declaredTool
    await drainOne(makeReq(), () => Promise.resolve([caller]))
    expect(handled[0].caller.tool).toBeUndefined()
  })

  it('relays the handler’s refusal back to the caller', async () => {
    answer = { ok: false, error: 'too many concurrent spawns' }
    const result = await drainOne(makeReq(), () => Promise.resolve([makeCaller()]))
    expect(result).toEqual({
      requestId: 'req-1', ok: false, error: 'too many concurrent spawns',
    })
  })

  // The one judgement this side makes: a request from a worktree the runtime
  // does not report cannot be attributed to a project.
  it('rejects a caller the runtime does not report, without running anything', async () => {
    const result = await drainOne(makeReq(), () => Promise.resolve([]))
    expect(result).toEqual({ requestId: 'req-1', ok: false, error: 'calling worktree not found' })
    expect(handled).toEqual([])
  })

  it('fails soft when the workspace listing throws', async () => {
    const result = await drainOne(makeReq(), () => Promise.reject(new Error('apiserver down')))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('apiserver down')
    expect(handled).toEqual([])
  })

  it('drains, answers, and posts one result per request', async () => {
    const posted: MamaResultWire[][] = []
    await reconcileMamaRequests({
      listWorkspacesFn: () => Promise.resolve([makeCaller()]),
      fetchPendingFn: () => Promise.resolve([
        makeReq({ requestId: 'a' }),
        makeReq({ requestId: 'b', worktreeId: 'nobody' }),
      ]),
      postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toEqual([
      { requestId: 'a', ok: true, output: 'minted-id' },
      { requestId: 'b', ok: false, error: 'calling worktree not found' },
    ])
  })

  it('lists workspaces once per drain, not once per request', async () => {
    const listWorkspacesFn = vi.fn(() => Promise.resolve([makeCaller()]))
    await reconcileMamaRequests({
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
    const posted: MamaResultWire[][] = []
    await reconcileMamaRequests({
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
    await reconcileMamaRequests({
      fetchPendingFn: () => Promise.resolve([]),
      postResultsFn,
    })
    expect(postResultsFn).not.toHaveBeenCalled()
  })

  it('never throws when the proxy fetch fails', async () => {
    await expect(reconcileMamaRequests({
      fetchPendingFn: () => Promise.reject(new Error('tunnel down')),
    })).resolves.toBeUndefined()
  })
})

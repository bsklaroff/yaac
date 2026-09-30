import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MamaCaller, MamaOutcome, MamaRequestInput } from '#domain/workspaces/mama'

vi.mock('#domain/workspaces/mama', () => ({ runMamaCommand: vi.fn() }))
import { runMamaCommand } from '#domain/workspaces/mama'
import type { PendingMamaRequest, MamaResultWire } from '@yaac/shared/types'
import type { RuntimeHandle } from '#drivers/contract'
import { handleFixture, snapshotFixture } from '@yaac/test-utils/fake-driver'
import { reconcileMamaRequests } from '#domain/workspaces/mama-reconcile'

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
    workspaceId: 'caller-session',
    command: 'create',
    args: {},
    body: 'write the report',
    ...over,
  }
}

/** Each caller and request the drain passed to runMamaCommand. The drain does
 *  not interpret commands, so the tests assert only on what it hands over. */
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

/** Drain exactly one request and return the result posted for it. */
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
    // The handler decides which commands exist, so an unknown one must
    // reach it to be refused rather than be dropped here.
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
    // The request comes off the wire, so args/body may be missing.
    const bare = { requestId: 'req-1', workspaceId: 'caller-session', command: 'list' }
    await drainOne(bare as PendingMamaRequest, () => Promise.resolve([makeCaller()]))
    expect(handled[0].request).toEqual({ command: 'list', args: {}, body: '' })
  })

  // A guessed tool would override the server's configured default for the
  // spawned workspace.
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

  // A request from a workspace the runtime does not report cannot be
  // attributed to a project.
  it('rejects a caller the runtime does not report, without running anything', async () => {
    const result = await drainOne(makeReq(), () => Promise.resolve([]))
    expect(result).toEqual({ requestId: 'req-1', ok: false, error: 'calling workspace not found' })
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
        makeReq({ requestId: 'b', workspaceId: 'nobody' }),
      ]),
      postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toEqual([
      { requestId: 'a', ok: true, output: 'minted-id' },
      { requestId: 'b', ok: false, error: 'calling workspace not found' },
    ])
  })

  it('lists workspaces once per drain, not once per request', async () => {
    const listWorkspacesFn = vi.fn(() => Promise.resolve([makeCaller()]))
    await reconcileMamaRequests({
      listWorkspacesFn,
      fetchPendingFn: () => Promise.resolve([
        makeReq({ requestId: 'a', workspaceId: 'nobody-1' }),
        makeReq({ requestId: 'b', workspaceId: 'nobody-2' }),
        makeReq({ requestId: 'c', workspaceId: 'nobody-3' }),
      ]),
      postResultsFn: () => Promise.resolve(),
    })
    expect(listWorkspacesFn).toHaveBeenCalledTimes(1)
  })

  it('resolves callers from the pass view when one is given', async () => {
    const workspaces = vi.fn(() => Promise.resolve([makeCaller()]))
    const posted: MamaResultWire[][] = []
    await reconcileMamaRequests({
      // No listWorkspacesFn: callers must resolve from the pass's listing,
      // since a fallback listing here would find nothing.
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

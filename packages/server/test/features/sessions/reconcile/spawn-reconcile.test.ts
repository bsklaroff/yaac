import { describe, it, expect, beforeEach, vi } from 'vitest'
import { listProvisioning, clearAllProvisioningForTests } from '#features/sessions/provisioning'
import type { PendingSpawn, SpawnResultWire } from '#features/sessions/egress/proxy-client'
import type { SessionPod } from '#platform/k8s/pods'
import type { TickSnapshot } from '#platform/k8s/tick-snapshot'
import type { SessionCreateOptions, SessionCreateResult } from '#features/sessions/create'
import {
  SPAWN_MAX_IN_FLIGHT_PER_SESSION,
  SPAWN_MAX_PROMPT_CHARS,
  handleSpawnRequest,
  reconcileSpawnRequests,
} from '#features/sessions/reconcile/spawn-reconcile'

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

type CreateSessionFn = (slug: string, opts: SessionCreateOptions) => Promise<SessionCreateResult>

/** Deps resolving the caller pod with a controllable createSession. */
function makeDeps(over: Parameters<typeof handleSpawnRequest>[1] = {}): {
  deps: NonNullable<Parameters<typeof handleSpawnRequest>[1]>
  createSessionFn: ReturnType<typeof vi.fn<CreateSessionFn>>
} {
  const createSessionFn = vi.fn<CreateSessionFn>().mockResolvedValue({
    sessionId: 'ignored', jobName: 'j', forwardedPorts: [], tool: 'claude',
  } as SessionCreateResult)
  return {
    deps: {
      listSessionPodsFn: () => Promise.resolve([makePod()]),
      getDefaultToolFn: () => Promise.resolve(undefined),
      createSessionFn,
      ...over,
    },
    createSessionFn,
  }
}

/** Let detached createSession .then/.finally chains settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  clearAllProvisioningForTests()
})

describe('handleSpawnRequest', () => {
  it('spawns in the caller project with the minted id and returns ok', async () => {
    const { deps, createSessionFn } = makeDeps({ mintIdFn: () => 'minted-id' })
    const result = await handleSpawnRequest(makeReq(), deps)
    expect(result).toEqual({ requestId: 'req-1', ok: true, sessionId: 'minted-id' })
    expect(createSessionFn).toHaveBeenCalledWith('proj', {
      tool: 'codex', // the caller's own tool, absent an explicit request
      initialPrompt: 'write the report',
      sessionId: 'minted-id',
      onProgress: expect.any(Function) as (message: string) => void,
    })
    await settle()
  })

  it('provisions under a sidebar row: registered on spawn, dropped on success', async () => {
    let rowDuringCreate: ReturnType<typeof listProvisioning>[number] | undefined
    const { deps } = makeDeps({
      mintIdFn: () => 'minted-id',
      createSessionFn: vi.fn().mockImplementation((_slug, opts: SessionCreateOptions) => {
        opts.onProgress?.('Creating job...')
        rowDuringCreate = listProvisioning().find((p) => p.sessionId === 'minted-id')
        return Promise.resolve({ sessionId: 'minted-id', jobName: 'j', forwardedPorts: [], tool: 'codex' })
      }),
    })
    expect((await handleSpawnRequest(makeReq(), deps)).ok).toBe(true)
    expect(rowDuringCreate).toMatchObject({
      sessionId: 'minted-id',
      projectSlug: 'proj',
      tool: 'codex',
      kind: 'create',
      message: 'Creating job...',
    })
    await settle()
    expect(listProvisioning()).toEqual([])
  })

  it('keeps a failed row (dismissable) when the detached create rejects', async () => {
    const { deps } = makeDeps({
      mintIdFn: () => 'minted-id',
      createSessionFn: vi.fn().mockRejectedValue(new Error('image build exploded')),
    })
    expect((await handleSpawnRequest(makeReq(), deps)).ok).toBe(true)
    await settle()
    expect(listProvisioning()[0]).toMatchObject({
      sessionId: 'minted-id',
      error: 'image build exploded',
    })
  })

  it('prefers an explicitly requested tool over the caller tool', async () => {
    const { deps, createSessionFn } = makeDeps()
    const result = await handleSpawnRequest(makeReq({ tool: 'opencode' }), deps)
    expect(result.ok).toBe(true)
    expect(createSessionFn.mock.calls[0][1].tool).toBe('opencode')
    await settle()
  })

  it('falls back to the configured default, then claude, for an unknown caller tool', async () => {
    const withDefault = makeDeps({
      listSessionPodsFn: () => Promise.resolve([makePod({ tool: 'bogus' })]),
      getDefaultToolFn: () => Promise.resolve('pi' as const),
    })
    const r1 = await handleSpawnRequest(makeReq(), withDefault.deps)
    expect(r1.ok).toBe(true)
    expect(withDefault.createSessionFn.mock.calls[0][1].tool).toBe('pi')

    const noDefault = makeDeps({
      listSessionPodsFn: () => Promise.resolve([makePod({ tool: 'bogus' })]),
    })
    const r2 = await handleSpawnRequest(makeReq(), noDefault.deps)
    expect(r2.ok).toBe(true)
    expect(noDefault.createSessionFn.mock.calls[0][1].tool).toBe('claude')
    await settle()
  })

  it('threads a model override into the create', async () => {
    const { deps, createSessionFn } = makeDeps({ mintIdFn: () => 'minted-id' })
    const result = await handleSpawnRequest(
      makeReq({ tool: 'claude', model: 'claude-opus-4-8' }), deps,
    )
    expect(result.ok).toBe(true)
    expect(createSessionFn).toHaveBeenCalledWith('proj', {
      tool: 'claude',
      initialPrompt: 'write the report',
      sessionId: 'minted-id',
      model: 'claude-opus-4-8',
      onProgress: expect.any(Function) as (message: string) => void,
    })
    await settle()
  })

  it('threads a provider/model override for a non-claude tool', async () => {
    // No explicit tool: resolves to the caller's own tool (codex).
    const { deps, createSessionFn } = makeDeps({ mintIdFn: () => 'minted-id' })
    const result = await handleSpawnRequest(
      makeReq({ model: 'openai/gpt-5.2' }), deps,
    )
    expect(result.ok).toBe(true)
    expect(createSessionFn.mock.calls[0][1]).toMatchObject({
      tool: 'codex',
      model: 'openai/gpt-5.2',
    })
    await settle()
  })

  it('rejects a malformed model without creating', async () => {
    const { deps, createSessionFn } = makeDeps()
    const result = await handleSpawnRequest(
      makeReq({ tool: 'claude', model: "opus'; rm -rf /" }), deps,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('invalid model')
    expect(createSessionFn).not.toHaveBeenCalled()
  })

  it('rejects an invalid requested tool without creating', async () => {
    const { deps, createSessionFn } = makeDeps()
    const result = await handleSpawnRequest(makeReq({ tool: 'not-a-tool' }), deps)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not-a-tool')
    expect(createSessionFn).not.toHaveBeenCalled()
  })

  it('rejects empty and oversize prompts', async () => {
    const { deps, createSessionFn } = makeDeps()
    expect((await handleSpawnRequest(makeReq({ prompt: '  ' }), deps)).ok).toBe(false)
    const over = makeReq({ prompt: 'x'.repeat(SPAWN_MAX_PROMPT_CHARS + 1) })
    expect((await handleSpawnRequest(over, deps)).ok).toBe(false)
    expect(createSessionFn).not.toHaveBeenCalled()
  })

  it('rejects a caller with no live session pod', async () => {
    const { deps, createSessionFn } = makeDeps({
      listSessionPodsFn: () => Promise.resolve([]),
    })
    const result = await handleSpawnRequest(makeReq(), deps)
    expect(result).toEqual({ requestId: 'req-1', ok: false, error: 'calling session not found' })
    expect(createSessionFn).not.toHaveBeenCalled()
  })

  it('fails soft when pod listing throws', async () => {
    const { deps } = makeDeps({
      listSessionPodsFn: () => Promise.reject(new Error('apiserver down')),
    })
    const result = await handleSpawnRequest(makeReq(), deps)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('apiserver down')
  })

  it('caps concurrent in-flight creates per caller and releases on settle', async () => {
    // Use a dedicated caller id so leakage between tests is impossible.
    const sessionId = 'guarded-caller'
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { deps } = makeDeps({
      listSessionPodsFn: () => Promise.resolve([makePod({ sessionId })]),
      createSessionFn: vi.fn().mockImplementation(async () => {
        await gate
        return { sessionId: 'x', jobName: 'j', forwardedPorts: [], tool: 'claude' }
      }),
    })
    for (let i = 0; i < SPAWN_MAX_IN_FLIGHT_PER_SESSION; i++) {
      expect((await handleSpawnRequest(makeReq({ sessionId, requestId: `r${i}` }), deps)).ok).toBe(true)
    }
    const over = await handleSpawnRequest(makeReq({ sessionId, requestId: 'r-over' }), deps)
    expect(over.ok).toBe(false)
    expect(over.error).toContain('too many concurrent spawns')

    release()
    await settle()
    expect((await handleSpawnRequest(makeReq({ sessionId, requestId: 'r-after' }), deps)).ok).toBe(true)
    await settle()
  })

  it('releases the guard and stays ok when the detached create rejects', async () => {
    const sessionId = 'failing-caller'
    const { deps } = makeDeps({
      listSessionPodsFn: () => Promise.resolve([makePod({ sessionId })]),
      createSessionFn: vi.fn().mockRejectedValue(new Error('provision failed')),
    })
    // ok:true — the fire is already acked; the failure is a lost fire.
    expect((await handleSpawnRequest(makeReq({ sessionId }), deps)).ok).toBe(true)
    await settle()
    for (let i = 0; i < SPAWN_MAX_IN_FLIGHT_PER_SESSION; i++) {
      expect((await handleSpawnRequest(makeReq({ sessionId, requestId: `r${i}` }), deps)).ok).toBe(true)
      await settle()
    }
  })
})

describe('reconcileSpawnRequests', () => {
  it('does nothing when the proxy is not attachable', async () => {
    const fetchPendingFn = vi.fn()
    await reconcileSpawnRequests({
      attachIfRunningFn: () => Promise.resolve(false),
      fetchPendingFn,
    })
    expect(fetchPendingFn).not.toHaveBeenCalled()
  })

  it('drains, handles, and posts one result per request', async () => {
    const posted: SpawnResultWire[][] = []
    const { deps } = makeDeps({ mintIdFn: () => 'minted-id' })
    await reconcileSpawnRequests({
      ...deps,
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
    await settle()
  })

  it('lists session pods once per drain, not once per request', async () => {
    const listSessionPodsFn = vi.fn(() => Promise.resolve([makePod()]))
    const { deps } = makeDeps({ listSessionPodsFn, mintIdFn: () => 'minted-id' })
    await reconcileSpawnRequests({
      ...deps,
      attachIfRunningFn: () => Promise.resolve(true),
      fetchPendingFn: () => Promise.resolve([
        makeReq({ requestId: 'a', sessionId: 'nobody-1' }),
        makeReq({ requestId: 'b', sessionId: 'nobody-2' }),
        makeReq({ requestId: 'c', sessionId: 'nobody-3' }),
      ]),
      postResultsFn: () => Promise.resolve(),
    })
    expect(listSessionPodsFn).toHaveBeenCalledTimes(1)
    await settle()
  })

  it('resolves callers from the tick snapshot when one is given', async () => {
    const pods = vi.fn(() => Promise.resolve([makePod()]))
    const posted: SpawnResultWire[][] = []
    const { deps } = makeDeps({ mintIdFn: () => 'minted-id' })
    await reconcileSpawnRequests({
      ...deps,
      // Snapshot wins over the module-level kubectl list; makeDeps' stub is
      // dropped so a leaked direct listing would fail the caller lookup.
      listSessionPodsFn: undefined,
      attachIfRunningFn: () => Promise.resolve(true),
      fetchPendingFn: () => Promise.resolve([makeReq(), makeReq({ requestId: 'r2' })]),
      postResultsFn: (r) => { posted.push(r); return Promise.resolve() },
    }, { resync: true, pods } as unknown as TickSnapshot)
    expect(pods).toHaveBeenCalledTimes(1)
    expect(posted[0].every((r) => r.ok)).toBe(true)
    await settle()
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

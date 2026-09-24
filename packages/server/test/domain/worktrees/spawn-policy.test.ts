import { describe, it, expect, beforeEach, vi } from 'vitest'
import { listProvisioning, clearAllProvisioningForTests } from '#domain/worktrees/provisioning'
vi.mock('#domain/worktrees/create', () => ({ createWorktree: vi.fn() }))
import { createWorktree } from '#domain/worktrees/create'
import type { WorktreeCreateOptions, WorktreeCreateResult } from '#domain/worktrees/create'
import {
  SPAWN_MAX_IN_FLIGHT_PER_WORKTREE,
  SPAWN_MAX_PROMPT_CHARS,
  decideSpawn,
  type SpawnRequest,
} from '#domain/worktrees/spawn-policy'

type CreateFn = (slug: string, opts: WorktreeCreateOptions) => Promise<WorktreeCreateResult>

function makeRequest(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    requestId: 'req-1',
    callerWorkspaceId: 'caller-session',
    callerProjectSlug: 'proj',
    callerTool: 'codex',
    callerPermissionMode: 'bypass',
    prompt: 'write the report',
    ...over,
  }
}

/** Stub the create whose only job is to record what it was asked for. */
function stubCreate(impl?: CreateFn): ReturnType<typeof vi.mocked<typeof createWorktree>> {
  const create = vi.mocked(createWorktree)
  create.mockReset().mockImplementation(impl ?? (() => Promise.resolve({
    worktreeId: 'ignored', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
  } as WorktreeCreateResult)))
  return create
}

/** Let the detached create's .then/.finally chains settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  clearAllProvisioningForTests()
  stubCreate()
})

describe('decideSpawn', () => {
  it('creates in the caller project with the minted id and returns ok', async () => {
    const create = stubCreate()
    const decision = await decideSpawn(makeRequest(), { mintIdFn: () => 'minted-id' })
    expect(decision).toEqual({ ok: true, workspaceId: 'minted-id' })
    // The exact options, so nothing identity-shaped can creep back in: a
    // spawn has no interactive caller to resolve one, which is the reason
    // the identity a worktree commits under is the server's own setting.
    expect(create).toHaveBeenCalledWith('proj', {
      tool: 'codex', // the caller's own tool, absent an explicit request
      initialPrompt: 'write the report',
      worktreeId: 'minted-id',
      mode: 'tui',
      permissionMode: 'bypass', // the caller's own posture, likewise
      onProgress: expect.any(Function) as (message: string) => void,
    })
    await settle()
  })

  it('provisions under a sidebar row: registered on spawn, dropped on success', async () => {
    let rowDuringCreate: ReturnType<typeof listProvisioning>[number] | undefined
    stubCreate((_slug, opts) => {
      opts.onProgress?.('Creating job...')
      rowDuringCreate = listProvisioning().find((p) => p.worktreeId === 'minted-id')
      return Promise.resolve({
        worktreeId: 'minted-id', jobName: 'j', forwardedPorts: [], tool: 'codex', mode: 'tui',
      } as WorktreeCreateResult)
    })
    expect((await decideSpawn(makeRequest(), { mintIdFn: () => 'minted-id' })).ok).toBe(true)
    expect(rowDuringCreate).toMatchObject({
      worktreeId: 'minted-id',
      projectSlug: 'proj',
      tool: 'codex',
      kind: 'create',
      message: 'Creating job...',
    })
    await settle()
    expect(listProvisioning()).toEqual([])
  })

  it('keeps a failed row (dismissable) when the detached create rejects', async () => {
    stubCreate(() => Promise.reject(new Error('image build exploded')))
    expect((await decideSpawn(makeRequest(), { mintIdFn: () => 'minted-id' })).ok).toBe(true)
    await settle()
    expect(listProvisioning()[0]).toMatchObject({
      worktreeId: 'minted-id',
      error: 'image build exploded',
    })
  })

  it('prefers an explicitly requested tool over the caller tool', async () => {
    const create = stubCreate()
    expect((await decideSpawn(makeRequest({ tool: 'opencode' }))).ok).toBe(true)
    expect(create.mock.calls[0][1].tool).toBe('opencode')
    await settle()
  })

  // The caller's tool is only reported when the substrate labelled it with one
  // yaac knows, so an unlabelled caller falls through to the agent its project
  // was last created with, and then to claude.
  it('falls back to the project\'s last agent, then claude, for an unknown caller tool', async () => {
    const withDefault = stubCreate()
    const lastToolFn = vi.fn(() => Promise.resolve<'pi'>('pi'))
    expect((await decideSpawn(
      makeRequest({ callerTool: undefined }),
      { lastToolFn },
    )).ok).toBe(true)
    expect(lastToolFn).toHaveBeenCalledWith(makeRequest().callerProjectSlug)
    expect(withDefault.mock.calls[0][1].tool).toBe('pi')
    await settle()

    const noDefault = stubCreate()
    expect((await decideSpawn(
      makeRequest({ callerTool: undefined }),
      { lastToolFn: () => Promise.resolve(undefined) },
    )).ok).toBe(true)
    expect(noDefault.mock.calls[0][1].tool).toBe('claude')
    await settle()
  })

  it('threads a model override into the create', async () => {
    const create = stubCreate()
    const decision = await decideSpawn(
      makeRequest({ tool: 'claude', model: 'claude-opus-4-8' }),
      { mintIdFn: () => 'minted-id' },
    )
    expect(decision.ok).toBe(true)
    expect(create).toHaveBeenCalledWith('proj', {
      tool: 'claude',
      initialPrompt: 'write the report',
      worktreeId: 'minted-id',
      model: 'claude-opus-4-8',
      mode: 'tui',
      permissionMode: 'bypass',
      onProgress: expect.any(Function) as (message: string) => void,
    })
    await settle()
  })

  it('threads a provider/model override for a non-claude tool', async () => {
    // No explicit tool: resolves to the caller's own tool (codex).
    const create = stubCreate()
    expect((await decideSpawn(makeRequest({ model: 'openai/gpt-5.2' }))).ok).toBe(true)
    expect(create.mock.calls[0][1]).toMatchObject({ tool: 'codex', model: 'openai/gpt-5.2' })
    await settle()
  })

  it('threads the UI mode and reference branch into the create', async () => {
    const create = stubCreate()
    expect((await decideSpawn(makeRequest({ mode: 'acp', branch: 'feature/x' }))).ok).toBe(true)
    expect(create.mock.calls[0][1]).toMatchObject({ mode: 'acp', branch: 'feature/x' })
    await settle()
  })

  it('inherits the caller\'s posture, stepping down to the most the tool has', async () => {
    const posture = async (over: Partial<SpawnRequest>): Promise<unknown> => {
      const create = stubCreate()
      const decision = await decideSpawn(makeRequest(over))
      await settle()
      return decision.ok ? create.mock.calls[0][1].permissionMode : decision
    }
    expect(await posture({ callerPermissionMode: 'auto' })).toBe('auto')
    // The headline case: a `plan` caller's sibling is `plan`, not the
    // driver's default (`bypass` in a container).
    expect(await posture({ callerPermissionMode: 'plan', tool: 'claude' })).toBe('plan')
    // opencode has no `auto`; the next one down is what it inherits.
    expect(await posture({ callerPermissionMode: 'auto', tool: 'opencode' })).toBe('accept-edits')
    // Stepping down never goes UP: codex's adapter has nothing at or below
    // `manual`, and pi has nothing below `bypass`, so both are refused.
    expect(await posture({ callerPermissionMode: 'manual', mode: 'acp' })).toEqual({
      ok: false,
      error: "codex has no permission mode under acp at or below this worktree's own ('manual')",
    })
    expect(await posture({ callerPermissionMode: 'plan', tool: 'pi' })).toMatchObject({ ok: false })
  })

  it('grants a named posture up to the caller\'s own, and refuses anything else loudly', async () => {
    const create = stubCreate()
    const at = (callerPermissionMode: SpawnRequest['callerPermissionMode'], permissionMode: string) =>
      decideSpawn(makeRequest({ callerPermissionMode, permissionMode }))

    expect((await at('accept-edits', 'accept-edits')).ok).toBe(true)
    expect((await at('accept-edits', 'manual')).ok).toBe(true)
    expect((await at('manual', 'plan')).ok).toBe(true)
    await settle()
    expect(create.mock.calls.map((c) => c[1].permissionMode)).toEqual(['accept-edits', 'manual', 'plan'])
    create.mockClear()

    // bypass > auto > accept-edits > manual > plan: anything left of the
    // caller's own is refused, never clamped.
    expect(await at('accept-edits', 'auto')).toEqual({
      ok: false,
      error: "permission mode 'auto' is more permissive than this worktree's own ('accept-edits'); "
        + 'a spawned worktree may be granted at most that (bypass > auto > accept-edits > manual > plan)',
    })
    for (const [caller, asked] of [['plan', 'bypass'], ['plan', 'manual'], ['manual', 'accept-edits'], ['auto', 'bypass']] as const) {
      expect((await at(caller, asked)).ok, `${caller} → ${asked}`).toBe(false)
    }
    // Within the ceiling but not a posture the tool has under that UI.
    expect(await decideSpawn(makeRequest({ permissionMode: 'plan', mode: 'acp' }))).toEqual({
      ok: false, error: "codex has no 'plan' permission mode under acp",
    })
    // A caller row holding a posture this build does not rank (written by
    // another build) cannot be compared, so it grants nothing — named or not.
    const unknown = 'dontAsk' as SpawnRequest['callerPermissionMode']
    for (const asked of ['bypass', 'plan', undefined]) {
      expect(await decideSpawn(makeRequest({
        callerPermissionMode: unknown, tool: 'claude', ...(asked !== undefined ? { permissionMode: asked } : {}),
      }))).toEqual({
        ok: false, error: "this worktree's recorded permission mode 'dontAsk' is not one this server knows",
      })
    }
    expect(await at('bypass', 'yolo')).toMatchObject({ ok: false, error: expect.stringContaining("invalid permission mode 'yolo'") as string })
    expect(await decideSpawn(makeRequest({ mode: 'gui' }))).toMatchObject({ ok: false })
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects a malformed model without creating', async () => {
    const create = stubCreate()
    const decision = await decideSpawn(makeRequest({ tool: 'claude', model: "opus'; rm -rf /" }))
    expect(decision).toEqual({ ok: false, error: "invalid model 'opus'; rm -rf /'" })
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects an invalid requested tool without creating', async () => {
    const create = stubCreate()
    const decision = await decideSpawn(makeRequest({ tool: 'not-a-tool' }))
    expect(decision.ok).toBe(false)
    expect(decision.ok ? '' : decision.error).toContain('not-a-tool')
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects empty and oversize prompts', async () => {
    const create = stubCreate()
    expect((await decideSpawn(makeRequest({ prompt: '  ' }))).ok).toBe(false)
    const over = makeRequest({ prompt: 'x'.repeat(SPAWN_MAX_PROMPT_CHARS + 1) })
    expect((await decideSpawn(over)).ok).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('caps concurrent in-flight creates per caller and releases on settle', async () => {
    // A dedicated caller id so leakage between tests is impossible.
    const callerWorkspaceId = 'guarded-caller'
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    stubCreate(async () => {
      await gate
      return {
        worktreeId: 'x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
      } as WorktreeCreateResult
    })
    for (let i = 0; i < SPAWN_MAX_IN_FLIGHT_PER_WORKTREE; i++) {
      expect((await decideSpawn(makeRequest({ callerWorkspaceId, requestId: `r${i}` }))).ok).toBe(true)
    }
    const over = await decideSpawn(makeRequest({ callerWorkspaceId, requestId: 'r-over' }))
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.error).toContain('too many concurrent spawns')

    release()
    await settle()
    expect((await decideSpawn(makeRequest({ callerWorkspaceId, requestId: 'r-after' }))).ok).toBe(true)
    await settle()
  })

  it('releases the guard and stays ok when the detached create rejects', async () => {
    const callerWorkspaceId = 'failing-caller'
    stubCreate(() => Promise.reject(new Error('provision failed')))
    // ok:true — the fire is already acked; the failure is a lost fire.
    expect((await decideSpawn(makeRequest({ callerWorkspaceId }))).ok).toBe(true)
    await settle()
    for (let i = 0; i < SPAWN_MAX_IN_FLIGHT_PER_WORKTREE; i++) {
      expect((await decideSpawn(makeRequest({ callerWorkspaceId, requestId: `r${i}` }))).ok).toBe(true)
      await settle()
    }
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type * as worktreesModule from '#features/worktrees'
import { listProvisioning, clearAllProvisioningForTests } from '#features/worktrees/provisioning'
vi.mock('#features/worktrees', async (importOriginal) => ({
  ...(await importOriginal<typeof worktreesModule>()),
  createWorktree: vi.fn(),
}))
import { createWorktree } from '#features/worktrees'
import type { WorktreeCreateOptions, WorktreeCreateResult } from '#features/worktrees/create'
import type { SpawnRequest } from '#server-link'
import {
  SPAWN_MAX_IN_FLIGHT_PER_SESSION,
  SPAWN_MAX_PROMPT_CHARS,
  decideSpawn,
} from '#main/spawn'

type CreateFn = (slug: string, opts: WorktreeCreateOptions) => Promise<WorktreeCreateResult>

function makeRequest(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    requestId: 'req-1',
    callerWorkspaceId: 'caller-session',
    callerProjectSlug: 'proj',
    callerTool: 'codex',
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
    expect(create).toHaveBeenCalledWith('proj', {
      tool: 'codex', // the caller's own tool, absent an explicit request
      initialPrompt: 'write the report',
      worktreeId: 'minted-id',
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
  // yaac knows, so an unlabelled caller falls through to the server's own
  // preference row, and then to claude.
  it('falls back to the configured default, then claude, for an unknown caller tool', async () => {
    const withDefault = stubCreate()
    expect((await decideSpawn(
      makeRequest({ callerTool: undefined }),
      { defaultToolFn: () => Promise.resolve('pi') },
    )).ok).toBe(true)
    expect(withDefault.mock.calls[0][1].tool).toBe('pi')
    await settle()

    const noDefault = stubCreate()
    expect((await decideSpawn(
      makeRequest({ callerTool: undefined }),
      { defaultToolFn: () => Promise.resolve(undefined) },
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
    for (let i = 0; i < SPAWN_MAX_IN_FLIGHT_PER_SESSION; i++) {
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
    for (let i = 0; i < SPAWN_MAX_IN_FLIGHT_PER_SESSION; i++) {
      expect((await decideSpawn(makeRequest({ callerWorkspaceId, requestId: `r${i}` }))).ok).toBe(true)
      await settle()
    }
  })
})

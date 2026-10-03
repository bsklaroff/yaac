import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type * as createModule from '#domain/workspaces/create'

// Only createWorkspace is stubbed; setup resolution, the provisioning row and
// the spare decision run for real.
vi.mock('#domain/workspaces/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorkspace: vi.fn(),
}))
import {
  createWorkspace,
  type WorkspaceCreateOptions,
  type WorkspaceCreateResult,
} from '#domain/workspaces/create'
import { clearAllProvisioningForTests, listProvisioning } from '#domain/workspaces/provisioning'
import {
  SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE,
  SPAWN_MAX_PROMPT_CHARS,
  decideSpawn,
  type SpawnRequest,
} from '#domain/workspaces/spawn-policy'
import { recordProject } from '#db/project-store'
import type { PermissionMode } from '@yaac/shared/types'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'

type CreateFn = (slug: string, opts: WorkspaceCreateOptions) => Promise<WorkspaceCreateResult>

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

/** Stub createWorkspace so it only records its arguments. */
function stubCreate(impl?: CreateFn): ReturnType<typeof vi.mocked<typeof createWorkspace>> {
  const create = vi.mocked(createWorkspace)
  create.mockReset().mockImplementation(impl ?? ((_slug, opts) => Promise.resolve({
    workspaceId: opts.workspaceId ?? 'minted', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
  } as WorkspaceCreateResult)))
  return create
}

/** What the detached creates were asked for, once `n` of them have been. */
async function createdWith(
  create: ReturnType<typeof stubCreate>,
  n = 1,
): Promise<WorkspaceCreateOptions[]> {
  await vi.waitFor(() => { expect(create.mock.calls.length).toBeGreaterThanOrEqual(n) })
  return create.mock.calls.map((c) => c[1])
}

/** Let the detached create's .then/.finally chains settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let tmpDir: string
const listSpares = vi.fn(() => Promise.resolve([]))

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installFakeWorkspaceDriver({ list: listSpares })
  listSpares.mockClear()
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
  clearAllProvisioningForTests()
  stubCreate()
})

afterEach(async () => {
  await settle()
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('decideSpawn', () => {
  it('creates in the caller project under the id it answers with, never a spare\'s', async () => {
    const create = stubCreate()
    const decision = await decideSpawn(makeRequest(), { mintIdFn: () => 'minted-id' })
    expect(decision).toEqual({ ok: true, workspaceId: 'minted-id' })
    const [opts] = await createdWith(create)
    expect(create.mock.calls[0][0]).toBe('proj')
    expect(opts).toMatchObject({
      workspaceId: 'minted-id',
      tool: 'codex', // the caller's tool, absent an explicit request
      initialPrompt: 'write the report',
      mode: 'acp',
      permissionMode: 'bypass', // the caller's permission mode, likewise
      model: FALLBACK_MODELS.codex,
    })
    // A claimed spare keeps its own id, so the id handed back to
    // `id=$(yaac-mama create …)` would name nothing.
    expect(listSpares).not.toHaveBeenCalled()
  })

  it('provisions under a sidebar row: registered on spawn, dropped on success', async () => {
    let rowDuringCreate: ReturnType<typeof listProvisioning>[number] | undefined
    stubCreate((_slug, opts) => {
      opts.onProgress?.('Creating job...')
      rowDuringCreate = listProvisioning().find((p) => p.workspaceId === 'minted-id')
      return Promise.resolve({
        workspaceId: 'minted-id', jobName: 'j', forwardedPorts: [], tool: 'codex', mode: 'tui',
      } as WorkspaceCreateResult)
    })
    expect((await decideSpawn(makeRequest(), { mintIdFn: () => 'minted-id' })).ok).toBe(true)
    // Registered before the answer returns, so the id resolves at once.
    expect(listProvisioning().map((p) => p.workspaceId)).toEqual(['minted-id'])
    await vi.waitFor(() => { expect(rowDuringCreate).toBeDefined() })
    expect(rowDuringCreate).toMatchObject({
      workspaceId: 'minted-id', projectSlug: 'proj', tool: 'codex', kind: 'create', message: 'Creating job...',
    })
    await vi.waitFor(() => { expect(listProvisioning()).toEqual([]) })
  })

  it('keeps a failed row (dismissable) when the detached create rejects', async () => {
    stubCreate(() => Promise.reject(new Error('image build exploded')))
    expect((await decideSpawn(makeRequest(), { mintIdFn: () => 'minted-id' })).ok).toBe(true)
    await vi.waitFor(() => {
      expect(listProvisioning()[0]).toMatchObject({ workspaceId: 'minted-id', error: 'image build exploded' })
    })
  })

  it('prefers an explicitly requested tool over the caller tool', async () => {
    const create = stubCreate()
    expect((await decideSpawn(makeRequest({ tool: 'opencode' }))).ok).toBe(true)
    expect((await createdWith(create))[0].tool).toBe('opencode')
    await settle()
  })

  // The caller's tool is reported only when it is one yaac knows. Otherwise
  // the project's last-used agent is used, then claude.
  it('falls back to the project\'s last agent, then claude, for an unknown caller tool', async () => {
    const withDefault = stubCreate()
    const lastToolFn = vi.fn(() => Promise.resolve<'pi'>('pi'))
    expect((await decideSpawn(
      makeRequest({ callerTool: undefined }),
      { lastToolFn },
    )).ok).toBe(true)
    expect(lastToolFn).toHaveBeenCalledWith(makeRequest().callerProjectSlug)
    expect((await createdWith(withDefault))[0].tool).toBe('pi')
    await settle()

    const noDefault = stubCreate()
    expect((await decideSpawn(
      makeRequest({ callerTool: undefined }),
      { lastToolFn: () => Promise.resolve(undefined) },
    )).ok).toBe(true)
    expect((await createdWith(noDefault))[0].tool).toBe('claude')
    await settle()
  })

  it('threads a model override into the create', async () => {
    const create = stubCreate()
    const decision = await decideSpawn(
      makeRequest({ tool: 'claude', model: 'claude-opus-4-8' }),
      { mintIdFn: () => 'minted-id' },
    )
    expect(decision.ok).toBe(true)
    expect((await createdWith(create))[0]).toMatchObject({ tool: 'claude', model: 'claude-opus-4-8' })
    await settle()
  })

  it('threads a provider/model override for a non-claude tool', async () => {
    // No explicit tool, so the caller's tool (codex) is used.
    const create = stubCreate()
    expect((await decideSpawn(makeRequest({ model: 'openai/gpt-5.2' }))).ok).toBe(true)
    expect((await createdWith(create))[0]).toMatchObject({ tool: 'codex', model: 'openai/gpt-5.2' })
    await settle()
  })

  it('threads the UI mode, reference branch and title into the create', async () => {
    const create = stubCreate()
    expect((await decideSpawn(makeRequest({ uiMode: 'acp', branch: 'feature/x', title: 'Port the lexer' }))).ok).toBe(true)
    expect((await createdWith(create))[0]).toMatchObject({ mode: 'acp', branch: 'feature/x', title: 'Port the lexer' })
    await settle()
  })

  it('defaults the UI mode to the caller\'s, else chat', async () => {
    const modeFor = async (over: Partial<SpawnRequest>): Promise<unknown> => {
      const create = stubCreate()
      expect((await decideSpawn(makeRequest(over))).ok).toBe(true)
      await settle()
      return (await createdWith(create))[0].mode
    }
    expect(await modeFor({ callerMode: 'tui' })).toBe('tui')
    expect(await modeFor({ callerMode: 'tui', uiMode: 'acp' })).toBe('acp')
    expect(await modeFor({})).toBe('acp')
  })

  it('inherits the caller\'s posture, stepping down to the most the tool has', async () => {
    const posture = async (over: Partial<SpawnRequest>): Promise<unknown> => {
      const create = stubCreate()
      const decision = await decideSpawn(makeRequest(over))
      await settle()
      return decision.ok ? (await createdWith(create))[0].permissionMode : decision
    }
    expect(await posture({ callerPermissionMode: 'auto' })).toBe('auto')
    // A `plan` caller's sibling is `plan`, not the driver's default.
    expect(await posture({ callerPermissionMode: 'plan', tool: 'claude' })).toBe('plan')
    // opencode has no `auto`, so it inherits the next mode down.
    expect(await posture({ callerPermissionMode: 'auto', tool: 'opencode' })).toBe('accept-edits')
    // codex has no `manual`, so it steps down to `read-only`, in chat too.
    expect(await posture({ callerPermissionMode: 'manual', uiMode: 'acp' })).toBe('read-only')
    // Never steps up: pi has nothing below `bypass`, so it is refused.
    expect(await posture({ callerPermissionMode: 'plan', tool: 'pi' })).toEqual({
      ok: false,
      error: "pi has no permission mode at or below this workspace's own ('plan')",
    })
  })

  it('grants a named posture up to the caller\'s own, and refuses anything else loudly', async () => {
    const create = stubCreate()
    const at = (callerPermissionMode: SpawnRequest['callerPermissionMode'], permissionMode: PermissionMode) =>
      decideSpawn(makeRequest({ tool: 'claude', callerPermissionMode, permissionMode }))

    expect((await at('accept-edits', 'accept-edits')).ok).toBe(true)
    expect((await at('accept-edits', 'manual')).ok).toBe(true)
    expect((await at('manual', 'plan')).ok).toBe(true)
    await settle()
    // Sorted, since the detached creates run in any order.
    expect((await createdWith(create, 3)).map((o) => o.permissionMode).sort())
      .toEqual(['accept-edits', 'manual', 'plan'])
    create.mockClear()

    // Anything more permissive than the caller's mode is refused, never
    // clamped.
    expect(await at('accept-edits', 'auto')).toEqual({
      ok: false,
      error: "permission mode 'auto' is more permissive than this workspace's own ('accept-edits'); "
        + 'a workspace it starts may be granted at most that '
        + '(bypass > auto > accept-edits > manual > plan = read-only)',
    })
    // plan and read-only rank equal, so either may be granted under the
    // other, whether named or inherited.
    expect(await decideSpawn(makeRequest({ callerPermissionMode: 'plan', permissionMode: 'read-only' })))
      .toMatchObject({ ok: true })
    expect(await at('read-only', 'plan')).toMatchObject({ ok: true })
    await createdWith(create, 2)
    create.mockClear()
    expect(await decideSpawn(makeRequest({ callerPermissionMode: 'plan' }))).toMatchObject({ ok: true })
    expect((await createdWith(create)).map((o) => o.permissionMode)).toEqual(['read-only'])
    create.mockClear()
    for (const [caller, asked] of [['plan', 'bypass'], ['plan', 'manual'], ['manual', 'accept-edits'], ['auto', 'bypass']] as const) {
      expect((await at(caller, asked)).ok, `${caller} → ${asked}`).toBe(false)
    }
    // Allowed by rank, but the tool lacks that mode.
    expect(await decideSpawn(makeRequest({ permissionMode: 'plan', uiMode: 'acp' }))).toEqual({
      ok: false, error: "codex has no 'plan' permission mode",
    })
    expect(await decideSpawn(makeRequest({ permissionMode: 'manual' }))).toEqual({
      ok: false, error: "codex has no 'manual' permission mode",
    })
    // A caller mode this build does not know (written by another build)
    // cannot be ranked, so nothing is granted.
    const unknown = 'dontAsk' as SpawnRequest['callerPermissionMode']
    for (const asked of ['bypass', 'plan', undefined] as const) {
      expect(await decideSpawn(makeRequest({
        callerPermissionMode: unknown, tool: 'claude', ...(asked !== undefined ? { permissionMode: asked } : {}),
      }))).toEqual({
        ok: false, error: "this workspace's recorded permission mode 'dontAsk' is not one this server knows",
      })
    }
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
    // A dedicated caller id keeps the in-flight count isolated.
    const callerWorkspaceId = 'guarded-caller'
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const create = stubCreate(async () => {
      await gate
      return {
        workspaceId: 'x', jobName: 'j', forwardedPorts: [], tool: 'claude', mode: 'tui',
      } as WorkspaceCreateResult
    })
    for (let i = 0; i < SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE; i++) {
      expect((await decideSpawn(makeRequest({ callerWorkspaceId, requestId: `r${i}` }))).ok).toBe(true)
    }
    const over = await decideSpawn(makeRequest({ callerWorkspaceId, requestId: 'r-over' }))
    expect(over.ok).toBe(false)
    expect(over.ok ? '' : over.error).toContain('too many concurrent spawns')

    await createdWith(create, SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE)
    release()
    await vi.waitFor(async () => {
      expect((await decideSpawn(makeRequest({ callerWorkspaceId, requestId: 'r-after' }))).ok).toBe(true)
    })
  })

  it('releases the guard and stays ok when the detached create rejects', async () => {
    const callerWorkspaceId = 'failing-caller'
    stubCreate(() => Promise.reject(new Error('provision failed')))
    // The spawn was already acknowledged, so the failure does not change ok.
    expect((await decideSpawn(makeRequest({ callerWorkspaceId }))).ok).toBe(true)
    await settle()
    for (let i = 0; i < SPAWN_MAX_IN_FLIGHT_PER_WORKSPACE; i++) {
      expect((await decideSpawn(makeRequest({ callerWorkspaceId, requestId: `r${i}` }))).ok).toBe(true)
      await settle()
    }
  })
})

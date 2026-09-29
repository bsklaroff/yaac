import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type * as createModule from '#domain/worktrees/create'
import type * as toolAuthModule from '@yaac/shared/tool-auth'

// Queueing composes real rows, real create resolution and the real launch
// path. The create itself is the boundary: past it lies the substrate, and
// what a queued launch hands it is what these assertions are about.
vi.mock('#domain/worktrees/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorktree: vi.fn(),
}))
// The host's tool credentials, read off disk: real unless a case says what
// the host is signed in with.
vi.mock('@yaac/shared/tool-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof toolAuthModule>()
  return { ...actual, loadToolAuthEntry: vi.fn(actual.loadToolAuthEntry) }
})

import { createWorktree, type WorktreeCreateResult } from '#domain/worktrees/create'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
import {
  discardQueuedWorktree,
  listHeldWorktrees,
  listQueuedWorktrees,
  queueWorktree,
  reconcileQueuedWorktrees,
  runQueuedWorktree,
  updateQueuedWorktree,
} from '#domain/worktrees'
import { clearQueuedLaunchesForTests } from '#domain/worktrees/queued-worktrees'
import {
  clearAllProvisioningForTests,
  listProvisioning,
  registerProvisioning,
} from '#domain/worktrees/provisioning'
import { applyWorktreeEvent, createWorktreeGroup, setWorktreeGroup } from '#db'
import {
  claimQueuedLaunch,
  failQueuedLaunch,
  getQueuedWorktreeRow,
  releaseQueuedWorktree,
} from '#db/queued-worktree-store'
import { recordProject } from '#db/project-store'
import { recordWorktreeCreated, recordWorktreeStopped } from '#db/worktree-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir, createTestRepo } from '@yaac/test-utils/setup'
import { installFakeWorktreeDriver, resetWorktreeDriver } from '@yaac/test-utils/fake-driver'
import { projectDir, repoDir } from '@yaac/shared/project-paths'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

const mockCreate = vi.mocked(createWorktree)
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installFakeWorktreeDriver()
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  await fs.mkdir(projectDir('proj'), { recursive: true })
  await createTestRepo(repoDir('proj'))
  await recordProject({ slug: 'proj', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' })
  mockCreate.mockReset().mockImplementation((_slug, opts) => Promise.resolve({
    worktreeId: opts.worktreeId ?? 'minted', jobName: 'j', forwardedPorts: [], tool: opts.tool ?? 'claude', mode: 'tui',
  } as WorktreeCreateResult))
})

afterEach(async () => {
  resetWorktreeDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A worktree as a create leaves it: a row, and its first conversation. */
async function worktree(
  worktreeId: string,
  over: {
    tool?: AgentTool
    model?: string
    mode?: AgentMode
    permissionMode?: PermissionMode
    baseBranch?: string | null
  } = {},
): Promise<void> {
  await recordWorktreeCreated({
    projectSlug: 'proj',
    worktreeId,
    permissionMode: over.permissionMode ?? 'auto',
    mode: over.mode ?? 'tui',
    ...(over.baseBranch !== null ? { baseBranch: over.baseBranch ?? 'develop' } : {}),
  })
  await applyWorktreeEvent({
    type: 'sessions-launched',
    projectSlug: 'proj',
    worktreeId,
    sessions: [{
      agentSessionId: worktreeId,
      tool: over.tool ?? 'claude',
      mode: over.mode ?? 'tui',
      model: over.model ?? 'claude-sonnet-5',
      firstPrompt: `founding ask of ${worktreeId}`,
    }],
  })
}

/** Wait for every detached launch to have reached the create. */
const launched = (n: number): Promise<void> =>
  vi.waitFor(() => { expect(mockCreate).toHaveBeenCalledTimes(n) })

/** Wait for a launch to have settled — its entry finished or put back. */
async function settled(id: string, gone: boolean): Promise<void> {
  await vi.waitFor(async () => {
    const row = await getQueuedWorktreeRow(id)
    expect(gone ? row : row?.launchWorktreeId).toBeUndefined()
  })
}


describe('queueWorktree', () => {
  it('stores every setting concrete, defaulted from the parent worktree', async () => {
    await worktree('parent-1', { tool: 'codex', model: 'gpt-5.5', permissionMode: 'accept-edits' })
    const entry = await queueWorktree('proj', { parent: 'parent-1', prompt: 'follow up' }, 'user')
    // The parent's current model, its posture, and its REFERENCE branch —
    // not its own agent branch.
    expect(entry).toMatchObject({
      parentWorktreeId: 'parent-1',
      tool: 'codex',
      model: 'gpt-5.5',
      mode: 'tui',
      permissionMode: 'accept-edits',
      branch: 'develop',
      prompt: 'follow up',
    })

    // A different tool takes the create defaults for that tool instead.
    const other = await queueWorktree('proj', { parent: 'parent', prompt: 'x', tool: 'claude' }, 'user')
    expect(other).toMatchObject({ tool: 'claude', model: FALLBACK_MODELS.claude, branch: 'develop' })
    // …and a prefix names the parent like an id does.
    expect(other.parentWorktreeId).toBe('parent-1')
  })

  it('stores a branch for a parent still provisioning and for one whose row predates it', async () => {
    // A worktree mid-create has its row but no conversation yet: its
    // provisioning row names the tool.
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'booting', permissionMode: 'bypass', baseBranch: 'main' })
    registerProvisioning({ worktreeId: 'booting', projectSlug: 'proj', tool: 'opencode', kind: 'create' })
    const early = await queueWorktree('proj', { parent: 'booting', prompt: 'x' }, 'user')
    expect(early).toMatchObject({ tool: 'opencode', permissionMode: 'bypass', branch: 'main' })
    expect(early.model).not.toBe('')

    // No recorded base: the project's reference branch, stored concretely.
    await worktree('old', { baseBranch: null })
    const fromOld = await queueWorktree('proj', { parent: 'old', prompt: 'x' }, 'user')
    expect(fromOld.branch).toMatch(/^(main|master)$/)
  })

  it('chains under an entry, defaulting from its stored settings', async () => {
    await worktree('top')
    const b = await queueWorktree('proj', { parent: 'top', prompt: 'b', tool: 'codex', branch: 'feature' }, 'user')
    const c = await queueWorktree('proj', { parent: b.id.slice(0, 8), prompt: 'c' }, 'user')
    expect(c).toMatchObject({ parentQueuedId: b.id, tool: 'codex', model: b.model, branch: 'feature' })
    expect(c.parentWorktreeId).toBeUndefined()
  })

  it('queues under a create still in flight, before its row exists, by its full id', async () => {
    // `id=$(yaac-mama create …); yaac-mama queue --worktree "$id"` — the id
    // is answered before the create has recorded anything.
    registerProvisioning({ worktreeId: 'spawned', projectSlug: 'proj', tool: 'codex', kind: 'create', branch: 'feature' })
    const entry = await queueWorktree('proj', { parent: 'spawned', prompt: 'x' }, 'user')
    expect(entry).toMatchObject({ parentWorktreeId: 'spawned', tool: 'codex', branch: 'feature' })
    expect((await listQueuedWorktrees())[0].orphaned).toBeUndefined()
    // Another project's create is not a parent here.
    registerProvisioning({ worktreeId: 'theirs', projectSlug: 'other', tool: 'codex', kind: 'create' })
    await expect(queueWorktree('proj', { parent: 'theirs', prompt: 'x' }, 'user'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('queues under a launching entry as a child of the worktree it is becoming', async () => {
    await worktree('top')
    const b = await queueWorktree('proj', { parent: 'top', prompt: 'b' }, 'user')
    await claimQueuedLaunch(b.id, 'becoming')
    const c = await queueWorktree('proj', { parent: b.id, prompt: 'c' }, 'user')
    expect(c).toMatchObject({ parentWorktreeId: 'becoming', tool: b.tool })
  })

  it('refuses no prompt, an unknown parent, and a posture the tool lacks', async () => {
    await worktree('p')
    await expect(queueWorktree('proj', { parent: 'p', prompt: '  ' }, 'user')).rejects.toThrow(/needs a prompt/)
    await expect(queueWorktree('proj', { parent: 'nope', prompt: 'x' }, 'user'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(queueWorktree('proj', { parent: 'p', prompt: 'x', tool: 'pi', permissionMode: 'plan' }, 'user'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses rather than stores an empty model when the catalog has none for the tool', async () => {
    await worktree('p')
    // Signed in with a provider the model catalog lists nothing for.
    vi.mocked(loadToolAuthEntry).mockResolvedValueOnce({ tool: 'opencode', opencodeProvider: 'nowhere' } as never)
    await expect(queueWorktree('proj', { parent: 'p', prompt: 'x', tool: 'opencode' }, 'user'))
      .rejects.toThrow(/no model is known for opencode; pick one/)
    // Naming one is the way out.
    vi.mocked(loadToolAuthEntry).mockResolvedValueOnce({ tool: 'opencode', opencodeProvider: 'nowhere' } as never)
    expect((await queueWorktree('proj', { parent: 'p', prompt: 'x', tool: 'opencode', model: 'nowhere/m' }, 'user')).model)
      .toBe('nowhere/m')
  })

  it('holds an agent to its own posture as the ceiling', async () => {
    await worktree('sibling', { permissionMode: 'bypass' })
    const ceiling = { ceiling: 'accept-edits' as const }
    // Inherited from a looser parent: stepped down to the caller's own.
    expect((await queueWorktree('proj', { parent: 'sibling', prompt: 'x' }, ceiling)).permissionMode)
      .toBe('accept-edits')
    // Asked for above it: refused.
    await expect(queueWorktree('proj', { parent: 'sibling', prompt: 'x', permissionMode: 'bypass' }, ceiling))
      .rejects.toThrow(/more permissive than this worktree's own/)
    // A tool with nothing at or below it: refused.
    await expect(queueWorktree('proj', { parent: 'sibling', prompt: 'x', tool: 'pi' }, ceiling))
      .rejects.toThrow(/pi has no permission mode/)
  })
})

describe('updateQueuedWorktree', () => {
  it('replaces what it names, re-resolving a new tool\'s model and posture', async () => {
    await worktree('p', { tool: 'claude', model: 'claude-sonnet-5', permissionMode: 'plan' })
    const entry = await queueWorktree('proj', { parent: 'p', prompt: 'x' }, 'user')
    expect(entry.permissionMode).toBe('plan')

    const edited = await updateQueuedWorktree(entry.id, { prompt: 'edited', branch: 'other' })
    expect(edited).toMatchObject({ prompt: 'edited', branch: 'other', model: 'claude-sonnet-5', permissionMode: 'plan' })

    const retooled = await updateQueuedWorktree(entry.id, { tool: 'codex' })
    expect(retooled).toMatchObject({ tool: 'codex', model: FALLBACK_MODELS.codex, prompt: 'edited' })
    expect(retooled.permissionMode).not.toBe('plan')
  })

  it('refuses a cycle, including one hidden behind a launching entry', async () => {
    await worktree('top')
    const q = await queueWorktree('proj', { parent: 'top', prompt: 'q' }, 'user')
    const e = await queueWorktree('proj', { parent: q.id, prompt: 'e' }, 'user')
    const c = await queueWorktree('proj', { parent: e.id, prompt: 'c' }, 'user')
    await expect(updateQueuedWorktree(q.id, { parent: c.id })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(updateQueuedWorktree(q.id, { parent: q.id })).rejects.toMatchObject({ code: 'VALIDATION' })

    // E launches as W: C now waits on W, and W is E, which waits on Q.
    await claimQueuedLaunch(e.id, 'w')
    await expect(updateQueuedWorktree(q.id, { parent: c.id })).rejects.toMatchObject({ code: 'VALIDATION' })
    // Mid-launch, E itself cannot be edited.
    await expect(updateQueuedWorktree(e.id, { prompt: 'x' })).rejects.toMatchObject({ code: 'CONFLICT' })

    // Two edits racing to close a cycle between them: one of them loses.
    await failQueuedLaunch(e.id, 'w', 'x')
    const x = await queueWorktree('proj', { parent: 'top', prompt: 'x' }, 'user')
    const y = await queueWorktree('proj', { parent: 'top', prompt: 'y' }, 'user')
    const raced = await Promise.allSettled([
      updateQueuedWorktree(x.id, { parent: y.id }),
      updateQueuedWorktree(y.id, { parent: x.id }),
    ])
    expect(raced.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])

    // A legal move takes the children along.
    await worktree('elsewhere')
    const moved = await updateQueuedWorktree(e.id, { parent: 'elsewhere' })
    expect(moved.parentWorktreeId).toBe('elsewhere')
    expect((await getQueuedWorktreeRow(c.id))?.parentQueuedId).toBe(e.id)
  })
})

describe('discardQueuedWorktree', () => {
  it('splices its children up to its own parent', async () => {
    await worktree('top')
    const a = await queueWorktree('proj', { parent: 'top', prompt: 'a' }, 'user')
    const b = await queueWorktree('proj', { parent: a.id, prompt: 'b' }, 'user')
    const c = await queueWorktree('proj', { parent: b.id, prompt: 'c' }, 'user')
    await discardQueuedWorktree(b.id)
    expect((await getQueuedWorktreeRow(c.id))?.parentQueuedId).toBe(a.id)
    await expect(discardQueuedWorktree(b.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await claimQueuedLaunch(a.id, 'w')
    await expect(discardQueuedWorktree(a.id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('runQueuedWorktree', () => {
  it('launches cold from the stored settings, in the parent\'s group as it is now', async () => {
    await worktree('p', { tool: 'codex', model: 'gpt-5.5', permissionMode: 'accept-edits' })
    const entry = await queueWorktree('proj', { parent: 'p', prompt: 'go' }, 'user')
    const child = await queueWorktree('proj', { parent: entry.id, prompt: 'after' }, 'user')
    // Moved after queueing: the child follows the parent.
    const group = await createWorktreeGroup('proj', 'review', null)
    await setWorktreeGroup('proj', 'p', group.groupId)

    const { worktreeId } = await runQueuedWorktree(entry.id)
    // A second press loses the claim.
    await expect(runQueuedWorktree(entry.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    await launched(1)
    expect(mockCreate.mock.calls[0]).toEqual(['proj', expect.objectContaining({
      worktreeId,
      tool: 'codex',
      model: 'gpt-5.5',
      permissionMode: 'accept-edits',
      branch: 'develop',
      initialPrompt: 'go',
      groupId: group.groupId,
    })])
    await settled(entry.id, true)
    // Its chain now waits on the worktree it became, and the parent keeps
    // running undisturbed.
    expect((await getQueuedWorktreeRow(child.id))?.parentWorktreeId).toBe(worktreeId)
  })

  it('keeps the prompt when the launch fails, and shows the error once, on the entry', async () => {
    await worktree('p')
    const entry = await queueWorktree('proj', { parent: 'p', prompt: 'go' }, 'user')
    const child = await queueWorktree('proj', { parent: entry.id, prompt: 'after' }, 'user')
    mockCreate.mockRejectedValue(new Error('image build exploded'))

    await runQueuedWorktree(entry.id)
    await settled(entry.id, false)
    expect(await getQueuedWorktreeRow(entry.id)).toMatchObject({ prompt: 'go', launchError: 'image build exploded' })
    expect((await getQueuedWorktreeRow(child.id))?.parentQueuedId).toBe(entry.id)
    // Not a second time as a failed provisioning row.
    expect(listProvisioning()).toEqual([])
  })
})

describe('listQueuedWorktrees', () => {
  it('hides a launching entry and flags one whose parent worktree is gone', async () => {
    await worktree('p')
    const a = await queueWorktree('proj', { parent: 'p', prompt: 'a' }, 'user')
    const b = await queueWorktree('proj', { parent: a.id, prompt: 'b' }, 'user')
    await claimQueuedLaunch(a.id, 'provisioning')
    // Its provisioning row stands in for it, and b nests under that.
    registerProvisioning({ worktreeId: 'provisioning', projectSlug: 'proj', tool: 'claude', kind: 'create' })
    let listed = await listQueuedWorktrees()
    expect(listed.map((e) => e.id)).toEqual([b.id])
    expect(listed[0].orphaned).toBeUndefined()

    // A released child whose launch failed under a worktree whose own create
    // failed: nothing left to nest under.
    clearAllProvisioningForTests()
    await releaseQueuedWorktree(b.id)
    await claimQueuedLaunch(b.id, 'b-launch')
    await failQueuedLaunch(b.id, 'b-launch', 'x')
    listed = await listQueuedWorktrees()
    expect(listed[0]).toMatchObject({ id: b.id, parentWorktreeId: 'provisioning', orphaned: true })
  })
})

describe('listHeldWorktrees', () => {
  it('lists a stopped worktree while entries still wait on it', async () => {
    await worktree('dead')
    await worktree('alive')
    await recordWorktreeStopped('proj', 'dead', { reason: 'oom' })
    const entry = await queueWorktree('proj', { parent: 'dead', prompt: 'x' }, 'user')
    await queueWorktree('proj', { parent: 'alive', prompt: 'y' }, 'user')

    expect(await listHeldWorktrees()).toEqual([expect.objectContaining({
      worktreeId: 'dead', tool: 'claude', prompt: 'founding ask of dead', deathReason: 'oom',
    })])
    await discardQueuedWorktree(entry.id)
    expect(await listHeldWorktrees()).toEqual([])
  })
})

describe('reconcileQueuedWorktrees', () => {
  it('puts an interrupted launch back with the error, whether or not its worktree came up', async () => {
    await worktree('p')
    const up = await queueWorktree('proj', { parent: 'p', prompt: 'up' }, 'user')
    const upChild = await queueWorktree('proj', { parent: up.id, prompt: 'after up' }, 'user')
    // What a server restart mid-launch leaves: a claim nothing is running.
    // Its workspace may well be live — but that says nothing about whether
    // the agent was started or the prompt typed, so it is not taken as done.
    await claimQueuedLaunch(up.id, 'came-up')

    await reconcileQueuedWorktrees()

    expect(await getQueuedWorktreeRow(up.id)).toMatchObject({
      prompt: 'up', launchError: expect.stringContaining('interrupted by a server restart') as string,
    })
    expect((await getQueuedWorktreeRow(up.id))?.launchWorktreeId).toBeUndefined()
    // Its children are back under it, and nothing was launched again.
    expect((await getQueuedWorktreeRow(upChild.id))?.parentQueuedId).toBe(up.id)
    await new Promise((r) => setTimeout(r, 10))
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('launches a release a restart lost, and leaves a stop-released chain\'s lower links waiting', async () => {
    await worktree('p')
    const a = await queueWorktree('proj', { parent: 'p', prompt: 'a' }, 'user')
    const b = await queueWorktree('proj', { parent: a.id, prompt: 'b' }, 'user')
    await releaseQueuedWorktree(a.id)

    await reconcileQueuedWorktrees()
    await launched(1)
    await settled(a.id, true)
    expect(mockCreate.mock.calls[0][1].initialPrompt).toBe('a')
    expect((await getQueuedWorktreeRow(b.id))?.releasedAt).toBeUndefined()

    // Nothing released, nothing to do.
    await reconcileQueuedWorktrees()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

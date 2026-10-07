import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type * as createModule from '#domain/workspaces/create'
import type * as toolAuthModule from '@yaac/shared/tool-auth'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const P = '83878c91-1713-4890-8e0f-e0fb97a8c47a'

// Rows, create resolution and the launch path are real. createWorkspace is
// stubbed, and the tests assert on what a queued launch passes to it.
vi.mock('#domain/workspaces/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorkspace: vi.fn(),
}))
// The host's tool credentials: real unless a case overrides them.
vi.mock('@yaac/shared/tool-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof toolAuthModule>()
  return { ...actual, loadToolAuthEntry: vi.fn(actual.loadToolAuthEntry) }
})

import { createWorkspace } from '#domain/workspaces/create'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
import {
  discardQueuedWorkspace,
  listHeldWorkspaces,
  listQueuedWorkspaces,
  queueWorkspace,
  reconcileQueuedWorkspaces,
  runQueuedWorkspace,
  updateQueuedWorkspace,
} from '#domain/workspaces'
import { clearQueuedLaunchesForTests } from '#domain/workspaces/queued-workspaces'
import {
  clearAllProvisioningForTests,
  listProvisioning,
  ProvisionStoppedError,
  registerProvisioning,
} from '#domain/workspaces/provisioning'
import { BUILT_IN_USER_ID, applyWorkspaceEvent, createWorkspaceGroup, listWorkspaceGroupRows, setWorkspaceGroup } from '#db'
import {
  claimQueuedLaunch,
  failQueuedLaunch,
  getQueuedWorkspaceRow,
  releaseQueuedWorkspace,
  setQueuedWorkspaceTitle,
} from '#db/queued-workspace-store'
import { recordProject } from '#db/project-store'
import { recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir, createTestRepo } from '@yaac/test-utils/setup'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '@yaac/test-utils/fake-driver'
import { projectDir, repoDir } from '@yaac/shared/project-paths'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const mockCreate = vi.mocked(createWorkspace)
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  installFakeWorkspaceDriver()
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  await fs.mkdir(projectDir(PROJ), { recursive: true })
  await createTestRepo(repoDir(PROJ))
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  // Record the row as the real create does; a launched entry has a foreign
  // key to it.
  mockCreate.mockReset().mockImplementation(async (projectId, opts) => {
    await recordWorkspaceCreated({ projectId: projectId, workspaceId: opts.workspaceId ?? 'minted' })
    return {
      workspaceId: opts.workspaceId ?? 'minted', jobName: 'j', forwardedPorts: [], tool: opts.tool ?? 'claude', mode: 'tui',
    }
  })
})

afterEach(async () => {
  resetWorkspaceDriver()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** A workspace as a create leaves it: a row, and its first conversation. */
async function workspace(
  workspaceId: string,
  over: {
    tool?: AgentTool
    model?: string
    mode?: AgentMode
    permissionMode?: PermissionMode
    baseBranch?: string | null
  } = {},
): Promise<void> {
  await recordWorkspaceCreated({
    projectId: PROJ,
    workspaceId,
    permissionMode: over.permissionMode ?? 'auto',
    mode: over.mode ?? 'tui',
    ...(over.baseBranch !== null ? { baseBranch: over.baseBranch ?? 'develop' } : {}),
  })
  await applyWorkspaceEvent({
    type: 'sessions-launched',
    projectId: PROJ,
    workspaceId,
    sessions: [{
      agentSessionId: workspaceId,
      tool: over.tool ?? 'claude',
      mode: over.mode ?? 'tui',
      model: over.model ?? 'claude-sonnet-5',
      firstPrompt: `founding ask of ${workspaceId}`,
    }],
  })
}

/** Wait for every detached launch to have reached the create. */
const launched = (n: number): Promise<void> =>
  vi.waitFor(() => { expect(mockCreate).toHaveBeenCalledTimes(n) })

/** Wait for a launch to have settled — its entry finished or put back. */
async function settled(id: string, gone: boolean): Promise<void> {
  await vi.waitFor(async () => {
    const row = await getQueuedWorkspaceRow(id)
    expect(gone ? row : row?.launchWorkspaceId).toBeUndefined()
  })
}


describe('queueWorkspace', () => {
  it('stores every setting concrete, defaulted from the parent workspace', async () => {
    await workspace('parent-1', { tool: 'codex', model: 'gpt-5.5', permissionMode: 'accept-edits' })
    const entry = await queueWorkspace(local, PROJ, { parent: 'parent-1', prompt: 'follow up' }, 'user')
    // The parent's current model, permission mode, and base branch (not
    // its agent branch).
    expect(entry).toMatchObject({
      parentWorkspaceId: 'parent-1',
      tool: 'codex',
      model: 'gpt-5.5',
      mode: 'tui',
      permissionMode: 'accept-edits',
      branch: 'develop',
      prompt: 'follow up',
    })

    // A different tool takes the create defaults for that tool instead,
    // bar the UI mode, which is not tool-specific.
    const other = await queueWorkspace(local, PROJ, { parent: 'parent', prompt: 'x', tool: 'claude' }, 'user')
    expect(other).toMatchObject({ tool: 'claude', model: FALLBACK_MODELS.claude, mode: 'tui', branch: 'develop' })
    // A prefix names the parent like an id does.
    expect(other.parentWorkspaceId).toBe('parent-1')
  })

  it('stores a branch for a parent still provisioning and for one whose row predates it', async () => {
    // Mid-create there is no conversation yet, so the provisioning row
    // supplies the tool.
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'booting', permissionMode: 'bypass', baseBranch: 'main' })
    registerProvisioning({ workspaceId: 'booting', projectId: PROJ, tool: 'opencode', kind: 'create' })
    const early = await queueWorkspace(local, PROJ, { parent: 'booting', prompt: 'x' }, 'user')
    expect(early).toMatchObject({ tool: 'opencode', permissionMode: 'bypass', branch: 'main' })
    expect(early.model).not.toBe('')

    // No recorded base: origin's default branch is stored.
    await workspace('old', { baseBranch: null })
    const fromOld = await queueWorkspace(local, PROJ, { parent: 'old', prompt: 'x' }, 'user')
    expect(fromOld.branch).toMatch(/^(main|master)$/)
  })

  it('chains under an entry, defaulting from its stored settings', async () => {
    await workspace('top')
    const b = await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'b', tool: 'codex', branch: 'feature' }, 'user')
    const c = await queueWorkspace(local, PROJ, { parent: b.id.slice(0, 8), prompt: 'c' }, 'user')
    expect(c).toMatchObject({ parentQueuedId: b.id, tool: 'codex', model: b.model, branch: 'feature' })
    expect(c.parentWorkspaceId).toBeUndefined()
  })

  it('takes its parent\'s group unless it names one, and keeps a title of its own', async () => {
    const review = await createWorkspaceGroup(PROJ, 'review', null)
    await createWorkspaceGroup(PROJ, OTHER, null)
    await workspace('top')
    await setWorkspaceGroup(PROJ, 'top', review.groupId)
    const b = await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'b', title: '  My   title ' }, 'user')
    expect(b).toMatchObject({ groupId: review.groupId, title: 'My title' })
    // Chained under an entry: that entry's group.
    const c = await queueWorkspace(local, PROJ, { parent: b.id, prompt: 'c', title: ' ' }, 'user')
    expect(c.groupId).toBe(review.groupId)
    expect(c.title).toBeUndefined()
    // A group given by name, or none; an unknown name creates the group.
    expect((await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'd', group: OTHER }, 'user')).groupId)
      .not.toBe(review.groupId)
    expect((await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'e', group: null }, 'user')).groupId)
      .toBeUndefined()
    const fresh = await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'f', group: 'Brand new' }, 'user')
    expect((await listWorkspaceGroupRows(PROJ)).find((g) => g.groupId === fresh.groupId)?.name).toBe('Brand new')
  })

  it('queues under a create still in flight, before its row exists, by its full id', async () => {
    // `id=$(yaac-mama create …); yaac-mama queue --parent-workspace "$id"`:
    // the id comes back before the create has recorded anything.
    registerProvisioning({ workspaceId: 'spawned', projectId: PROJ, tool: 'codex', kind: 'create', branch: 'feature' })
    const entry = await queueWorkspace(local, PROJ, { parent: 'spawned', prompt: 'x' }, 'user')
    expect(entry).toMatchObject({ parentWorkspaceId: 'spawned', tool: 'codex', branch: 'feature' })
    expect((await listQueuedWorkspaces())[0].orphaned).toBeUndefined()
    // Another project's create is not a parent here.
    registerProvisioning({ workspaceId: 'theirs', projectId: OTHER, tool: 'codex', kind: 'create' })
    await expect(queueWorkspace(local, PROJ, { parent: 'theirs', prompt: 'x' }, 'user'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('queues under a launching entry as a child of the workspace it is becoming', async () => {
    await workspace('top')
    const b = await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'b' }, 'user')
    await claimQueuedLaunch(b.id, 'becoming')
    const c = await queueWorkspace(local, PROJ, { parent: b.id, prompt: 'c' }, 'user')
    expect(c).toMatchObject({ parentWorkspaceId: 'becoming', tool: b.tool })
  })

  it('refuses no prompt, an unknown parent, and a posture the tool lacks', async () => {
    await workspace(P)
    await expect(queueWorkspace(local, PROJ, { parent: P, prompt: '  ' }, 'user')).rejects.toThrow(/needs a prompt/)
    await expect(queueWorkspace(local, PROJ, { parent: 'nope', prompt: 'x' }, 'user'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(queueWorkspace(local, PROJ, { parent: P, prompt: 'x', tool: 'pi', permissionMode: 'plan' }, 'user'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('refuses rather than stores an empty model when the catalog has none for the tool', async () => {
    await workspace(P)
    // Signed in with a provider the model catalog has no models for.
    vi.mocked(loadToolAuthEntry).mockResolvedValueOnce({ tool: 'opencode', opencodeProvider: 'nowhere' } as never)
    await expect(queueWorkspace(local, PROJ, { parent: P, prompt: 'x', tool: 'opencode' }, 'user'))
      .rejects.toThrow(/no model is known for opencode; pick one/)
    // Naming a model fixes it.
    vi.mocked(loadToolAuthEntry).mockResolvedValueOnce({ tool: 'opencode', opencodeProvider: 'nowhere' } as never)
    expect((await queueWorkspace(local, PROJ, { parent: P, prompt: 'x', tool: 'opencode', model: 'nowhere/m' }, 'user')).model)
      .toBe('nowhere/m')
  })

  it('holds an agent to its own posture as the ceiling', async () => {
    await workspace('sibling', { permissionMode: 'bypass' })
    const ceiling = { ceiling: 'accept-edits' as const }
    // Inherited from a more permissive parent: capped at the caller's mode.
    expect((await queueWorkspace(local, PROJ, { parent: 'sibling', prompt: 'x' }, ceiling)).permissionMode)
      .toBe('accept-edits')
    // Asking for more is refused.
    await expect(queueWorkspace(local, PROJ, { parent: 'sibling', prompt: 'x', permissionMode: 'bypass' }, ceiling))
      .rejects.toThrow(/more permissive than this workspace's own/)
    // A tool with no mode at or below it is refused.
    await expect(queueWorkspace(local, PROJ, { parent: 'sibling', prompt: 'x', tool: 'pi' }, ceiling))
      .rejects.toThrow(/pi has no permission mode/)
  })
})

describe('updateQueuedWorkspace', () => {
  it('replaces what it names, re-resolving a new tool\'s model and posture', async () => {
    await workspace(P, { tool: 'claude', model: 'claude-sonnet-5', permissionMode: 'plan' })
    const entry = await queueWorkspace(local, PROJ, { parent: P, prompt: 'x' }, 'user')
    expect(entry.permissionMode).toBe('plan')

    const edited = await updateQueuedWorkspace(local, entry.id, { prompt: 'edited', branch: OTHER }, 'user')
    expect(edited).toMatchObject({ prompt: 'edited', branch: OTHER, model: 'claude-sonnet-5', permissionMode: 'plan' })

    const retooled = await updateQueuedWorkspace(local, entry.id, { tool: 'codex' }, 'user')
    expect(retooled).toMatchObject({ tool: 'codex', model: FALLBACK_MODELS.codex, prompt: 'edited' })
    expect(retooled.permissionMode).not.toBe('plan')

    // A title and a group are kept until named, and a blank or null clears them.
    const group = await createWorkspaceGroup(PROJ, 'review', null)
    expect(await updateQueuedWorkspace(local, entry.id, { title: 'Named', group: 'review' }, 'user'))
      .toMatchObject({ title: 'Named', groupId: group.groupId })
    expect(await updateQueuedWorkspace(local, entry.id, { prompt: 'again' }, 'user'))
      .toMatchObject({ title: 'Named', groupId: group.groupId })
    const cleared = await updateQueuedWorkspace(local, entry.id, { title: '', group: null }, 'user')
    expect(cleared.title).toBeUndefined()
    expect(cleared.groupId).toBeUndefined()
  })

  it('refuses a cycle, including one hidden behind a launching entry', async () => {
    await workspace('top')
    const q = await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'q' }, 'user')
    const e = await queueWorkspace(local, PROJ, { parent: q.id, prompt: 'e' }, 'user')
    const c = await queueWorkspace(local, PROJ, { parent: e.id, prompt: 'c' }, 'user')
    await expect(updateQueuedWorkspace(local, q.id, { parent: c.id }, 'user')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(updateQueuedWorkspace(local, q.id, { parent: q.id }, 'user')).rejects.toMatchObject({ code: 'VALIDATION' })

    // E launches as W: C now waits on W, and W is E, which waits on Q.
    await claimQueuedLaunch(e.id, 'w')
    await expect(updateQueuedWorkspace(local, q.id, { parent: c.id }, 'user')).rejects.toMatchObject({ code: 'VALIDATION' })
    // Mid-launch, E itself cannot be edited.
    await expect(updateQueuedWorkspace(local, e.id, { prompt: 'x' }, 'user')).rejects.toMatchObject({ code: 'CONFLICT' })

    // Of two edits that together would close a cycle, one loses.
    await failQueuedLaunch(e.id, 'w', 'x')
    const x = await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'x' }, 'user')
    const y = await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'y' }, 'user')
    const raced = await Promise.allSettled([
      updateQueuedWorkspace(local, x.id, { parent: y.id }, 'user'),
      updateQueuedWorkspace(local, y.id, { parent: x.id }, 'user'),
    ])
    expect(raced.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])

    // A legal move takes the children along.
    await workspace('elsewhere')
    const moved = await updateQueuedWorkspace(local, e.id, { parent: 'elsewhere' }, 'user')
    expect(moved.parentWorkspaceId).toBe('elsewhere')
    expect((await getQueuedWorkspaceRow(c.id))?.parentQueuedId).toBe(e.id)
  })
})

describe('discardQueuedWorkspace', () => {
  it('splices its children up to its own parent', async () => {
    await workspace('top')
    const a = await queueWorkspace(local, PROJ, { parent: 'top', prompt: 'a' }, 'user')
    const b = await queueWorkspace(local, PROJ, { parent: a.id, prompt: 'b' }, 'user')
    const c = await queueWorkspace(local, PROJ, { parent: b.id, prompt: 'c' }, 'user')
    await discardQueuedWorkspace(local, b.id)
    expect((await getQueuedWorkspaceRow(c.id))?.parentQueuedId).toBe(a.id)
    await expect(discardQueuedWorkspace(local, b.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await claimQueuedLaunch(a.id, 'w')
    await expect(discardQueuedWorkspace(local, a.id)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('runQueuedWorkspace', () => {
  it('launches cold from the stored settings, in the group it was queued with', async () => {
    await workspace(P, { tool: 'codex', model: 'gpt-5.5', permissionMode: 'accept-edits' })
    const group = await createWorkspaceGroup(PROJ, 'review', null)
    await setWorkspaceGroup(PROJ, P, group.groupId)
    const entry = await queueWorkspace(local, PROJ, { parent: P, prompt: 'go', title: 'Named' }, 'user')
    const child = await queueWorkspace(local, PROJ, { parent: entry.id, prompt: 'after' }, 'user')
    // Moving the parent after queueing leaves the entry where it was filed.
    await setWorkspaceGroup(PROJ, P, null)

    const { workspaceId } = await runQueuedWorkspace(local, entry.id)
    // A second press loses the claim.
    await expect(runQueuedWorkspace(local, entry.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    await launched(1)
    expect(mockCreate.mock.calls[0]).toEqual([PROJ, expect.objectContaining({
      workspaceId,
      tool: 'codex',
      model: 'gpt-5.5',
      permissionMode: 'accept-edits',
      branch: 'develop',
      initialPrompt: 'go',
      title: 'Named',
      groupId: group.groupId,
    })])
    await settled(entry.id, true)
    // Its chain now waits on the new workspace; the parent keeps running.
    expect((await getQueuedWorkspaceRow(child.id))?.parentWorkspaceId).toBe(workspaceId)

    // With no user title, an entry launches with its generated title, which
    // also heads its provisioning row.
    await setQueuedWorkspaceTitle(child.id, 'after', 'Generated')
    expect((await listQueuedWorkspaces()).find((e) => e.id === child.id)?.generatedTitle).toBe('Generated')
    const create = mockCreate.getMockImplementation()!
    let rows: unknown[] = []
    mockCreate.mockImplementationOnce((projectId, opts) => {
      rows = listProvisioning()
      return create(projectId, opts)
    })
    await runQueuedWorkspace(local, child.id)
    await launched(2)
    expect(mockCreate.mock.calls[1][1]).toMatchObject({ initialPrompt: 'after', title: 'Generated' })
    expect(rows).toEqual([expect.objectContaining({ title: 'Generated' })])
  })

  it('keeps the prompt when the launch fails, and shows the error once, on the entry', async () => {
    await workspace(P)
    const entry = await queueWorkspace(local, PROJ, { parent: P, prompt: 'go' }, 'user')
    const child = await queueWorkspace(local, PROJ, { parent: entry.id, prompt: 'after' }, 'user')
    mockCreate.mockRejectedValue(new Error('image build exploded'))

    await runQueuedWorkspace(local, entry.id)
    await settled(entry.id, false)
    expect(await getQueuedWorkspaceRow(entry.id)).toMatchObject({ prompt: 'go', launchError: 'image build exploded' })
    expect((await getQueuedWorkspaceRow(child.id))?.parentQueuedId).toBe(entry.id)
    // The failure is not also shown as a provisioning row.
    expect(listProvisioning()).toEqual([])

    // A stop takes the same path but is no failure: the entry waits again
    // with no error to show.
    mockCreate.mockRejectedValue(new ProvisionStoppedError())
    await runQueuedWorkspace(local, entry.id)
    await settled(entry.id, false)
    expect((await getQueuedWorkspaceRow(entry.id))?.launchError).toBeUndefined()
    expect((await getQueuedWorkspaceRow(child.id))?.parentQueuedId).toBe(entry.id)
  })
})

describe('listQueuedWorkspaces', () => {
  it('hides a launching entry and flags one whose parent workspace is gone', async () => {
    await workspace(P)
    const a = await queueWorkspace(local, PROJ, { parent: P, prompt: 'a' }, 'user')
    const b = await queueWorkspace(local, PROJ, { parent: a.id, prompt: 'b' }, 'user')
    await claimQueuedLaunch(a.id, 'provisioning')
    // Its provisioning row stands in for it, and b nests under that.
    registerProvisioning({ workspaceId: 'provisioning', projectId: PROJ, tool: 'claude', kind: 'create' })
    let listed = await listQueuedWorkspaces()
    expect(listed.map((e) => e.id)).toEqual([b.id])
    expect(listed[0].orphaned).toBeUndefined()

    // A released child whose launch failed, under a parent whose create
    // failed, has nothing to nest under.
    clearAllProvisioningForTests()
    await releaseQueuedWorkspace(b.id)
    await claimQueuedLaunch(b.id, 'b-launch')
    await failQueuedLaunch(b.id, 'b-launch', 'x')
    listed = await listQueuedWorkspaces()
    expect(listed[0]).toMatchObject({ id: b.id, parentWorkspaceId: 'provisioning', orphaned: true })
  })
})

describe('listHeldWorkspaces', () => {
  it('lists a stopped workspace while entries still wait on it', async () => {
    await workspace('dead')
    await workspace('alive')
    await recordWorkspaceStopped(PROJ, 'dead', { reason: 'oom' })
    const entry = await queueWorkspace(local, PROJ, { parent: 'dead', prompt: 'x' }, 'user')
    await queueWorkspace(local, PROJ, { parent: 'alive', prompt: 'y' }, 'user')

    expect(await listHeldWorkspaces()).toEqual([expect.objectContaining({
      workspaceId: 'dead', tool: 'claude', prompt: 'founding ask of dead', deathReason: 'oom',
    })])
    await discardQueuedWorkspace(local, entry.id)
    expect(await listHeldWorkspaces()).toEqual([])
  })
})

describe('reconcileQueuedWorkspaces', () => {
  it('puts an interrupted launch back with the error, whether or not its workspace came up', async () => {
    await workspace(P)
    const up = await queueWorkspace(local, PROJ, { parent: P, prompt: 'up' }, 'user')
    const upChild = await queueWorkspace(local, PROJ, { parent: up.id, prompt: 'after up' }, 'user')
    // A server restart mid-launch leaves a stale claim. A live workspace does
    // not prove the agent started or got its prompt, so it is not done.
    await claimQueuedLaunch(up.id, 'came-up')

    await reconcileQueuedWorkspaces()

    expect(await getQueuedWorkspaceRow(up.id)).toMatchObject({
      prompt: 'up', launchError: expect.stringContaining('interrupted by a server restart') as string,
    })
    expect((await getQueuedWorkspaceRow(up.id))?.launchWorkspaceId).toBeUndefined()
    // Its children are back under it, and nothing was launched again.
    expect((await getQueuedWorkspaceRow(upChild.id))?.parentQueuedId).toBe(up.id)
    await new Promise((r) => setTimeout(r, 10))
    expect(mockCreate).not.toHaveBeenCalled()
  })

  // The backstop runs every resync, but only the first pass can tell a
  // claim a previous server left from one this process holds.
  it('puts back only the claims a previous server left', async () => {
    await workspace(P)
    await reconcileQueuedWorkspaces()
    const mine = await queueWorkspace(local, PROJ, { parent: P, prompt: 'mine' }, 'user')
    await claimQueuedLaunch(mine.id, 'launching-here')

    await reconcileQueuedWorkspaces()

    expect(await getQueuedWorkspaceRow(mine.id)).toMatchObject({ launchWorkspaceId: 'launching-here' })
    expect((await getQueuedWorkspaceRow(mine.id))?.launchError).toBeUndefined()
  })

  it('launches a release a restart lost, and leaves a stop-released chain\'s lower links waiting', async () => {
    await workspace(P)
    const a = await queueWorkspace(local, PROJ, { parent: P, prompt: 'a' }, 'user')
    const b = await queueWorkspace(local, PROJ, { parent: a.id, prompt: 'b' }, 'user')
    await releaseQueuedWorkspace(a.id)

    await reconcileQueuedWorkspaces()
    await launched(1)
    await settled(a.id, true)
    expect(mockCreate.mock.calls[0][1].initialPrompt).toBe('a')
    expect((await getQueuedWorkspaceRow(b.id))?.releasedAt).toBeUndefined()

    await reconcileQueuedWorkspaces()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

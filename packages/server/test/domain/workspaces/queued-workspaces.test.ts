import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type * as createModule from '#domain/workspaces/create'
import type * as generatedModule from '@yaac/shared/tool-providers.generated'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const OTHER = '795f3202-b17c-46bc-8d4b-771d8c6c9eaf'
const P = '83878c91-1713-4890-8e0f-e0fb97a8c47a'

// Rows, create resolution and the launch path are real. createWorkspace is
// stubbed, and the tests assert on what a queued launch passes to it.
vi.mock('#domain/workspaces/create', async (importOriginal) => ({
  ...(await importOriginal<typeof createModule>()),
  createWorkspace: vi.fn(),
}))
// The baked model catalog, with one provider's models gone, as when a
// catalog update drops a provider a user is still signed in with.
vi.mock('@yaac/shared/tool-providers.generated', async (importOriginal) => {
  const actual = await importOriginal<typeof generatedModule>()
  return { ...actual, MODELS_BY_PROVIDER: { ...actual.MODELS_BY_PROVIDER, neuralwatt: [] } }
})

import { createWorkspace } from '#domain/workspaces/create'
import {
  discardQueuedWorkspace,
  listHeldWorkspaces,
  listQueuedWorkspaces,
  queueWorkspace,
  resumeQueuedWorkspaces,
  runQueuedWorkspace,
  startScheduledWorkspaces,
  updateQueuedWorkspace,
} from '#domain/workspaces'
import { clearQueuedLaunchesForTests, startQueuedChildren } from '#domain/workspaces/queued-workspaces'
import {
  clearAllProvisioningForTests,
  listProvisioning,
  ProvisionStoppedError,
  registerProvisioning,
} from '#domain/workspaces/provisioning'
import {
  BUILT_IN_USER_ID,
  setTimeZone,
  setToolCredential,
  applyWorkspaceEvent,
  createWorkspaceGroup,
  listWorkspaceGroupRows,
  setWorkspaceGroup,
  setWorkspaceGroupLimit,
} from '#db'
import {
  claimQueuedLaunch,
  failQueuedLaunch,
  getQueuedWorkspaceRow,
  insertRoutineRun,
  releaseQueuedWorkspace,
  setQueuedWorkspaceTitle,
} from '#db/queued-workspace-store'
import { recordProject, recordProjectCreate } from '#db/project-store'
import { insertRoutine } from '#db/routine-store'
import { getProjectWorkspaceRows, recordWorkspaceCreated, recordWorkspaceStopped } from '#db/workspace-store'
import { closeDb } from '#db/client'
import { createTempDataDir, cleanupTempDir, createTestRepo } from '@yaac/test-utils/setup'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import { projectDir, repoDir } from '@yaac/shared/project-paths'
import { FALLBACK_MODELS } from '@yaac/shared/tool-providers'
import { EFFORTS } from '@yaac/shared/tool-providers.generated'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

/** The caller of every user-caused write here. */
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

const mockCreate = vi.mocked(createWorkspace)
let tmpDir: string

beforeEach(async () => {
  tmpDir = await createTempDataDir()
  // The runtime runs every workspace with no stop: the create is stubbed,
  // so a row is all a workspace here has.
  installFakeWorkspaceDriver({
    list: async (projectId) => [...(await getProjectWorkspaceRows(projectId ?? PROJ)).values()]
      .filter((r) => r.stoppedAt === undefined)
      .map((r) => handleFixture({ workspaceId: r.workspaceId, projectId: r.projectId })),
  })
  clearAllProvisioningForTests()
  clearQueuedLaunchesForTests()
  await fs.mkdir(projectDir(PROJ), { recursive: true })
  await createTestRepo(repoDir(PROJ))
  await recordProject({ id: PROJ, name: 'demo', remoteUrl: 'https://example.com/proj', addedAt: '2026-01-01T00:00:00.000Z' }, BUILT_IN_USER_ID)
  // Record the row as the real create does; a launched entry has a foreign
  // key to it.
  mockCreate.mockReset().mockImplementation(async (projectId, opts) => {
    await recordWorkspaceCreated({
      projectId: projectId, workspaceId: opts.workspaceId ?? 'minted', ...(opts.groupId !== undefined ? { groupId: opts.groupId } : {}),
    })
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

  // The parent's model is as its agent reported it, which anything in that
  // workspace can set: an agent could otherwise queue a child that launches
  // a command of its choosing.
  it("inherits only a launchable model from the parent's conversation", async () => {
    await workspace('hostile', { tool: 'claude', model: 'x; touch /tmp/pwned; #' })
    expect((await queueWorkspace(local, PROJ, { parent: 'hostile', prompt: 'x' }, 'user')).model)
      .toBe(FALLBACK_MODELS.claude)
    await workspace('long', { tool: 'claude', model: 'claude-opus-5-5[1m]' })
    expect((await queueWorkspace(local, PROJ, { parent: 'long', prompt: 'x' }, 'user')).model)
      .toBe('claude-opus-5-5[1m]')
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
    await setToolCredential(BUILT_IN_USER_ID, 'opencode', { kind: 'api-key', provider: 'neuralwatt', savedAt: 'x', apiKey: 'k' })
    await expect(queueWorkspace(local, PROJ, { parent: P, prompt: 'x', tool: 'opencode' }, 'user'))
      .rejects.toThrow(/no model is known for opencode; pick one/)
    // Naming a model fixes it.
    expect((await queueWorkspace(local, PROJ, { parent: P, prompt: 'x', tool: 'opencode', model: 'neuralwatt/m' }, 'user')).model)
      .toBe('neuralwatt/m')
  })

  it('starts at a time instead, read in the owner\'s zone, with the project\'s defaults and a timeout', async () => {
    await setTimeZone(BUILT_IN_USER_ID, 'America/New_York', true)
    const entry = await queueWorkspace(local, PROJ, { start: { at: '2099-03-04 09:30' }, prompt: 'later', timeout: 90 }, 'user')
    // 09:30 in New York, in March before the clocks change, is 14:30 UTC.
    expect(entry).toMatchObject({ startAt: '2099-03-04T14:30:00.000Z', timeoutMinutes: 90, tool: 'claude' })
    expect(entry.parentWorkspaceId ?? entry.parentQueuedId).toBeUndefined()
    expect(entry.groupId).toBeUndefined()
    const before = Date.now()
    const soon = await queueWorkspace(local, PROJ, { start: { inMinutes: 30 }, prompt: 'soon' }, 'user')
    expect(new Date(soon.startAt ?? '').getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000)
    // Chaining after a scheduled entry works as after any entry.
    expect((await queueWorkspace(local, PROJ, { parent: entry.id, prompt: 'after' }, 'user')).parentQueuedId).toBe(entry.id)

    await workspace(P)
    await expect(queueWorkspace(local, PROJ, { parent: P, start: { inMinutes: 5 }, prompt: 'x' }, 'user'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(queueWorkspace(local, PROJ, { prompt: 'x' }, 'user')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(queueWorkspace(local, PROJ, { start: { at: 'tomorrowish' }, prompt: 'x' }, 'user'))
      .rejects.toThrow(/not a start time/)
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

  // With no parent, it waits for room in its group (docs/workspace-groups.md).
  it('needs an existing group with a workspace limit, creating none', async () => {
    await createWorkspaceGroup(PROJ, 'open', null)
    await expect(queueWorkspace(local, PROJ, { prompt: 'go' }, 'user'))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/needs a group with a workspace limit.*Use create/) as string })
    await expect(queueWorkspace(local, PROJ, { prompt: 'go', group: 'nowhere' }, 'user'))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/no group "nowhere".*Use create/) as string })
    await expect(queueWorkspace(local, PROJ, { prompt: 'go', group: 'open' }, { ceiling: 'bypass' }))
      .rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/"open" has no workspace limit.*Use create/) as string })
    expect((await listWorkspaceGroupRows(PROJ)).map((g) => g.name)).toEqual(['open'])
  })

  it('defaults as a create does, waits while its group is full, and launches at once when it has room', async () => {
    await recordProjectCreate(PROJ, 'codex', { model: 'gpt-5.5', permissionMode: 'read-only' })
    const { groupId } = await createWorkspaceGroup(PROJ, 'workers', null)
    await setWorkspaceGroupLimit(PROJ, groupId, 1)
    await workspace(P, { tool: 'claude', permissionMode: 'auto' })
    await setWorkspaceGroup(PROJ, P, groupId)

    const entry = await queueWorkspace(local, PROJ, { prompt: 'wait', group: 'workers' }, 'user')
    // The project's remembered create settings, not any workspace's.
    expect(entry).toMatchObject({ tool: 'codex', model: 'gpt-5.5', permissionMode: 'read-only', groupId, waitingForRoom: true })
    expect(entry).not.toHaveProperty('parentWorkspaceId')
    expect(entry).not.toHaveProperty('parentQueuedId')
    expect(mockCreate).not.toHaveBeenCalled()

    // One slot frees with no trigger; the next queue fills it, oldest first.
    await setWorkspaceGroupLimit(PROJ, groupId, 2)
    const later = await queueWorkspace(local, PROJ, { prompt: 'later', group: groupId }, 'user')
    await launched(1)
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ initialPrompt: 'wait', groupId })
    await settled(entry.id, true)
    expect(await getQueuedWorkspaceRow(later.id)).toMatchObject({ prompt: 'later' })
  })
})

// docs/workspace-groups.md

describe('updateQueuedWorkspace', () => {
  it('lets an agent set or shorten a timeout, but not lengthen or clear one', async () => {
    await workspace(P, { permissionMode: 'accept-edits' })
    const entry = await queueWorkspace(local, PROJ, { parent: P, prompt: 'x', timeout: 60 }, 'user')
    const agent = { ceiling: 'accept-edits' as const }
    expect((await updateQueuedWorkspace(local, entry.id, { timeout: 30 }, agent)).timeoutMinutes).toBe(30)
    await expect(updateQueuedWorkspace(local, entry.id, { timeout: 90 }, agent)).rejects.toThrow(/only the user can give it longer/)
    await expect(updateQueuedWorkspace(local, entry.id, { timeout: null }, agent)).rejects.toThrow(/only the user/)
    expect((await updateQueuedWorkspace(local, entry.id, { timeout: null }, 'user')).timeoutMinutes).toBeUndefined()
  })

  it('replaces what it names, re-resolving a new tool\'s model and posture', async () => {
    await workspace(P, { tool: 'claude', model: 'claude-sonnet-5', permissionMode: 'plan' })
    const entry = await queueWorkspace(local, PROJ, { parent: P, prompt: 'x' }, 'user')
    expect(entry.permissionMode).toBe('plan')

    const edited = await updateQueuedWorkspace(local, entry.id, { prompt: 'edited', branch: OTHER }, 'user')
    expect(edited).toMatchObject({ prompt: 'edited', branch: OTHER, model: 'claude-sonnet-5', permissionMode: 'plan' })

    // A stored effort stays for a model that has it and is re-resolved for
    // one that does not (docs/effort-levels.md).
    expect((await updateQueuedWorkspace(local, entry.id, { effort: 'max', model: 'claude-opus-4-7' }, 'user')).effort)
      .toBe('max')
    expect((await updateQueuedWorkspace(local, entry.id, { model: 'claude-opus-4-6' }, 'user')).effort).toBe('max')
    expect(await updateQueuedWorkspace(local, entry.id, { model: 'claude-opus-4-5' }, 'user')).not.toHaveProperty('effort')
    await expect(updateQueuedWorkspace(local, entry.id, { effort: 'low' }, 'user')).rejects.toThrow(/no effort setting/)

    const retooled = await updateQueuedWorkspace(local, entry.id, { tool: 'codex' }, 'user')
    expect(retooled).toMatchObject({
      tool: 'codex', model: FALLBACK_MODELS.codex, prompt: 'edited', effort: EFFORTS.codex[FALLBACK_MODELS.codex].default,
    })
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

  it('needs a group with a workspace limit, and keeps checking one it moves to', async () => {
    const { groupId } = await createWorkspaceGroup(PROJ, 'workers', null)
    await setWorkspaceGroupLimit(PROJ, groupId, 1)
    await createWorkspaceGroup(PROJ, 'open', null)
    await workspace(P)
    await setWorkspaceGroup(PROJ, P, groupId)
    const entry = await queueWorkspace(local, PROJ, { parent: P, prompt: 'go', group: null }, 'user')

    await expect(updateQueuedWorkspace(local, entry.id, { parent: null }, 'user'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    const moved = await updateQueuedWorkspace(local, entry.id, { parent: null, group: 'workers' }, 'user')
    expect(moved).toMatchObject({ groupId, waitingForRoom: true })
    expect(moved).not.toHaveProperty('parentWorkspaceId')
    await expect(updateQueuedWorkspace(local, entry.id, { group: 'open' }, 'user'))
      .rejects.toMatchObject({ code: 'VALIDATION' })
    // Other edits leave it waiting where it is.
    expect(await updateQueuedWorkspace(local, entry.id, { prompt: 'go on' }, 'user')).toMatchObject({ groupId, prompt: 'go on' })
    expect(mockCreate).not.toHaveBeenCalled()
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
    expect(mockCreate.mock.calls[1][1]).toMatchObject({ initialPrompt: 'after', generatedTitle: 'Generated' })
    expect(mockCreate.mock.calls[1][1]).not.toHaveProperty('title')
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

  it('refuses while the group is at its workspace limit, leaving the entry as it was', async () => {
    const { groupId } = await createWorkspaceGroup(PROJ, 'workers', null)
    await setWorkspaceGroupLimit(PROJ, groupId, 1)
    await workspace(P)
    await setWorkspaceGroup(PROJ, P, groupId)
    const entry = await queueWorkspace(local, PROJ, { parent: P, prompt: 'go' }, 'user')

    await expect(runQueuedWorkspace(local, entry.id)).rejects.toMatchObject({
      code: 'CONFLICT', message: expect.stringMatching(/group "workers" is at its workspace limit of 1 \(running or starting\)/) as string,
    })
    expect((await getQueuedWorkspaceRow(entry.id))?.releasedAt).toBeUndefined()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('runQueuedWorkspace on a scheduled entry', () => {
  it('counts a routine\'s run from its tick, so a late run never outlives the next one', async () => {
    const routine = await insertRoutine(PROJ, {
      name: 'r', cron: '*/30 * * * *', timeZone: 'UTC', prompt: 'p', tool: 'claude', model: 'claude-sonnet-5',
      mode: 'tui', permissionMode: 'auto', branch: 'main', timeoutMinutes: 30,
    }, null)
    const settings = { prompt: 'late run', tool: 'claude', model: 'claude-sonnet-5', mode: 'tui', permissionMode: 'auto', branch: 'main' } as const
    const tick = new Date(Date.now() - 10 * 60_000)
    const run = await insertRoutineRun(routine.id, PROJ, tick, { ...settings, timeoutMinutes: 30 })
    await runQueuedWorkspace(local, run!.id)
    await launched(1)
    expect(mockCreate.mock.calls[0][1].deadline).toEqual(new Date(tick.getTime() + 30 * 60_000))

    // One whose window is already over says where a fresh run comes from.
    const stale = await insertRoutineRun(routine.id, PROJ, new Date(Date.now() - 60 * 60_000), { ...settings, timeoutMinutes: 30 })
    await runQueuedWorkspace(local, stale!.id)
    await settled(stale!.id, false)
    // Its window was its own timeout, not the next tick.
    expect((await getQueuedWorkspaceRow(stale!.id))?.launchError)
      .toBe('its timeout ran out before it could start; start a fresh run from the routine')
  })

  it('runs it early, counting its timeout from now rather than its start time', async () => {
    const entry = await queueWorkspace(local, PROJ, { start: { at: '2099-01-01T00:00Z' }, prompt: 'early', timeout: 60 }, 'user')
    const before = Date.now()
    await runQueuedWorkspace(local, entry.id)
    await launched(1)
    const deadline = mockCreate.mock.calls[0][1].deadline?.getTime() ?? 0
    expect(deadline).toBeGreaterThanOrEqual(before + 60 * 60_000)
    expect(deadline).toBeLessThan(before + 61 * 60_000)
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

describe('resumeQueuedWorkspaces', () => {
  it('resolves a launch a restart interrupted: launched if its workspace runs, else back with the error', async () => {
    await workspace(P)
    const up = await queueWorkspace(local, PROJ, { parent: P, prompt: 'up' }, 'user')
    const down = await queueWorkspace(local, PROJ, { parent: P, prompt: 'down' }, 'user')
    const downChild = await queueWorkspace(local, PROJ, { parent: down.id, prompt: 'after down' }, 'user')
    // A server restart mid-launch leaves stale claims. One whose workspace
    // got a row and runs is that workspace; launching again would start a
    // second beside it.
    await claimQueuedLaunch(up.id, 'came-up')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'came-up' })
    await claimQueuedLaunch(down.id, 'never-ran')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'never-ran' })
    installFakeWorkspaceDriver({
      find: (id) => Promise.resolve(id === 'came-up' ? handleFixture({ workspaceId: id, projectId: PROJ }) : undefined),
    })

    await resumeQueuedWorkspaces()

    expect(await getQueuedWorkspaceRow(up.id)).toBeUndefined()
    expect(await getQueuedWorkspaceRow(down.id)).toMatchObject({
      prompt: 'down', launchError: expect.stringContaining('interrupted by a server restart') as string,
    })
    expect((await getQueuedWorkspaceRow(down.id))?.launchWorkspaceId).toBeUndefined()
    // Its children are back under it, and nothing was launched again.
    expect((await getQueuedWorkspaceRow(downChild.id))?.parentQueuedId).toBe(down.id)
    await new Promise((r) => setTimeout(r, 10))
    expect(mockCreate).not.toHaveBeenCalled()
  })

  // docs/workspace-groups.md: only what the runtime runs holds a slot.
  it('leaves the half-made workspace of an interrupted launch holding no slot', async () => {
    await workspace(P)
    const { groupId } = await createWorkspaceGroup(PROJ, 'workers', null)
    const interrupted = await queueWorkspace(local, PROJ, { parent: P, prompt: 'was launching', group: groupId }, 'user')
    await claimQueuedLaunch(interrupted.id, 'half-made')
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'half-made', groupId })
    await setWorkspaceGroupLimit(PROJ, groupId, 1)
    // A restart: nothing of the half-made workspace runs.
    installFakeWorkspaceDriver({ list: () => Promise.resolve([]) })

    await resumeQueuedWorkspaces()
    const waiting = await queueWorkspace(local, PROJ, { prompt: 'waiting', group: groupId }, 'user')
    await launched(1)
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ initialPrompt: 'waiting', groupId })
    await settled(waiting.id, true)
  })

  // Requests are served before it runs, so a Run now can beat it.
  it('leaves a launch this server already started', async () => {
    await workspace(P)
    const mine = await queueWorkspace(local, PROJ, { parent: P, prompt: 'mine' }, 'user')
    const create = mockCreate.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mockCreate.mockImplementationOnce(async (projectId, opts) => { await gate; return create(projectId, opts) })
    const { workspaceId } = await runQueuedWorkspace(local, mine.id)
    await launched(1)

    await resumeQueuedWorkspaces()

    expect(await getQueuedWorkspaceRow(mine.id)).toMatchObject({ launchWorkspaceId: workspaceId })
    expect((await getQueuedWorkspaceRow(mine.id))?.launchError).toBeUndefined()
    release()
    await settled(mine.id, true)
  })

  // docs/workspace-groups.md
  it('fills the slots freed while no server ran, oldest first, never past the limit', async () => {
    const { groupId } = await createWorkspaceGroup(PROJ, 'workers', null)
    await setWorkspaceGroupLimit(PROJ, groupId, 2)
    for (const id of ['busy-1', 'busy-2']) await recordWorkspaceCreated({ projectId: PROJ, workspaceId: id, groupId })
    const entries = []
    for (const prompt of ['a', 'b', 'c']) entries.push(await queueWorkspace(local, PROJ, { prompt, group: groupId }, 'user'))
    // Stops no running server saw.
    await recordWorkspaceStopped(PROJ, 'busy-1')
    await recordWorkspaceStopped(PROJ, 'busy-2')

    await resumeQueuedWorkspaces()
    await launched(2)
    await settled(entries[0].id, true)
    await settled(entries[1].id, true)
    expect(mockCreate.mock.calls.map((c) => c[1].initialPrompt)).toEqual(['a', 'b'])
    expect(await getQueuedWorkspaceRow(entries[2].id)).toMatchObject({ prompt: 'c' })
  })

  it('launches a release a restart lost, and leaves a stop-released chain\'s lower links waiting', async () => {
    await workspace(P)
    const a = await queueWorkspace(local, PROJ, { parent: P, prompt: 'a' }, 'user')
    const b = await queueWorkspace(local, PROJ, { parent: a.id, prompt: 'b' }, 'user')
    await releaseQueuedWorkspace(a.id)

    await resumeQueuedWorkspaces()
    await launched(1)
    await settled(a.id, true)
    expect(mockCreate.mock.calls[0][1].initialPrompt).toBe('a')
    expect((await getQueuedWorkspaceRow(b.id))?.releasedAt).toBeUndefined()
  })
})

describe('startScheduledWorkspaces', () => {
  it('launches a scheduled entry once its time comes, its timeout counted from that time', async () => {
    const startAt = new Date(Date.now() - 5 * 60_000)
    const due = await queueWorkspace(local, PROJ, { start: { at: startAt.toISOString() }, prompt: 'due', timeout: 60 }, 'user')
    const later = await queueWorkspace(local, PROJ, { start: { inMinutes: 60 }, prompt: 'later' }, 'user')

    await startScheduledWorkspaces()
    await launched(1)
    await settled(due.id, true)
    expect(mockCreate.mock.calls[0][1]).toMatchObject({
      initialPrompt: 'due',
      deadline: new Date(startAt.getTime() + 60 * 60_000),
    })
    expect((await getQueuedWorkspaceRow(later.id))?.releasedAt).toBeUndefined()
  })

  it('fails a scheduled entry whose window passed or whose launch failed, and waits for the user', async () => {
    const gone = await queueWorkspace(local, PROJ,
      { start: { at: new Date(Date.now() - 2 * 3_600_000).toISOString() }, prompt: 'gone', timeout: 60 }, 'user')
    const broken = await queueWorkspace(local, PROJ, { start: { inMinutes: 1 }, prompt: 'broken' }, 'user')
    await updateQueuedWorkspace(local, broken.id, { start: { at: new Date(Date.now() - 60_000).toISOString() } }, 'user')
    mockCreate.mockRejectedValue(new Error('image build exploded'))

    await startScheduledWorkspaces()
    await settled(gone.id, false)
    await settled(broken.id, false)
    expect((await getQueuedWorkspaceRow(gone.id))?.launchError).toMatch(/window passed/)
    expect((await getQueuedWorkspaceRow(broken.id))?.launchError).toBe('image build exploded')
    // Only the broken one reached the create; neither is retried.
    expect(mockCreate).toHaveBeenCalledTimes(1)
    await startScheduledWorkspaces()
    await new Promise((r) => setTimeout(r, 10))
    expect(mockCreate).toHaveBeenCalledTimes(1)

    // A stopped launch is past its time too, so it also waits for the user.
    mockCreate.mockRejectedValue(new ProvisionStoppedError())
    await runQueuedWorkspace(local, broken.id)
    await settled(broken.id, false)
    expect((await getQueuedWorkspaceRow(broken.id))?.launchError).toMatch(/stopped before it started/)
  })

  it('launches a due entry only where its group has room, and never one not yet due as waiting for room', async () => {
    const { groupId } = await createWorkspaceGroup(PROJ, 'workers', null)
    await setWorkspaceGroupLimit(PROJ, groupId, 1)
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'busy', groupId })
    const due = await queueWorkspace(local, PROJ, { start: { at: new Date(Date.now() - 60_000).toISOString() }, prompt: 'due', group: groupId }, 'user')
    const later = await queueWorkspace(local, PROJ, { start: { inMinutes: 60 }, prompt: 'later', group: groupId }, 'user')
    expect((await listQueuedWorkspaces()).find((e) => e.id === later.id)?.waitingForRoom).toBeUndefined()

    await startScheduledWorkspaces()
    // Due, but its group is full: it waits for room, released.
    expect(await getQueuedWorkspaceRow(due.id)).toMatchObject({ releasedAt: expect.any(Date) as Date })
    expect(mockCreate).not.toHaveBeenCalled()
    await recordWorkspaceStopped(PROJ, 'busy')
    await startQueuedChildren(PROJ, 'busy')
    await launched(1)
    expect(mockCreate.mock.calls[0][1].initialPrompt).toBe('due')
    expect((await getQueuedWorkspaceRow(later.id))?.releasedAt).toBeUndefined()
  })
})

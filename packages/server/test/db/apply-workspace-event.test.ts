import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import {
  _resetPriorStopsForTests,
  applyWorkspaceEvent,
} from '#db/apply-workspace-event'
import {
  getProjectWorkspaceRows,
  recordWorkspaceCreated,
  setWorkspaceTitle,
} from '#db/workspace-store'
import { createWorkspaceGroup } from '#db/group-store'
import { listWorkspaceAgentSessions } from '#db/agent-session-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'

describe('applyWorkspaceEvent', () => {
  let tmpDir: string

  let pushes: number

  beforeEach(async () => {
    _resetPriorStopsForTests()
    _resetWorkspaceListChangedForTests()
    pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })
    tmpDir = await createTempDataDir()
    await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'wt-1' })
  })

  afterEach(async () => {
    _resetWorkspaceListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const rowOf = async (workspaceId: string) =>
    (await getProjectWorkspaceRows('proj')).get(workspaceId)

  const created = (workspaceId: string, extra = {}): Promise<void> =>
    applyWorkspaceEvent({
      type: 'workspace-created', projectSlug: 'proj', workspaceId, ...extra,
    })

  const stopped = (workspaceId: string, extra = {}): Promise<void> =>
    applyWorkspaceEvent({
      type: 'workspace-stopped', projectSlug: 'proj', workspaceId, ...extra,
    })

  const failed = (workspaceId: string, extra = {}): Promise<void> =>
    applyWorkspaceEvent({
      type: 'workspace-create-failed', projectSlug: 'proj', workspaceId, ...extra,
    })

  it('records a reported workspace, with the branch when the emitter knew it', async () => {
    await created('wt-new', { baseBranch: 'main' })

    expect(await rowOf('wt-new')).toMatchObject({
      projectSlug: 'proj', workspaceId: 'wt-new', baseBranch: 'main', deathSeen: false,
    })
  })

  // What its first agent launched with — the facts a spare claim matches on.
  it('records the launch it was created with', async () => {
    await created('wt-launch', { permissionMode: 'plan', model: 'claude-opus-5-5', mode: 'acp' })

    expect(await rowOf('wt-launch')).toMatchObject({
      permissionMode: 'plan', model: 'claude-opus-5-5', mode: 'acp',
    })
  })

  // The row is the posture the running agent is in: every reported move
  // lands, up or down, and a restart records what it relaunched in.
  it('follows a posture the agent moved to, either way', async () => {
    const moved = (permissionMode: 'bypass' | 'plan'): Promise<void> => applyWorkspaceEvent({
      type: 'permission-mode-changed', projectSlug: 'proj', workspaceId: 'wt-p', permissionMode,
    })
    const posture = async (): Promise<string | undefined> => (await rowOf('wt-p'))?.permissionMode
    await created('wt-p', { permissionMode: 'accept-edits', model: 'claude-opus-5-5', mode: 'tui' })

    await moved('plan')
    expect(await posture()).toBe('plan')
    await moved('bypass')
    expect(await posture()).toBe('bypass')

    // A restart relaunching in another posture (the row's, where this tool
    // lacks it) records the one it launched.
    await created('wt-p', { resume: true, permissionMode: 'plan' })
    expect(await posture()).toBe('plan')
    expect(await rowOf('wt-p')).toMatchObject({ model: 'claude-opus-5-5', mode: 'tui' })
  })

  // A workspace id is claimed once across all projects: otherwise a create
  // posting a live workspace's id could re-stamp it and then tear it down
  // as its own when the create failed.
  it('refuses a fresh create on a taken id, in this project or another, leaving the row be', async () => {
    await applyWorkspaceEvent({ type: 'base-branch-resolved', projectSlug: 'proj', workspaceId: 'wt-1', baseBranch: 'main' })
    await stopped('wt-1', { cause: { reason: 'oom' } })
    const before = await rowOf('wt-1')

    await expect(created('wt-1', { baseBranch: 'other' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(applyWorkspaceEvent({
      type: 'workspace-created', projectSlug: 'elsewhere', workspaceId: 'wt-1',
    })).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(await rowOf('wt-1')).toEqual(before)
    expect((await getProjectWorkspaceRows('elsewhere')).size).toBe(0)
  })

  it('re-stamps a resumed workspace\'s live fields, keeping what belongs to the workspace', async () => {
    await applyWorkspaceEvent({ type: 'base-branch-resolved', projectSlug: 'proj', workspaceId: 'wt-1', baseBranch: 'main' })
    await setWorkspaceTitle('proj', 'wt-1', 'my workspace')
    const group = await createWorkspaceGroup('proj', 'release', 'wt-1')
    await stopped('wt-1', { cause: { reason: 'oom', detail: 'exit code 137' } })
    const before = await rowOf('wt-1')

    await created('wt-1', { resume: true, permissionMode: 'plan' })

    expect(await rowOf('wt-1')).toMatchObject({
      createdAt: before?.createdAt,
      title: 'my workspace',
      groupId: group.groupId,
      baseBranch: 'main',
      permissionMode: 'plan',
      deathSeen: false,
    })
    const row = await rowOf('wt-1')
    expect(row?.stoppedAt).toBeUndefined()
    expect(row?.deathReason).toBeUndefined()
  })

  // A stop keeps its row, so only a pod yaac has no record of (a reset or
  // restored DB) can reach a resume without one — and minting a row for it
  // would be making a record up.
  it('refuses to resume a workspace with no row', async () => {
    await expect(created('wt-ghost', { resume: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await rowOf('wt-ghost')).toBeUndefined()
  })

  it('stamps a resolved base branch onto an existing row', async () => {
    await applyWorkspaceEvent({
      type: 'base-branch-resolved',
      projectSlug: 'proj',
      workspaceId: 'wt-1',
      baseBranch: 'develop',
    })

    expect((await rowOf('wt-1'))?.baseBranch).toBe('develop')
  })

  // One event carries both halves of the record, because a launch is the one
  // moment when the conversation list is complete and all of it is live.
  it('links launched conversations and marks them active, in launch order', async () => {
    await applyWorkspaceEvent({
      type: 'sessions-launched',
      projectSlug: 'proj',
      workspaceId: 'wt-1',
      sessions: [
        {
          tool: 'claude', agentSessionId: 'conv-a', mode: 'acp', paneId: 'claude', firstPrompt: 'do the thing',
          model: 'claude-opus-5-5',
        },
        { tool: 'claude', agentSessionId: 'conv-b', mode: 'acp', paneId: 'claude-2' },
      ],
    })

    const links = await listWorkspaceAgentSessions('proj', 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.ordinal, l.active, l.paneId])).toEqual([
      ['conv-a', 0, true, 'claude'],
      ['conv-b', 1, true, 'claude-2'],
    ])
    expect(links[0].firstPrompt).toBe('do the thing')
    // Named from the launch, before the agent has answered.
    expect(links[0].model).toBe('claude-opus-5-5')
    expect(links[1].model).toBeUndefined()
  })

  it('stamps the stop, and the cause when a reaper supplied one', async () => {
    await applyWorkspaceEvent({
      type: 'workspace-stopped',
      projectSlug: 'proj',
      workspaceId: 'wt-1',
      cause: { reason: 'oom', detail: 'exit code 137' },
    })

    const row = await rowOf('wt-1')
    expect(row?.stoppedAt).toBeInstanceOf(Date)
    expect(row?.deathReason).toBe('oom')
    expect(row?.deathDetail).toBe('exit code 137')
    // The user has not seen this death yet — it is what raises the
    // stopped-workspaces notification dot.
    expect(row?.deathSeen).toBe(false)
  })

  // A user stop is a stop with no cause: recording one would let the next
  // reader claim the session died of something.
  it('records a causeless stop without inventing a reason', async () => {
    await applyWorkspaceEvent({
      type: 'workspace-stopped', projectSlug: 'proj', workspaceId: 'wt-1',
    })

    const row = await rowOf('wt-1')
    expect(row?.stoppedAt).toBeInstanceOf(Date)
    expect(row?.deathReason).toBeUndefined()
    expect(row?.deathDetail).toBeUndefined()
  })

  it('touches only the workspace the event names', async () => {
    await recordWorkspaceCreated({ projectSlug: 'proj', workspaceId: 'wt-2' })

    await applyWorkspaceEvent({
      type: 'workspace-stopped', projectSlug: 'proj', workspaceId: 'wt-1',
    })

    expect((await rowOf('wt-2'))?.stoppedAt).toBeUndefined()
  })

  // An observer reports what it saw; a workspace the server has no row for is
  // not an error it can do anything about, and must not fail the teardown
  // that reported it.
  it('is a no-op for a workspace with no row', async () => {
    await expect(stopped('nonexistent')).resolves.toBeUndefined()
  })

  it('erases a failed fresh workspace, links and all', async () => {
    await created('wt-fresh')
    await applyWorkspaceEvent({
      type: 'sessions-launched',
      projectSlug: 'proj',
      workspaceId: 'wt-fresh',
      sessions: [{ tool: 'claude', agentSessionId: 'conv-x' }],
    })

    await failed('wt-fresh')

    expect(await rowOf('wt-fresh')).toBeUndefined()
    expect(await listWorkspaceAgentSessions('proj', 'wt-fresh')).toEqual([])
  })

  // A resume re-stamped a row that already carried the workspace's history,
  // so a failed one is put back exactly as the restart found it — including
  // the cause it died of and whether the user had already dismissed it.
  it('restores a failed resume to the stop it was found in', async () => {
    await stopped('wt-1', { cause: { reason: 'oom', detail: 'exit code 137' } })
    const before = await rowOf('wt-1')

    await created('wt-1', { resume: true })
    expect((await rowOf('wt-1'))?.stoppedAt).toBeUndefined() // live while it provisions

    await failed('wt-1', { resume: true })

    const after = await rowOf('wt-1')
    expect(after?.stoppedAt).toEqual(before?.stoppedAt)
    expect(after?.deathReason).toBe('oom')
    expect(after?.deathDetail).toBe('exit code 137')
  })

  // The remembered stop is re-read on every resume, so a second restart
  // cannot put back a death the workspace has since stopped having.
  it('restores the stop the latest resume found, not an earlier one', async () => {
    await stopped('wt-1', { cause: { reason: 'oom' } })
    await created('wt-1', { resume: true })
    await failed('wt-1', { resume: true })

    await stopped('wt-1', { cause: { reason: 'crashed', detail: 'exit code 1' } })
    await created('wt-1', { resume: true })
    await failed('wt-1', { resume: true })

    expect((await rowOf('wt-1'))?.deathReason).toBe('crashed')
  })

  // A workspace that had no stop when the resume began must not inherit one
  // remembered from an earlier life.
  it('forgets a remembered stop once the row no longer carries it', async () => {
    await stopped('wt-1', { cause: { reason: 'oom' } })
    await created('wt-1', { resume: true }) // remembers the oom
    await created('wt-1', { resume: true }) // row is live now — nothing to remember

    await failed('wt-1', { resume: true })

    const row = await rowOf('wt-1')
    expect(row?.stoppedAt).toBeInstanceOf(Date)
    expect(row?.deathReason).toBeUndefined()
  })

  // A workspace that was live when the restart began has no stop to put back.
  it('records a plain stop for a failed resume that had none', async () => {
    await created('wt-1', { resume: true })
    await failed('wt-1', { resume: true })

    const row = await rowOf('wt-1')
    expect(row?.stoppedAt).toBeInstanceOf(Date)
    expect(row?.deathReason).toBeUndefined()
    expect(await rowOf('wt-1')).toBeDefined() // kept, not erased
  })

  // Rows are a snapshot input and this is the only door they change
  // through, so every event notifies; the hub diffs before broadcasting.
  it('pushes a fresh snapshot for every event it applies', async () => {
    const before = pushes
    await created('wt-2')
    await applyWorkspaceEvent({
      type: 'base-branch-resolved', projectSlug: 'proj', workspaceId: 'wt-2', baseBranch: 'main',
    })
    await applyWorkspaceEvent({
      type: 'sessions-discovered', projectSlug: 'proj', workspaceId: 'wt-2', sessions: [],
    })
    await applyWorkspaceEvent({
      type: 'sessions-active', projectSlug: 'proj', workspaceId: 'wt-2', active: [],
    })
    await stopped('wt-2')
    expect(pushes - before).toBe(5)
  })

  // The rollback path still pushes: a failed create leaves a row that looks
  // different from the one the client last saw, whether it was erased or
  // put back.
  it('pushes after a rolled-back create', async () => {
    await created('wt-3')
    const before = pushes
    await failed('wt-3')
    expect(pushes - before).toBe(1)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#db/client'
import { applyWorkspaceEvent } from '#db/apply-workspace-event'
import {
  getProjectWorkspaceRows,
  recordWorkspaceCreated,
  setWorkspaceTitle,
} from '#db/workspace-store'
import { createWorkspaceGroup } from '#db/group-store'
import { listWorkspaceAgentSessions } from '#db/agent-session-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#notify'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const ELSEWHERE = '916a4314-2e8d-4811-8766-75eeedc5ae4a'

describe('applyWorkspaceEvent', () => {
  let tmpDir: string

  let pushes: number

  beforeEach(async () => {
    _resetWorkspaceListChangedForTests()
    pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })
    tmpDir = await createTempDataDir()
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-1' })
  })

  afterEach(async () => {
    _resetWorkspaceListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const rowOf = async (workspaceId: string) =>
    (await getProjectWorkspaceRows(PROJ)).get(workspaceId)

  const created = (workspaceId: string, extra = {}): Promise<void> =>
    applyWorkspaceEvent({
      type: 'workspace-created', projectId: PROJ, workspaceId, ...extra,
    })

  const stopped = (workspaceId: string, extra = {}): Promise<void> =>
    applyWorkspaceEvent({
      type: 'workspace-stopped', projectId: PROJ, workspaceId, ...extra,
    })

  const failed = (workspaceId: string, extra = {}): Promise<void> =>
    applyWorkspaceEvent({
      type: 'workspace-create-failed', projectId: PROJ, workspaceId, ...extra,
    })

  it('records a reported workspace, with the branch when the emitter knew it', async () => {
    await created('wt-new', { baseBranch: 'main' })

    expect(await rowOf('wt-new')).toMatchObject({
      projectId: PROJ, workspaceId: 'wt-new', baseBranch: 'main', deathSeen: false,
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
      type: 'permission-mode-changed', projectId: PROJ, workspaceId: 'wt-p', permissionMode,
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

  // The effort is followed the same way (docs/effort-levels.md), and a
  // restart that names none keeps what the agent last moved to.
  it('follows the effort the agent moved to, and keeps it over a restart that names none', async () => {
    const effort = async (): Promise<string | undefined> => (await rowOf('wt-e'))?.effort
    await created('wt-e', { permissionMode: 'bypass', effort: 'high' })
    expect(await effort()).toBe('high')
    await applyWorkspaceEvent({ type: 'effort-changed', projectId: PROJ, workspaceId: 'wt-e', effort: 'low' })
    expect(await effort()).toBe('low')
    await created('wt-e', { resume: true, permissionMode: 'bypass' })
    expect(await effort()).toBe('low')
  })

  // A workspace id is claimed once across all projects: otherwise a create
  // posting a live workspace's id could re-stamp it and then tear it down
  // as its own when the create failed.
  it('refuses a fresh create on a taken id, in this project or another, leaving the row be', async () => {
    await applyWorkspaceEvent({ type: 'base-branch-resolved', projectId: PROJ, workspaceId: 'wt-1', baseBranch: 'main' })
    await stopped('wt-1', { cause: { reason: 'oom' } })
    const before = await rowOf('wt-1')

    await expect(created('wt-1', { baseBranch: 'other' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(applyWorkspaceEvent({
      type: 'workspace-created', projectId: ELSEWHERE, workspaceId: 'wt-1',
    })).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(await rowOf('wt-1')).toEqual(before)
    expect((await getProjectWorkspaceRows(ELSEWHERE)).size).toBe(0)
  })

  it('re-stamps a resumed workspace\'s live fields, keeping what belongs to the workspace', async () => {
    await applyWorkspaceEvent({ type: 'base-branch-resolved', projectId: PROJ, workspaceId: 'wt-1', baseBranch: 'main' })
    await setWorkspaceTitle(PROJ, 'wt-1', 'my workspace')
    const group = await createWorkspaceGroup(PROJ, 'release', 'wt-1')
    await stopped('wt-1', { cause: { reason: 'oom', detail: 'exit code 137' } })
    const before = await rowOf('wt-1')

    await created('wt-1', { resume: true, permissionMode: 'plan' })

    expect(await rowOf('wt-1')).toMatchObject({
      createdAt: before?.createdAt,
      title: 'my workspace',
      groupId: group.groupId,
      baseBranch: 'main',
      permissionMode: 'plan',
      // The stop stays until the restart succeeds (`clearWorkspaceStopped`).
      stoppedAt: before?.stoppedAt,
      deathReason: 'oom',
    })
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
      projectId: PROJ,
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
      projectId: PROJ,
      workspaceId: 'wt-1',
      sessions: [
        {
          tool: 'claude', agentSessionId: 'conv-a', mode: 'acp', paneId: 'claude', firstPrompt: 'do the thing',
          model: 'claude-opus-5-5',
        },
        { tool: 'claude', agentSessionId: 'conv-b', mode: 'acp', paneId: 'claude-2' },
      ],
    })

    const links = await listWorkspaceAgentSessions(PROJ, 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.ordinal, l.active, l.paneId])).toEqual([
      ['conv-a', 0, true, 'claude'],
      ['conv-b', 1, true, 'claude-2'],
    ])
    expect(links[0].firstPrompt).toBe('do the thing')
    // Named from the launch, before the agent has answered.
    expect(links[0].model).toBe('claude-opus-5-5')
    expect(links[1].model).toBeUndefined()
  })

  // A capture fills what no discovery pass recorded, and nothing else: a
  // conversation a pass has since recorded is left as the pass wrote it.
  it('fills a stopped conversation\'s activity once, keeping a captured prompt', async () => {
    await applyWorkspaceEvent({
      type: 'sessions-discovered',
      projectId: PROJ,
      workspaceId: 'wt-1',
      sessions: [
        { tool: 'claude', agentSessionId: 'conv-a' },
        { tool: 'claude', agentSessionId: 'conv-b', firstPrompt: 'the real ask' },
        { tool: 'claude', agentSessionId: 'conv-c', lastActiveMs: Date.parse('2026-03-01') },
      ],
    })
    const captured = (agentSessionId: string, lastActiveMs: number, firstPrompt?: string) => ({
      tool: 'claude' as const, agentSessionId, lastActiveMs, ...(firstPrompt !== undefined ? { firstPrompt } : {}),
    })
    await applyWorkspaceEvent({
      type: 'sessions-captured',
      projectId: PROJ,
      workspaceId: 'wt-1',
      sessions: [
        captured('conv-a', Date.parse('2026-01-02'), 'from the transcript'),
        captured('conv-b', Date.parse('2026-01-02'), 'from the transcript'),
        captured('conv-c', Date.parse('2026-01-02'), 'from the transcript'),
      ],
    })

    const links = await listWorkspaceAgentSessions(PROJ, 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.firstPrompt, l.lastActiveAt?.toISOString()])).toEqual([
      ['conv-a', 'from the transcript', '2026-01-02T00:00:00.000Z'],
      ['conv-b', 'the real ask', '2026-01-02T00:00:00.000Z'],
      ['conv-c', undefined, '2026-03-01T00:00:00.000Z'],
    ])
  })

  it('stamps the stop, and the cause when a reaper supplied one', async () => {
    await applyWorkspaceEvent({
      type: 'workspace-stopped',
      projectId: PROJ,
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
      type: 'workspace-stopped', projectId: PROJ, workspaceId: 'wt-1',
    })

    const row = await rowOf('wt-1')
    expect(row?.stoppedAt).toBeInstanceOf(Date)
    expect(row?.deathReason).toBeUndefined()
    expect(row?.deathDetail).toBeUndefined()
  })

  it('touches only the workspace the event names', async () => {
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-2' })

    await applyWorkspaceEvent({
      type: 'workspace-stopped', projectId: PROJ, workspaceId: 'wt-1',
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
      projectId: PROJ,
      workspaceId: 'wt-fresh',
      sessions: [{ tool: 'claude', agentSessionId: 'conv-x' }],
    })

    await failed('wt-fresh')

    expect(await rowOf('wt-fresh')).toBeUndefined()
    expect(await listWorkspaceAgentSessions(PROJ, 'wt-fresh')).toEqual([])
  })

  // The row keeps its stop until a restart succeeds, so a failed resume
  // leaves it exactly as the restart found it, death cause and all.
  it('leaves a failed resume as the restart found it', async () => {
    await stopped('wt-1', { cause: { reason: 'oom', detail: 'exit code 137' } })
    const before = await rowOf('wt-1')

    await created('wt-1', { resume: true })
    await failed('wt-1', { resume: true })

    expect(await rowOf('wt-1')).toEqual(before)
  })

  // Rows are a snapshot input and this is the only door they change
  // through, so every event notifies; the hub diffs before broadcasting.
  it('pushes a fresh snapshot for every event it applies', async () => {
    const before = pushes
    await created('wt-2')
    await applyWorkspaceEvent({
      type: 'base-branch-resolved', projectId: PROJ, workspaceId: 'wt-2', baseBranch: 'main',
    })
    await applyWorkspaceEvent({
      type: 'sessions-discovered', projectId: PROJ, workspaceId: 'wt-2', sessions: [],
    })
    await applyWorkspaceEvent({
      type: 'sessions-active', projectId: PROJ, workspaceId: 'wt-2', active: [],
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

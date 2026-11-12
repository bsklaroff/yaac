import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { asc, eq } from 'drizzle-orm'
import { closeDb, getDb } from '#db/client'
import { workspaceLifeWorkflows, workspaceLives } from '#db/schema'
import { applyWorkspaceEvent } from '#db/apply-workspace-event'
import { listWorkspaceSteps } from '#db/step-store'
import { storeWorkflow } from '#db/workflow-store'
import {
  getProjectWorkspaceRows,
  recordWorkspaceCreated,
  setWorkspaceTitle,
} from '#db/workspace-store'
import { getSessionRow, insertSession, listWorkspaceSessions, recordSessionWaitingSeen } from '#db/session-store'
import { createWorkspaceGroup } from '#db/group-store'
import { listWorkspaceRepos } from '#db/repo-store'
import { BUILT_IN_USER_ID } from '#db/user-store'
import { listWorkspaceConversations } from '#db/conversation-store'
import { onWorkspaceListChanged, _resetWorkspaceListChangedForTests } from '#lib/notify'
import type { StepGraph } from '@yaac/shared/steps'

const PROJ = '4dc844ab-ccfc-4d13-8d08-7c1c7fcec557'
const ELSEWHERE = '916a4314-2e8d-4811-8766-75eeedc5ae4a'
/** Repos the fixtures hold checkouts of; a checkout's row needs no repo row. */
const REPO = '0b9b4c6e-2f0d-4c5e-9a55-7f1f3e1f2a10'
const OTHER_REPO = '1c0c5d7f-3a1e-4d6f-8b66-8a2a4f2a3b21'

describe('applyWorkspaceEvent', () => {
  let tmpDir: string

  let pushes: number

  beforeEach(async () => {
    _resetWorkspaceListChangedForTests()
    pushes = 0
    onWorkspaceListChanged(() => { pushes += 1 })
    tmpDir = await createTempDataDir()
    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-1', repos: [{ repoId: REPO, path: '' }] })
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

  /** A restart: the workspace's next life, each later than any before it. */
  let ahead = 0
  const restarted = (workspaceId: string, extra = {}): Promise<void> =>
    applyWorkspaceEvent({
      type: 'workspace-life-started', projectId: PROJ, workspaceId, at: new Date(Date.now() + (ahead += 1000)), startSteps: [],
      ...extra,
    })

  /** A workspace's lives, oldest first. */
  const livesOf = async (workspaceId: string) => (await getDb()).select().from(workspaceLives)
    .where(eq(workspaceLives.workspaceId, workspaceId)).orderBy(asc(workspaceLives.startedAt))

  const stopped = (workspaceId: string, extra = {}): Promise<void> =>
    applyWorkspaceEvent({
      type: 'workspace-stopped', projectId: PROJ, workspaceId, ...extra,
    })

  const failed = (workspaceId: string, extra = {}): Promise<void> =>
    applyWorkspaceEvent({
      type: 'workspace-create-failed', projectId: PROJ, workspaceId, ...extra,
    })

  it('records a reported workspace, with its checkouts, each branch the emitter knew, and its cwd', async () => {
    await created('wt-new', { repos: [{ repoId: REPO, path: 'api', baseBranch: 'main' }, { repoId: OTHER_REPO, path: 'web' }], cwd: 'api' })

    expect(await rowOf('wt-new')).toMatchObject({ projectId: PROJ, workspaceId: 'wt-new', cwd: 'api', deathSeenBy: [] })
    expect(await listWorkspaceRepos('wt-new')).toEqual([
      { workspaceId: 'wt-new', repoId: REPO, path: 'api', baseBranch: 'main' },
      { workspaceId: 'wt-new', repoId: OTHER_REPO, path: 'web' },
    ])
  })

  // Its first life starts with it, holding what its runtime launched with.
  it('records the life it was created with: when it began, its zone, scratch dirs and deadline', async () => {
    const at = new Date(Date.now() - 5_000)
    await created('wt-launch', {
      at, timeZone: 'Europe/Paris', scratchDirs: ['node_modules'], deadline: new Date(Date.now() + 30 * 60_000),
    })

    expect(await rowOf('wt-launch')).toMatchObject({
      lifeStartedAt: at, timeZone: 'Europe/Paris', scratchDirs: ['node_modules'], timeoutMinutes: 30, deathSeenBy: [],
    })
    expect(await livesOf('wt-launch')).toHaveLength(1)

    // Its runtime coming up is stamped once, on that life.
    expect((await rowOf('wt-launch'))?.launchedAt).toBeUndefined()
    const launched = (): Promise<void> => applyWorkspaceEvent({ type: 'workspace-launched', projectId: PROJ, workspaceId: 'wt-launch' })
    await launched()
    const launchedAt = (await rowOf('wt-launch'))?.launchedAt
    expect(launchedAt).toBeInstanceOf(Date)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await launched()
    expect((await rowOf('wt-launch'))?.launchedAt).toEqual(launchedAt)
  })

  // A life's workflows are its own rows: the ones it starts, with their
  // steps pending, one with no steps, and an init workflow it skipped.
  it('records the workflows a life starts and the init workflows it skips', async () => {
    const graphs: StepGraph[] = [{ install: { run: ['pnpm install'] } }, {}, { test: { run: ['pytest'] } }]
    const [web, empty, api] = await Promise.all(graphs
      .map(async (steps) => ({ id: (await storeWorkflow(PROJ, { steps, secrets: [] })).id, steps })))
    const at = new Date(Date.now() - 5_000)
    await created('wt-flows', {
      at,
      startSteps: [{ ...web, name: 'web-init' }, { ...empty, name: 'noop' }],
      skipped: [{ id: api.id, name: 'api-init' }],
    })

    const flows = await (await getDb()).select().from(workspaceLifeWorkflows)
      .where(eq(workspaceLifeWorkflows.workspaceId, 'wt-flows')).orderBy(asc(workspaceLifeWorkflows.name))
    expect(flows).toEqual([
      { workspaceId: 'wt-flows', life: at, name: 'api-init', workflowId: api.id, skipped: true },
      { workspaceId: 'wt-flows', life: at, name: 'noop', workflowId: empty.id, skipped: false },
      { workspaceId: 'wt-flows', life: at, name: 'web-init', workflowId: web.id, skipped: false },
    ])
    expect(await listWorkspaceSteps('wt-flows')).toMatchObject([
      { life: at, workflowName: 'web-init', workflowId: web.id, name: 'install', origin: 'start', state: 'pending' },
    ])
  })

  // A session's row is what its agent is doing: each reported move lands,
  // up or down, on that session alone, and an unnamed field is left alone.
  it("follows what a session's agent reports, on that session alone", async () => {
    await created('wt-p')
    const a = await insertSession(PROJ, 'wt-p', { cwd: '', tool: 'claude', mode: 'tui', permissionMode: 'accept-edits', effort: 'high' })
    const b = await insertSession(PROJ, 'wt-p', { cwd: '', tool: 'claude', mode: 'acp', permissionMode: 'accept-edits' })
    const reported = (fields: object): Promise<void> => applyWorkspaceEvent({
      type: 'session-reported', projectId: PROJ, workspaceId: 'wt-p', sessionId: a.id, ...fields,
    })

    await reported({ permissionMode: 'plan' })
    expect(await getSessionRow(a.id)).toMatchObject({ permissionMode: 'plan', effort: 'high' })
    await reported({ permissionMode: 'bypass', effort: 'low', model: 'claude-opus-5-5', conversationId: 'conv-2' })
    expect(await getSessionRow(a.id)).toMatchObject({
      permissionMode: 'bypass', effort: 'low', model: 'claude-opus-5-5', conversationId: 'conv-2',
    })
    expect((await getSessionRow(b.id))?.permissionMode).toBe('accept-edits')
  })

  // The sidebar's unread dot: a session going back to work makes its next
  // waiting spell unread, and a workspace restart does not.
  it("clears a session's waitingSeenBy when its waiting ends, and keeps it over a resume", async () => {
    await created('wt-w')
    const a = await insertSession(PROJ, 'wt-w', { cwd: '', tool: 'claude', mode: 'tui', permissionMode: 'bypass' })
    const b = await insertSession(PROJ, 'wt-w', { cwd: '', tool: 'codex', mode: 'tui', permissionMode: 'bypass' })
    for (const s of [a, b]) await recordSessionWaitingSeen(s.id, BUILT_IN_USER_ID)
    await restarted('wt-w')
    expect((await getSessionRow(a.id))?.waitingSeenBy).toEqual([BUILT_IN_USER_ID])
    await applyWorkspaceEvent({ type: 'waiting-ended', projectId: PROJ, workspaceId: 'wt-w', window: a.window })
    expect((await getSessionRow(a.id))?.waitingSeenBy).toEqual([])
    expect((await getSessionRow(b.id))?.waitingSeenBy).toEqual([BUILT_IN_USER_ID])
  })

  // A workspace id is claimed once across all projects: otherwise a create
  // posting a live workspace's id could re-stamp it and then tear it down
  // as its own when the create failed.
  it('refuses a fresh create on a taken id, in this project or another, leaving the row be', async () => {
    await applyWorkspaceEvent({ type: 'base-branch-resolved', projectId: PROJ, workspaceId: 'wt-1', repoId: REPO, baseBranch: 'main' })
    await stopped('wt-1', { cause: { reason: 'oom' } })
    const before = await rowOf('wt-1')

    await expect(created('wt-1', { repos: [{ repoId: OTHER_REPO, path: '', baseBranch: 'other' }] }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(applyWorkspaceEvent({
      type: 'workspace-created', projectId: ELSEWHERE, workspaceId: 'wt-1',
    })).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(await rowOf('wt-1')).toEqual(before)
    expect(await listWorkspaceRepos('wt-1')).toEqual([{ workspaceId: 'wt-1', repoId: REPO, path: '', baseBranch: 'main' }])
    expect((await getProjectWorkspaceRows(ELSEWHERE)).size).toBe(0)
  })

  // A restart is the workspace's next life: the workspace keeps what is
  // its own, and the life before keeps how it ended.
  it('starts a restarted workspace\'s next life, keeping the workspace and the life before it', async () => {
    await applyWorkspaceEvent({ type: 'base-branch-resolved', projectId: PROJ, workspaceId: 'wt-1', repoId: REPO, baseBranch: 'main' })
    await setWorkspaceTitle(PROJ, 'wt-1', 'my workspace')
    const group = await createWorkspaceGroup(PROJ, 'release', 'wt-1')
    await stopped('wt-1', { cause: { reason: 'oom', detail: 'exit code 137' } })
    const before = await rowOf('wt-1')

    await restarted('wt-1', { timeZone: 'Asia/Tokyo', scratchDirs: ['target'] })

    const row = await rowOf('wt-1')
    expect(row).toMatchObject({
      createdAt: before?.createdAt,
      title: 'my workspace',
      groupId: group.groupId,
      timeZone: 'Asia/Tokyo',
      scratchDirs: ['target'],
      deathSeenBy: [],
    })
    expect(row?.stoppedAt).toBeUndefined()
    expect(row?.deathReason).toBeUndefined()
    expect(await livesOf('wt-1')).toMatchObject([
      { startedAt: before?.lifeStartedAt, stoppedAt: before?.stoppedAt, deathReason: 'oom', deathDetail: 'exit code 137' },
      { startedAt: row?.lifeStartedAt, stoppedAt: null },
    ])
    expect(await listWorkspaceRepos('wt-1')).toMatchObject([{ repoId: REPO, baseBranch: 'main' }])
  })

  // A stop keeps its row, so only a pod yaac has no record of (a reset or
  // restored DB) can reach a resume without one — and minting a row for it
  // would be making a record up.
  it('refuses to resume a workspace with no row', async () => {
    await expect(restarted('wt-ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await rowOf('wt-ghost')).toBeUndefined()
  })

  it('stamps a resolved base branch and start commit onto the checkout they are of', async () => {
    await applyWorkspaceEvent({
      type: 'base-branch-resolved', projectId: PROJ, workspaceId: 'wt-1', repoId: REPO, baseBranch: 'develop',
    })
    await applyWorkspaceEvent({
      type: 'start-commit-resolved', projectId: PROJ, workspaceId: 'wt-1', repoId: REPO, startCommit: 'a'.repeat(40),
    })
    // A repo the workspace holds no checkout of is no row to write.
    await applyWorkspaceEvent({
      type: 'base-branch-resolved', projectId: PROJ, workspaceId: 'wt-1', repoId: OTHER_REPO, baseBranch: 'main',
    })

    expect(await listWorkspaceRepos('wt-1')).toEqual([
      { workspaceId: 'wt-1', repoId: REPO, path: '', baseBranch: 'develop', startCommit: 'a'.repeat(40) },
    ])
  })

  // Discovery only adds, in the order the workspace first saw each
  // conversation; the active set is reported apart, since a pass also finds
  // conversations that ended long ago.
  it('links discovered conversations to their sessions, and marks the live ones active', async () => {
    const session = await insertSession(PROJ, 'wt-1', { cwd: '', tool: 'claude', mode: 'tui', permissionMode: 'bypass' })
    await applyWorkspaceEvent({
      type: 'conversations-discovered',
      projectId: PROJ,
      workspaceId: 'wt-1',
      sessions: [
        { tool: 'claude', conversationId: 'conv-a', sessionId: session.id, firstPrompt: 'do the thing', model: 'claude-opus-5-5' },
        { tool: 'codex', conversationId: 'conv-b' },
      ],
    })
    await applyWorkspaceEvent({
      type: 'conversations-active', projectId: PROJ, workspaceId: 'wt-1', active: [{ tool: 'codex', conversationId: 'conv-b' }],
    })

    const links = await listWorkspaceConversations(PROJ, 'wt-1')
    expect(links.map((l) => [l.conversationId, l.ordinal, l.active, l.sessionId])).toEqual([
      ['conv-a', 0, false, session.id],
      ['conv-b', 1, true, undefined],
    ])
    expect(links[0]).toMatchObject({ firstPrompt: 'do the thing', model: 'claude-opus-5-5' })
  })

  // A capture fills what no discovery pass recorded, and nothing else: a
  // conversation a pass has since recorded is left as the pass wrote it.
  it('fills a stopped conversation\'s activity once, keeping a captured prompt', async () => {
    await applyWorkspaceEvent({
      type: 'conversations-discovered',
      projectId: PROJ,
      workspaceId: 'wt-1',
      sessions: [
        { tool: 'claude', conversationId: 'conv-a' },
        { tool: 'claude', conversationId: 'conv-b', firstPrompt: 'the real ask' },
        { tool: 'claude', conversationId: 'conv-c', lastActiveMs: Date.parse('2026-03-01') },
      ],
    })
    const captured = (conversationId: string, lastActiveMs: number, firstPrompt?: string) => ({
      tool: 'claude' as const, conversationId, lastActiveMs, ...(firstPrompt !== undefined ? { firstPrompt } : {}),
    })
    await applyWorkspaceEvent({
      type: 'conversations-captured',
      projectId: PROJ,
      workspaceId: 'wt-1',
      sessions: [
        captured('conv-a', Date.parse('2026-01-02'), 'from the transcript'),
        captured('conv-b', Date.parse('2026-01-02'), 'from the transcript'),
        captured('conv-c', Date.parse('2026-01-02'), 'from the transcript'),
      ],
    })

    const links = await listWorkspaceConversations(PROJ, 'wt-1')
    expect(links.map((l) => [l.conversationId, l.firstPrompt, l.lastActiveAt?.toISOString()])).toEqual([
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
    expect(row?.deathSeenBy).toEqual([])
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

  // A reaper pass that probed a workspace mid-stop reports a death after the
  // user's stop; it must not relabel it, nor a later stop wipe a death.
  it('keeps the first stop recorded in a life', async () => {
    await stopped('wt-1')
    const stoppedAt = (await rowOf('wt-1'))?.stoppedAt
    await stopped('wt-1', { cause: { reason: 'agent-exited' } })
    expect(await rowOf('wt-1')).toMatchObject({ stoppedAt })
    expect((await rowOf('wt-1'))?.deathReason).toBeUndefined()

    await recordWorkspaceCreated({ projectId: PROJ, workspaceId: 'wt-2' })
    await stopped('wt-2', { cause: { reason: 'oom', detail: 'exit code 137' } })
    await stopped('wt-2')
    expect(await rowOf('wt-2')).toMatchObject({ deathReason: 'oom', deathDetail: 'exit code 137' })

    await restarted('wt-2')
    await stopped('wt-2')
    expect((await rowOf('wt-2'))?.deathReason).toBeUndefined()
  })

  // A clean that began before the latest stop (one that outlived a
  // restart) does not answer for it.
  it('stamps a clean of the ignored files only against a stop recorded before it began', async () => {
    const before = new Date(Date.now() - 1_000)
    await stopped('wt-1')
    await applyWorkspaceEvent({ type: 'ignored-files-cleaned', projectId: PROJ, workspaceId: 'wt-1', at: before })
    expect((await rowOf('wt-1'))?.ignoredCleanedAt).toBeUndefined()

    const at = new Date()
    await applyWorkspaceEvent({ type: 'ignored-files-cleaned', projectId: PROJ, workspaceId: 'wt-1', at })
    expect((await rowOf('wt-1'))?.ignoredCleanedAt).toEqual(at)
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

  it('erases a failed fresh workspace, sessions, links and all', async () => {
    await created('wt-fresh')
    await insertSession(PROJ, 'wt-fresh', { cwd: '', tool: 'claude', mode: 'tui', permissionMode: 'bypass' })
    await applyWorkspaceEvent({
      type: 'conversations-discovered',
      projectId: PROJ,
      workspaceId: 'wt-fresh',
      sessions: [{ tool: 'claude', conversationId: 'conv-x' }],
    })

    await failed('wt-fresh')

    expect(await rowOf('wt-fresh')).toBeUndefined()
    expect(await listWorkspaceSessions('wt-fresh', { all: true })).toEqual([])
    expect(await listWorkspaceConversations(PROJ, 'wt-fresh')).toEqual([])
  })

  // A failed restart loses only the life it had started, steps and all,
  // so the workspace reads as the restart found it, death cause and all.
  it('leaves a failed resume as the restart found it', async () => {
    await stopped('wt-1', { cause: { reason: 'oom', detail: 'exit code 137' } })
    const before = await rowOf('wt-1')
    const workflow = await storeWorkflow(PROJ, { steps: { install: { run: ['pnpm install'] } }, secrets: [] })

    // One that failed before its life began has none to lose.
    await failed('wt-1', { lifeBefore: before?.lifeStartedAt })
    expect(await rowOf('wt-1')).toEqual(before)

    await restarted('wt-1', { startSteps: [{ id: workflow.id, name: 'ci', steps: workflow.steps }] })
    expect((await rowOf('wt-1'))?.stoppedAt).toBeUndefined()
    await failed('wt-1', { lifeBefore: before?.lifeStartedAt })

    expect(await rowOf('wt-1')).toEqual(before)
    expect(await listWorkspaceSteps('wt-1')).toEqual([])
  })

  // Rows are a snapshot input and this is the only door they change
  // through, so every event notifies; the hub diffs before broadcasting.
  it('pushes a fresh snapshot for every event it applies', async () => {
    const before = pushes
    await created('wt-2')
    await applyWorkspaceEvent({
      type: 'base-branch-resolved', projectId: PROJ, workspaceId: 'wt-2', repoId: REPO, baseBranch: 'main',
    })
    await applyWorkspaceEvent({
      type: 'conversations-discovered', projectId: PROJ, workspaceId: 'wt-2', sessions: [],
    })
    await applyWorkspaceEvent({
      type: 'conversations-active', projectId: PROJ, workspaceId: 'wt-2', active: [],
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

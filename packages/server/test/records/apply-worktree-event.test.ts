import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#platform/db/client'
import {
  _resetPriorStopsForTests,
  applyWorktreeEvent,
} from '#records/apply-worktree-event'
import {
  getProjectWorktreeRows,
  recordWorktreeCreated,
} from '#records/worktree-store'
import { listWorktreeAgentSessions } from '#records/agent-session-store'

describe('applyWorktreeEvent', () => {
  let tmpDir: string

  beforeEach(async () => {
    _resetPriorStopsForTests()
    tmpDir = await createTempDataDir()
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-1' })
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const rowOf = async (worktreeId: string) =>
    (await getProjectWorktreeRows('proj')).get(worktreeId)

  const created = (worktreeId: string, extra = {}): Promise<void> =>
    applyWorktreeEvent({
      type: 'worktree-created', projectSlug: 'proj', worktreeId, ...extra,
    })

  const stopped = (worktreeId: string, extra = {}): Promise<void> =>
    applyWorktreeEvent({
      type: 'worktree-stopped', projectSlug: 'proj', worktreeId, ...extra,
    })

  const failed = (worktreeId: string, extra = {}): Promise<void> =>
    applyWorktreeEvent({
      type: 'worktree-create-failed', projectSlug: 'proj', worktreeId, ...extra,
    })

  it('records a reported worktree, with the branch when the herd knew it', async () => {
    await created('wt-new', { baseBranch: 'main' })

    expect(await rowOf('wt-new')).toMatchObject({
      projectSlug: 'proj', worktreeId: 'wt-new', baseBranch: 'main', background: false,
    })
  })

  it('stamps a resolved base branch onto an existing row', async () => {
    await applyWorktreeEvent({
      type: 'base-branch-resolved',
      projectSlug: 'proj',
      worktreeId: 'wt-1',
      baseBranch: 'develop',
    })

    expect((await rowOf('wt-1'))?.baseBranch).toBe('develop')
  })

  // One event carries both halves of the record, because a launch is the one
  // moment when the conversation list is complete and all of it is live.
  it('links launched conversations and marks them active, in launch order', async () => {
    await applyWorktreeEvent({
      type: 'sessions-launched',
      projectSlug: 'proj',
      worktreeId: 'wt-1',
      sessions: [
        { tool: 'claude', agentSessionId: 'conv-a', mode: 'acp', paneId: 'claude', firstPrompt: 'do the thing' },
        { tool: 'claude', agentSessionId: 'conv-b', mode: 'acp', paneId: 'claude-2' },
      ],
    })

    const links = await listWorktreeAgentSessions('proj', 'wt-1')
    expect(links.map((l) => [l.agentSessionId, l.ordinal, l.active, l.paneId])).toEqual([
      ['conv-a', 0, true, 'claude'],
      ['conv-b', 1, true, 'claude-2'],
    ])
    expect(links[0].firstPrompt).toBe('do the thing')
  })

  it('stamps the stop, and the cause when a reaper supplied one', async () => {
    await applyWorktreeEvent({
      type: 'worktree-stopped',
      projectSlug: 'proj',
      worktreeId: 'wt-1',
      cause: { reason: 'oom', detail: 'exit code 137' },
    })

    const row = await rowOf('wt-1')
    expect(row?.stoppedAt).toBeInstanceOf(Date)
    expect(row?.deathReason).toBe('oom')
    expect(row?.deathDetail).toBe('exit code 137')
    // The user has not seen this death yet — it is what raises the
    // stopped-worktrees notification dot.
    expect(row?.deathSeen).toBe(false)
  })

  // A user stop is a stop with no cause: recording one would let the next
  // reader claim the session died of something.
  it('records a causeless stop without inventing a reason', async () => {
    await applyWorktreeEvent({
      type: 'worktree-stopped', projectSlug: 'proj', worktreeId: 'wt-1',
    })

    const row = await rowOf('wt-1')
    expect(row?.stoppedAt).toBeInstanceOf(Date)
    expect(row?.deathReason).toBeUndefined()
    expect(row?.deathDetail).toBeUndefined()
  })

  it('touches only the worktree the event names', async () => {
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-2' })

    await applyWorktreeEvent({
      type: 'worktree-stopped', projectSlug: 'proj', worktreeId: 'wt-1',
    })

    expect((await rowOf('wt-2'))?.stoppedAt).toBeUndefined()
  })

  // The herd reports what it saw; a worktree the server has no row for is
  // not an error it can do anything about, and must not fail the teardown
  // that reported it.
  it('is a no-op for a worktree with no row', async () => {
    await expect(stopped('nonexistent')).resolves.toBeUndefined()
  })

  it('erases a failed fresh worktree, links and all', async () => {
    await created('wt-fresh')
    await applyWorktreeEvent({
      type: 'sessions-launched',
      projectSlug: 'proj',
      worktreeId: 'wt-fresh',
      sessions: [{ tool: 'claude', agentSessionId: 'conv-x' }],
    })

    await failed('wt-fresh')

    expect(await rowOf('wt-fresh')).toBeUndefined()
    expect(await listWorktreeAgentSessions('proj', 'wt-fresh')).toEqual([])
  })

  // A resume re-stamped a row that already carried the worktree's history,
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
  // cannot put back a death the worktree has since stopped having.
  it('restores the stop the latest resume found, not an earlier one', async () => {
    await stopped('wt-1', { cause: { reason: 'oom' } })
    await created('wt-1', { resume: true })
    await failed('wt-1', { resume: true })

    await stopped('wt-1', { cause: { reason: 'crashed', detail: 'exit code 1' } })
    await created('wt-1', { resume: true })
    await failed('wt-1', { resume: true })

    expect((await rowOf('wt-1'))?.deathReason).toBe('crashed')
  })

  // A worktree that had no stop when the resume began must not inherit one
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

  // A worktree that was live when the restart began has no stop to put back.
  it('records a plain stop for a failed resume that had none', async () => {
    await created('wt-1', { resume: true })
    await failed('wt-1', { resume: true })

    const row = await rowOf('wt-1')
    expect(row?.stoppedAt).toBeInstanceOf(Date)
    expect(row?.deathReason).toBeUndefined()
    expect(await rowOf('wt-1')).toBeDefined() // kept, not erased
  })
})

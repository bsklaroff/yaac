import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { claudeDir } from '@yaac/shared/project-paths'
import { closeDb } from '#db/client'
import {
  deleteProjectWorktrees,
  deleteWorktreeRow,
  findWorktreeRow,
  listLiveWorktreeRows,
  priorStopOf,
  restoreWorktreeStop,
  setWorktreeBaseBranch,
  getProjectWorktreeRows,
  getWorktreeRow,
  listStoppedWorktreeIds,
  listWorktreeRows,
  recordDeathSeen,
  recordWorktreeCreated,
  recordWorktreeStopped,
  claimSpareWorktree,
  restoreSpareWorktree,
  clearWorktreeStopped,
  setWorktreeTitle,
} from '#db/worktree-store'
import { applyWorktreeEvent } from '#db/apply-worktree-event'
import { firstAgentSession, recordAgentSessions } from '#db/agent-session-store'
import { onWorktreeListChanged, _resetWorktreeListChangedForTests } from '#notify'

describe('session store', () => {
  let tmpDir: string

  let pushes: number

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    _resetWorktreeListChangedForTests()
    pushes = 0
    onWorktreeListChanged(() => { pushes += 1 })
  })

  afterEach(async () => {
    _resetWorktreeListChangedForTests()
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const create = (worktreeId: string, extra = {}): Promise<void> =>
    recordWorktreeCreated({ projectSlug: 'proj', worktreeId, ...extra })

  /** A spare as prewarm leaves it: warming inserts the row, then stamps the
   *  life its pod starts. */
  const warmSpare = async (): Promise<void> => {
    await applyWorktreeEvent({
      type: 'worktree-created', projectSlug: 'proj', worktreeId: 'spare1',
      spare: true, baseBranch: 'main', permissionMode: 'bypass', mode: 'tui',
    })
    await applyWorktreeEvent({ type: 'worktree-life-started', projectSlug: 'proj', worktreeId: 'spare1' })
  }

  describe('recordWorktreeCreated', () => {
    it('stores the row', async () => {
      await create('sid-1', { baseBranch: 'main' })

      const row = (await getProjectWorktreeRows('proj')).get('sid-1')
      expect(row).toMatchObject({
        projectSlug: 'proj',
        worktreeId: 'sid-1',
        baseBranch: 'main',
        deathSeen: false,
      })
      expect(row?.stoppedAt).toBeUndefined()
    })
  })

  // Against the real table, the calls prewarm makes: warming inserts the
  // row, and the claim must hand that same row over — a second insert on
  // the id is refused now, which silently sent every claim to a cold create.
  describe('claimSpareWorktree', () => {
    const warmT = new Date('2026-01-01T00:00:00Z')
    const claimT = new Date('2026-01-01T00:05:00Z')
    afterEach(() => { vi.useRealTimers() })

    it('hands the warmed row over with the claim\'s launch and time, and refuses a second claim', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(warmT)
      await warmSpare()
      pushes = 0
      vi.setSystemTime(claimT)

      await claimSpareWorktree('proj', 'spare1', {
        baseBranch: 'dev', permissionMode: 'plan', mode: 'acp', model: 'claude-opus-5-5',
      })

      expect(await getWorktreeRow('proj', 'spare1')).toMatchObject({
        spare: false,
        // The worktree is born at the claim, not the warm…
        createdAt: claimT,
        // …but it is the warmed row: only warming stamps the life.
        lifeStartedAt: warmT,
        baseBranch: 'dev',
        permissionMode: 'plan',
        mode: 'acp',
        model: 'claude-opus-5-5',
      })
      expect(pushes).toBe(1)
      await expect(claimSpareWorktree('proj', 'spare1')).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(claimSpareWorktree('proj', 'no-such-spare')).rejects.toMatchObject({ code: 'CONFLICT' })
    })
  })

  describe('restoreSpareWorktree', () => {
    it('puts back everything the claim stamped and drops the conversation it recorded', async () => {
      await warmSpare()
      const warmed = (await getWorktreeRow('proj', 'spare1'))!
      await claimSpareWorktree('proj', 'spare1', {
        baseBranch: 'dev', permissionMode: 'plan', mode: 'acp', model: 'claude-opus-5-5',
      })
      await applyWorktreeEvent({
        type: 'sessions-launched', projectSlug: 'proj', worktreeId: 'spare1',
        sessions: [{ tool: 'claude', agentSessionId: 'spare1' }],
      })

      await restoreSpareWorktree(warmed)

      expect(await getWorktreeRow('proj', 'spare1')).toEqual(warmed)
      expect(await firstAgentSession('proj', 'spare1')).toBeUndefined()
    })
  })

  describe('deletion', () => {
    it('records the deletion time and clears it again on restart', async () => {
      await create('sid-1')
      await recordWorktreeStopped('proj', 'sid-1')
      expect((await getProjectWorktreeRows('proj')).get('sid-1')?.stoppedAt).toBeInstanceOf(Date)

      await clearWorktreeStopped('proj', 'sid-1')
      expect((await getProjectWorktreeRows('proj')).get('sid-1')?.stoppedAt).toBeUndefined()
    })

    it('stores a reaper-supplied cause and drops it on a plain delete', async () => {
      await create('sid-1')
      await recordWorktreeStopped('proj', 'sid-1', { reason: 'oom', detail: 'exit code 137' })
      expect((await getProjectWorktreeRows('proj')).get('sid-1')).toMatchObject({
        deathReason: 'oom',
        deathDetail: 'exit code 137',
      })

      await recordWorktreeStopped('proj', 'sid-1')
      const row = (await getProjectWorktreeRows('proj')).get('sid-1')
      expect(row?.deathReason).toBeUndefined()
      expect(row?.deathDetail).toBeUndefined()
    })

    it('tracks whether the user has seen the death, re-flagging on a re-death', async () => {
      await create('sid-1')
      await recordWorktreeStopped('proj', 'sid-1', { reason: 'crashed' })
      expect((await getProjectWorktreeRows('proj')).get('sid-1')?.deathSeen).toBe(false)

      await recordDeathSeen('proj', 'sid-1')
      expect((await getProjectWorktreeRows('proj')).get('sid-1')?.deathSeen).toBe(true)

      await recordWorktreeStopped('proj', 'sid-1', { reason: 'evicted' })
      expect((await getProjectWorktreeRows('proj')).get('sid-1')?.deathSeen).toBe(false)
    })

    it('never creates a row — an unrecorded session (a prewarmed spare) stays invisible', async () => {
      await recordWorktreeStopped('proj', 'spare')
      await recordDeathSeen('proj', 'spare')
      await setWorktreeTitle('proj', 'spare', 'nope')
      expect(await listWorktreeRows()).toEqual([])
    })
  })

  describe('title', () => {
    it('normalizes on write and clears on a blank title', async () => {
      await create('sid-1')
      await setWorktreeTitle('proj', 'sid-1', '  fix   the  parser \n')
      expect((await getProjectWorktreeRows('proj')).get('sid-1')?.title).toBe('fix the parser')

      await setWorktreeTitle('proj', 'sid-1', '   ')
      expect((await getProjectWorktreeRows('proj')).get('sid-1')?.title).toBeUndefined()
    })

    it('with ifUntitled, writes only a row that has no title yet', async () => {
      await create('sid-1')
      await create('sid-2')
      await setWorktreeTitle('proj', 'sid-1', 'user rename')
      await setWorktreeTitle('proj', 'sid-1', 'generated', { ifUntitled: true })
      await setWorktreeTitle('proj', 'sid-2', 'generated', { ifUntitled: true })

      const rows = await getProjectWorktreeRows('proj')
      expect(rows.get('sid-1')?.title).toBe('user rename')
      expect(rows.get('sid-2')?.title).toBe('generated')
    })

    // The rename is a snapshot input, so the writer pushes it — which is
    // what lets both the route and the title generator above it stay
    // ignorant of the push channel entirely.
    it('pushes a fresh snapshot on every write', async () => {
      await create('sid-1')
      const before = pushes
      await setWorktreeTitle('proj', 'sid-1', 'renamed')
      expect(pushes - before).toBe(1)
      await setWorktreeTitle('proj', 'sid-1', '')
      expect(pushes - before).toBe(2)
    })
  })

  describe('deleteWorktreeRow', () => {
    it('removes one session and leaves its siblings', async () => {
      await create('sid-1')
      await create('sid-2')
      await deleteWorktreeRow('proj', 'sid-1')
      expect((await listWorktreeRows('proj')).map((r) => r.worktreeId)).toEqual(['sid-2'])
    })

    it('is a no-op for a session that was never recorded', async () => {
      await expect(deleteWorktreeRow('proj', 'ghost')).resolves.toBeUndefined()
    })
  })

  describe('setWorktreeBaseBranch', () => {
    it('stamps the branch after the row exists, without touching anything else', async () => {
      await create('sid-1')
      await setWorktreeBaseBranch('proj', 'sid-1', 'release/2.x')
      expect((await getProjectWorktreeRows('proj')).get('sid-1')).toMatchObject({
        baseBranch: 'release/2.x',
      })
    })

    it('no-ops for an unrecorded session rather than creating one', async () => {
      await setWorktreeBaseBranch('proj', 'ghost', 'main')
      expect(await listWorktreeRows('proj')).toEqual([])
    })
  })

  describe('listLiveWorktreeRows', () => {
    it('excludes stopped worktrees and reports whether each ever ran', async () => {
      // `ran` now comes from a captured founding ask OR any linked agent
      // A link alone proves nothing — session create records one before the
      // agent launches. Evidence is a captured opening message or a
      // transcript; without either the create was interrupted.
      await create('never-ran')
      await recordAgentSessions('proj', 'never-ran', [
        { tool: 'claude', agentSessionId: 'never-ran' },
      ])
      await create('has-prompt')
      await recordAgentSessions('proj', 'has-prompt', [
        { tool: 'claude', agentSessionId: 'conv-a', firstPrompt: 'hello' },
      ])
      await create('has-transcript')
      await recordAgentSessions('proj', 'has-transcript', [
        {
          tool: 'claude',
          agentSessionId: 'conv-b',
          // Inside the tool home: the column stores paths relative to it, so
          // one outside has no storable form and would record as null.
          transcriptPath: path.join(claudeDir('proj'), 'projects', '-workspace', 'conv-b.jsonl'),
        },
      ])
      await create('gone')
      await recordWorktreeStopped('proj', 'gone')

      const rows = await listLiveWorktreeRows()
      expect(rows.map((r) => [r.worktreeId, r.ran]).sort())
        .toEqual([['has-prompt', true], ['has-transcript', true], ['never-ran', false]])
    })
  })

  describe('restoreWorktreeStop', () => {
    it('puts a failed restart\'s row back, cause and seen flag intact', async () => {
      await create('sid-1')
      await recordWorktreeStopped('proj', 'sid-1', { reason: 'oom', detail: 'exit code 137' })
      await recordDeathSeen('proj', 'sid-1')
      const before = (await getProjectWorktreeRows('proj')).get('sid-1')
      const prior = priorStopOf(before)
      expect(prior).toBeDefined()

      // The restart clears the deletion, then fails.
      await clearWorktreeStopped('proj', 'sid-1')
      await restoreWorktreeStop('proj', 'sid-1', prior!)

      expect((await getProjectWorktreeRows('proj')).get('sid-1')).toMatchObject({
        stoppedAt: before?.stoppedAt,
        deathReason: 'oom',
        deathDetail: 'exit code 137',
        deathSeen: true, // the user had already dismissed this death
      })
    })

    it('priorStopOf ignores a row that was not deleted', async () => {
      await clearWorktreeStopped('proj', 'sid-1')
      expect(priorStopOf((await getProjectWorktreeRows('proj')).get('sid-1'))).toBeUndefined()
      expect(priorStopOf(undefined)).toBeUndefined()
    })
  })

  describe('deleteProjectWorktrees', () => {
    it('forgets one project\'s sessions and leaves the rest', async () => {
      await create('sid-1')
      await create('sid-2')
      await recordWorktreeCreated({ projectSlug: 'other', worktreeId: 'sid-3' })

      await deleteProjectWorktrees('proj')

      expect(await listWorktreeRows('proj')).toEqual([])
      expect((await listWorktreeRows('other')).map((r) => r.worktreeId)).toEqual(['sid-3'])
    })
  })

  describe('getWorktreeRow', () => {
    it('point-reads one session, in the project named', async () => {
      await create('sid-1')

      expect(await getWorktreeRow('proj', 'sid-1')).toMatchObject({ worktreeId: 'sid-1' })
      expect(await getWorktreeRow('other', 'sid-1')).toBeUndefined()
      expect(await getWorktreeRow('proj', 'nope')).toBeUndefined()
    })
  })

  describe('listStoppedWorktreeIds', () => {
    it('returns only sessions with a recorded deletion, keyed by project', async () => {
      await create('live')
      await create('dead')
      await recordWorktreeStopped('proj', 'dead')

      expect(await listStoppedWorktreeIds()).toEqual(new Set(['proj/dead']))
    })
  })

  describe('findWorktreeRow', () => {
    it('finds an exact id in whichever project holds it, and nothing shorter', async () => {
      await create('abcdef-1234')
      await recordWorktreeCreated({ projectSlug: 'other', worktreeId: 'zzz' })
      await create('spare-1', { spare: true })

      expect((await findWorktreeRow('abcdef-1234'))?.projectSlug).toBe('proj')
      expect((await findWorktreeRow('zzz'))?.projectSlug).toBe('other')
      // Prefix expansion is domain's `resolveWorktree`, never this.
      expect(await findWorktreeRow('abcdef')).toBeUndefined()
      expect(await findWorktreeRow('spare-1')).toBeUndefined()
      expect(await findWorktreeRow('nope')).toBeUndefined()
      expect(await findWorktreeRow('')).toBeUndefined()
    })
  })
})

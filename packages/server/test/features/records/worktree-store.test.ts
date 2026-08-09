import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { claudeDir } from '@yaac/shared/project-paths'
import { closeDb } from '#platform/db/client'
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
  clearWorktreeStopped,
  setWorktreeBackground,
  setWorktreeTitle,
} from '#features/records/worktree-store'
import { recordAgentSessions } from '#features/records/agent-session-store'

describe('session store', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const create = (worktreeId: string, extra = {}): Promise<void> =>
    recordWorktreeCreated({ projectSlug: 'proj', worktreeId, ...extra })

  describe('recordWorktreeCreated', () => {
    it('stores the row, keyed per project', async () => {
      await create('sid-1', { baseBranch: 'main' })
      await recordWorktreeCreated({ projectSlug: 'other', worktreeId: 'sid-1' })

      const row = (await getProjectWorktreeRows('proj')).get('sid-1')
      expect(row).toMatchObject({
        projectSlug: 'proj',
        worktreeId: 'sid-1',
        baseBranch: 'main',
        background: false,
        deathSeen: false,
      })
      expect(row?.stoppedAt).toBeUndefined()
    })

    it('re-recording an id clears the previous life\'s deletion and death', async () => {
      await create('sid-1')
      await recordWorktreeStopped('proj', 'sid-1', { reason: 'oom', detail: 'exit code 137' })
      await create('sid-1')

      const row = (await getProjectWorktreeRows('proj')).get('sid-1')
      expect(row?.stoppedAt).toBeUndefined()
      expect(row?.deathReason).toBeUndefined()
      expect(row?.deathDetail).toBeUndefined()
    })

    it('keeps the title and pin across a restart', async () => {
      await create('sid-1')
      await setWorktreeTitle('proj', 'sid-1', 'my session')
      await setWorktreeBackground('proj', 'sid-1', true)
      await create('sid-1') // restart: same id, no new prompt

      expect((await getProjectWorktreeRows('proj')).get('sid-1')).toMatchObject({
        title: 'my session',
        background: true,
      })
    })

    it('keeps the original creation time across a restart', async () => {
      await recordWorktreeCreated({
        projectSlug: 'proj', worktreeId: 'sid-1', createdAt: new Date('2026-01-01'),
      })
      await create('sid-1')
      expect((await getProjectWorktreeRows('proj')).get('sid-1')?.createdAt)
        .toEqual(new Date('2026-01-01'))
    })

    it('keeps the recorded base branch when a resume does not resolve one', async () => {
      await create('sid-1', { baseBranch: 'main' })
      await create('sid-1')
      expect((await getProjectWorktreeRows('proj')).get('sid-1')?.baseBranch).toBe('main')
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
      await setWorktreeBackground('proj', 'spare', true)
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
      await create('sid-1')
      await restoreWorktreeStop('proj', 'sid-1', prior!)

      expect((await getProjectWorktreeRows('proj')).get('sid-1')).toMatchObject({
        stoppedAt: before?.stoppedAt,
        deathReason: 'oom',
        deathDetail: 'exit code 137',
        deathSeen: true, // the user had already dismissed this death
      })
    })

    it('priorStopOf ignores a row that was not deleted', async () => {
      await create('sid-1')
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
    it('point-reads one session, per project', async () => {
      await create('sid-1')
      await recordWorktreeCreated({ projectSlug: 'other', worktreeId: 'sid-1' })

      expect(await getWorktreeRow('proj', 'sid-1')).toMatchObject({ worktreeId: 'sid-1' })
      expect(await getWorktreeRow('other', 'sid-1')).toMatchObject({ projectSlug: 'other' })
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
    it('resolves by exact id and by unique prefix, across projects', async () => {
      await create('abcdef-1234')
      await recordWorktreeCreated({ projectSlug: 'other', worktreeId: 'zzz' })

      expect((await findWorktreeRow('abcdef-1234'))?.projectSlug).toBe('proj')
      expect((await findWorktreeRow('abcdef'))?.worktreeId).toBe('abcdef-1234')
      expect((await findWorktreeRow('zzz'))?.projectSlug).toBe('other')
      expect(await findWorktreeRow('nope')).toBeUndefined()
      expect(await findWorktreeRow('')).toBeUndefined()
    })

    it('prefers an exact match over a longer id that starts with it', async () => {
      await create('abc')
      await create('abcdef')
      expect((await findWorktreeRow('abc'))?.worktreeId).toBe('abc')
    })
  })
})

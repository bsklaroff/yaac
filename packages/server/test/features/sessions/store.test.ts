import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { closeDb } from '#platform/db/client'
import {
  deleteProjectSessions,
  deleteSessionRow,
  findSessionRow,
  listLiveSessionRows,
  priorDeletionOf,
  restoreSessionDeletion,
  setSessionBaseBranch,
  getProjectSessionRows,
  getSessionRow,
  listDeletedSessionIds,
  listSessionRows,
  listSessionsMissingCapture,
  recordDeathSeen,
  recordSessionCreated,
  recordSessionDeleted,
  clearSessionDeleted,
  setSessionBackground,
  setSessionCapture,
  setSessionPrompt,
  setSessionTitle,
  MAX_PROMPT_LENGTH,
} from '#features/sessions/store'

describe('session store', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const create = (sessionId: string, extra = {}): Promise<void> =>
    recordSessionCreated({ projectSlug: 'proj', sessionId, tool: 'claude', ...extra })

  describe('recordSessionCreated', () => {
    it('stores the row, keyed per project', async () => {
      await create('sid-1', { prompt: 'do the thing', baseBranch: 'main' })
      await recordSessionCreated({ projectSlug: 'other', sessionId: 'sid-1', tool: 'codex' })

      const row = (await getProjectSessionRows('proj')).get('sid-1')
      expect(row).toMatchObject({
        projectSlug: 'proj',
        sessionId: 'sid-1',
        tool: 'claude',
        prompt: 'do the thing',
        baseBranch: 'main',
        background: false,
        deathSeen: false,
      })
      expect(row?.deletedAt).toBeUndefined()
      expect((await getProjectSessionRows('other')).get('sid-1')?.tool).toBe('codex')
    })

    it('re-recording an id clears the previous life\'s deletion and death', async () => {
      await create('sid-1')
      await recordSessionDeleted('proj', 'sid-1', { reason: 'oom', detail: 'exit code 137' })
      await create('sid-1')

      const row = (await getProjectSessionRows('proj')).get('sid-1')
      expect(row?.deletedAt).toBeUndefined()
      expect(row?.deathReason).toBeUndefined()
      expect(row?.deathDetail).toBeUndefined()
    })

    it('keeps the title and pin across a restart, and the captured prompt', async () => {
      await create('sid-1', { prompt: 'original ask' })
      await setSessionTitle('proj', 'sid-1', 'my session')
      await setSessionBackground('proj', 'sid-1', true)
      await create('sid-1') // restart: same id, no new prompt

      expect((await getProjectSessionRows('proj')).get('sid-1')).toMatchObject({
        title: 'my session',
        background: true,
        prompt: 'original ask',
      })
    })

    it('keeps the original creation time across a restart', async () => {
      await recordSessionCreated({
        projectSlug: 'proj', sessionId: 'sid-1', tool: 'claude', createdAt: new Date('2026-01-01'),
      })
      await create('sid-1')
      expect((await getProjectSessionRows('proj')).get('sid-1')?.createdAt)
        .toEqual(new Date('2026-01-01'))
    })

    it('keeps the recorded base branch when a resume does not resolve one', async () => {
      await create('sid-1', { baseBranch: 'main' })
      await create('sid-1')
      expect((await getProjectSessionRows('proj')).get('sid-1')?.baseBranch).toBe('main')
    })
  })

  describe('deletion', () => {
    it('records the deletion time and clears it again on restart', async () => {
      await create('sid-1')
      await recordSessionDeleted('proj', 'sid-1')
      expect((await getProjectSessionRows('proj')).get('sid-1')?.deletedAt).toBeInstanceOf(Date)

      await clearSessionDeleted('proj', 'sid-1')
      expect((await getProjectSessionRows('proj')).get('sid-1')?.deletedAt).toBeUndefined()
    })

    it('stores a reaper-supplied cause and drops it on a plain delete', async () => {
      await create('sid-1')
      await recordSessionDeleted('proj', 'sid-1', { reason: 'oom', detail: 'exit code 137' })
      expect((await getProjectSessionRows('proj')).get('sid-1')).toMatchObject({
        deathReason: 'oom',
        deathDetail: 'exit code 137',
      })

      await recordSessionDeleted('proj', 'sid-1')
      const row = (await getProjectSessionRows('proj')).get('sid-1')
      expect(row?.deathReason).toBeUndefined()
      expect(row?.deathDetail).toBeUndefined()
    })

    it('tracks whether the user has seen the death, re-flagging on a re-death', async () => {
      await create('sid-1')
      await recordSessionDeleted('proj', 'sid-1', { reason: 'crashed' })
      expect((await getProjectSessionRows('proj')).get('sid-1')?.deathSeen).toBe(false)

      await recordDeathSeen('proj', 'sid-1')
      expect((await getProjectSessionRows('proj')).get('sid-1')?.deathSeen).toBe(true)

      await recordSessionDeleted('proj', 'sid-1', { reason: 'evicted' })
      expect((await getProjectSessionRows('proj')).get('sid-1')?.deathSeen).toBe(false)
    })

    it('never creates a row — an unrecorded session (a prewarmed spare) stays invisible', async () => {
      await recordSessionDeleted('proj', 'spare')
      await recordDeathSeen('proj', 'spare')
      await setSessionPrompt('proj', 'spare', 'hi')
      await setSessionTitle('proj', 'spare', 'nope')
      await setSessionBackground('proj', 'spare', true)
      expect(await listSessionRows()).toEqual([])
    })
  })

  describe('title', () => {
    it('normalizes on write and clears on a blank title', async () => {
      await create('sid-1')
      await setSessionTitle('proj', 'sid-1', '  fix   the  parser \n')
      expect((await getProjectSessionRows('proj')).get('sid-1')?.title).toBe('fix the parser')

      await setSessionTitle('proj', 'sid-1', '   ')
      expect((await getProjectSessionRows('proj')).get('sid-1')?.title).toBeUndefined()
    })
  })

  describe('prompt capture', () => {
    it('stores the prompt and transcript path together', async () => {
      await create('sid-1')
      await setSessionCapture('proj', 'sid-1', { prompt: 'hello', transcriptPath: '/tmp/a.jsonl' })
      expect((await getProjectSessionRows('proj')).get('sid-1')).toMatchObject({
        prompt: 'hello',
        transcriptPath: '/tmp/a.jsonl',
      })
    })

    it('truncates a pathological first message', async () => {
      await create('sid-1')
      await setSessionPrompt('proj', 'sid-1', 'x'.repeat(MAX_PROMPT_LENGTH + 500))
      expect((await getProjectSessionRows('proj')).get('sid-1')?.prompt)
        .toHaveLength(MAX_PROMPT_LENGTH)
    })

    it('lists live sessions missing a prompt OR a transcript path', async () => {
      // A session created with a prompt still has no transcript path, and
      // the deleted listing stats that path for last activity.
      await create('with-prompt', { prompt: 'already here' })
      await create('pending')
      await create('gone')
      await recordSessionDeleted('proj', 'gone')

      expect((await listSessionsMissingCapture()).map((r) => r.sessionId).sort())
        .toEqual(['pending', 'with-prompt'])

      await setSessionCapture('proj', 'with-prompt', { transcriptPath: '/tmp/a.jsonl' })
      await setSessionCapture('proj', 'pending', { prompt: 'now captured', transcriptPath: '/tmp/b.jsonl' })
      expect(await listSessionsMissingCapture()).toEqual([])
    })

    it('caps a prompt supplied at create time', async () => {
      await create('sid-2', { prompt: 'y'.repeat(MAX_PROMPT_LENGTH + 500) })
      expect((await getProjectSessionRows('proj')).get('sid-2')?.prompt)
        .toHaveLength(MAX_PROMPT_LENGTH)
    })
  })

  describe('deleteSessionRow', () => {
    it('removes one session and leaves its siblings', async () => {
      await create('sid-1')
      await create('sid-2')
      await deleteSessionRow('proj', 'sid-1')
      expect((await listSessionRows('proj')).map((r) => r.sessionId)).toEqual(['sid-2'])
    })

    it('is a no-op for a session that was never recorded', async () => {
      await expect(deleteSessionRow('proj', 'ghost')).resolves.toBeUndefined()
    })
  })

  describe('setSessionBaseBranch', () => {
    it('stamps the branch after the row exists, without touching anything else', async () => {
      await create('sid-1', { prompt: 'do the thing' })
      await setSessionBaseBranch('proj', 'sid-1', 'release/2.x')
      expect((await getProjectSessionRows('proj')).get('sid-1')).toMatchObject({
        baseBranch: 'release/2.x',
        prompt: 'do the thing',
      })
    })

    it('no-ops for an unrecorded session rather than creating one', async () => {
      await setSessionBaseBranch('proj', 'ghost', 'main')
      expect(await listSessionRows('proj')).toEqual([])
    })
  })

  describe('listLiveSessionRows', () => {
    it('excludes deleted sessions and reports whether each ever ran', async () => {
      await create('never-ran')
      await create('has-prompt', { prompt: 'hello' })
      await create('has-transcript')
      await setSessionCapture('proj', 'has-transcript', { transcriptPath: '/tmp/t.jsonl' })
      await create('gone')
      await recordSessionDeleted('proj', 'gone')

      const rows = await listLiveSessionRows()
      expect(rows.map((r) => [r.sessionId, r.ran]).sort())
        .toEqual([['has-prompt', true], ['has-transcript', true], ['never-ran', false]])
    })
  })

  describe('restoreSessionDeletion', () => {
    it('puts a failed restart\'s row back, cause and seen flag intact', async () => {
      await create('sid-1')
      await recordSessionDeleted('proj', 'sid-1', { reason: 'oom', detail: 'exit code 137' })
      await recordDeathSeen('proj', 'sid-1')
      const before = (await getProjectSessionRows('proj')).get('sid-1')
      const prior = priorDeletionOf(before)
      expect(prior).toBeDefined()

      // The restart clears the deletion, then fails.
      await create('sid-1')
      await restoreSessionDeletion('proj', 'sid-1', prior!)

      expect((await getProjectSessionRows('proj')).get('sid-1')).toMatchObject({
        deletedAt: before?.deletedAt,
        deathReason: 'oom',
        deathDetail: 'exit code 137',
        deathSeen: true, // the user had already dismissed this death
      })
    })

    it('priorDeletionOf ignores a row that was not deleted', async () => {
      await create('sid-1')
      expect(priorDeletionOf((await getProjectSessionRows('proj')).get('sid-1'))).toBeUndefined()
      expect(priorDeletionOf(undefined)).toBeUndefined()
    })
  })

  describe('deleteProjectSessions', () => {
    it('forgets one project\'s sessions and leaves the rest', async () => {
      await create('sid-1')
      await create('sid-2')
      await recordSessionCreated({ projectSlug: 'other', sessionId: 'sid-3', tool: 'claude' })

      await deleteProjectSessions('proj')

      expect(await listSessionRows('proj')).toEqual([])
      expect((await listSessionRows('other')).map((r) => r.sessionId)).toEqual(['sid-3'])
    })
  })

  describe('getSessionRow', () => {
    it('point-reads one session, per project', async () => {
      await create('sid-1', { prompt: 'hello' })
      await recordSessionCreated({ projectSlug: 'other', sessionId: 'sid-1', tool: 'codex' })

      expect(await getSessionRow('proj', 'sid-1')).toMatchObject({ tool: 'claude', prompt: 'hello' })
      expect(await getSessionRow('other', 'sid-1')).toMatchObject({ tool: 'codex' })
      expect(await getSessionRow('proj', 'nope')).toBeUndefined()
    })
  })

  describe('listDeletedSessionIds', () => {
    it('returns only sessions with a recorded deletion, keyed by project', async () => {
      await create('live')
      await create('dead')
      await recordSessionDeleted('proj', 'dead')

      expect(await listDeletedSessionIds()).toEqual(new Set(['proj/dead']))
    })
  })

  describe('findSessionRow', () => {
    it('resolves by exact id and by unique prefix, across projects', async () => {
      await create('abcdef-1234')
      await recordSessionCreated({ projectSlug: 'other', sessionId: 'zzz', tool: 'pi' })

      expect((await findSessionRow('abcdef-1234'))?.projectSlug).toBe('proj')
      expect((await findSessionRow('abcdef'))?.sessionId).toBe('abcdef-1234')
      expect((await findSessionRow('zzz'))?.tool).toBe('pi')
      expect(await findSessionRow('nope')).toBeUndefined()
      expect(await findSessionRow('')).toBeUndefined()
    })

    it('prefers an exact match over a longer id that starts with it', async () => {
      await create('abc')
      await create('abcdef')
      expect((await findSessionRow('abc'))?.sessionId).toBe('abc')
    })
  })
})

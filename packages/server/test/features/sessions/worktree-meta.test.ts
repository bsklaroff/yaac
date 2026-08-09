import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { worktreeMetaPath, worktreeSessionStartsPath } from '@yaac/shared/project-paths'
import {
  WORKTREE_META_VERSION,
  clearSpareFlag,
  deleteWorktreeMeta,
  ensureSessionStartsLog,
  foldSessionStarts,
  mergeSessions,
  newWorktreeMeta,
  readSessionStarts,
  readWorktreeMeta,
  recordWorktreeLife,
  sessionsOnCurrentLife,
  updateWorktreeMeta,
  type WorktreeMeta,
} from '#features/sessions/worktree-meta'

/**
 * The herd's own record of a worktree — what it reads back when it may not
 * read a row. Two writers meet here and neither may block the other: this
 * module rewrites the document whole, while the in-pod hook only ever appends
 * to the log beside it.
 */
describe('worktree-meta', () => {
  let tmpDir: string
  const slug = 'demo'
  const wt = 'wt-1'

  const seed = async (): Promise<void> => {
    await updateWorktreeMeta(slug, wt, () => newWorktreeMeta({
      projectSlug: slug,
      worktreeId: wt,
      branch: `agent/${wt}`,
      createdAtMs: 1000,
    }))
  }

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  describe('updateWorktreeMeta', () => {
    it('round-trips a document and refuses to invent one', async () => {
      // An update for a worktree create never recorded declines rather than
      // inventing: a discovery sweep must not mint a document for a spare that
      // was never claimed.
      await updateWorktreeMeta(slug, wt, (current) =>
        current === undefined ? undefined : current)
      expect(await readWorktreeMeta(slug, wt)).toBeUndefined()

      await seed()
      const meta = await readWorktreeMeta(slug, wt)
      expect(meta).toMatchObject({
        version: WORKTREE_META_VERSION,
        projectSlug: slug,
        worktreeId: wt,
        branch: `agent/${wt}`,
        spare: false,
        sessions: [],
      })
    })

    it('treats an unreadable document as absent rather than fatal', async () => {
      await seed()
      await fs.writeFile(worktreeMetaPath(slug, wt), '{ not json')
      expect(await readWorktreeMeta(slug, wt)).toBeUndefined()

      // A document that fails its schema is the same verdict — the worktree is
      // rediscovered, not stranded.
      await fs.writeFile(worktreeMetaPath(slug, wt), JSON.stringify({ version: 1 }))
      expect(await readWorktreeMeta(slug, wt)).toBeUndefined()
    })

    it('leaves a document a newer yaac wrote alone', async () => {
      // zod strips unknown keys, so rewriting a newer document would silently
      // drop whatever it knows that this version does not.
      const future = { version: WORKTREE_META_VERSION + 1, whatever: true }
      await fs.mkdir(path.dirname(worktreeMetaPath(slug, wt)), { recursive: true })
      await fs.writeFile(worktreeMetaPath(slug, wt), JSON.stringify(future))

      await updateWorktreeMeta(slug, wt, () => newWorktreeMeta({
        projectSlug: slug, worktreeId: wt, branch: 'agent/x', createdAtMs: 1,
      }))

      expect(JSON.parse(await fs.readFile(worktreeMetaPath(slug, wt), 'utf8')))
        .toEqual(future)
    })

    it('serializes concurrent updates instead of losing one', async () => {
      await seed()
      // Read-modify-write from two callers at once is exactly what the mutex
      // exists for; without it the second read would predate the first write.
      await Promise.all(['a', 'b', 'c'].map((id) =>
        updateWorktreeMeta(slug, wt, (current) =>
          current === undefined
            ? undefined
            : mergeSessions(current, [{ agentSessionId: id, tool: 'claude' }], 1))))

      const meta = await readWorktreeMeta(slug, wt)
      expect(meta?.sessions.map((s) => s.agentSessionId).sort()).toEqual(['a', 'b', 'c'])
    })
  })

  describe('mergeSessions', () => {
    const base = (): WorktreeMeta => newWorktreeMeta({
      projectSlug: slug, worktreeId: wt, branch: 'agent/x', createdAtMs: 1,
    })

    it('adds in first-seen order and fills without clobbering', () => {
      let meta = mergeSessions(base(), [
        { agentSessionId: 'a', tool: 'claude', firstPrompt: 'the founding ask' },
      ], 100)
      meta = mergeSessions(meta, [{ agentSessionId: 'b', tool: 'claude' }], 200)

      // A later sighting reading a compacted transcript must not replace an
      // opening message already recorded, but may fill one that is missing.
      meta = mergeSessions(meta, [
        { agentSessionId: 'a', tool: 'claude', firstPrompt: 'whatever it says now' },
        { agentSessionId: 'b', tool: 'claude', firstPrompt: 'b speaks' },
      ], 300)

      expect(meta.sessions.map((s) => [s.agentSessionId, s.firstPrompt, s.firstSeenMs]))
        .toEqual([['a', 'the founding ask', 100], ['b', 'b speaks', 200]])
    })

    it('overwrites the handle, because that is the field that means "now"', () => {
      let meta = mergeSessions(base(), [
        { agentSessionId: 'a', tool: 'claude', handle: '%0', handleLifeId: 'life-1' },
      ], 1)
      // Not observed on a handle this pass — that is silence, not a move.
      meta = mergeSessions(meta, [{ agentSessionId: 'a', tool: 'claude' }], 2)
      expect(meta.sessions[0]?.handle).toBe('%0')

      meta = mergeSessions(meta, [
        { agentSessionId: 'a', tool: 'claude', handle: '%7', handleLifeId: 'life-2' },
      ], 3)
      expect(meta.sessions[0]).toMatchObject({ handle: '%7', handleLifeId: 'life-2' })
    })

    it('keys on tool as well as id, so two tools can share one id', () => {
      const meta = mergeSessions(base(), [
        { agentSessionId: 'same', tool: 'claude' },
        { agentSessionId: 'same', tool: 'codex' },
      ], 1)
      expect(meta.sessions).toHaveLength(2)
    })
  })

  describe('sessionsOnCurrentLife', () => {
    it('counts only handles the current life recorded', async () => {
      await seed()
      const life1 = await recordWorktreeLife(slug, wt, 'job-1', 10)
      await updateWorktreeMeta(slug, wt, (current) =>
        current === undefined ? undefined : mergeSessions(current, [
          { agentSessionId: 'a', tool: 'claude', handle: '%0', handleLifeId: life1 },
        ], 20))

      const first = await readWorktreeMeta(slug, wt)
      expect(sessionsOnCurrentLife(first as WorktreeMeta).map((s) => s.agentSessionId))
        .toEqual(['a'])

      // A restart: tmux pane ids start again at %0, so last life's handle must
      // stop counting without anything having been deleted.
      await recordWorktreeLife(slug, wt, 'job-2', 30)
      const second = await readWorktreeMeta(slug, wt)
      expect(sessionsOnCurrentLife(second as WorktreeMeta)).toEqual([])
      // The session itself is still part of the worktree's history.
      expect(second?.sessions).toHaveLength(1)
    })
  })

  describe('readSessionStarts', () => {
    it('reads what the hook appends and skips what it garbled', async () => {
      const log = await ensureSessionStartsLog(slug, wt)
      await fs.appendFile(log, [
        JSON.stringify({ id: 'a', tool: 'claude', pane: '3', path: 'claude/p/a.jsonl' }),
        'not json at all',
        JSON.stringify({ tool: 'claude', pane: '4' }),
        // Outside the project tree, so the hook recorded no path — the session
        // is still real.
        JSON.stringify({ id: 'b', tool: 'codex', pane: '', path: '' }),
        // A partial trailing line: the hook writing as this reads.
        '{"id":"c","tool":"pi"',
        // The log is writable by the sandboxed pod, so an absolute path is
        // something the hook could never have written — it names a file
        // anywhere on the host, and everything downstream would stat and
        // parse it. Dropped here, where the input is already untrusted.
        JSON.stringify({ id: 'evil', tool: 'claude', path: '/etc/passwd' }),
        JSON.stringify({ id: 'evil2', tool: 'claude', path: '../../../etc/passwd' }),
      ].join('\n') + '\n')

      const seen = await readSessionStarts(slug, wt)
      expect(seen.map(({ atByte: _at, ...rest }) => rest)).toEqual([
        { agentSessionId: 'a', tool: 'claude', transcriptPath: 'claude/p/a.jsonl', handle: '%3' },
        { agentSessionId: 'b', tool: 'codex' },
      ])
      // Offsets are real positions in the file, skipping the lines between.
      expect(seen[0]?.atByte).toBe(0)
      expect(seen[1]?.atByte).toBeGreaterThan(0)
    })
  })

  describe('foldSessionStarts', () => {
    it('stamps folded handles with the life that is running', async () => {
      await seed()
      const life = await recordWorktreeLife(slug, wt, 'job-1', 10)
      const log = await ensureSessionStartsLog(slug, wt)
      await fs.appendFile(log, `${JSON.stringify({
        id: 'a', tool: 'claude', pane: '0', path: 'claude/p/a.jsonl',
      })}\n`)

      const meta = await foldSessionStarts(slug, wt)
      expect(meta?.sessions[0]).toMatchObject({
        agentSessionId: 'a', handle: '%0', handleLifeId: life,
      })

      // Nothing truncates the log, so the same line folds again on the next
      // tick — and must stay one session.
      const again = await foldSessionStarts(slug, wt)
      expect(again?.sessions).toHaveLength(1)
    })

    it('does not re-validate the previous life\'s pane after a restart', async () => {
      // The log is never truncated, so the old pod's lines are re-folded on
      // every tick of the new one. Carrying their handles forward would be
      // worse than useless: tmux pane ids restart at %0, so the dead session's
      // pane number now belongs to whatever the new pod opened there, and the
      // liveAgents intersection would report it active on another session's
      // pane — then freeze that at teardown for the next restart to resume.
      await seed()
      await recordWorktreeLife(slug, wt, 'job-1', 10)
      const log = await ensureSessionStartsLog(slug, wt)
      await fs.appendFile(log, `${JSON.stringify({
        id: 'cleared-away', tool: 'claude', pane: '0', path: 'claude/p/old.jsonl',
      })}\n`)
      await foldSessionStarts(slug, wt)

      // The pod restarts. The old line stays on disk; a new session takes the
      // pane number the old one had.
      const life2 = await recordWorktreeLife(slug, wt, 'job-2', 30)
      await fs.appendFile(log, `${JSON.stringify({
        id: 'the-new-one', tool: 'claude', pane: '0', path: 'claude/p/new.jsonl',
      })}\n`)

      const meta = await foldSessionStarts(slug, wt)
      // Both are still part of the worktree's history, with their transcripts.
      expect(meta?.sessions.map((s) => s.agentSessionId))
        .toEqual(['cleared-away', 'the-new-one'])
      // But only the one this life actually opened is on a pane.
      expect(sessionsOnCurrentLife(meta as WorktreeMeta).map((s) => s.agentSessionId))
        .toEqual(['the-new-one'])
      expect(meta?.sessions.find((s) => s.agentSessionId === 'the-new-one'))
        .toMatchObject({ handle: '%0', handleLifeId: life2 })
    })

    it('answers undefined for a worktree with no document', async () => {
      const log = await ensureSessionStartsLog(slug, wt)
      await fs.appendFile(log, `${JSON.stringify({ id: 'a', tool: 'claude' })}\n`)
      expect(await foldSessionStarts(slug, wt)).toBeUndefined()
    })
  })

  describe('clearSpareFlag', () => {
    it('reports whether the document really stopped saying spare', async () => {
      await updateWorktreeMeta(slug, wt, () => newWorktreeMeta({
        projectSlug: slug, worktreeId: wt, branch: `agent/${wt}`, createdAtMs: 1, spare: true,
      }))
      expect(await clearSpareFlag(slug, wt, { baseBranch: 'main' })).toBe(true)
      expect(await readWorktreeMeta(slug, wt))
        .toMatchObject({ spare: false, baseBranch: 'main' })
    })

    it('answers false when the flip could not land', async () => {
      // The write is best-effort and swallows its errors, so the read-back is
      // the only thing standing between a failed flip and the startup sweep
      // deleting a real worktree's checkout. Simulated by making the document
      // unwritable-but-readable: the update is dropped, the old value stays.
      await updateWorktreeMeta(slug, wt, () => newWorktreeMeta({
        projectSlug: slug, worktreeId: wt, branch: `agent/${wt}`, createdAtMs: 1, spare: true,
      }))
      await fs.chmod(path.dirname(worktreeMetaPath(slug, wt)), 0o500)
      try {
        expect(await clearSpareFlag(slug, wt)).toBe(false)
      } finally {
        await fs.chmod(path.dirname(worktreeMetaPath(slug, wt)), 0o700)
      }
    })

    it('is satisfied by a document that is missing entirely', async () => {
      // Nothing to delete on: the sweep skips a worktree it cannot read, so
      // "no document" is as safe as "says false".
      expect(await clearSpareFlag(slug, wt)).toBe(true)
    })
  })

  describe('deleteWorktreeMeta', () => {
    it('takes both files, and is happy when there are none', async () => {
      await seed()
      await ensureSessionStartsLog(slug, wt)
      await deleteWorktreeMeta(slug, wt)

      expect(await readWorktreeMeta(slug, wt)).toBeUndefined()
      await expect(fs.access(worktreeSessionStartsPath(slug, wt))).rejects.toThrow()
      await expect(deleteWorktreeMeta(slug, wt)).resolves.toBeUndefined()
    })
  })
})

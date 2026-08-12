import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { worktreeSessionStartsPath } from '@yaac/shared/project-paths'
import {
  deleteSessionStartsLog,
  ensureSessionStartsLog,
  readSessionStarts,
  sessionStartsLogSize,
} from '#domain/worktrees/session-starts'

/**
 * The one channel out of a worktree's pod: the in-pod `SessionStart` hook
 * appends, the server folds. Everything the fold decides — which conversation
 * exists, where its transcript is, which pane it is on, and whether that pane
 * belongs to the pod running now — is derived from what this module reads, so
 * what it refuses matters as much as what it returns.
 */
describe('session-starts', () => {
  let tmpDir: string
  const slug = 'demo'
  const wt = 'wt-1'

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  describe('readSessionStarts', () => {
    it('reads what the hook appends and skips what it garbled', async () => {
      const log = await ensureSessionStartsLog(slug, wt)
      await fs.appendFile(log, [
        JSON.stringify({ id: 'a', tool: 'claude', pane: '3', path: 'claude/p/a.jsonl' }),
        'not json at all',
        JSON.stringify({ tool: 'claude', pane: '4' }),
        // Outside the project tree, so the hook recorded no path — the
        // conversation is still real.
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

      const { sightings: seen } = await readSessionStarts(slug, wt)
      expect(seen.map(({ atByte: _at, ...rest }) => rest)).toEqual([
        { agentSessionId: 'a', tool: 'claude', transcriptPath: 'claude/p/a.jsonl', handle: '%3' },
        { agentSessionId: 'b', tool: 'codex' },
      ])
      // Offsets are real positions in the file, skipping the lines between —
      // this is what the fold compares against the life boundary, so a
      // sequence number would not do.
      expect(seen[0]?.atByte).toBe(0)
      expect(seen[1]?.atByte).toBeGreaterThan(0)
    })

    it('measures offsets in bytes, not characters', async () => {
      // The offset is compared against a file SIZE. A multi-byte character
      // would drift the two apart, and every line after it would land on the
      // wrong side of the life boundary.
      const log = await ensureSessionStartsLog(slug, wt)
      await fs.appendFile(log, [
        JSON.stringify({ id: 'a', tool: 'claude', path: 'claude/p/✨.jsonl' }),
        JSON.stringify({ id: 'b', tool: 'claude' }),
      ].join('\n') + '\n')

      const { sightings: seen, sizeBytes } = await readSessionStarts(slug, wt)
      const size = await sessionStartsLogSize(slug, wt)
      expect(seen[1]?.atByte).toBe(
        Buffer.byteLength(JSON.stringify({ id: 'a', tool: 'claude', path: 'claude/p/✨.jsonl' })) + 1,
      )
      expect(seen[1]?.atByte).toBeLessThan(size)
      // The size travels with the sightings, from the same buffer, because it
      // is what a recorded life boundary is an offset into.
      expect(sizeBytes).toBe(size)
    })

    it('answers empty for a worktree whose pod never wrote one', async () => {
      expect(await readSessionStarts(slug, 'never-existed'))
        .toEqual({ sightings: [], sizeBytes: 0 })
    })
  })

  describe('sessionStartsLogSize', () => {
    it('measures the log, and calls a missing one zero', async () => {
      // Zero is the right answer for a fresh worktree: everything the hook
      // appends from here belongs to the life about to start.
      expect(await sessionStartsLogSize(slug, wt)).toBe(0)

      const log = await ensureSessionStartsLog(slug, wt)
      await fs.appendFile(log, `${JSON.stringify({ id: 'a', tool: 'claude' })}\n`)
      const size = await sessionStartsLogSize(slug, wt)
      expect(size).toBeGreaterThan(0)
      expect(size).toBe((await fs.stat(log)).size)
    })
  })

  describe('ensureSessionStartsLog', () => {
    it('creates the file so the pod\'s File mount resolves first time', async () => {
      const log = await ensureSessionStartsLog(slug, wt)
      expect(log).toBe(worktreeSessionStartsPath(slug, wt))
      await expect(fs.access(log)).resolves.toBeUndefined()

      // Idempotent, and never truncating: a restart calls this again on a log
      // the previous pod filled, and re-folding it is how handles survive.
      await fs.appendFile(log, 'kept\n')
      await ensureSessionStartsLog(slug, wt)
      expect(await fs.readFile(log, 'utf8')).toBe('kept\n')
    })
  })

  describe('deleteSessionStartsLog', () => {
    it('removes it, and is happy when there is none', async () => {
      await ensureSessionStartsLog(slug, wt)
      await deleteSessionStartsLog(slug, wt)
      await expect(fs.access(worktreeSessionStartsPath(slug, wt))).rejects.toThrow()
      await expect(deleteSessionStartsLog(slug, wt)).resolves.toBeUndefined()
    })
  })
})

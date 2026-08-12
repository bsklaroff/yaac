import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import {
  worktreeMetaDir,
  worktreeMetaPath,
  worktreeSessionStartsPath,
} from '@yaac/shared/project-paths'
import {
  deleteLegacyMetaFiles,
  readLegacyMetaDocuments,
  setAsideUnreadableMeta,
} from '#domain/worktrees/meta-files'

/**
 * Reading the per-worktree metadata documents a previous yaac left behind, so
 * the import can move them into rows and delete them.
 *
 * Forgiving on the way in — anything salvageable is worth taking — and
 * deliberately unforgiving on the way out: a document it could not read is
 * the one case whose facts nothing else can reconstruct, so it is set aside
 * rather than deleted.
 */
describe('meta-import', () => {
  let tmpDir: string
  const slug = 'demo'

  const write = async (worktreeId: string, body: unknown): Promise<void> => {
    await fs.mkdir(worktreeMetaDir(slug), { recursive: true })
    await fs.writeFile(worktreeMetaPath(slug, worktreeId), JSON.stringify(body))
  }

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  describe('readLegacyMetaDocuments', () => {
    it('reads what it can and lists every file the import must remove', async () => {
      await write('wt-1', {
        version: 1,
        projectSlug: slug,
        worktreeId: 'wt-1',
        createdAtMs: 1000,
        branch: 'agent/wt-1',
        baseBranch: 'main',
        spare: false,
        life: { id: 'life-1', startedAtMs: 10, jobName: 'job-1', logBytes: 42 },
        sessions: [
          {
            agentSessionId: 'a',
            tool: 'claude',
            mode: 'tui',
            firstSeenMs: 5,
            transcriptPath: 'claude/p/a.jsonl',
            firstPrompt: 'the founding ask',
            handle: '%0',
            handleLifeId: 'life-1',
          },
        ],
      })
      await write('wt-2', { version: 1, projectSlug: slug, worktreeId: 'wt-2', spare: true, sessions: [] })
      // A rewrite that died between write and rename. It belongs to no
      // worktree and nothing else will ever collect it.
      await fs.writeFile(path.join(worktreeMetaDir(slug), 'wt-3.json.tmp-abc123'), '{')
      // Unparseable: dropped from the import, and NOT deletable — the facts
      // this import exists for are the ones nothing can reconstruct.
      await write('wt-4', 'not an object at all')
      // One malformed session line must not cost the document its `spare`
      // and `life`, which do not depend on it.
      await write('wt-5', {
        version: 1,
        projectSlug: slug,
        worktreeId: 'wt-5',
        spare: true,
        life: { id: 'life-5', startedAtMs: 1, jobName: 'j', logBytes: 7 },
        sessions: [
          { agentSessionId: 'ok', tool: 'claude', mode: 'tui', firstSeenMs: 1 },
          { tool: 'not-a-tool', nonsense: true },
        ],
      })
      // The hook's log lives in the same directory and is emphatically NOT
      // the import's to remove — it is the pod's channel, and it stays.
      await fs.writeFile(worktreeSessionStartsPath(slug, 'wt-1'), '')

      const { documents, junk, unreadable } = await readLegacyMetaDocuments(slug)

      expect(documents.map((d) => d.worktreeId).sort()).toEqual(['wt-1', 'wt-2', 'wt-5'])
      const first = documents.find((d) => d.worktreeId === 'wt-1')
      expect(first).toMatchObject({
        baseBranch: 'main',
        spare: false,
        life: { logBytes: 42 },
      })
      expect(first?.sessions).toEqual([{
        agentSessionId: 'a',
        tool: 'claude',
        mode: 'tui',
        firstSeenMs: 5,
        transcriptPath: 'claude/p/a.jsonl',
        firstPrompt: 'the founding ask',
        handle: '%0',
        handleLifeId: 'life-1',
      }])
      expect(documents.find((d) => d.worktreeId === 'wt-2')?.spare).toBe(true)

      // A bad session line costs its own conversation and nothing else.
      const salvaged = documents.find((d) => d.worktreeId === 'wt-5')
      expect(salvaged).toMatchObject({ spare: true, life: { logBytes: 7 } })
      expect(salvaged?.sessions.map((s) => s.agentSessionId)).toEqual(['ok'])

      // Only `.tmp-*` is deletable on sight. The hook's log lives in the same
      // directory and is emphatically NOT the import's to remove — it is the
      // pod's channel, and it stays.
      expect(junk.map((f) => path.basename(f))).toEqual(['wt-3.json.tmp-abc123'])
      expect(unreadable.map((f) => path.basename(f))).toEqual(['wt-4.json'])
      expect([...junk, ...unreadable].some((f) => f.endsWith('.session-starts.jsonl')))
        .toBe(false)
      // Each importable document names its own file, so the caller can delete
      // it only once its contents are in rows.
      expect(documents.every((d) => d.file.endsWith(`${d.worktreeId}.json`))).toBe(true)
    })

    it('answers empty for a project that never had a meta directory', async () => {
      expect(await readLegacyMetaDocuments('no-such-project'))
        .toEqual({ documents: [], junk: [], unreadable: [] })
    })
  })

  describe('setAsideUnreadableMeta', () => {
    it('renames rather than deletes, so a hand recovery is still possible', async () => {
      // The bytes are the point: a corrupt document is the one case where the
      // facts the import exists for cannot be reconstructed from anything
      // else, so losing the file loses them for good.
      await write('wt-bad', 'not an object at all')
      const file = worktreeMetaPath(slug, 'wt-bad')

      await setAsideUnreadableMeta([file])

      await expect(fs.access(file)).rejects.toThrow()
      expect(await fs.readFile(`${file}.bad`, 'utf8')).toBe('"not an object at all"')
      // And the directory reads clean by extension again, which is the tell
      // for retiring this module (docs/plans/retire-legacy-paths.md).
      expect((await fs.readdir(worktreeMetaDir(slug))).some((f) => f.endsWith('.json')))
        .toBe(false)
      // A second pass finds nothing to move and must not throw.
      await expect(setAsideUnreadableMeta([file])).resolves.toBeUndefined()
    })
  })

  describe('deleteLegacyMetaFiles', () => {
    it('removes them, and shrugs at one that is already gone', async () => {
      await write('wt-1', { version: 1, projectSlug: slug, worktreeId: 'wt-1', sessions: [] })
      const file = worktreeMetaPath(slug, 'wt-1')
      const missing = worktreeMetaPath(slug, 'never-existed')

      await deleteLegacyMetaFiles([file, missing])
      await expect(fs.access(file)).rejects.toThrow()
      // The import is retried by the next server start if it dies half way,
      // so a second pass over the same list must not throw.
      await expect(deleteLegacyMetaFiles([file])).resolves.toBeUndefined()
    })
  })
})

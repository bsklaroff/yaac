/**
 * The startup sweep of the legacy JSON stores — `importLegacyJsonStores`.
 *
 * Nothing under platform/db is mocked here: a real database is opened in a
 * temp data dir and the legacy files are written to disk by hand, so the
 * private path builders, the tolerant parsers and the one-shot session
 * backfill are covered by the data-dir states these tests lay down rather
 * than by tests of their own. What the import produced is read back through
 * the stores that own each table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import { claudeDir, codexDir, codexTranscriptDir, projectDir } from '@yaac/shared/project-paths'
import { eq } from 'drizzle-orm'
import { _freshDbForTests, agentSessions, closeDb, getDb, importLegacyJsonStores } from '#platform/db'
import { getDefaultTool, getShortcutOverrides, setDefaultTool } from '#features/records/preferences'
import {
  getProjectWorktreeRows,
  listWorktreeRows,
  recordWorktreeCreated,
} from '#features/records/worktree-store'
import { MAX_PROMPT_LENGTH } from '@yaac/shared/herd'
import {
  listWorktreeAgentSessions,
  recordAgentSessions,
} from '#features/records/agent-session-store'
import { loadTokens } from '#http'

// The legacy on-disk layout, rebuilt by hand: the production path builders
// for these files are gone (that is the point of the import).
const prefsPath = (): string => path.join(getDataDir(), '.preferences.json')
const titlesPath = (slug: string): string => path.join(projectDir(slug), 'session-titles.json')
const metaDir = (slug: string): string => path.join(projectDir(slug), 'opencode-meta')
const tokensJsonPath = (): string => path.join(getDataDir(), 'tokens.json')

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

const chord = { code: 'KeyG', alt: true, ctrl: false, meta: false, shift: false }

describe('importLegacyJsonStores', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('is a clean no-op with no legacy files', async () => {
    await importLegacyJsonStores()
    expect(await getDefaultTool()).toBeUndefined()
    expect(await loadTokens()).toEqual([])
  })

  it('imports preferences + shortcuts (dropping malformed chords) and deletes the file', async () => {
    await fs.writeFile(prefsPath(), JSON.stringify({
      defaultTool: 'codex',
      shortcuts: {
        'new-session': chord,
        'bad': { code: 'KeyW' }, // missing modifier flags
      },
    }))
    await importLegacyJsonStores()
    expect(await getDefaultTool()).toBe('codex')
    expect(await getShortcutOverrides()).toEqual({ 'new-session': chord })
    expect(await exists(prefsPath())).toBe(false)
  })

  it('is idempotent — a second run after re-import changes nothing', async () => {
    await fs.writeFile(prefsPath(), JSON.stringify({ defaultTool: 'codex' }))
    await importLegacyJsonStores()
    await importLegacyJsonStores()
    expect(await getDefaultTool()).toBe('codex')
  })

  it('an existing DB row wins over a stale re-appearing file', async () => {
    await setDefaultTool('claude')
    await fs.writeFile(prefsPath(), JSON.stringify({ defaultTool: 'codex' }))
    await importLegacyJsonStores()
    expect(await getDefaultTool()).toBe('claude')
    expect(await exists(prefsPath())).toBe(false) // consumed all the same
  })

  it('sweeps session titles across every project onto their session rows', async () => {
    for (const slug of ['alpha', 'beta']) {
      await fs.mkdir(projectDir(slug), { recursive: true })
    }
    await fs.writeFile(titlesPath('alpha'), JSON.stringify({ s1: 'fix parser', junk: 42, blank: '' }))
    await fs.writeFile(titlesPath('beta'), JSON.stringify({ s2: 'docs pass' }))
    await importLegacyJsonStores()
    expect((await getProjectWorktreeRows('alpha')).get('s1')?.title).toBe('fix parser')
    expect((await getProjectWorktreeRows('alpha')).get('junk')).toBeUndefined()
    expect((await getProjectWorktreeRows('beta')).get('s2')?.title).toBe('docs pass')
    expect(await exists(titlesPath('alpha'))).toBe(false)
    expect(await exists(titlesPath('beta'))).toBe(false)
  })

  it('imports opencode meta with the file birthtime as createdAt and removes the dir', async () => {
    await fs.mkdir(metaDir('proj'), { recursive: true })
    const file = path.join(metaDir('proj'), 'ocsess.json')
    await fs.writeFile(file, JSON.stringify({ firstMessage: 'build a thing', capturedAt: '2026-05-01T00:00:00.000Z' }))
    const stat = await fs.lstat(file)
    await importLegacyJsonStores()
    const row = (await getProjectWorktreeRows('proj')).get('ocsess')
    expect(row).toBeDefined()
    expect(await listWorktreeAgentSessions('proj', 'ocsess')).toMatchObject([
      { tool: 'opencode', firstPrompt: 'build a thing' },
    ])
    expect(Math.abs((row?.createdAt.getTime() ?? 0) - stat.birthtime.getTime())).toBeLessThanOrEqual(1)
    expect(await exists(metaDir('proj'))).toBe(false)
  })

  it('adopts transcripts even when the data migration already seeded rows', async () => {
    // The regression that matters on a real upgrade: the SQL migration
    // folds the old side tables into agent_sessions before this runs, so a
    // gate on "table is empty" would skip adoption on every install that
    // had ever titled a session.
    await fs.mkdir(projectDir('proj'), { recursive: true })
    await fs.writeFile(titlesPath('proj'), JSON.stringify({ seeded: 'an older session' }))
    await importLegacyJsonStores()
    expect((await getProjectWorktreeRows('proj')).get('seeded')?.title).toBe('an older session')

    // Now a *second* data dir state: rows exist, and a transcript-only
    // session appears. A fresh DB replays the migration + import with rows
    // already present.
    const workspaceDir = path.join(claudeDir('proj'), 'projects', '-workspace')
    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.writeFile(path.join(workspaceDir, 'transcript-only.jsonl'), '{}\n')
    // Clear the one-shot flag the way a fresh upgrade would: a new DB.
    await _freshDbForTests()
    await importLegacyJsonStores()

    expect((await getProjectWorktreeRows('proj')).get('transcript-only')).toBeDefined()
    expect(await listWorktreeAgentSessions('proj', 'transcript-only'))
      .toMatchObject([{ tool: 'claude' }])
  })

  it('adopts pre-existing transcripts once, then leaves later ones alone', async () => {
    const workspaceDir = path.join(claudeDir('proj'), 'projects', '-workspace')
    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.writeFile(path.join(workspaceDir, 'old-session.jsonl'), '{}\n')
    await importLegacyJsonStores()
    expect((await getProjectWorktreeRows('proj')).get('old-session')).toBeDefined()
    // The transcript now hangs off the worktree's one agent session — before
    // the split, its conversation id WAS the worktree id, so the adoption can
    // record it rather than guess.
    expect(await listWorktreeAgentSessions('proj', 'old-session')).toMatchObject([{
      agentSessionId: 'old-session',
      tool: 'claude',
      active: true,
      transcriptPath: path.join(workspaceDir, 'old-session.jsonl'),
    }])

    // A transcript that appears afterwards belongs to a conversation the hook
    // links on its own, not to a worktree — the backfill is done.
    await fs.writeFile(path.join(workspaceDir, 'post-clear.jsonl'), '{}\n')
    await importLegacyJsonStores()
    expect((await getProjectWorktreeRows('proj')).get('post-clear')).toBeUndefined()
  })

  it('corrects the tool a migrated title row guessed at, from the transcript', async () => {
    await fs.mkdir(projectDir('proj'), { recursive: true })
    const codexDirPath = path.join(codexTranscriptDir('proj'))
    await fs.mkdir(codexDirPath, { recursive: true })
    await fs.writeFile(path.join(codexDirPath, 'cx.jsonl'), '{}\n')
    await fs.writeFile(titlesPath('proj'), JSON.stringify({ cx: 'a codex session' }))
    await importLegacyJsonStores()
    // The title stays on the worktree; the corrected tool is on its
    // conversation, which is what a worktree's tool now means.
    expect((await getProjectWorktreeRows('proj')).get('cx')).toMatchObject({
      title: 'a codex session',
    })
    expect(await listWorktreeAgentSessions('proj', 'cx')).toMatchObject([{ tool: 'codex' }])
  })

  it('normalizes an imported title and caps an imported prompt', async () => {
    await fs.mkdir(projectDir('proj'), { recursive: true })
    await fs.writeFile(titlesPath('proj'), JSON.stringify({ s1: '  spaced   out  ' }))
    await fs.mkdir(metaDir('proj'), { recursive: true })
    await fs.writeFile(
      path.join(metaDir('proj'), 'oc.json'),
      JSON.stringify({ firstMessage: 'x'.repeat(MAX_PROMPT_LENGTH + 500) }),
    )
    await importLegacyJsonStores()
    const rows = await getProjectWorktreeRows('proj')
    expect(rows.get('s1')?.title).toBe('spaced out')
    // The opencode meta file's first message lands on the conversation, which
    // is where a worktree's founding ask lives.
    const [ocFirst] = await listWorktreeAgentSessions('proj', 'oc')
    expect(ocFirst?.firstPrompt).toHaveLength(MAX_PROMPT_LENGTH)
  })

  it('imports tokens with kind defaulting, dropping malformed entries', async () => {
    await fs.writeFile(tokensJsonPath(), JSON.stringify([
      { name: 'old', token: 't'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z' }, // pre-kind
      { name: 'web-1', token: 'u'.repeat(64), kind: 'web', createdAt: '2026-01-02T00:00:00.000Z' },
      { name: 'open-1', token: 'v'.repeat(64), kind: 'one-time', createdAt: '2026-01-03T00:00:00.000Z', expiresAt: '2026-01-04T00:00:00.000Z' },
      { nope: 1 },
      'garbage',
    ]))
    await importLegacyJsonStores()
    expect(await loadTokens()).toEqual([
      { name: 'old', token: 't'.repeat(64), kind: 'durable', createdAt: '2026-01-01T00:00:00.000Z' },
      { name: 'web-1', token: 'u'.repeat(64), kind: 'web', createdAt: '2026-01-02T00:00:00.000Z' },
      { name: 'open-1', token: 'v'.repeat(64), kind: 'one-time', createdAt: '2026-01-03T00:00:00.000Z', expiresAt: '2026-01-04T00:00:00.000Z' },
    ])
    expect(await exists(tokensJsonPath())).toBe(false)
  })

  it('logs and leaves malformed files in place', async () => {
    await fs.writeFile(prefsPath(), 'not json')
    await fs.writeFile(tokensJsonPath(), '{}') // not an array
    await fs.mkdir(metaDir('proj'), { recursive: true })
    const badMeta = path.join(metaDir('proj'), 'bad.json')
    await fs.writeFile(badMeta, 'not json')
    await importLegacyJsonStores()
    expect(await exists(prefsPath())).toBe(true)
    expect(await exists(tokensJsonPath())).toBe(true)
    expect(await exists(badMeta)).toBe(true) // and the dir stays with it
    expect(await listWorktreeRows('proj')).toEqual([])
  })

  it('resolves a recorded transcript path that is a yaac symlink to its target', async () => {
    // yaac used to index codex's rollouts with a symlink per session, and
    // capture stored *that* path — so every pre-link-tree codex row points at
    // a symlink. Resolving them is what lets the symlinks stop being written:
    // afterwards the DB holds a real path, which is all any reader needs.
    const rollout = path.join(codexDir('proj'), 'sessions', 'rollout-2026-abc.jsonl')
    await fs.mkdir(path.dirname(rollout), { recursive: true })
    await fs.writeFile(rollout, '{}\n')
    const linkDir = path.join(codexDir('proj'), '.yaac-transcripts')
    await fs.mkdir(linkDir, { recursive: true })
    const link = path.join(linkDir, 'wt-codex.jsonl')
    await fs.symlink(rollout, link)

    const dangling = path.join(linkDir, 'wt-gone.jsonl')
    await fs.symlink(path.join(codexDir('proj'), 'sessions', 'missing.jsonl'), dangling)

    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-codex' })
    await recordAgentSessions('proj', 'wt-codex', [
      { tool: 'codex', agentSessionId: 'wt-codex', transcriptPath: link },
    ])
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-gone' })
    await recordAgentSessions('proj', 'wt-gone', [
      { tool: 'codex', agentSessionId: 'wt-gone', transcriptPath: dangling },
    ])
    // …and one whose symlink was deleted outright rather than left dangling.
    // Same dead end by a different route, so it must not survive the sweep as
    // a path that resolves nowhere.
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-unlinked' })
    await recordAgentSessions('proj', 'wt-unlinked', [
      {
        tool: 'codex',
        agentSessionId: 'wt-unlinked',
        transcriptPath: path.join(linkDir, 'wt-unlinked.jsonl'),
      },
    ])

    await importLegacyJsonStores()

    const [resolved] = await listWorktreeAgentSessions('proj', 'wt-codex')
    expect(resolved?.transcriptPath).toBe(await fs.realpath(rollout))
    // A dangling one becomes null: a path resolving nowhere is worse than
    // none, since every reader would keep stat-ing it forever.
    const [gone] = await listWorktreeAgentSessions('proj', 'wt-gone')
    expect(gone?.transcriptPath).toBeUndefined()
    const [unlinked] = await listWorktreeAgentSessions('proj', 'wt-unlinked')
    expect(unlinked?.transcriptPath).toBeUndefined()
  })

  it('rewrites an absolute recorded path to its home-relative form', async () => {
    // Every path recorded before the column went relative is absolute, so it
    // only resolved in the data dir that wrote it. The sweep re-homes them;
    // the store still hands back an absolute path, so no reader notices.
    const real = path.join(claudeDir('proj'), 'projects', '-workspace', 'conv-abs.jsonl')
    await fs.mkdir(path.dirname(real), { recursive: true })
    await fs.writeFile(real, '{}\n')
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-abs' })
    await recordAgentSessions('proj', 'wt-abs', [
      { tool: 'claude', agentSessionId: 'conv-abs', transcriptPath: real },
    ])
    // Back to the pre-change on-disk state the sweep exists to find.
    const db = await getDb()
    await db.update(agentSessions).set({ transcriptPath: real })
      .where(eq(agentSessions.agentSessionId, 'conv-abs'))

    await importLegacyJsonStores()

    const [stored] = await db.select({ p: agentSessions.transcriptPath }).from(agentSessions)
      .where(eq(agentSessions.agentSessionId, 'conv-abs'))
    expect(stored?.p).toBe(path.join('projects', '-workspace', 'conv-abs.jsonl'))
    const [row] = await listWorktreeAgentSessions('proj', 'wt-abs')
    expect(row?.transcriptPath).toBe(real)
  })

  it('re-homes an absolute path that a moved data dir stranded', async () => {
    // The restored-backup case: the row names a home this install does not
    // have. Waiting for the reconciler would strand it — that visits only
    // running worktrees, and after a restore nothing is running — so the
    // sweep recovers the tail from the /projects/<slug>/<tool>/ boundary.
    // The transcript itself came across in the backup, at the same
    // home-relative spot under the new data dir.
    const moved = path.join(claudeDir('proj'), 'projects', '-workspace', 'c.jsonl')
    await fs.mkdir(path.dirname(moved), { recursive: true })
    await fs.writeFile(moved, '{}\n')
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-moved' })
    await recordAgentSessions('proj', 'wt-moved', [
      { tool: 'claude', agentSessionId: 'conv-moved' },
    ])
    const db = await getDb()
    await db.update(agentSessions)
      .set({ transcriptPath: '/old/home/.yaac/projects/proj/claude/projects/-workspace/c.jsonl' })
      .where(eq(agentSessions.agentSessionId, 'conv-moved'))

    await importLegacyJsonStores()

    const [row] = await listWorktreeAgentSessions('proj', 'wt-moved')
    expect(row?.transcriptPath).toBe(moved)
  })

  it('drops an absolute path with no recoverable home', async () => {
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-lost' })
    await recordAgentSessions('proj', 'wt-lost', [
      { tool: 'claude', agentSessionId: 'conv-lost' },
    ])
    const db = await getDb()
    await db.update(agentSessions).set({ transcriptPath: '/somewhere/unrelated/c.jsonl' })
      .where(eq(agentSessions.agentSessionId, 'conv-lost'))

    await importLegacyJsonStores()

    const [row] = await listWorktreeAgentSessions('proj', 'wt-lost')
    expect(row?.transcriptPath).toBeUndefined()
  })

  it('leaves a real transcript path untouched', async () => {
    const real = path.join(claudeDir('proj'), 'projects', '-workspace', 'conv-a.jsonl')
    await fs.mkdir(path.dirname(real), { recursive: true })
    await fs.writeFile(real, '{}\n')
    await recordWorktreeCreated({ projectSlug: 'proj', worktreeId: 'wt-claude' })
    await recordAgentSessions('proj', 'wt-claude', [
      { tool: 'claude', agentSessionId: 'conv-a', transcriptPath: real },
    ])

    await importLegacyJsonStores()

    const [row] = await listWorktreeAgentSessions('proj', 'wt-claude')
    expect(row?.transcriptPath).toBe(real)
  })
})

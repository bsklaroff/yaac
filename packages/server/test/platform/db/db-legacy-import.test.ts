import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createTempDataDir, cleanupTempDir, getDataDir } from '@yaac/test-utils/setup'
import { claudeDir, codexTranscriptDir, projectDir } from '@yaac/shared/project-paths'
import { closeDb } from '#platform/db/client'
import { importLegacyJsonStores } from '#platform/db/legacy-import'
import { getDefaultTool, getShortcutOverrides, setDefaultTool } from '#features/projects/preferences'
import { MAX_PROMPT_LENGTH, getProjectSessionRows, listSessionRows } from '#features/sessions/store'
import { loadTokens } from '#http/token-store'

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
    expect((await getProjectSessionRows('alpha')).get('s1')?.title).toBe('fix parser')
    expect((await getProjectSessionRows('alpha')).get('junk')).toBeUndefined()
    expect((await getProjectSessionRows('beta')).get('s2')?.title).toBe('docs pass')
    expect(await exists(titlesPath('alpha'))).toBe(false)
    expect(await exists(titlesPath('beta'))).toBe(false)
  })

  it('imports opencode meta with the file birthtime as createdAt and removes the dir', async () => {
    await fs.mkdir(metaDir('proj'), { recursive: true })
    const file = path.join(metaDir('proj'), 'ocsess.json')
    await fs.writeFile(file, JSON.stringify({ firstMessage: 'build a thing', capturedAt: '2026-05-01T00:00:00.000Z' }))
    const stat = await fs.lstat(file)
    await importLegacyJsonStores()
    const row = (await getProjectSessionRows('proj')).get('ocsess')
    expect(row).toMatchObject({ tool: 'opencode', prompt: 'build a thing' })
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
    expect((await getProjectSessionRows('proj')).get('seeded')?.title).toBe('an older session')

    // Now a *second* data dir state: rows exist, and a transcript-only
    // session appears. A fresh DB replays the migration + import with rows
    // already present.
    const workspaceDir = path.join(claudeDir('proj'), 'projects', '-workspace')
    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.writeFile(path.join(workspaceDir, 'transcript-only.jsonl'), '{}\n')
    await closeDb()
    // Clear the one-shot flag the way a fresh upgrade would: a new DB.
    await fs.rm(path.join(getDataDir(), 'db'), { recursive: true, force: true })
    await importLegacyJsonStores()

    expect((await getProjectSessionRows('proj')).get('transcript-only')).toMatchObject({
      tool: 'claude',
    })
  })

  it('adopts pre-existing transcripts once, then leaves later ones alone', async () => {
    const workspaceDir = path.join(claudeDir('proj'), 'projects', '-workspace')
    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.writeFile(path.join(workspaceDir, 'old-session.jsonl'), '{}\n')
    await importLegacyJsonStores()
    expect((await getProjectSessionRows('proj')).get('old-session')).toMatchObject({
      tool: 'claude',
      transcriptPath: path.join(workspaceDir, 'old-session.jsonl'),
    })

    // A transcript that appears afterwards is a conversation the agent
    // started for itself (`/clear`), not a session — the backfill is done.
    await fs.writeFile(path.join(workspaceDir, 'post-clear.jsonl'), '{}\n')
    await importLegacyJsonStores()
    expect((await getProjectSessionRows('proj')).get('post-clear')).toBeUndefined()
  })

  it('corrects the tool a migrated title row guessed at, from the transcript', async () => {
    await fs.mkdir(projectDir('proj'), { recursive: true })
    const codexDirPath = path.join(codexTranscriptDir('proj'))
    await fs.mkdir(codexDirPath, { recursive: true })
    await fs.writeFile(path.join(codexDirPath, 'cx.jsonl'), '{}\n')
    await fs.writeFile(titlesPath('proj'), JSON.stringify({ cx: 'a codex session' }))
    await importLegacyJsonStores()
    expect((await getProjectSessionRows('proj')).get('cx')).toMatchObject({
      tool: 'codex',
      title: 'a codex session',
    })
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
    const rows = await getProjectSessionRows('proj')
    expect(rows.get('s1')?.title).toBe('spaced out')
    expect(rows.get('oc')?.prompt).toHaveLength(MAX_PROMPT_LENGTH)
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
    expect(await listSessionRows('proj')).toEqual([])
  })
})

import fs from 'node:fs/promises'
import path from 'node:path'
import { getDb, type Db } from './client'
import {
  agentSessions,
  preferences,
  shortcutOverrides,
  tokens,
} from './schema'
import {
  DEFAULT_TOOL_KEY,
  SESSIONS_BACKFILLED_KEY,
  isFlagSet,
  isSerializedChord,
  isValidTool,
  setFlag,
} from '#features/projects'
import { MAX_PROMPT_LENGTH } from '#features/sessions/store'
import { normalizeTitle } from '@yaac/shared/titles'
import { worktreeUpstreamBranch } from '#platform/git'
import { repoDir } from '@yaac/shared/project-paths'
import { scanProjectTranscripts } from '#features/sessions/transcripts'
import { serverLog } from '#log'
import { getDataDir, getProjectsDir } from '@yaac/shared/paths'
import { projectDir } from '@yaac/shared/project-paths'

/**
 * Import-then-delete migration of the legacy JSON stores into the DB:
 * `.preferences.json`, per-project `session-titles.json`, per-project
 * `opencode-meta/<sessionId>.json`, and `tokens.json`. Runs on every server
 * start; steady-state cost is a few stats plus one readdir per project.
 *
 * Per store: parse tolerantly (the same guards the old file loaders used),
 * insert with onConflictDoNothing — an existing DB row wins over a stale
 * re-appearing file — and unlink only after the rows are committed, so a
 * crash mid-import just re-imports harmlessly. A malformed file is logged
 * and left in place. `.web-sessions.json` (pre-token-store web sessions) is
 * neither imported nor touched — those files were already ignored.
 *
 * Alongside them runs the one-shot session backfill (`backfillSessions`),
 * which adopts sessions that predate the `agent_sessions` table.
 *
 * The legacy path builders live here, private: no other code reads these
 * files anymore.
 */

function legacyPreferencesPath(): string {
  return path.join(getDataDir(), '.preferences.json')
}

function legacySessionTitlesPath(slug: string): string {
  return path.join(projectDir(slug), 'session-titles.json')
}

function legacyOpencodeMetaDir(slug: string): string {
  return path.join(projectDir(slug), 'opencode-meta')
}

function legacyTokensPath(): string {
  return path.join(getDataDir(), 'tokens.json')
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8')
  } catch {
    return null
  }
}

/** JSON.parse to a plain object, or null (logged) for anything else. */
function parseObject(p: string, raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through to the log below
  }
  serverLog(`[db] legacy import: leaving malformed ${p}`)
  return null
}

async function importPreferences(db: Db): Promise<void> {
  const p = legacyPreferencesPath()
  const raw = await readIfExists(p)
  if (raw === null) return
  const obj = parseObject(p, raw)
  if (obj === null) return
  const defaultTool =
    typeof obj.defaultTool === 'string' && isValidTool(obj.defaultTool)
      ? obj.defaultTool
      : undefined
  const chords = Object.entries(
    typeof obj.shortcuts === 'object' && obj.shortcuts !== null && !Array.isArray(obj.shortcuts)
      ? obj.shortcuts as Record<string, unknown>
      : {},
  ).flatMap(([commandId, chord]) => isSerializedChord(chord) ? [{ commandId, ...chord }] : [])
  await db.transaction(async (tx) => {
    if (defaultTool !== undefined) {
      await tx.insert(preferences)
        .values({ key: DEFAULT_TOOL_KEY, value: defaultTool })
        .onConflictDoNothing()
    }
    if (chords.length > 0) {
      await tx.insert(shortcutOverrides).values(chords).onConflictDoNothing()
    }
  })
  await fs.unlink(p)
}

async function importSessionTitles(db: Db, slug: string): Promise<void> {
  const p = legacySessionTitlesPath(slug)
  const raw = await readIfExists(p)
  if (raw === null) return
  const obj = parseObject(p, raw)
  if (obj === null) return
  const rows = Object.entries(obj).flatMap(([sessionId, title]) => {
    if (typeof title !== 'string') return []
    // Same normalization a rename goes through, so an imported title can't
    // be a shape the store would never write.
    const normalized = normalizeTitle(title)
    return normalized === '' ? [] : [{ projectSlug: slug, sessionId, title: normalized, tool: 'claude' }]
  })
  for (const row of rows) {
    // A session row may not exist yet (the backfill only sees sessions with
    // a transcript); insert a placeholder so the title isn't lost, and let
    // the tool default to claude — the same guess the SQL data migration
    // makes, corrected by the transcript scan when one exists.
    await db.insert(agentSessions).values(row).onConflictDoUpdate({
      target: [agentSessions.projectSlug, agentSessions.sessionId],
      set: { title: row.title },
    })
  }
  await fs.unlink(p)
}

async function importOpencodeMeta(db: Db, slug: string): Promise<void> {
  const dir = legacyOpencodeMetaDir(slug)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return // no meta dir for this project
  }
  let leftBehind = false
  for (const file of files) {
    const p = path.join(dir, file)
    if (!file.endsWith('.json')) {
      leftBehind = true
      continue
    }
    const raw = await readIfExists(p)
    if (raw === null) {
      leftBehind = true
      continue
    }
    const obj = parseObject(p, raw)
    if (obj === null) {
      leftBehind = true
      continue
    }
    // The meta file's birthtime is what deleted-session listing used to
    // sort by; carry it over as the row's createdAt.
    const stat = await fs.lstat(p)
    // Capped like every other stored prompt (see MAX_PROMPT_LENGTH).
    const firstMessage = typeof obj.firstMessage === 'string'
      ? obj.firstMessage.slice(0, MAX_PROMPT_LENGTH)
      : null
    await db.insert(agentSessions).values({
      projectSlug: slug,
      sessionId: file.slice(0, -'.json'.length),
      tool: 'opencode',
      prompt: firstMessage,
      createdAt: stat.birthtime,
    }).onConflictDoUpdate({
      target: [agentSessions.projectSlug, agentSessions.sessionId],
      set: { tool: 'opencode', prompt: firstMessage },
    })
    await fs.unlink(p)
  }
  if (!leftBehind) {
    try {
      await fs.rmdir(dir)
    } catch {
      // Best-effort: a file that raced in keeps the dir; next boot retries.
    }
  }
}

/**
 * One-shot adoption of sessions that predate the `agent_sessions` table:
 * every session a project's transcripts prove existed becomes a row, and
 * rows the SQL data migration already created (from the old title /
 * deleted / pin / opencode-meta tables) get their guessed `tool` and
 * `createdAt` corrected from the file on disk.
 *
 * Gated on the table being empty rather than a marker row, and deliberately
 * so: once yaac has recorded a single session, an unrecognized transcript is
 * a conversation the agent started for itself (claude's `/clear` mints a new
 * id and file), not a session — adopting those on every boot is exactly the
 * phantom-row behaviour the spine replaces. A fresh install re-scans a few
 * empty directories per boot until its first session, which costs nothing.
 *
 * `prompt` is left for the capture step / the deleted listing to fill
 * lazily, so a data dir with thousands of transcripts doesn't pay a parse
 * per file at startup.
 */
async function backfillSessions(db: Db, slug: string): Promise<void> {
  const records = await scanProjectTranscripts(slug)
  for (const r of records) {
    // The base branch the pre-upgrade session forked from still lives in
    // the shared repo config, and nothing else would ever put it on the
    // row — the display used to read it from git on every tick.
    const baseBranch = await worktreeUpstreamBranch(repoDir(slug), `agent/${r.sessionId}`)
      .catch(() => null)
    const corrected = {
      tool: r.tool,
      createdAt: new Date(r.createdAtMs),
      transcriptPath: r.transcriptPath,
      ...(baseBranch !== null ? { baseBranch } : {}),
    }
    await db.insert(agentSessions)
      .values({ projectSlug: slug, sessionId: r.sessionId, ...corrected })
      .onConflictDoUpdate({
        target: [agentSessions.projectSlug, agentSessions.sessionId],
        // The SQL data migration had to guess `tool` and `created_at` from
        // the folded side tables; the transcript on disk is the better
        // source, so correcting them here is the point of this pass.
        set: corrected,
      })
  }
  if (records.length > 0) {
    serverLog(`[db] adopted ${records.length} pre-existing session(s) in ${slug}`)
  }
}

const TOKEN_KINDS = ['durable', 'one-time', 'web']

async function importTokens(db: Db): Promise<void> {
  const p = legacyTokensPath()
  const raw = await readIfExists(p)
  if (raw === null) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (!Array.isArray(parsed)) {
    serverLog(`[db] legacy import: leaving malformed ${p}`)
    return
  }
  // Same shape guard the old file loader used, including its kind
  // defaulting: entries written before kinds existed were all durable
  // client tokens. DB rows always carry a kind.
  const rows = parsed.flatMap((e: unknown) => {
    if (!e || typeof e !== 'object') return []
    const o = e as Record<string, unknown>
    if (typeof o.name !== 'string' || typeof o.token !== 'string' || typeof o.createdAt !== 'string') return []
    return [{
      name: o.name,
      token: o.token,
      kind: typeof o.kind === 'string' && TOKEN_KINDS.includes(o.kind) ? o.kind : 'durable',
      createdAt: o.createdAt,
      expiresAt: typeof o.expiresAt === 'string' ? o.expiresAt : null,
    }]
  })
  if (rows.length > 0) {
    await db.insert(tokens).values(rows).onConflictDoNothing()
  }
  await fs.unlink(p)
}

/** Run the full sweep. Called by runServer after the lock is held and the
 *  DB is open; any throw is treated as a failed startup there. */
export async function importLegacyJsonStores(): Promise<void> {
  const db = await getDb()
  await importPreferences(db)
  let slugs: string[] = []
  try {
    slugs = await fs.readdir(getProjectsDir())
  } catch {
    // No projects dir yet — nothing per-project to import.
  }
  // Adopt pre-existing sessions before the legacy JSON stores, so a title or
  // opencode snapshot lands on a row that already knows its tool and age.
  //
  // Gated on a durable flag, NOT on the table being empty: the SQL data
  // migration seeds `agent_sessions` from the four folded side tables and
  // runs (inside getDb) before this does, so any install that ever titled a
  // session would look "already populated" and skip adoption forever —
  // leaving the migration's guessed tool/createdAt in place and never
  // adopting transcript-only sessions.
  const backfilled = await isFlagSet(SESSIONS_BACKFILLED_KEY)
  for (const slug of slugs) {
    if (!backfilled) await backfillSessions(db, slug)
    await importSessionTitles(db, slug)
    await importOpencodeMeta(db, slug)
  }
  if (!backfilled) await setFlag(SESSIONS_BACKFILLED_KEY)
  await importTokens(db)
}

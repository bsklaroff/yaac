import fs from 'node:fs/promises'
import path from 'node:path'
import { getDb, type Db } from '#platform/db/client'
import {
  opencodeSessionMeta,
  preferences,
  sessionTitles,
  shortcutOverrides,
  tokens,
} from '#platform/db/schema'
import { DEFAULT_TOOL_KEY, isSerializedChord, isValidTool } from '#features/projects/preferences'
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
  const rows = Object.entries(obj).flatMap(([sessionId, title]) =>
    typeof title === 'string' && title !== '' ? [{ projectSlug: slug, sessionId, title }] : [])
  if (rows.length > 0) {
    await db.insert(sessionTitles).values(rows).onConflictDoNothing()
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
    await db.insert(opencodeSessionMeta).values({
      projectSlug: slug,
      sessionId: file.slice(0, -'.json'.length),
      firstMessage: typeof obj.firstMessage === 'string' ? obj.firstMessage : null,
      capturedAt: typeof obj.capturedAt === 'string' ? obj.capturedAt : null,
      createdAt: stat.birthtime,
    }).onConflictDoNothing()
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
  for (const slug of slugs) {
    await importSessionTitles(db, slug)
    await importOpencodeMeta(db, slug)
  }
  await importTokens(db)
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { and, eq, isNotNull } from 'drizzle-orm'
import { getDb, type Db } from './client'
import {
  agentSessions,
  preferences,
  shortcutOverrides,
  tokens,
  worktreeAgentSessions,
  worktrees,
} from './schema'
import { DEFAULT_TOOL_KEY, SESSIONS_BACKFILLED_KEY, TRANSCRIPT_PATHS_PROJECT_KEY, TRANSCRIPT_PATHS_RELATIVE_KEY, TRANSCRIPT_PATHS_RESOLVED_KEY, TRANSCRIPT_SYMLINKS_PURGED_KEY, isFlagSet, isSerializedChord, isValidTool, setFlag } from '#features/records'
import { MAX_PROMPT_LENGTH } from '@yaac/shared/herd'
import { normalizeTitle } from '@yaac/shared/titles'
import { worktreeUpstreamBranch } from '#platform/git'
import { codexTranscriptDir, repoDir } from '@yaac/shared/project-paths'
import {
  resolveProjectPath,
  scanProjectTranscripts,
  toProjectRelative,
} from '#features/agents'
import { serverLog } from '#log'
import { getProjectsDir, serverLocalPath } from '@yaac/shared/paths'
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
 * Alongside them runs the one-shot worktree backfill (`backfillWorktrees`),
 * which adopts worktrees that predate the `agent_sessions` table.
 *
 * The legacy path builders live here, private: no other code reads these
 * files anymore.
 */

function legacyPreferencesPath(): string {
  return serverLocalPath('.preferences.json')
}

function legacySessionTitlesPath(slug: string): string {
  return path.join(projectDir(slug), 'session-titles.json')
}

function legacyOpencodeMetaDir(slug: string): string {
  return path.join(projectDir(slug), 'opencode-meta')
}

function legacyTokensPath(): string {
  return serverLocalPath('tokens.json')
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
  const rows = Object.entries(obj).flatMap(([worktreeId, title]) => {
    if (typeof title !== 'string') return []
    // Same normalization a rename goes through, so an imported title can't
    // be a shape the store would never write.
    const normalized = normalizeTitle(title)
    return normalized === '' ? [] : [{ projectSlug: slug, worktreeId, title: normalized, tool: 'claude' }]
  })
  for (const row of rows) {
    // A worktree row may not exist yet (the backfill only sees worktrees with
    // a transcript); insert a placeholder so the title isn't lost, and let
    // the tool default to claude — the same guess the SQL data migration
    // makes, corrected by the transcript scan when one exists.
    await db.insert(worktrees).values(row).onConflictDoUpdate({
      target: [worktrees.projectSlug, worktrees.worktreeId],
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
    // The meta file's birthtime is what deleted-worktree listing used to
    // sort by; carry it over as the row's createdAt.
    const stat = await fs.lstat(p)
    // Capped like every other stored prompt (see MAX_PROMPT_LENGTH).
    const firstMessage = typeof obj.firstMessage === 'string'
      ? obj.firstMessage.slice(0, MAX_PROMPT_LENGTH)
      : null
    const worktreeId = file.slice(0, -'.json'.length)
    await db.insert(worktrees).values({
      projectSlug: slug,
      worktreeId,
      createdAt: stat.birthtime,
    }).onConflictDoNothing({
      target: [worktrees.projectSlug, worktrees.worktreeId],
    })
    // The tool and the first message live on the conversation, which for a
    // pre-split worktree is the one pinned to its id.
    await linkPreUpgradeAgentSession(db, slug, worktreeId, 'opencode', {
      createdAt: stat.birthtime,
      firstPrompt: firstMessage,
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
 * One-shot adoption of worktrees that predate the `agent_sessions` table:
 * every worktree a project's transcripts prove existed becomes a row, and
 * rows the SQL data migration already created (from the old title /
 * deleted / pin / opencode-meta tables) get their guessed `tool` and
 * `createdAt` corrected from the file on disk.
 *
 * Gated on the table being empty rather than a marker row, and deliberately
 * so: once yaac has recorded a single worktree, an unrecognized transcript is
 * a conversation the agent started for itself (claude's `/clear` mints a new
 * id and file), not a worktree — adopting those on every boot is exactly the
 * phantom-row behaviour the spine replaces. A fresh install re-scans a few
 * empty directories per boot until its first worktree, which costs nothing.
 *
 * `prompt` is left for the capture step / the deleted listing to fill
 * lazily, so a data dir with thousands of transcripts doesn't pay a parse
 * per file at startup.
 */
async function backfillWorktrees(db: Db, slug: string): Promise<void> {
  const records = await scanProjectTranscripts(slug)
  for (const r of records) {
    // The base branch the pre-upgrade worktree forked from still lives in
    // the shared repo config, and nothing else would ever put it on the
    // row — the display used to read it from git on every tick.
    const baseBranch = await worktreeUpstreamBranch(repoDir(slug), `agent/${r.worktreeId}`)
      .catch(() => null)
    const corrected = {
      tool: r.tool,
      createdAt: new Date(r.createdAtMs),
      transcriptPath: r.transcriptPath,
      ...(baseBranch !== null ? { baseBranch } : {}),
    }
    const { transcriptPath, ...worktreeFields } = corrected
    await db.insert(worktrees)
      .values({ projectSlug: slug, worktreeId: r.worktreeId, ...worktreeFields })
      .onConflictDoUpdate({
        target: [worktrees.projectSlug, worktrees.worktreeId],
        // The SQL data migration had to guess `tool` and `created_at` from
        // the folded side tables; the transcript on disk is the better
        // source, so correcting them here is the point of this pass.
        set: worktreeFields,
      })
    // A pre-upgrade session pinned the agent's conversation id to the
    // worktree id, so its one conversation is knowable without any link
    // tree — record it so every downstream path sees a uniform model.
    await linkPreUpgradeAgentSession(db, slug, r.worktreeId, r.tool, {
      createdAt: new Date(r.createdAtMs),
      transcriptPath,
    })
  }
  if (records.length > 0) {
    serverLog(`[db] adopted ${records.length} pre-existing session(s) in ${slug}`)
  }
}

/**
 * Record the single agent session a pre-upgrade worktree had, and link it
 * active. Everything before the split ran `claude --session-id <worktreeId>`
 * (and the codex/pi equivalents), so the conversation id IS the worktree id —
 * this is a fact, not a guess. Marked active so a restart brings the worktree
 * back exactly as it would have before.
 */
async function linkPreUpgradeAgentSession(
  db: Db,
  slug: string,
  worktreeId: string,
  tool: string,
  fields: { createdAt: Date; transcriptPath?: string | undefined; firstPrompt?: string | null },
): Promise<void> {
  // The scan hands back absolute paths; the column is project-relative.
  const stored = fields.transcriptPath !== undefined
    ? await toProjectRelative(slug, fields.transcriptPath)
    : null
  await db.insert(agentSessions).values({
    projectSlug: slug,
    tool,
    agentSessionId: worktreeId,
    createdAt: fields.createdAt,
    transcriptPath: stored,
    firstPrompt: fields.firstPrompt ?? null,
  }).onConflictDoUpdate({
    target: [agentSessions.projectSlug, agentSessions.tool, agentSessions.agentSessionId],
    set: {
      createdAt: fields.createdAt,
      ...(stored !== null ? { transcriptPath: stored } : {}),
    },
  })
  await db.insert(worktreeAgentSessions).values({
    projectSlug: slug,
    worktreeId,
    tool,
    agentSessionId: worktreeId,
    active: true,
    ordinal: 0,
    firstSeenAt: fields.createdAt,
    lastSeenAt: fields.createdAt,
  }).onConflictDoNothing()
}

/**
 * One-shot: rewrite transcript paths from the tool-home-relative form the
 * column used to store to the project-relative form it stores now.
 *
 * Purely textual, and that is the whole point: every tool home is
 * `<projectDir>/<tool>`, so the conversion is the row's own `tool` prepended.
 * The passes it runs beside cannot say that — theirs depend on `getDataDir()`
 * and on the disk — which is why this one could have been a `migration.sql`
 * and they could not. It is a startup pass anyway, because migrations run in
 * `getDb()` *before* this sweep: a row still holding an absolute path would be
 * skipped by the migration, then relativized by the sweep into the old form,
 * and nothing would ever convert it.
 *
 * Idempotent, so a lost flag costs a scan and nothing else: a path already in
 * the new form starts with its row's tool segment, and no tool-home-relative
 * path does — claude's start `projects/`, pi's `agent/`, codex's with the
 * rollout's own directory.
 */
async function projectRelativeTranscriptPaths(db: Db): Promise<void> {
  if (await isFlagSet(TRANSCRIPT_PATHS_PROJECT_KEY)) return
  const rows = await db.select({
    projectSlug: agentSessions.projectSlug,
    tool: agentSessions.tool,
    agentSessionId: agentSessions.agentSessionId,
    transcriptPath: agentSessions.transcriptPath,
  }).from(agentSessions).where(isNotNull(agentSessions.transcriptPath))

  let rewritten = 0
  for (const r of rows) {
    // Absolute rows belong to the pass below, which has the data dir and the
    // re-home fallback this one deliberately lacks.
    if (r.transcriptPath === null || path.isAbsolute(r.transcriptPath)) continue
    if (r.transcriptPath.startsWith(`${r.tool}${path.sep}`)) continue
    await db.update(agentSessions)
      .set({ transcriptPath: path.join(r.tool, r.transcriptPath) })
      .where(and(
        eq(agentSessions.projectSlug, r.projectSlug),
        eq(agentSessions.tool, r.tool),
        eq(agentSessions.agentSessionId, r.agentSessionId),
      ))
    rewritten++
  }
  await setFlag(TRANSCRIPT_PATHS_PROJECT_KEY)
  if (rewritten > 0) {
    serverLog(`[db] rewrote ${rewritten} transcript path(s) to project-relative`)
  }
}

/**
 * The project-relative tail of an absolute path that a *different* data dir
 * wrote — the restored-backup case, where the path names a project tree this
 * install does not have and so `toProjectRelative` cannot express it.
 *
 * Every project tree is `<root>/projects/<slug>`, so that boundary is enough
 * to recover the tail without the old root existing. The *last* occurrence
 * wins: a path from inside a yaac-in-yaac data dir repeats the marker, and the
 * innermost one is the real tree.
 *
 * Lives here rather than beside the encoders because it is migration-only —
 * nothing that runs in the steady state has an absolute path to re-home.
 */
function rehomeProjectPath(slug: string, absolute: string): string | null {
  const marker = `${path.sep}${path.join('projects', slug)}${path.sep}`
  const at = absolute.lastIndexOf(marker)
  if (at < 0) return null
  const rel = absolute.slice(at + marker.length)
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel
}

/**
 * Rewrite absolute recorded transcript paths to the project-relative form the
 * column now stores (`toProjectRelative`).
 *
 * Every path written before this existed carried the data dir, so the rows
 * only resolved on the machine and in the directory that wrote them.
 *
 * A path that is not inside this install's project tree is one the data dir
 * has *moved* out from under (a restored backup, a changed `YAAC_DATA_DIR`).
 * Those are re-homed rather than dropped: the row names its project, and
 * every tree is `<root>/projects/<slug>`, so the tail survives the move on
 * its own. Waiting for the reconciler instead would strand them — it visits
 * only *running* worktrees, and after a restore nothing is running, so a
 * stopped worktree that never restarts would lose the pointer for good while
 * its transcript sat intact in the new data dir. Only a path with no
 * recoverable tail at all becomes NULL.
 *
 * Not a `migration.sql`: the relative form depends on `getDataDir()`, which
 * SQL cannot see. (The pass above it can be, and says why it is not.)
 */
async function relativizeTranscriptPaths(db: Db): Promise<void> {
  if (await isFlagSet(TRANSCRIPT_PATHS_RELATIVE_KEY)) return
  const rows = await db.select({
    projectSlug: agentSessions.projectSlug,
    tool: agentSessions.tool,
    agentSessionId: agentSessions.agentSessionId,
    transcriptPath: agentSessions.transcriptPath,
  }).from(agentSessions).where(isNotNull(agentSessions.transcriptPath))

  let rewritten = 0
  let rehomed = 0
  let dropped = 0
  for (const r of rows) {
    // Already relative — a row written since the change, or a re-run.
    if (r.transcriptPath === null || !path.isAbsolute(r.transcriptPath)) continue
    const inProject = await toProjectRelative(r.projectSlug, r.transcriptPath)
    // Not under this install's project dir means the data dir moved. The row
    // still names its project, and every project tree is
    // `<root>/projects/<slug>`, so the tail is recoverable outright — no
    // waiting for the worktree to run again, which for a stopped one may be
    // never.
    const stored = inProject ?? rehomeProjectPath(r.projectSlug, r.transcriptPath)
    await db.update(agentSessions).set({ transcriptPath: stored }).where(and(
      eq(agentSessions.projectSlug, r.projectSlug),
      eq(agentSessions.tool, r.tool),
      eq(agentSessions.agentSessionId, r.agentSessionId),
    ))
    if (stored === null) dropped++
    else if (inProject === null) rehomed++
    else rewritten++
  }
  await setFlag(TRANSCRIPT_PATHS_RELATIVE_KEY)
  if (rewritten > 0 || rehomed > 0 || dropped > 0) {
    serverLog(
      `[db] relativized ${rewritten} transcript path(s), `
      + `re-homed ${rehomed} from a moved data dir, dropped ${dropped}`,
    )
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
  // Adopt pre-existing worktrees before the legacy JSON stores, so a title or
  // opencode snapshot lands on a row that already knows its tool and age.
  //
  // Gated on a durable flag, NOT on the table being empty: the SQL data
  // migration seeds `agent_sessions` from the four folded side tables and
  // runs (inside getDb) before this does, so any install that ever titled a
  // worktree would look "already populated" and skip adoption forever —
  // leaving the migration's guessed tool/createdAt in place and never
  // adopting transcript-only worktrees.
  const backfilled = await isFlagSet(SESSIONS_BACKFILLED_KEY)
  for (const slug of slugs) {
    if (!backfilled) await backfillWorktrees(db, slug)
    await importSessionTitles(db, slug)
    await importOpencodeMeta(db, slug)
  }
  if (!backfilled) await setFlag(SESSIONS_BACKFILLED_KEY)
  // The three transcript-path steps run in this order for one reason each,
  // and none of them commutes.
  //
  // The project-relative rewrite goes first because it is the only one that
  // can recognize the OLD relative form: once the other two have run, every
  // row is either absolute or project-relative, and a tool-home-relative row
  // reaching them would be read against the wrong root.
  //
  // The absolute rewrite goes before the symlink resolve because it is pure
  // re-encoding of the column and never touches the disk, while that one
  // interprets the stored path against the disk and reads an unstattable path
  // as a symlink someone deleted. Run the other way round, every row from a
  // moved data dir would be nulled as a dead symlink before it could be
  // re-homed.
  await projectRelativeTranscriptPaths(db)
  await relativizeTranscriptPaths(db)
  await resolveSymlinkedTranscripts(db)
  // Last, and only here: the symlinks the step above reads are the same ones
  // this deletes. It is a separate flag rather than a tail on that function
  // so a crash between the two retries the deletion instead of stranding the
  // links behind a flag that is already set.
  await purgeTranscriptSymlinks(slugs)
  await importTokens(db)
}

/**
 * Delete the codex transcript symlinks, now that no row names one.
 *
 * `.yaac-transcripts/<agentSessionId>.jsonl` was yaac's own index into codex's
 * rollout files, maintained by the in-pod hook; the recorded path replaced it,
 * and `resolveSymlinkedTranscripts` above has rewritten every row that still
 * pointed at one to the file behind it. What is left is a directory of links
 * nothing writes and nothing follows.
 *
 * It has to come after BOTH one-shots that read the directory — the row
 * rewrite, and `backfillWorktrees`, for which `scanProjectTranscripts` treats
 * this dir as codex's transcript root. Deleting a link before either would
 * cost a worktree its path, or lose it from the adoption entirely.
 *
 * Symlinks only, and the directory only if it empties. The path is still
 * codex's scan root, so a regular file that landed there is a transcript
 * someone would want; and `rmdir` on a non-empty directory failing is the
 * check, not an error.
 *
 * The flag is set only when every removal succeeded, because the flag is the
 * whole retry story — one stranded by an EACCES would never be reached again.
 * A directory that cannot be *read* counts as a failure for the same reason;
 * only ENOENT means "no index dir here". The cost of a permanent failure is
 * one readdir per project per server start, which is what the flag was
 * saving in the first place.
 */
async function purgeTranscriptSymlinks(slugs: string[]): Promise<void> {
  if (await isFlagSet(TRANSCRIPT_SYMLINKS_PURGED_KEY)) return
  let removed = 0
  let failed = 0
  for (const slug of slugs) {
    const dir = codexTranscriptDir(slug)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed++
      continue
    }
    for (const name of entries) {
      const p = path.join(dir, name)
      // lstat, so a real file is never mistaken for the link that used to
      // stand in front of it.
      const st = await fs.lstat(p).catch(() => null)
      if (st === null || !st.isSymbolicLink()) continue
      await fs.unlink(p).then(() => { removed++ }).catch(() => { failed++ })
    }
    await fs.rmdir(dir).catch(() => { /* still holds real transcripts */ })
  }
  if (failed === 0) await setFlag(TRANSCRIPT_SYMLINKS_PURGED_KEY)
  if (removed > 0) serverLog(`[db] removed ${removed} legacy transcript symlink(s)`)
  if (failed > 0) serverLog(`[db] ${failed} legacy transcript symlink(s) left for the next start`)
}

/**
 * Rewrite recorded transcript paths that point at a yaac-made symlink to the
 * file behind it.
 *
 * yaac used to index codex's transcripts with a symlink per worktree
 * (`.yaac-transcripts/<id>.jsonl`) because codex names its rollout files
 * unpredictably and there is no way to derive one from a worktree id. Capture
 * stored *that* path, so every codex row recorded before the hook began
 * reporting one points at a symlink rather than at a transcript — and nothing
 * maintains those symlinks now, so the ones on disk are the last that will
 * ever exist.
 *
 * Resolving them is what lets the symlinks go (`purgeTranscriptSymlinks`
 * takes them right after): afterwards the DB holds a real path for every row,
 * which is the only thing any reader needs. Must run
 * while the old symlinks are still present, which is why it lives in the
 * startup sweep rather than in a migration — SQL cannot follow a symlink.
 *
 * A dangling one becomes NULL: a path that resolves nowhere is worse than no
 * path, since every reader would keep stat-ing it forever. So does one that is
 * already gone — the era this targets recorded symlink paths, so a path that
 * `lstat` cannot see at all is a symlink someone deleted, which is the same
 * dead end by a different route.
 */
async function resolveSymlinkedTranscripts(db: Db): Promise<void> {
  if (await isFlagSet(TRANSCRIPT_PATHS_RESOLVED_KEY)) return
  const rows = await db.select({
    projectSlug: agentSessions.projectSlug,
    tool: agentSessions.tool,
    agentSessionId: agentSessions.agentSessionId,
    transcriptPath: agentSessions.transcriptPath,
  }).from(agentSessions).where(isNotNull(agentSessions.transcriptPath))

  let resolved = 0
  for (const r of rows) {
    if (r.transcriptPath === null) continue
    // Work in absolute space: the column is project-relative, and a relative
    // path handed to lstat would resolve against the cwd — every row would
    // look like a symlink someone deleted and be nulled.
    const abs = resolveProjectPath(r.projectSlug, r.transcriptPath)
    if (abs === undefined) continue
    const link = await fs.lstat(abs).catch(() => null)
    if (link !== null && !link.isSymbolicLink()) continue
    const target = await fs.realpath(abs).catch(() => null)
    const stored = target === null
      ? null
      : await toProjectRelative(r.projectSlug, target)
    await db.update(agentSessions).set({ transcriptPath: stored }).where(and(
      eq(agentSessions.projectSlug, r.projectSlug),
      eq(agentSessions.tool, r.tool),
      eq(agentSessions.agentSessionId, r.agentSessionId),
    ))
    resolved++
  }
  await setFlag(TRANSCRIPT_PATHS_RESOLVED_KEY)
  if (resolved > 0) serverLog(`[db] resolved ${resolved} symlinked transcript path(s)`)
}

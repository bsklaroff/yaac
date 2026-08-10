import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { worktreeMetaDir, worktreeMetaPath } from '@yaac/shared/project-paths'
import { AGENT_TOOLS } from '@yaac/shared/types'
import { MAX_PROMPT_LENGTH } from '@yaac/shared/types'

/**
 * Readers for the per-worktree metadata document a previous yaac kept beside
 * the session-starts log, so its contents can be moved into rows once and the
 * files removed (`importLegacyMeta` in #domain/worktrees).
 *
 * Rows are the durable account of a worktree now. This exists only to carry
 * an existing install across: conversations would be rediscovered from the
 * logs anyway, but `spare` would not, and an unclaimed spare whose flag was
 * forgotten leaks its checkout forever. Delete this module — and its
 * `meta/<id>.json` files — once no install can still be carrying them.
 *
 * That asymmetry is why nothing here deletes a document it failed to read.
 * The two facts worth importing are exactly the two that cannot be recovered
 * from anywhere else, so a corrupt document is set aside for a hand recovery
 * (`setAsideUnreadableMeta`) rather than swept with the junk.
 */

const sessionSchema = z.object({
  agentSessionId: z.string().min(1),
  tool: z.enum(AGENT_TOOLS),
  mode: z.enum(['tui', 'acp']),
  firstSeenMs: z.number().int().nonnegative(),
  transcriptPath: z.string().optional(),
  firstPrompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
  handle: z.string().optional(),
  handleLifeId: z.string().optional(),
})

/**
 * Deliberately laxer than the writer's schema was: this reads documents it
 * will never write back, so anything it can salvage is worth taking.
 *
 * `sessions` is validated per entry rather than as a whole, because the two
 * facts that make this import necessary — `spare` and the life offset — do
 * not depend on it. Failing the document on one malformed session line would
 * throw away the flag that keeps a spare's checkout collectable.
 */
const metaSchema = z.object({
  projectSlug: z.string().min(1),
  worktreeId: z.string().min(1),
  createdAtMs: z.number().int().nonnegative().optional(),
  baseBranch: z.string().optional(),
  spare: z.boolean().optional(),
  life: z.object({ id: z.string(), logBytes: z.number().int().nonnegative() }).optional(),
  sessions: z.array(z.unknown()).default([]),
})

export interface LegacyWorktreeMeta extends Omit<z.infer<typeof metaSchema>, 'sessions'> {
  sessions: Array<z.infer<typeof sessionSchema>>
  /** The file it came from — deleted only once its contents are in rows. */
  file: string
}

/**
 * Every document a project still has, the `.tmp-*` rewrites that died between
 * write and rename, and the documents this build could not read.
 *
 * The three are separated because only two of them are safe to delete. A
 * `.tmp-*` file is unconditional junk — it belongs to no worktree and nothing
 * else will ever collect it — and a document is deletable once its contents
 * are in rows. A document that will not parse is neither: the facts this
 * import exists for are precisely the ones nothing can reconstruct, so
 * deleting it would silently and irreversibly lose a spare's flag (its
 * checkout then never collected, because no sweep can tell it from a stopped
 * worktree) or a live worktree's log offset (its next fold reading the whole
 * log as the current pod's). It is set aside for a hand recovery instead.
 */
export async function readLegacyMetaDocuments(projectSlug: string): Promise<{
  documents: LegacyWorktreeMeta[]
  /** `.tmp-*` leftovers — deletable on sight. */
  junk: string[]
  /** Documents that would not parse. Renamed, never deleted. */
  unreadable: string[]
}> {
  let entries: string[]
  try {
    entries = await fs.readdir(worktreeMetaDir(projectSlug))
  } catch {
    return { documents: [], junk: [], unreadable: [] }
  }
  const documents: LegacyWorktreeMeta[] = []
  const junk: string[] = []
  const unreadable: string[] = []
  for (const name of entries) {
    if (name.includes('.tmp-')) {
      junk.push(path.join(worktreeMetaDir(projectSlug), name))
      continue
    }
    if (!name.endsWith('.json')) continue
    const worktreeId = name.slice(0, -'.json'.length)
    const file = worktreeMetaPath(projectSlug, worktreeId)
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      unreadable.push(file)
      continue
    }
    const result = metaSchema.safeParse(parsed)
    if (!result.success) {
      unreadable.push(file)
      continue
    }
    // Per entry, so one malformed session line costs its own conversation
    // rather than the document's `spare` and `life`, which do not depend on
    // it. A dropped conversation is rediscovered from the log; those two
    // are not.
    const sessions = result.data.sessions.flatMap((s) => {
      const parsedSession = sessionSchema.safeParse(s)
      return parsedSession.success ? [parsedSession.data] : []
    })
    documents.push({ ...result.data, sessions, file })
  }
  return { documents, junk, unreadable }
}

/** Remove the files the import has finished with. Best-effort: a survivor is
 *  re-imported next start, and the import is idempotent. */
export async function deleteLegacyMetaFiles(files: string[]): Promise<void> {
  await Promise.all(files.map((f) => fs.rm(f, { force: true }).catch(() => undefined)))
}

/**
 * Set an unreadable document aside as `<id>.json.bad`.
 *
 * Renamed rather than left in place for two reasons: the import would
 * otherwise re-read and re-fail it on every server start, and the tell for
 * retiring this module — a `meta/` directory holding nothing but
 * `*.session-starts.jsonl` — has to stay answerable by extension. The bytes
 * survive either way, which is the whole point.
 */
export async function setAsideUnreadableMeta(files: string[]): Promise<void> {
  await Promise.all(files.map((f) =>
    fs.rename(f, `${f}.bad`).catch(() => undefined)))
}

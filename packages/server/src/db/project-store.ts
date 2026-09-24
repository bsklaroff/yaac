import fs from 'node:fs/promises'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { projects, projectToolDefaults } from './schema'
import { notifyWorktreeListChanged } from '#notify'
import { getProjectsDir } from '@yaac/shared/project-paths'
import {
  normalizeTool,
  type AgentMode,
  type AgentTool,
  type PermissionMode,
  type ProjectMeta,
  type ToolCreateDefaults,
} from '@yaac/shared/types'

/**
 * Which projects exist, as the server records them.
 *
 * The clone, the config and the tool homes are the substrate's bytes; this is
 * the metadata, so that answering "which projects are there" never depends on
 * a filesystem the server may not share (docs/layered-server.md).
 */
export async function recordProject(
  meta: ProjectMeta,
  gitCredential?: { id: string; knownHostsEntry: string | null },
): Promise<void> {
  const db = await getDb()
  await db.insert(projects).values({
    ...meta,
    gitCredentialId: gitCredential?.id ?? null,
    knownHostsEntry: gitCredential?.knownHostsEntry ?? null,
  }).onConflictDoUpdate({
    target: projects.slug,
    set: {
      remoteUrl: meta.remoteUrl,
      // A host key was trusted for the remote it was fetched from; a
      // different remote has to earn its own.
      knownHostsEntry: sql`case when ${projects.remoteUrl} = excluded.remote_url
        then ${projects.knownHostsEntry} end`,
    },
  })
  notifyWorktreeListChanged()
}

/**
 * Assign the project's git credential, with the host key that goes with it
 * (null for an https token). Written together because a host key was
 * trusted for one credential's assignment; the next one fetches its own.
 * False when there is no such project.
 */
export async function setProjectGitCredential(
  slug: string,
  gitCredentialId: string,
  knownHostsEntry: string | null,
): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(projects).set({ gitCredentialId, knownHostsEntry })
    .where(eq(projects.slug, slug)).returning({ slug: projects.slug })
  notifyWorktreeListChanged()
  return rows.length > 0
}

/**
 * A project as this table holds it: its `project.json` identity plus the
 * create form's memory only the rows carry. Separate from `ProjectMeta`
 * because that type is also the shape of `project.json` on disk, and the
 * memory is not something the file has ever had.
 */
export interface ProjectRow extends ProjectMeta {
  lastTool?: AgentTool
  createDefaults: Partial<Record<AgentTool, ToolCreateDefaults>>
  gitCredentialId: string | null
  /** The remote's host key, for an SSH credential. Null for a token, and
   *  once the remote changed — until the key is assigned again. */
  knownHostsEntry: string | null
}

type DefaultsRow = typeof projectToolDefaults.$inferSelect

/** Read back with casts, like the worktree posture column: every value here
 *  is re-checked against the tool before anything launches with it. */
function toProjectRow(
  r: typeof projects.$inferSelect,
  defaults: DefaultsRow[],
): ProjectRow {
  const createDefaults: Partial<Record<AgentTool, ToolCreateDefaults>> = {}
  for (const d of defaults) {
    createDefaults[normalizeTool(d.tool)] = {
      ...(d.model !== null ? { model: d.model } : {}),
      ...(d.permissionMode !== null ? { permissionMode: d.permissionMode as PermissionMode } : {}),
      ...(d.mode !== null ? { mode: d.mode as AgentMode } : {}),
    }
  }
  return {
    slug: r.slug,
    remoteUrl: r.remoteUrl,
    addedAt: r.addedAt,
    ...(r.lastTool !== null ? { lastTool: normalizeTool(r.lastTool) } : {}),
    createDefaults,
    gitCredentialId: r.gitCredentialId,
    knownHostsEntry: r.knownHostsEntry,
  }
}

export async function getProjectRow(slug: string): Promise<ProjectRow | undefined> {
  await adoptProjectDirs()
  const db = await getDb()
  const rows = await db.select().from(projects).where(eq(projects.slug, slug))
  if (rows[0] === undefined) return undefined
  const defaults = await db.select().from(projectToolDefaults)
    .where(eq(projectToolDefaults.projectSlug, slug))
  return toProjectRow(rows[0], defaults)
}

export async function listProjectRows(): Promise<ProjectRow[]> {
  await adoptProjectDirs()
  const db = await getDb()
  const [rows, defaults] = await Promise.all([
    db.select().from(projects),
    db.select().from(projectToolDefaults),
  ])
  return rows.map((r) => toProjectRow(r, defaults.filter((d) => d.projectSlug === r.slug)))
}

/**
 * Remember a create as the project's next defaults: `tool` becomes the agent
 * this project was last created with, and whichever of model, posture and
 * mode the request named become that agent's. A field the request left out
 * is left as it was — a create that took the resolved default for a field
 * must not overwrite what a person picked for it.
 *
 * Called by the create route alone, since only there is the choice known to
 * be a person's rather than a restart's, a prewarm's or the spawn policy's.
 */
export async function recordProjectCreate(
  slug: string,
  tool: AgentTool,
  picked: ToolCreateDefaults,
): Promise<void> {
  const db = await getDb()
  const set = {
    ...(picked.model !== undefined ? { model: picked.model } : {}),
    ...(picked.permissionMode !== undefined ? { permissionMode: picked.permissionMode } : {}),
    ...(picked.mode !== undefined ? { mode: picked.mode } : {}),
  }
  await db.transaction(async (tx) => {
    const updated = await tx.update(projects).set({ lastTool: tool })
      .where(eq(projects.slug, slug)).returning({ slug: projects.slug })
    // No such project (the create is about to fail for it): nothing to
    // remember, and a row here would be inherited by a later project of the
    // same name.
    if (updated.length === 0) return
    const insert = tx.insert(projectToolDefaults).values({ projectSlug: slug, tool, ...set })
    // An empty `set` is an error rather than a no-op, so a create that named
    // nothing but its tool only makes sure the row exists.
    await (Object.keys(set).length > 0
      ? insert.onConflictDoUpdate({
        target: [projectToolDefaults.projectSlug, projectToolDefaults.tool],
        set,
      })
      : insert.onConflictDoNothing())
  })
  notifyWorktreeListChanged()
}

export async function deleteProjectRow(slug: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.delete(projectToolDefaults).where(eq(projectToolDefaults.projectSlug, slug))
    await tx.delete(projects).where(eq(projects.slug, slug))
  })
  notifyWorktreeListChanged()
}

/**
 * Turn a `project.json` with no row into a row on sight — the last code that
 * enumerates the projects directory, and the reason an existing install does
 * not lose its projects the first time it runs a yaac that reads rows.
 *
 * Deliberately NOT one-shot. A durable "already migrated" flag would make a
 * directory that appears *after* the first read invisible forever, and there
 * is no window in which that cannot happen — a second yaac writing into the
 * same data dir, a restored backup, a manual copy. Re-adoption cannot
 * resurrect a removed project either, because removal takes the directory
 * with it.
 *
 * It dies when the substrate stops sharing the server's filesystem, at which
 * point every project arrived through `recordProject`.
 */
async function adoptProjectDirs(): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(getProjectsDir())
  } catch {
    return // no projects directory: nothing to adopt
  }
  const db = await getDb()
  const known = new Set((await db.select({ slug: projects.slug }).from(projects))
    .map((r) => r.slug))
  for (const entry of entries) {
    if (known.has(entry)) continue
    let meta: ProjectMeta
    try {
      meta = JSON.parse(
        await fs.readFile(path.join(getProjectsDir(), entry, 'project.json'), 'utf8'),
      ) as ProjectMeta
    } catch {
      continue // not a project directory, or malformed — skip it
    }
    if (typeof meta.slug !== 'string' || typeof meta.remoteUrl !== 'string') continue
    // The directory name IS the slug — every path yaac builds for a project
    // comes from `projectDir(slug)`. A file claiming a different one does not
    // describe this directory, and adopting it would both point a row at
    // bytes that are elsewhere and, because the dedupe key above is the
    // directory name, re-record it on every read — overwriting the real row's
    // remote on each pass.
    if (meta.slug !== entry) continue
    await recordProject({
      slug: meta.slug,
      remoteUrl: meta.remoteUrl,
      addedAt: meta.addedAt ?? new Date().toISOString(),
    })
  }
}

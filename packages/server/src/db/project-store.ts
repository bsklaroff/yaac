import { eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { projects, projectToolDefaults } from './schema'
import { notifyWorkspaceListChanged } from '#notify'
import { nullsToUndefined } from '#lib/nulls'
import type { AgentTool, ProjectMeta, ToolCreateDefaults } from '@yaac/shared/types'

/*
 * Which projects exist, as the server records them. The clone, config and
 * tool homes live on the substrate; these rows let the server list projects
 * without reading a filesystem it may not share (docs/layered-server.md).
 */

/** Record a project, owned by `owner` if new; a known id keeps its
 *  owner. */
export async function recordProject(
  meta: ProjectMeta,
  owner: string,
  gitCredential?: { id: string; knownHostsEntry: string | null },
): Promise<void> {
  const db = await getDb()
  await db.insert(projects).values({
    ...meta,
    owner,
    gitCredentialId: gitCredential?.id ?? null,
    knownHostsEntry: gitCredential?.knownHostsEntry ?? null,
  }).onConflictDoUpdate({
    target: projects.id,
    set: {
      remoteUrl: meta.remoteUrl,
      // A trusted host key belongs to one remote; a new remote needs its own.
      knownHostsEntry: sql`case when ${projects.remoteUrl} = excluded.remote_url
        then ${projects.knownHostsEntry} end`,
    },
  })
  notifyWorkspaceListChanged()
}

/**
 * Assign the project's git credential together with its trusted host key
 * (null for an https token); each assignment fetches its own host key.
 * False when there is no such project.
 */
export async function setProjectGitCredential(
  projectId: string,
  gitCredentialId: string,
  knownHostsEntry: string | null,
): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(projects).set({ gitCredentialId, knownHostsEntry })
    .where(eq(projects.id, projectId)).returning({ projectId: projects.id })
  notifyWorkspaceListChanged()
  return rows.length > 0
}

/**
 * A project row: the wire `ProjectMeta` plus server-only state (remembered
 * create-form defaults and the git credential).
 */
export interface ProjectRow extends ProjectMeta {
  /** The owning user's id. */
  owner: string
  lastTool?: AgentTool
  lastBranch?: string
  createDefaults: Partial<Record<AgentTool, ToolCreateDefaults>>
  gitCredentialId: string | null
  /** The remote's host key for an SSH credential. Null for a token, and
   *  after the remote changes until the key is assigned again. */
  knownHostsEntry: string | null
}

function toProjectRow(
  r: typeof projects.$inferSelect,
  defaults: Array<typeof projectToolDefaults.$inferSelect>,
): ProjectRow {
  const createDefaults: Partial<Record<AgentTool, ToolCreateDefaults>> = {}
  for (const { tool, model, permissionMode, mode } of defaults) {
    createDefaults[tool] = nullsToUndefined({ model, permissionMode, mode })
  }
  return {
    ...nullsToUndefined(r),
    createDefaults,
    gitCredentialId: r.gitCredentialId,
    knownHostsEntry: r.knownHostsEntry,
  }
}

export async function getProjectRow(projectId: string): Promise<ProjectRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(projects).where(eq(projects.id, projectId))
  if (rows[0] === undefined) return undefined
  const defaults = await db.select().from(projectToolDefaults)
    .where(eq(projectToolDefaults.projectId, projectId))
  return toProjectRow(rows[0], defaults)
}

export async function listProjectRows(): Promise<ProjectRow[]> {
  const db = await getDb()
  const [rows, defaults] = await Promise.all([
    db.select().from(projects),
    db.select().from(projectToolDefaults),
  ])
  return rows.map((r) => toProjectRow(r, defaults.filter((d) => d.projectId === r.id)))
}

/**
 * Remember a create's choices as the project's next defaults: the tool, the
 * branch if named, and whichever of model, permission mode and agent mode
 * were given (for that tool). Omitted fields are left unchanged.
 *
 * Only the create route calls this, since only there is the choice known to
 * be the user's (not a restart, prewarm or spawn policy).
 */
export async function recordProjectCreate(
  projectId: string,
  tool: AgentTool,
  picked: ToolCreateDefaults,
  branch?: string,
): Promise<void> {
  const db = await getDb()
  const set = {
    ...(picked.model !== undefined ? { model: picked.model } : {}),
    ...(picked.permissionMode !== undefined ? { permissionMode: picked.permissionMode } : {}),
    ...(picked.mode !== undefined ? { mode: picked.mode } : {}),
  }
  await db.transaction(async (tx) => {
    const updated = await tx.update(projects)
      .set({ lastTool: tool, ...(branch !== undefined ? { lastBranch: branch } : {}) })
      .where(eq(projects.id, projectId)).returning({ projectId: projects.id })
    // No such project: skip rather than leave an orphan defaults row.
    if (updated.length === 0) return
    const insert = tx.insert(projectToolDefaults).values({ projectId, tool, ...set })
    // drizzle rejects an empty `set`, so with nothing to update just ensure
    // the row exists.
    await (Object.keys(set).length > 0
      ? insert.onConflictDoUpdate({
        target: [projectToolDefaults.projectId, projectToolDefaults.tool],
        set,
      })
      : insert.onConflictDoNothing())
  })
  notifyWorkspaceListChanged()
}

export async function deleteProjectRow(projectId: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.delete(projectToolDefaults).where(eq(projectToolDefaults.projectId, projectId))
    await tx.delete(projects).where(eq(projects.id, projectId))
  })
  notifyWorkspaceListChanged()
}

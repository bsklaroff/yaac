import { eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { projects, projectToolDefaults } from './schema'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { nullsToUndefined } from '#lib/nulls'
import type { AgentTool, EgressAllowlist, ProjectMeta, ScratchDirSettings, ToolCreateDefaults } from '@yaac/shared/types'

/*
 * Which projects exist, as the server records them. The clone, config and
 * tool homes live on the substrate; these rows let the server list projects
 * without reading a filesystem it may not share (docs/layered-server.md).
 */

/** Record a project, owned by `owner` if new; a known id keeps its
 *  owner. `sharedFrom` names the project a share uses the repository of. */
export async function recordProject(
  meta: ProjectMeta & { hosted?: boolean; sharedFrom?: string },
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
 * Point a project the server hosts, and every share of it, at a remote
 * elsewhere (docs/hosted-projects.md "Moving to a git host"), in one
 * transaction. The project takes `gitCredential`, and is recorded as still
 * keeping the repository it was hosted in (`clearProjectKeepsHostedRepo`).
 * Each share needs its own owner's credential, so it starts with none, and
 * stops being a share unless it was removed, which keeps it read-only.
 * False when there is no such project.
 */
export async function setProjectRemote(
  projectId: string,
  remoteUrl: string,
  gitCredential: { id: string; knownHostsEntry: string | null },
): Promise<boolean> {
  const db = await getDb()
  const rows = await db.transaction(async (tx) => {
    await tx.update(projects).set({
      remoteUrl,
      hosted: false,
      gitCredentialId: null,
      knownHostsEntry: null,
      sharedFrom: sql`case when ${projects.shareRevoked} then ${projects.sharedFrom} end`,
    }).where(eq(projects.sharedFrom, projectId))
    return tx.update(projects).set({
      remoteUrl,
      hosted: false,
      keepsHostedRepo: true,
      gitCredentialId: gitCredential.id,
      knownHostsEntry: gitCredential.knownHostsEntry,
    }).where(eq(projects.id, projectId)).returning({ projectId: projects.id })
  })
  notifyWorkspaceListChanged()
  return rows.length > 0
}

/** Record that yaac no longer keeps the repository of a project that
 *  moved off it. False when there is no such project. */
export async function clearProjectKeepsHostedRepo(projectId: string): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(projects).set({ keepsHostedRepo: false })
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
  egressAllowlist: EgressAllowlist
  /** Whether the server hosts the remote (docs/hosted-projects.md). */
  hosted: boolean
  guardDefaultBranch: boolean
  /** Whether yaac still keeps the repository it hosted before the project
   *  moved to another git host. */
  keepsHostedRepo: boolean
  /** The project this one was shared from (docs/hosted-projects.md
   *  "Sharing"). */
  sharedFrom?: string
  shareRevoked: boolean
  /** Days a stopped workspace is kept; absent keeps them forever. */
  stoppedWorkspaceRetentionDays?: number
  /** Gitignored checkout paths a stop keeps. */
  keptIgnoredPaths: string[]
  scratchDirs: ScratchDirSettings
}

function toProjectRow(
  r: typeof projects.$inferSelect,
  defaults: Array<typeof projectToolDefaults.$inferSelect>,
): ProjectRow {
  const createDefaults: Partial<Record<AgentTool, ToolCreateDefaults>> = {}
  for (const { tool, model, permissionMode, mode, effort } of defaults) {
    createDefaults[tool] = nullsToUndefined({ model, permissionMode, mode, effort })
  }
  return {
    ...nullsToUndefined(r),
    createDefaults,
    gitCredentialId: r.gitCredentialId,
    knownHostsEntry: r.knownHostsEntry,
  }
}

/** Replace the project's egress allowlist. False when there is no such
 *  project. */
export async function setProjectEgressAllowlist(
  projectId: string,
  egressAllowlist: EgressAllowlist,
): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(projects).set({ egressAllowlist })
    .where(eq(projects.id, projectId)).returning({ projectId: projects.id })
  return rows.length > 0
}

/** Turn a hosted project's default-branch guard on or off. False when
 *  there is no such project. */
export async function setProjectDefaultBranchGuard(projectId: string, enabled: boolean): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(projects).set({ guardDefaultBranch: enabled })
    .where(eq(projects.id, projectId)).returning({ projectId: projects.id })
  notifyWorkspaceListChanged()
  return rows.length > 0
}

/** Set how many days the project's stopped workspaces are kept (null:
 *  forever). False when there is no such project. */
export async function setProjectWorkspaceRetention(projectId: string, days: number | null): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(projects).set({ stoppedWorkspaceRetentionDays: days })
    .where(eq(projects.id, projectId)).returning({ projectId: projects.id })
  notifyWorkspaceListChanged()
  return rows.length > 0
}

/** Replace the gitignored paths a stop keeps. False when there is no such
 *  project. */
export async function setProjectKeptIgnoredPaths(projectId: string, keptIgnoredPaths: string[]): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(projects).set({ keptIgnoredPaths })
    .where(eq(projects.id, projectId)).returning({ projectId: projects.id })
  notifyWorkspaceListChanged()
  return rows.length > 0
}

/** Replace the project's scratch dirs, or the tracked ones it is not warned
 *  about; each is left as it is when absent. Answers the settings as stored,
 *  or undefined when there is no such project. */
export async function setProjectScratchDirs(
  projectId: string,
  set: Partial<ScratchDirSettings>,
): Promise<ScratchDirSettings | undefined> {
  const db = await getDb()
  const [row] = await db.update(projects)
    .set({ scratchDirs: sql`${projects.scratchDirs} || ${JSON.stringify(set)}::jsonb` })
    .where(eq(projects.id, projectId))
    .returning({ scratchDirs: projects.scratchDirs })
  notifyWorkspaceListChanged()
  return row?.scratchDirs
}

/** Remove a share from its owner, or give it back. False when there is no
 *  such project. */
export async function setProjectShareRevoked(projectId: string, revoked: boolean): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(projects).set({ shareRevoked: revoked })
    .where(eq(projects.id, projectId)).returning({ projectId: projects.id })
  notifyWorkspaceListChanged()
  return rows.length > 0
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
 * branch if named, and whichever of model, permission mode, agent mode and
 * effort were given (for that tool). Omitted fields are left unchanged.
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
    ...(picked.effort !== undefined ? { effort: picked.effort } : {}),
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

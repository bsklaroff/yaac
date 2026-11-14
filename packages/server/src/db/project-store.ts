import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from './client'
import { projectIcons, projectRepos, projects, projectToolDefaults } from './schema'
import { listAllProjectRepos, listProjectRepos, type ProjectRepoLink } from './repo-store'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { nullsToUndefined } from '#lib/nulls'
import type { AgentTool, EgressAllowlist, ProjectConfig, ProjectMeta, ScratchDirSettings, ToolCreateDefaults } from '@yaac/shared/types'

/*
 * Which projects exist, as the server records them. The clone, config and
 * tool homes live on the substrate; these rows let the server list projects
 * without reading a filesystem it may not share (docs/layered-server.md).
 */

/** Record a new project, owned by `owner`. */
export async function recordProject(meta: ProjectMeta, owner: string): Promise<void> {
  const db = await getDb()
  await db.insert(projects).values({ ...meta, owner })
  notifyWorkspaceListChanged()
}

/**
 * A project row: the wire `ProjectMeta` plus server-only state (remembered
 * create-form defaults) and the repos it links.
 */
export interface ProjectRow extends ProjectMeta, ProjectConfig {
  /** The owning user's id. */
  owner: string
  lastTool?: AgentTool
  /** The layout and cwd the last create chose (`projects.lastNested`). */
  lastNested?: boolean
  lastCwd?: string
  createDefaults: Partial<Record<AgentTool, ToolCreateDefaults>>
  /** The repos it links, in order. */
  repos: ProjectRepoLink[]
  egressAllowlist: EgressAllowlist
  /** Days a stopped workspace is kept; absent keeps them forever. */
  stoppedWorkspaceRetentionDays?: number
  /** Gitignored checkout paths a stop keeps. */
  keptIgnoredPaths: string[]
  scratchDirs: ScratchDirSettings
}

function toProjectRow(
  r: typeof projects.$inferSelect,
  defaults: Array<typeof projectToolDefaults.$inferSelect>,
  links: ProjectRepoLink[],
): ProjectRow {
  const createDefaults: Partial<Record<AgentTool, ToolCreateDefaults>> = {}
  for (const { tool, model, permissionMode, mode, effort, agentOptions } of defaults) {
    createDefaults[tool] = { ...nullsToUndefined({ model, permissionMode, mode, effort }), agentOptions }
  }
  return { ...nullsToUndefined(r), createDefaults, repos: links }
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

/**
 * Append `host` to the project's egress allowlist unless it is listed. One
 * statement, so two writers never drop each other's host and an append
 * never writes back a host a concurrent save removed.
 */
export async function addProjectEgressHost(projectId: string, host: string): Promise<void> {
  const db = await getDb()
  const hosts = sql`${projects.egressAllowlist} -> 'hosts'`
  const entry = sql`jsonb_build_array(${host}::text)`
  await db.update(projects)
    .set({ egressAllowlist: sql`jsonb_set(${projects.egressAllowlist}, '{hosts}', ${hosts} || ${entry})` })
    .where(and(eq(projects.id, projectId), sql`NOT (${hosts} @> ${entry})`))
}

/**
 * Place `owner`'s projects in the order `projectIds` lists them. Any of
 * theirs it leaves out lose their place and follow in `addedAt` order, so a
 * project added while the list was being dragged lands last; ids of other
 * users' projects are ignored.
 */
export async function setProjectOrder(owner: string, projectIds: string[]): Promise<void> {
  const db = await getDb()
  const ids = sql.join(projectIds.map((id) => sql`${id}`), sql`, `)
  await db.update(projects)
    .set({ position: sql`array_position(array[${ids}]::uuid[], ${projects.id})` })
    .where(eq(projects.owner, owner))
  notifyWorkspaceListChanged()
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

/** Replace some of the settings a workspace launches with, the rest left
 *  as they are. Answers all of them as stored, or undefined when there is
 *  no such project. */
export async function setProjectConfig(
  projectId: string,
  set: Partial<ProjectConfig>,
): Promise<ProjectConfig | undefined> {
  const db = await getDb()
  const [row] = await db.update(projects).set(set)
    .where(eq(projects.id, projectId))
    .returning({
      portForwards: projects.portForwards,
      cacheVolumes: projects.cacheVolumes,
      npmCache: projects.npmCache,
    })
  notifyWorkspaceListChanged()
  return row
}

/** A project's chip picture: its bytes, their type, and a hash of them. */
export interface ProjectIcon {
  mimeType: string
  bytes: Buffer
  hash: string
}

/** Replace the project's picture. The project must exist. */
export async function setProjectIcon(projectId: string, icon: ProjectIcon): Promise<void> {
  const db = await getDb()
  await db.insert(projectIcons).values({ projectId, ...icon })
    .onConflictDoUpdate({ target: projectIcons.projectId, set: icon })
  notifyWorkspaceListChanged()
}

export async function getProjectIcon(projectId: string): Promise<ProjectIcon | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(projectIcons).where(eq(projectIcons.projectId, projectId))
  return row && { mimeType: row.mimeType, bytes: row.bytes, hash: row.hash }
}

export async function deleteProjectIcon(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(projectIcons).where(eq(projectIcons.projectId, projectId))
  notifyWorkspaceListChanged()
}

/** Each project with a picture, mapped to its picture's hash. */
export async function listProjectIconHashes(): Promise<Map<string, string>> {
  const db = await getDb()
  const rows = await db.select({ projectId: projectIcons.projectId, hash: projectIcons.hash }).from(projectIcons)
  return new Map(rows.map((r) => [r.projectId, r.hash]))
}

export async function getProjectRow(projectId: string): Promise<ProjectRow | undefined> {
  const db = await getDb()
  const rows = await db.select().from(projects).where(eq(projects.id, projectId))
  if (rows[0] === undefined) return undefined
  const defaults = await db.select().from(projectToolDefaults)
    .where(eq(projectToolDefaults.projectId, projectId))
  return toProjectRow(rows[0], defaults, await listProjectRepos(projectId))
}

/** Every project, in the order their owners placed them. */
export async function listProjectRows(): Promise<ProjectRow[]> {
  const db = await getDb()
  const [rows, defaults, links] = await Promise.all([
    // Ascending puts nulls last: projects never placed follow the placed.
    db.select().from(projects).orderBy(asc(projects.position), asc(projects.addedAt)),
    db.select().from(projectToolDefaults),
    listAllProjectRepos(),
  ])
  return rows.map((r) => toProjectRow(r, defaults.filter((d) => d.projectId === r.id), links.get(r.id) ?? []))
}

/**
 * Remember a create's choices as the project's next defaults: the tool,
 * whichever of model, permission mode, agent mode, effort and agent options
 * were given (for that tool), and what the workspace started with (which
 * repos, each one's branch if named, the layout and the cwd). Omitted
 * fields are left unchanged.
 *
 * Only the create route calls this, since only there is the choice known to
 * be the user's (not a restart, prewarm or spawn policy).
 */
export async function recordProjectCreate(
  projectId: string,
  tool: AgentTool,
  picked: ToolCreateDefaults,
  started?: {
    /** The repos included, by id, with the branch named for each. */
    repos: Array<{ repoId: string; branch?: string }>
    nested: boolean
    /** A repo id, or `.` for the workspace root. */
    cwd: string
  },
): Promise<void> {
  const db = await getDb()
  const set = {
    ...(picked.model !== undefined ? { model: picked.model } : {}),
    ...(picked.permissionMode !== undefined ? { permissionMode: picked.permissionMode } : {}),
    ...(picked.mode !== undefined ? { mode: picked.mode } : {}),
    ...(picked.effort !== undefined ? { effort: picked.effort } : {}),
    ...(picked.agentOptions !== undefined && Object.keys(picked.agentOptions).length > 0
      ? { agentOptions: sql`${projectToolDefaults.agentOptions} || ${JSON.stringify(picked.agentOptions)}::jsonb` }
      : {}),
  }
  await db.transaction(async (tx) => {
    const updated = await tx.update(projects)
      .set({ lastTool: tool, ...(started !== undefined ? { lastNested: started.nested, lastCwd: started.cwd } : {}) })
      .where(eq(projects.id, projectId)).returning({ projectId: projects.id })
    // No such project: skip rather than leave an orphan defaults row.
    if (updated.length === 0) return
    if (started !== undefined) {
      const included = started.repos.map((r) => r.repoId)
      await tx.update(projectRepos)
        .set({ lastIncluded: included.length > 0 ? inArray(projectRepos.repoId, included) : sql`false` })
        .where(eq(projectRepos.projectId, projectId))
      for (const { repoId, branch } of started.repos) {
        if (branch === undefined) continue
        await tx.update(projectRepos).set({ lastBranch: branch })
          .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.repoId, repoId)))
      }
    }
    const insert = tx.insert(projectToolDefaults).values({
      projectId,
      tool,
      ...set,
      ...(picked.agentOptions !== undefined ? { agentOptions: picked.agentOptions } : {}),
    })
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
    await tx.delete(projectRepos).where(eq(projectRepos.projectId, projectId))
    await tx.delete(projects).where(eq(projects.id, projectId))
  })
  notifyWorkspaceListChanged()
}

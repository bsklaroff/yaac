import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { getDb } from './client'
import {
  draftWorkspaces, namedWorkflows, projectRepos, projects, queuedWorkspaces, repos, repoShares, routines, sites,
  workflowApprovals, workflows, workspaceRepos, workspaces,
} from './schema'
import { workflowHash } from './workflow-store'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { nullsToUndefined } from '#lib/nulls'

/*
 * Git repos and the three ways a row names one (docs/project-repos.md): a
 * project's link to it, a user's share of it, and a workspace's checkout of
 * it.
 */

export interface RepoRow {
  id: string
  /** The owning user's id. */
  owner: string
  remoteUrl: string
  addedAt: string
  gitCredentialId: string | null
  /** The remote's host key for an SSH credential. Null for a token, and
   *  after the remote changes until the key is assigned again. */
  knownHostsEntry: string | null
  /** Whether the server hosts the remote (docs/hosted-projects.md). */
  hosted: boolean
  guardDefaultBranch: boolean
  /** Whether yaac still keeps the repository it hosted before the repo
   *  moved to another git host. */
  keepsHostedRepo: boolean
  /** Set once its owner deleted it while workspaces held checkouts. */
  deletedAt?: Date
}

/** A project's link to a repo, with the repo. */
export interface ProjectRepoLink {
  projectId: string
  repo: RepoRow
  /** The folder its checkout takes when nested. */
  dir: string
  readOnly: boolean
  ghToken: boolean
  lastIncluded: boolean
  lastBranch?: string
}

/** One checkout of a workspace. */
export interface WorkspaceRepoRow {
  workspaceId: string
  repoId: string
  /** `''` for the workspace root, else the folder under it. */
  path: string
  baseBranch?: string
  startCommit?: string
}

function toRepoRow(r: typeof repos.$inferSelect): RepoRow {
  const { deletedAt, ...rest } = r
  return { ...rest, ...(deletedAt !== null ? { deletedAt } : {}) }
}

export async function insertRepo(
  repo: Pick<RepoRow, 'id' | 'owner' | 'remoteUrl'> & { hosted?: boolean },
  gitCredential?: { id: string; knownHostsEntry: string | null },
): Promise<RepoRow> {
  const db = await getDb()
  const [row] = await db.insert(repos).values({
    ...repo,
    addedAt: new Date().toISOString(),
    gitCredentialId: gitCredential?.id ?? null,
    knownHostsEntry: gitCredential?.knownHostsEntry ?? null,
  }).returning()
  notifyWorkspaceListChanged()
  return toRepoRow(row)
}

export async function getRepo(repoId: string): Promise<RepoRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(repos).where(eq(repos.id, repoId))
  return row && toRepoRow(row)
}

/** Every repo, oldest first, deleted ones included. */
export async function listRepos(): Promise<RepoRow[]> {
  const db = await getDb()
  return (await db.select().from(repos).orderBy(asc(repos.addedAt))).map(toRepoRow)
}

/** The oldest repo `owner` has for `remoteUrl`, which adding that URL again
 *  links rather than cloning a second time. */
export async function findOwnerRepo(owner: string, remoteUrl: string): Promise<RepoRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(repos)
    .where(and(eq(repos.owner, owner), eq(repos.remoteUrl, remoteUrl), isNull(repos.deletedAt)))
    .orderBy(asc(repos.addedAt)).limit(1)
  return row && toRepoRow(row)
}

/**
 * Assign the repo's git credential together with its trusted host key
 * (null for an https token); each assignment fetches its own host key.
 * False when there is no such repo.
 */
export async function setRepoGitCredential(
  repoId: string,
  gitCredentialId: string,
  knownHostsEntry: string | null,
): Promise<boolean> {
  return updateRepo(repoId, { gitCredentialId, knownHostsEntry })
}

/**
 * Point a repo the server hosts at a remote elsewhere
 * (docs/hosted-projects.md "Moving to a git host"). It takes
 * `gitCredential`, and is recorded as still keeping the repository it was
 * hosted in (`clearRepoKeepsHostedRepo`). False when there is no such repo.
 */
export async function setRepoRemote(
  repoId: string,
  remoteUrl: string,
  gitCredential: { id: string; knownHostsEntry: string | null },
): Promise<boolean> {
  return updateRepo(repoId, {
    remoteUrl,
    hosted: false,
    keepsHostedRepo: true,
    gitCredentialId: gitCredential.id,
    knownHostsEntry: gitCredential.knownHostsEntry,
  })
}

/** Record that yaac no longer keeps the repository of a repo that moved
 *  off it. False when there is no such repo. */
export async function clearRepoKeepsHostedRepo(repoId: string): Promise<boolean> {
  return updateRepo(repoId, { keepsHostedRepo: false })
}

/** Turn a hosted repo's default-branch guard on or off. False when there
 *  is no such repo. */
export async function setRepoDefaultBranchGuard(repoId: string, enabled: boolean): Promise<boolean> {
  return updateRepo(repoId, { guardDefaultBranch: enabled })
}

/** Mark a repo deleted: it stays only for the workspaces that hold a
 *  checkout of it. */
export async function markRepoDeleted(repoId: string): Promise<boolean> {
  return updateRepo(repoId, { deletedAt: new Date(), gitCredentialId: null, knownHostsEntry: null })
}

async function updateRepo(repoId: string, set: Partial<typeof repos.$inferInsert>): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(repos).set(set).where(eq(repos.id, repoId)).returning({ id: repos.id })
  notifyWorkspaceListChanged()
  return rows.length > 0
}

/** Delete a repo's row with its shares. Its links must be gone. */
export async function deleteRepoRow(repoId: string): Promise<void> {
  const db = await getDb()
  await db.delete(repos).where(eq(repos.id, repoId))
  notifyWorkspaceListChanged()
}

/** Share a repo with a user; a no-op when it already is. */
export async function addRepoShare(repoId: string, userId: string): Promise<void> {
  const db = await getDb()
  await db.insert(repoShares).values({ repoId, userId }).onConflictDoNothing()
  notifyWorkspaceListChanged()
}

/** End a user's share, or with no user every share of the repo. */
export async function removeRepoShares(repoId: string, userId?: string): Promise<void> {
  const db = await getDb()
  await db.delete(repoShares).where(and(
    eq(repoShares.repoId, repoId),
    ...(userId !== undefined ? [eq(repoShares.userId, userId)] : []),
  ))
  notifyWorkspaceListChanged()
}

/** Every share, for the listings and `canUseRepo`. */
export async function listRepoShares(): Promise<Array<{ repoId: string; userId: string }>> {
  const db = await getDb()
  return db.select({ repoId: repoShares.repoId, userId: repoShares.userId }).from(repoShares)
}

function toLink(row: { link: typeof projectRepos.$inferSelect; repo: typeof repos.$inferSelect }): ProjectRepoLink {
  const { repoId: _, position: __, ...link } = row.link
  return { ...nullsToUndefined(link), repo: toRepoRow(row.repo) }
}

/** A project's links, in the order it lists its repos. */
export async function listProjectRepos(projectId: string): Promise<ProjectRepoLink[]> {
  return (await listAllProjectRepos([projectId])).get(projectId) ?? []
}

/** The links of the named projects (or of all), by project id. */
export async function listAllProjectRepos(projectIds?: string[]): Promise<Map<string, ProjectRepoLink[]>> {
  const db = await getDb()
  const rows = await db.select({ link: projectRepos, repo: repos }).from(projectRepos)
    .innerJoin(repos, eq(repos.id, projectRepos.repoId))
    .where(projectIds !== undefined ? inArray(projectRepos.projectId, projectIds) : undefined)
    .orderBy(asc(projectRepos.position), asc(repos.addedAt))
  const byProject = new Map<string, ProjectRepoLink[]>()
  for (const row of rows) {
    byProject.set(row.link.projectId, [...(byProject.get(row.link.projectId) ?? []), toLink(row)])
  }
  return byProject
}

/** Link a repo into a project under `dir`, after the ones it has. */
export async function linkProjectRepo(projectId: string, repoId: string, dir: string): Promise<void> {
  const db = await getDb()
  await db.insert(projectRepos).values({
    projectId,
    repoId,
    dir,
    position: sql`(select coalesce(max(${projectRepos.position}) + 1, 0) from ${projectRepos}
      where ${projectRepos.projectId} = ${projectId})`,
  })
  notifyWorkspaceListChanged()
}

/** Unlink a repo from one project, or with no project from every one.
 *  Answers the projects it was unlinked from. */
export async function unlinkProjectRepo(repoId: string, projectId?: string): Promise<string[]> {
  const db = await getDb()
  const rows = await db.delete(projectRepos).where(and(
    eq(projectRepos.repoId, repoId),
    ...(projectId !== undefined ? [eq(projectRepos.projectId, projectId)] : []),
  )).returning({ projectId: projectRepos.projectId })
  notifyWorkspaceListChanged()
  return rows.map((r) => r.projectId)
}

/** Change a link's folder name or its k8s-only flags. False when the
 *  project does not link the repo. */
export async function updateProjectRepo(
  projectId: string,
  repoId: string,
  set: { dir?: string; readOnly?: boolean; ghToken?: boolean },
): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(projectRepos).set(set)
    .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.repoId, repoId)))
    .returning({ repoId: projectRepos.repoId })
  notifyWorkspaceListChanged()
  return rows.length > 0
}

/** List a project's repos in the order `repoIds` names them; any it leaves
 *  out follow. */
export async function setProjectRepoOrder(projectId: string, repoIds: string[]): Promise<void> {
  const db = await getDb()
  const ids = sql.join(repoIds.map((id) => sql`${id}`), sql`, `)
  await db.update(projectRepos)
    .set({ position: sql`coalesce(array_position(array[${ids}]::uuid[], ${projectRepos.repoId}), ${repoIds.length + 1})` })
    .where(eq(projectRepos.projectId, projectId))
  notifyWorkspaceListChanged()
}

/**
 * Point everything in `owner`'s projects that names `fromRepoId` at
 * `toRepoId`, in one transaction: for a user whose shared repo became one of
 * their own when it moved to a git host. That is each link (keeping its
 * folder and flags), each workspace's checkout, what queued entries,
 * routines, drafts and sites start with, the commits a site's releases
 * ran, the repos a workflow names (with its hash), and the branches their
 * workflows are approved on.
 */
export async function repointProjectRepos(owner: string, fromRepoId: string, toRepoId: string): Promise<void> {
  const db = await getDb()
  const owned = db.select({ id: projects.id }).from(projects).where(eq(projects.owner, owner))
  // A repo id is unique text, so replacing it in the stored JSON is exact.
  const renamed = (column: AnyPgColumn) => sql`replace(${column}::text, ${fromRepoId}, ${toRepoId})::jsonb`
  await db.transaction(async (tx) => {
    await tx.update(projectRepos).set({ repoId: toRepoId })
      .where(and(eq(projectRepos.repoId, fromRepoId), inArray(projectRepos.projectId, owned)))
    await tx.update(workspaceRepos).set({ repoId: toRepoId }).where(and(
      eq(workspaceRepos.repoId, fromRepoId),
      inArray(workspaceRepos.workspaceId,
        tx.select({ id: workspaces.workspaceId }).from(workspaces).where(inArray(workspaces.projectId, owned))),
    ))
    await tx.update(queuedWorkspaces).set({ repos: renamed(queuedWorkspaces.repos) })
      .where(inArray(queuedWorkspaces.projectId, owned))
    await tx.update(routines).set({ repos: renamed(routines.repos) }).where(inArray(routines.projectId, owned))
    await tx.update(draftWorkspaces).set({ repos: renamed(draftWorkspaces.repos) })
      .where(and(inArray(draftWorkspaces.projectId, owned), isNotNull(draftWorkspaces.repos)))
    await tx.update(projects).set({ lastCwd: toRepoId }).where(and(eq(projects.owner, owner), eq(projects.lastCwd, fromRepoId)))
    await tx.update(sites).set({
      repos: renamed(sites.repos),
      releaseCommits: renamed(sites.releaseCommits),
      deployCommits: renamed(sites.deployCommits),
      lastDeployCommits: renamed(sites.lastDeployCommits),
      failedCommits: renamed(sites.failedCommits),
    }).where(inArray(sites.projectId, owned))
    // A workflow's repos are content, so its hash moves with them. Where the
    // project already holds that content, its names point there instead.
    const named = await tx.select().from(workflows)
      .where(and(inArray(workflows.projectId, owned), sql`${fromRepoId}::uuid = any(${workflows.repos})`))
    for (const w of named) {
      const repos = [...new Set(w.repos.map((r) => (r === fromRepoId ? toRepoId : r)))].sort()
      const hash = workflowHash(w.steps, w.secrets, repos)
      const [same] = await tx.select({ id: workflows.id }).from(workflows)
        .where(and(eq(workflows.projectId, w.projectId), eq(workflows.hash, hash)))
      if (same === undefined) await tx.update(workflows).set({ repos, hash }).where(eq(workflows.id, w.id))
      else await tx.update(namedWorkflows).set({ workflowId: same.id }).where(eq(namedWorkflows.workflowId, w.id))
    }
    await tx.update(workflowApprovals)
      .set({ ref: sql`${toRepoId} || substr(${workflowApprovals.ref}, ${fromRepoId.length + 1})` })
      .where(and(
        sql`starts_with(${workflowApprovals.ref}, ${`${fromRepoId}:`})`,
        inArray(workflowApprovals.namedWorkflowId,
          tx.select({ id: namedWorkflows.id }).from(namedWorkflows).where(inArray(namedWorkflows.projectId, owned))),
      ))
  })
  notifyWorkspaceListChanged()
}

/** Record a workspace's checkouts as it is created. */
export async function insertWorkspaceRepos(rows: WorkspaceRepoRow[]): Promise<void> {
  if (rows.length === 0) return
  const db = await getDb()
  await db.insert(workspaceRepos).values(rows)
}

/** A workspace's checkouts, the one at its root (or the first folder) first. */
export async function listWorkspaceRepos(workspaceId: string): Promise<WorkspaceRepoRow[]> {
  return (await listWorkspaceReposFor([workspaceId])).get(workspaceId) ?? []
}

/** The checkouts of the named workspaces, by workspace id. */
export async function listWorkspaceReposFor(workspaceIds: string[]): Promise<Map<string, WorkspaceRepoRow[]>> {
  if (workspaceIds.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select().from(workspaceRepos)
    .where(inArray(workspaceRepos.workspaceId, workspaceIds))
    .orderBy(asc(workspaceRepos.path))
  const byWorkspace = new Map<string, WorkspaceRepoRow[]>()
  for (const row of rows) {
    byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), nullsToUndefined(row)])
  }
  return byWorkspace
}

/** Record the branch a checkout is based on, or the commit it was created
 *  at. */
export async function setWorkspaceRepoStart(
  workspaceId: string,
  repoId: string,
  set: { baseBranch?: string; startCommit?: string },
): Promise<void> {
  const db = await getDb()
  await db.update(workspaceRepos).set(set)
    .where(and(eq(workspaceRepos.workspaceId, workspaceId), eq(workspaceRepos.repoId, repoId)))
}

/** The workspaces that hold a checkout of a repo, running or stopped, with
 *  their projects. */
export async function listRepoHolders(repoId: string): Promise<Array<{
  workspaceId: string
  projectId: string
  path: string
}>> {
  const db = await getDb()
  return db.select({
    workspaceId: workspaceRepos.workspaceId,
    projectId: workspaces.projectId,
    path: workspaceRepos.path,
  }).from(workspaceRepos)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceRepos.workspaceId))
    .where(eq(workspaceRepos.repoId, repoId))
}

/** The deleted repos no workspace holds a checkout of any more, whose main
 *  clone and row can go. */
export async function listReleasedDeletedRepos(): Promise<RepoRow[]> {
  const db = await getDb()
  const rows = await db.select().from(repos).where(sql`${repos.deletedAt} is not null and not exists (
    select 1 from ${workspaceRepos} where ${workspaceRepos.repoId} = ${repos.id})`)
  return rows.map(toRepoRow)
}

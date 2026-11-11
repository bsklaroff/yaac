import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { getDb } from './client'
import { sites, workspaces } from './schema'
import { listWorkspaceReposFor, type WorkspaceRepoRow } from './repo-store'
import { isUuid } from '#lib/uuid'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import { ServerError } from '@yaac/shared/errors'
import type { RepoStart } from '@yaac/shared/types'

/**
 * Public sites (docs/public-sites.md). Everything here is the domain's own
 * decision, a user's intent or a deploy advancing, so it is written
 * directly rather than through `applyWorkspaceEvent`.
 */

type Row = typeof sites.$inferSelect

/** A site (columns documented in schema.ts). */
export type SiteRow = NullsToUndefined<Row>

/** The columns a site change may set; null clears one. */
export type SitePatch = Partial<Omit<typeof sites.$inferInsert, 'id' | 'projectId' | 'createdAt'>>

const toRow = (r: Row): SiteRow => nullsToUndefined(r)

/** Whether a site is built from a repo: named in its repos, or among the
 *  commits its last release ran, which a replacement starts again. */
export function siteBuiltFrom(site: SiteRow, repoId: string): boolean {
  return site.repos.some((r) => r.repo === repoId) || site.releaseCommits?.[repoId] !== undefined
}

/** Insert a site, refusing a name its project uses or a hostname any site
 *  uses. */
export async function insertSite(values: {
  projectId: string
  name: string
  hostname: string
  port: number
  adminPort?: number
  namedWorkflowId: string
  volumeId?: string
  repos: RepoStart[]
  follow: boolean
}): Promise<SiteRow> {
  const db = await getDb()
  const [row] = await db.insert(sites).values(values).onConflictDoNothing().returning()
  if (row) return toRow(row)
  if (await findSiteByName(values.projectId, values.name)) {
    throw new ServerError('CONFLICT', `this project already has a site named "${values.name}"`)
  }
  throw new ServerError('CONFLICT', `another site already serves ${values.hostname}`)
}

export async function listProjectSites(projectId: string): Promise<SiteRow[]> {
  const db = await getDb()
  return (await db.select().from(sites).where(eq(sites.projectId, projectId)).orderBy(asc(sites.name))).map(toRow)
}

/** Every site of the install, for the reconcile step and the driver. */
export async function listSites(): Promise<SiteRow[]> {
  const db = await getDb()
  return (await db.select().from(sites).orderBy(asc(sites.createdAt))).map(toRow)
}

export async function findSiteByName(projectId: string, name: string): Promise<SiteRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(sites).where(and(eq(sites.projectId, projectId), eq(sites.name, name)))
  return row ? toRow(row) : undefined
}

export async function getSiteRow(id: string): Promise<SiteRow | undefined> {
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const [row] = await db.select().from(sites).where(eq(sites.id, id))
  return row ? toRow(row) : undefined
}

/** Whether a site other than `id` serves `hostname`. */
async function hostnameTaken(hostname: string, id?: string): Promise<boolean> {
  const db = await getDb()
  const [taken] = await db.select({ id: sites.id }).from(sites)
    .where(id !== undefined ? and(eq(sites.hostname, hostname), ne(sites.id, id)) : eq(sites.hostname, hostname))
  return taken !== undefined
}

/**
 * Change a site. A hostname another site serves is a `CONFLICT`, checked
 * before the write and again after one that failed, which a concurrent
 * edit taking the same hostname makes violate its unique index.
 */
export async function updateSite(id: string, patch: SitePatch): Promise<void> {
  const db = await getDb()
  const taken = (): ServerError => new ServerError('CONFLICT', `another site already serves ${patch.hostname ?? ''}`)
  if (patch.hostname !== undefined && await hostnameTaken(patch.hostname, id)) throw taken()
  try {
    await db.update(sites).set(patch).where(eq(sites.id, id))
  } catch (err) {
    if (patch.hostname !== undefined && await hostnameTaken(patch.hostname, id)) throw taken()
    throw err
  }
}

/** Start a deploy, only if none is in progress. Resolves whether it did. */
export async function beginSiteDeploy(id: string, patch: SitePatch): Promise<boolean> {
  const db = await getDb()
  const rows = await db.update(sites).set(patch)
    .where(and(eq(sites.id, id), isNull(sites.deployWorkspaceId)))
    .returning({ id: sites.id })
  return rows.length > 0
}

export async function deleteSiteRow(id: string): Promise<void> {
  const db = await getDb()
  await db.delete(sites).where(eq(sites.id, id))
}

/** Drop a deleted project's sites. The next sync stops routing them. */
export async function deleteProjectSiteRows(projectId: string): Promise<void> {
  const db = await getDb()
  await db.delete(sites).where(eq(sites.projectId, projectId))
}

/** Each site's name by id, for workspace listings. */
export async function siteNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const db = await getDb()
  const rows = await db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, ids))
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** The sites that name a volume, which may not be deleted under them. */
export async function listVolumeSites(volumeId: string): Promise<SiteRow[]> {
  const db = await getDb()
  return (await db.select().from(sites).where(eq(sites.volumeId, volumeId))).map(toRow)
}

/** A site's newest releases, newest first, each with its checkouts. */
export async function listSiteReleases(siteId: string, limit: number): Promise<Array<{
  workspaceId: string
  checkouts: WorkspaceRepoRow[]
  createdAt: Date
  stoppedAt?: Date
  rerunOf?: string
}>> {
  const db = await getDb()
  const rows = await db.select({
    workspaceId: workspaces.workspaceId,
    createdAt: workspaces.createdAt,
    stoppedAt: workspaces.stoppedAt,
    rerunOf: workspaces.rerunOf,
  }).from(workspaces).where(eq(workspaces.siteId, siteId)).orderBy(desc(workspaces.createdAt)).limit(limit)
  const checkouts = await listWorkspaceReposFor(rows.map((r) => r.workspaceId))
  return rows.map((r) => ({ ...nullsToUndefined(r), checkouts: checkouts.get(r.workspaceId) ?? [] }))
}

import { and, asc, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm'
import { getDb } from './client'
import { deletedVolumes, volumes, workspaces } from './schema'
import { isUuid } from '#lib/uuid'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import { ServerError } from '@yaac/shared/errors'

/**
 * Volumes and their leases (docs/workspace-volumes.md). Creating, deleting
 * and claiming are user intent and written here directly; a lease ending
 * because its holder's runtime is gone, and a disk being pinned, are
 * observed and arrive as events (`releaseVolume`, `markVolumesPinned`).
 *
 * A lease is identified by its holder and `attachedAt`, which every claim
 * sets afresh, a holder's own renewal included. Taking over or ending a
 * lease matches both as they were read before judging the holder gone, so
 * a holder that renewed meanwhile keeps it.
 */

/** A lease as read: who holds the volume, since when. */
export interface VolumeLease {
  holderWorkspaceId: string
  attachedAt: Date
}

type Row = typeof volumes.$inferSelect

/** A volume (columns documented in schema.ts). */
export type VolumeRow = NullsToUndefined<Row>

const toRow = (r: Row): VolumeRow => nullsToUndefined(r)

/** Insert a volume, refusing a name the project already uses. */
export async function insertVolume(projectId: string, name: string, size: string): Promise<VolumeRow> {
  const db = await getDb()
  const [row] = await db.insert(volumes).values({ projectId, name, size })
    .onConflictDoNothing().returning()
  if (!row) throw new ServerError('CONFLICT', `this project already has a volume named "${name}"`)
  return toRow(row)
}

export async function listProjectVolumes(projectId: string): Promise<VolumeRow[]> {
  const db = await getDb()
  const rows = await db.select().from(volumes).where(eq(volumes.projectId, projectId)).orderBy(asc(volumes.name))
  return rows.map(toRow)
}

/** The deleted volumes whose storage may remain, for the orphan sweep. */
export async function listDeletedVolumeIds(): Promise<string[]> {
  const db = await getDb()
  return (await db.select({ id: deletedVolumes.id }).from(deletedVolumes)).map((r) => r.id)
}

/** Drop a deleted volume's tombstone, once its storage is gone. */
export async function forgetDeletedVolume(id: string): Promise<void> {
  const db = await getDb()
  await db.delete(deletedVolumes).where(eq(deletedVolumes.id, id))
}

/** Every volume someone holds, for the lease sweep. */
export async function listHeldVolumes(): Promise<VolumeRow[]> {
  const db = await getDb()
  return (await db.select().from(volumes).where(isNotNull(volumes.holderWorkspaceId))).map(toRow)
}

/** Every volume whose disk is not pinned yet, for the pin sweep. */
export async function listUnpinnedVolumes(): Promise<VolumeRow[]> {
  const db = await getDb()
  return (await db.select().from(volumes).where(isNull(volumes.pinnedAt))).map(toRow)
}

export async function findVolumeByName(projectId: string, name: string): Promise<VolumeRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(volumes)
    .where(and(eq(volumes.projectId, projectId), eq(volumes.name, name)))
  return row ? toRow(row) : undefined
}

export async function getVolumeRow(id: string): Promise<VolumeRow | undefined> {
  if (!isUuid(id)) return undefined
  const db = await getDb()
  const [row] = await db.select().from(volumes).where(eq(volumes.id, id))
  return row ? toRow(row) : undefined
}

/**
 * Take the lease for `workspaceId`: when nobody holds it, when the workspace
 * already does (a restart), or when it is still exactly `replacing` (a
 * lease whose holder was found gone). Two claims never both win. Resolves
 * with the new lease, or undefined if this claim lost.
 */
export async function claimVolume(
  id: string,
  workspaceId: string,
  replacing?: VolumeLease,
): Promise<VolumeLease | undefined> {
  const db = await getDb()
  const holder = volumes.holderWorkspaceId
  const attachedAt = new Date()
  const rows = await db.update(volumes)
    .set({ holderWorkspaceId: workspaceId, attachedAt })
    .where(and(eq(volumes.id, id), or(
      isNull(holder),
      eq(holder, workspaceId),
      ...(replacing !== undefined ? [isLease(replacing)] : []),
    )))
    .returning({ id: volumes.id })
  return rows.length > 0 ? { holderWorkspaceId: workspaceId, attachedAt } : undefined
}

const isLease = (lease: VolumeLease): SQL | undefined => and(
  eq(volumes.holderWorkspaceId, lease.holderWorkspaceId),
  eq(volumes.attachedAt, lease.attachedAt),
)

/** End a lease, only if it is still exactly `lease`. */
export async function releaseVolume(id: string, lease: VolumeLease): Promise<void> {
  const db = await getDb()
  await db.update(volumes).set({ holderWorkspaceId: null, attachedAt: null })
    .where(and(eq(volumes.id, id), isLease(lease)))
}

/** A volume's lease, if it has one. */
export function leaseOf(row: VolumeRow): VolumeLease | undefined {
  return row.holderWorkspaceId !== undefined && row.attachedAt !== undefined
    ? { holderWorkspaceId: row.holderWorkspaceId, attachedAt: row.attachedAt }
    : undefined
}

export async function markVolumesPinned(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await getDb()
  await db.update(volumes).set({ pinnedAt: new Date() })
    .where(and(inArray(volumes.id, ids), isNull(volumes.pinnedAt)))
}

export async function setVolumeSize(id: string, size: string): Promise<void> {
  const db = await getDb()
  await db.update(volumes).set({ size }).where(eq(volumes.id, id))
}

/** The volume a workspace takes back on restart; null forgets it. */
export async function setWorkspaceVolume(workspaceId: string, volumeId: string | null): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({ volumeId }).where(eq(workspaces.workspaceId, workspaceId))
}

/** The workspaces that name each volume, held or stopped, for the list. */
export async function listVolumeWorkspaces(
  volumeIds: string[],
): Promise<Array<{ volumeId: string; workspaceId: string; title?: string; stopped: boolean }>> {
  if (volumeIds.length === 0) return []
  const db = await getDb()
  const rows = await db.select({
    volumeId: workspaces.volumeId,
    workspaceId: workspaces.workspaceId,
    title: workspaces.title,
    generatedTitle: workspaces.generatedTitle,
    stoppedAt: workspaces.stoppedAt,
  }).from(workspaces).where(inArray(workspaces.volumeId, volumeIds))
  return rows.flatMap((r) => r.volumeId === null ? [] : [{
    volumeId: r.volumeId,
    workspaceId: r.workspaceId,
    ...((r.title ?? r.generatedTitle) !== null ? { title: (r.title ?? r.generatedTitle) as string } : {}),
    stopped: r.stoppedAt !== null,
  }])
}

/**
 * Delete a volume's row unless someone holds it, leaving a tombstone for
 * its storage, and forget it on every workspace that names it. Returns
 * whether it was deleted.
 */
export async function deleteVolumeRow(id: string): Promise<boolean> {
  const db = await getDb()
  return await db.transaction(async (tx) => {
    const rows = await tx.delete(volumes)
      .where(and(eq(volumes.id, id), isNull(volumes.holderWorkspaceId)))
      .returning({ id: volumes.id })
    if (rows.length === 0) return false
    await tx.insert(deletedVolumes).values({ id }).onConflictDoNothing()
    await tx.update(workspaces).set({ volumeId: null }).where(eq(workspaces.volumeId, id))
    return true
  })
}

/** Drop a deleted project's volumes, held or not, leaving a tombstone for
 *  each one's storage. */
export async function deleteProjectVolumeRows(projectId: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    const rows = await tx.delete(volumes).where(eq(volumes.projectId, projectId)).returning({ id: volumes.id })
    if (rows.length > 0) await tx.insert(deletedVolumes).values(rows).onConflictDoNothing()
  })
}

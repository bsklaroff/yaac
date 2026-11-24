import { and, desc, eq, inArray, max, sql } from 'drizzle-orm'
import { getDb } from './client'
import { draftWorkspaces, imageBuilds, imageRevisions, images, installSettings, projects, queuedWorkspaces, routines, sites, workspaces } from './schema'
import { notifyWorkspaceListChanged } from '#lib/notify'
import { nullsToUndefined, type NullsToUndefined } from '#lib/nulls'
import type { ImageBuildStatus, ImageFileManifest } from '@yaac/shared/types'

/**
 * Images, their revisions and their builds (docs/image-builds.md "Images,
 * revisions and builds"). Revisions are immutable. Build rows change as a
 * build runs, and every change notifies the snapshot hub, whose building
 * pill reads them.
 */

export type ImageRow = NullsToUndefined<typeof images.$inferSelect>
export type ImageRevisionRow = NullsToUndefined<typeof imageRevisions.$inferSelect>
export type ImageBuildRow = NullsToUndefined<typeof imageBuilds.$inferSelect>

/** The scope an image belongs to: a project, or a user (their own Dockerfile.user). */
export type ImageScope = { projectId: string } | { userId: string }

export async function insertImage(scope: ImageScope, name: string): Promise<ImageRow> {
  const db = await getDb()
  const [row] = await db.insert(images).values({ ...scope, name }).returning()
  return nullsToUndefined(row)
}

export async function getImage(id: string): Promise<ImageRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(images).where(eq(images.id, id))
  return row ? nullsToUndefined(row) : undefined
}

/** A project's images, or a user's, oldest first. */
export async function listImages(scope: ImageScope): Promise<ImageRow[]> {
  const db = await getDb()
  const where = 'projectId' in scope ? eq(images.projectId, scope.projectId) : eq(images.userId, scope.userId)
  return (await db.select().from(images).where(where).orderBy(images.createdAt)).map(nullsToUndefined)
}

/**
 * Delete an image with its revisions and builds, and forget it wherever a
 * create would otherwise name it.
 */
export async function deleteImage(id: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.update(projects).set({ defaultImageId: null }).where(eq(projects.defaultImageId, id))
    await tx.update(projects).set({ lastImageId: null }).where(eq(projects.lastImageId, id))
    for (const table of [queuedWorkspaces, routines, draftWorkspaces, sites]) {
      await tx.update(table).set({ imageId: null }).where(eq(table.imageId, id))
    }
    await tx.delete(images).where(eq(images.id, id))
  })
  notifyWorkspaceListChanged()
}

/**
 * A new image at revision 1, and for a project image optionally its
 * default, in one transaction, so an import that dies part-way leaves
 * nothing behind (docs/legacy-compat-shims.md "Build dirs").
 */
export async function insertImageWithRevision(
  scope: ImageScope,
  name: string,
  revision: { dockerfile: string; files: ImageFileManifest; contentHash: string; author: string; note?: string },
  opts: { makeDefault?: boolean } = {},
): Promise<ImageRow> {
  const db = await getDb()
  const row = await db.transaction(async (tx) => {
    const [image] = await tx.insert(images).values({ ...scope, name }).returning()
    const [inserted] = await tx.insert(imageRevisions)
      .values({ ...revision, imageId: image.id, note: revision.note ?? null, number: 1 }).returning()
    const [updated] = await tx.update(images).set({ currentRevisionId: inserted.id }).where(eq(images.id, image.id)).returning()
    if (opts.makeDefault && 'projectId' in scope) {
      await tx.update(projects).set({ defaultImageId: image.id }).where(eq(projects.id, scope.projectId))
    }
    return updated
  })
  return nullsToUndefined(row)
}

/** Delete a project's images (their revisions and builds go with them) and
 *  every build row of the project, user-image builds included. */
export async function deleteProjectImageRows(projectId: string): Promise<void> {
  const db = await getDb()
  await db.transaction(async (tx) => {
    await tx.delete(imageBuilds).where(eq(imageBuilds.projectId, projectId))
    await tx.delete(images).where(eq(images.projectId, projectId))
  })
  notifyWorkspaceListChanged()
}

/** Append a revision and make it the image's current one. */
export async function insertImageRevision(fields: {
  imageId: string
  dockerfile: string
  files: ImageFileManifest
  contentHash: string
  author: string
  note?: string
}): Promise<ImageRevisionRow> {
  const db = await getDb()
  const row = await db.transaction(async (tx) => {
    const [{ last }] = await tx.select({ last: max(imageRevisions.number) }).from(imageRevisions)
      .where(eq(imageRevisions.imageId, fields.imageId))
    const [inserted] = await tx.insert(imageRevisions)
      .values({ ...fields, note: fields.note ?? null, number: (last ?? 0) + 1 }).returning()
    await tx.update(images).set({ currentRevisionId: inserted.id }).where(eq(images.id, fields.imageId))
    return inserted
  })
  return nullsToUndefined(row)
}

export async function getImageRevision(id: string): Promise<ImageRevisionRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(imageRevisions).where(eq(imageRevisions.id, id))
  return row ? nullsToUndefined(row) : undefined
}

/** An image's revisions, newest first. */
export async function listImageRevisions(imageId: string): Promise<ImageRevisionRow[]> {
  const db = await getDb()
  return (await db.select().from(imageRevisions).where(eq(imageRevisions.imageId, imageId))
    .orderBy(desc(imageRevisions.number))).map(nullsToUndefined)
}

/** Record that `revisionId`'s chain finished building, as `tag`. */
export async function setImageLastBuilt(imageId: string, revisionId: string, tag: string): Promise<void> {
  const db = await getDb()
  await db.update(images).set({ lastBuiltRevisionId: revisionId, lastBuiltTag: tag }).where(eq(images.id, imageId))
}

export async function insertImageBuild(fields: typeof imageBuilds.$inferInsert): Promise<ImageBuildRow> {
  const db = await getDb()
  const [row] = await db.insert(imageBuilds).values(fields).returning()
  notifyWorkspaceListChanged()
  return nullsToUndefined(row)
}

export async function updateImageBuild(
  id: string,
  patch: Partial<Omit<typeof imageBuilds.$inferInsert, 'id'>>,
): Promise<void> {
  const db = await getDb()
  await db.update(imageBuilds).set(patch).where(eq(imageBuilds.id, id))
  notifyWorkspaceListChanged()
}

export async function getImageBuild(id: string): Promise<ImageBuildRow | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(imageBuilds).where(eq(imageBuilds.id, id))
  return row ? nullsToUndefined(row) : undefined
}

/** Builds, newest first, narrowed by any of the filters. */
export async function listImageBuilds(filter: {
  projectId?: string
  imageId?: string
  revisionId?: string
  statuses?: ImageBuildStatus[]
  limit?: number
}): Promise<ImageBuildRow[]> {
  const db = await getDb()
  const where = and(
    filter.projectId !== undefined ? eq(imageBuilds.projectId, filter.projectId) : undefined,
    filter.imageId !== undefined ? eq(imageBuilds.imageId, filter.imageId) : undefined,
    filter.revisionId !== undefined ? eq(imageBuilds.revisionId, filter.revisionId) : undefined,
    filter.statuses !== undefined ? inArray(imageBuilds.status, filter.statuses) : undefined,
  )
  const rows = await db.select().from(imageBuilds).where(where)
    .orderBy(desc(imageBuilds.queuedAt)).limit(filter.limit ?? 200)
  return rows.map(nullsToUndefined)
}

/**
 * Mark every build left queued or running as failed: no build outlives the
 * server that started it (its builder pod is deleted at the next start).
 */
export async function failInterruptedImageBuilds(): Promise<number> {
  const db = await getDb()
  const rows = await db.update(imageBuilds)
    .set({ status: 'failed', error: 'the server restarted during this build', finishedAt: sql`now()` })
    .where(inArray(imageBuilds.status, ['queued', 'running'])).returning({ id: imageBuilds.id })
  return rows.length
}

export async function setProjectImageFields(
  projectId: string,
  patch: { defaultImageId?: string | null; lastImageId?: string | null; imageCacheDays?: number | null },
): Promise<void> {
  const db = await getDb()
  await db.update(projects).set(patch).where(eq(projects.id, projectId))
  notifyWorkspaceListChanged()
}

export async function getInstallSetting(key: string): Promise<string | undefined> {
  const db = await getDb()
  const [row] = await db.select().from(installSettings).where(eq(installSettings.key, key))
  return row?.value
}

export async function setInstallSetting(key: string, value: string | null): Promise<void> {
  const db = await getDb()
  if (value === null) {
    await db.delete(installSettings).where(eq(installSettings.key, key))
  } else {
    await db.insert(installSettings).values({ key, value })
      .onConflictDoUpdate({ target: installSettings.key, set: { value } })
  }
}

/** Record the image a workspace launched with (`workspaces.imageId`). */
export async function setWorkspaceImage(
  workspaceId: string,
  image: { imageId?: string; revisionId?: string; tag?: string },
): Promise<void> {
  const db = await getDb()
  await db.update(workspaces).set({
    imageId: image.imageId ?? null,
    imageRevisionId: image.revisionId ?? null,
    imageTag: image.tag ?? null,
  }).where(eq(workspaces.workspaceId, workspaceId))
}

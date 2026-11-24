/**
 * A project's named images and a user's own image, their revisions, and
 * what a create launches (docs/image-builds.md "Behavior").
 *
 * A project's images are its owner's to read and change; a user image is
 * its user's. Every save that changes content appends a revision and
 * starts its build at once; a create takes an image's last built revision,
 * so a save or rebuild in progress never holds one up.
 */
import { ServerError } from '@yaac/shared/errors'
import { STOCK_IMAGE_ID, type ImageBuild, type ImageBuildReason, type ImageFileManifest, type ImageRevision, type ImageSummary } from '@yaac/shared/types'
import {
  deleteImage as deleteImageRow,
  deleteProjectImageRows,
  getImage,
  getImageBuild,
  getImageRevision,
  getProjectRow,
  insertImage,
  insertImageRevision,
  listImageBuilds,
  listImageRevisions,
  listImages,
  listProjectRows,
  setProjectImageFields,
  type ImageRevisionRow,
  type ImageRow,
  type ImageScope,
} from '#db'
import { authorizeProject, personId, type Actor } from '#domain/access'
import { addAllowedHostToProject } from '#domain/projects'
import { relatedRegistryHosts } from '@yaac/shared/allowed-hosts'
import { workspaceDriver } from '#drivers/driver'
import { isLayered } from '#lib/build-context'
import { isUuid } from '#lib/uuid'
import { serverLog } from '#lib/log'
import { missingFiles, putBlob, readBlob, revisionContentHash, validateFilePath, validateManifest } from './blobs'
import {
  buildView,
  cancelBuildJob,
  chainFinalTag,
  chainTarget,
  queueChain,
  readBuildLog,
  removeBuildLogs,
  type ChainOutcome,
  type ChainTarget,
} from './builds'

/** The name a user's one image goes by. */
export const USER_IMAGE_NAME = 'Dockerfile.user'

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/

/**
 * The scope of an image, once `actor` may act on it: a project image is
 * its owner's in person, and a user image its user's alone (`personId`
 * refuses a delegate, whose edit would reach every project they own).
 */
async function authorizeImage(actor: Actor, image: ImageRow): Promise<ImageScope> {
  if (image.projectId) {
    await authorizeProject(actor, image.projectId)
    return { projectId: image.projectId }
  }
  if (actor.kind !== 'system' && personId(actor) !== image.userId) {
    throw new ServerError('FORBIDDEN', 'only its user may read or change a user image')
  }
  return { userId: image.userId! }
}

async function loadImage(actor: Actor, imageId: string): Promise<{ image: ImageRow; scope: ImageScope }> {
  const image = isUuid(imageId) ? await getImage(imageId) : undefined
  if (!image) throw new ServerError('NOT_FOUND', 'no such image')
  return { image, scope: await authorizeImage(actor, image) }
}

/** A revision as the wire shows it. */
async function revisionView(scope: ImageScope, row: ImageRevisionRow): Promise<ImageRevision> {
  const [newest] = await listImageBuilds({ revisionId: row.id, limit: 1 })
  return {
    id: row.id,
    imageId: row.imageId,
    number: row.number,
    dockerfile: row.dockerfile,
    files: row.files,
    contentHash: row.contentHash,
    author: row.author,
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(newest ? { buildStatus: newest.status } : {}),
    missingFiles: await missingFiles(scope, row.files),
  }
}

/** An image's state for a project's creates (`ImageSummary.state`). */
async function summaryOf(image: ImageRow, projectId: string | undefined, isDefault: boolean): Promise<ImageSummary> {
  const current = image.currentRevisionId ? await getImageRevision(image.currentRevisionId) : undefined
  const lastBuilt = image.lastBuiltRevisionId ? await getImageRevision(image.lastBuiltRevisionId) : undefined
  const [newest] = current
    ? await listImageBuilds({ revisionId: current.id, ...(projectId ? { projectId } : {}), limit: 1 })
    : []
  let state: ImageSummary['state'] = lastBuilt ? 'ready' : 'never-built'
  if (newest?.status === 'queued' || newest?.status === 'running') state = 'building'
  else if (newest?.status === 'failed' && lastBuilt?.id !== current?.id) state = 'failed'
  return {
    id: image.id,
    scope: image.userId ? 'user' : 'project',
    name: image.name,
    isDefault,
    ...(current ? { currentRevision: { id: current.id, number: current.number, createdAt: current.createdAt.toISOString() } } : {}),
    ...(lastBuilt ? { lastBuiltRevision: { id: lastBuilt.id, number: lastBuilt.number } } : {}),
    state,
    ...(newest ? { latestBuildId: newest.id } : {}),
  }
}

/** A project's images, the stock image first. */
export async function listProjectImages(actor: Actor, projectId: string): Promise<ImageSummary[]> {
  await authorizeProject(actor, projectId)
  const project = await getProjectRow(projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${projectId} not found`)
  const stock: ImageSummary = { id: STOCK_IMAGE_ID, scope: 'project', name: 'yaac', isDefault: project.defaultImageId === undefined, state: 'ready' }
  const rows = await listImages({ projectId })
  return [stock, ...await Promise.all(rows.map((r) => summaryOf(r, projectId, project.defaultImageId === r.id)))]
}

/** The caller's own user image, if they have one. */
export async function getUserImage(actor: Actor): Promise<ImageSummary | null> {
  const [image] = await listImages({ userId: personId(actor) })
  return image ? summaryOf(image, undefined, false) : null
}

/** One image with its current revision's content. */
export async function getImageDetail(actor: Actor, imageId: string): Promise<{ image: ImageSummary; revision: ImageRevision | null }> {
  const { image, scope } = await loadImage(actor, imageId)
  const current = image.currentRevisionId ? await getImageRevision(image.currentRevisionId) : undefined
  const project = image.projectId ? await getProjectRow(image.projectId) : undefined
  return {
    image: await summaryOf(image, image.projectId, project?.defaultImageId === image.id),
    revision: current ? await revisionView(scope, current) : null,
  }
}

/**
 * Store one support file's bytes, before a save names it: for an image, a
 * project (before its image exists) or the caller's user image.
 */
export async function uploadImageFile(
  actor: Actor,
  to: { imageId: string } | { projectId: string } | { user: true },
  data: Buffer,
): Promise<{ sha256: string; size: number }> {
  if ('imageId' in to) return putBlob((await loadImage(actor, to.imageId)).scope, data)
  if ('projectId' in to) {
    await authorizeProject(actor, to.projectId)
    return putBlob({ projectId: to.projectId }, data)
  }
  return putBlob({ userId: personId(actor) }, data)
}

/** A stored support file of a revision. */
export async function readImageFile(actor: Actor, imageId: string, revisionId: string, rel: string): Promise<Buffer> {
  const { scope } = await loadImage(actor, imageId)
  const revision = isUuid(revisionId) ? await getImageRevision(revisionId) : undefined
  if (!revision || revision.imageId !== imageId) throw new ServerError('NOT_FOUND', 'no such revision')
  const entry = revision.files[validateFilePath(rel)]
  const data = entry ? await readBlob(scope, entry.sha256) : undefined
  if (!data) throw new ServerError('NOT_FOUND', `no stored file ${rel} in revision ${revision.number}`)
  return data
}

export interface ImageContent {
  dockerfile: string
  /** Every support file, by path, as `uploadImageFile` returned it. */
  files: ImageFileManifest
  note?: string
}

/** What a save answers: the current revision, whether the save made it,
 *  and the builds it started. */
export interface SaveResult {
  revision: ImageRevision
  changed: boolean
  builds: ImageBuild[]
}

/**
 * Append a revision when the content changed, and start building it. A
 * user image must be layered on its parent.
 */
async function appendRevision(
  actor: Actor,
  image: ImageRow,
  scope: ImageScope,
  content: ImageContent,
): Promise<SaveResult> {
  if (image.userId && !isLayered(content.dockerfile)) {
    throw new ServerError('VALIDATION', 'Dockerfile.user must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}`, so it builds on the project\'s image')
  }
  if (content.dockerfile.trim() === '') throw new ServerError('VALIDATION', 'a Dockerfile cannot be empty')
  const files = await validateManifest(scope, content.files)
  const contentHash = revisionContentHash(content.dockerfile, files)
  const current = image.currentRevisionId ? await getImageRevision(image.currentRevisionId) : undefined
  if (current?.contentHash === contentHash) {
    return { revision: await revisionView(scope, current), changed: false, builds: [] }
  }
  const row = await insertImageRevision({
    imageId: image.id, dockerfile: content.dockerfile, files, contentHash, author: personId(actor),
    ...(content.note ? { note: content.note } : {}),
  })
  const buildIds = await buildSaved(image).catch((err: unknown) => {
    serverLog(`[images] build of ${image.name} after a save: ${String(err)}`)
    return []
  })
  const builds = await Promise.all(buildIds.map((id) => getImageBuild(id)))
  return {
    revision: await revisionView(scope, row),
    changed: true,
    builds: await Promise.all(builds.filter((b) => b !== undefined).map(buildView)),
  }
}

/**
 * Queue a saved image's build at once: a project image for its project, a
 * user image on top of each owned project's default image. Returns the
 * build rows queued.
 */
async function buildSaved(image: ImageRow): Promise<string[]> {
  if (workspaceDriver().kind !== 'k8s') return []
  const targets = image.projectId
    ? [await chainTarget(image.projectId, image.id)]
    : await Promise.all((await ownedProjectIds(image.userId!)).map(async (projectId) =>
      chainTarget(projectId, (await getProjectRow(projectId))?.defaultImageId)))
  const ids: string[] = []
  for (const target of targets) ids.push(...(await queueChain(target, { reason: 'save' })).buildIds)
  return ids
}

async function ownedProjectIds(userId: string): Promise<string[]> {
  return (await listProjectRows()).filter((p) => p.owner === userId).map((p) => p.id)
}

/** Create a project image, at revision 1, and start its build. */
export async function createProjectImage(
  actor: Actor,
  projectId: string,
  name: string,
  content: ImageContent,
): Promise<ImageSummary & { builds: ImageBuild[] }> {
  await authorizeProject(actor, projectId)
  if (!NAME_PATTERN.test(name) || name === 'yaac') {
    throw new ServerError('VALIDATION', 'an image name is lowercase letters, digits, `.`, `_` and `-`, and not `yaac`')
  }
  if ((await listImages({ projectId })).some((i) => i.name === name)) {
    throw new ServerError('CONFLICT', `this project already has an image named ${name}`)
  }
  const image = await insertImage({ projectId }, name)
  let saved: SaveResult
  try {
    saved = await appendRevision(actor, image, { projectId }, content)
  } catch (err) {
    await deleteImageRow(image.id)
    throw err
  }
  return { ...await summaryOf((await getImage(image.id))!, projectId, false), builds: saved.builds }
}

/** Save the caller's user image, creating it on its first save. */
export async function saveUserImage(actor: Actor, content: ImageContent): Promise<SaveResult> {
  const userId = personId(actor)
  const image = (await listImages({ userId }))[0] ?? await insertImage({ userId }, USER_IMAGE_NAME)
  return appendRevision(actor, image, { userId }, content)
}

/** Save new content of an image (a new revision when it changed). */
export async function saveImage(actor: Actor, imageId: string, content: ImageContent): Promise<SaveResult> {
  const { image, scope } = await loadImage(actor, imageId)
  return appendRevision(actor, image, scope, content)
}

/**
 * Delete an image with its history and build logs. Running workspaces keep
 * their image; a stopped one restarts on the project default.
 */
export async function deleteImage(actor: Actor, imageId: string): Promise<void> {
  const { image } = await loadImage(actor, imageId)
  const builds = await listImageBuilds({ imageId, limit: 100_000 })
  for (const build of builds) if (build.status === 'queued' || build.status === 'running') await cancelBuildJob(build.id)
  await deleteImageRow(image.id)
  await removeBuildLogs(builds)
}

/** A project's removal: its builds stop, and its images and build rows and
 *  logs go. Its support files go with the project's own tree. */
export async function removeProjectImages(projectId: string): Promise<void> {
  const builds = await listImageBuilds({ projectId, limit: 100_000 })
  for (const build of builds) if (build.status === 'queued' || build.status === 'running') await cancelBuildJob(build.id)
  await deleteProjectImageRows(projectId)
  await removeBuildLogs(builds)
}

/** An image of the project by name, as its id (`yaac` is the stock image). */
export async function resolveImageName(projectId: string, name: string): Promise<string> {
  if (name === 'yaac') return STOCK_IMAGE_ID
  const image = (await listImages({ projectId })).find((i) => i.name === name)
  if (!image) throw new ServerError('NOT_FOUND', `this project has no image named "${name}"`)
  return image.id
}

/** Make an image (or the stock image) the project's default. */
export async function setDefaultImage(actor: Actor, projectId: string, imageId: string): Promise<void> {
  await authorizeProject(actor, projectId)
  if (imageId !== STOCK_IMAGE_ID) {
    const image = isUuid(imageId) ? await getImage(imageId) : undefined
    if (!image || image.projectId !== projectId) throw new ServerError('NOT_FOUND', 'no such image in this project')
  }
  await setProjectImageFields(projectId, { defaultImageId: imageId === STOCK_IMAGE_ID ? null : imageId })
}

/** Set the project's build cache age, in days (null for the default). */
export async function setImageCacheDays(actor: Actor, projectId: string, days: number | null): Promise<void> {
  await authorizeProject(actor, projectId)
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) {
    throw new ServerError('VALIDATION', 'cache days must be a whole number from 1 to 365')
  }
  await setProjectImageFields(projectId, { imageCacheDays: days })
}

/** An image's revisions, newest first. */
export async function listRevisions(actor: Actor, imageId: string): Promise<ImageRevision[]> {
  const { scope } = await loadImage(actor, imageId)
  return Promise.all((await listImageRevisions(imageId)).map((r) => revisionView(scope, r)))
}

/**
 * Append a revision with an old one's content. Support files whose bytes
 * are gone are dropped and named, so the Dockerfile comes back.
 */
export async function restoreRevision(actor: Actor, imageId: string, revisionId: string): Promise<SaveResult & { droppedFiles: string[] }> {
  const { image, scope } = await loadImage(actor, imageId)
  const old = isUuid(revisionId) ? await getImageRevision(revisionId) : undefined
  if (!old || old.imageId !== imageId) throw new ServerError('NOT_FOUND', 'no such revision')
  const gone = await missingFiles(scope, old.files)
  const files = Object.fromEntries(Object.entries(old.files).filter(([rel]) => !gone.includes(rel)))
  const saved = await appendRevision(actor, image, scope, {
    dockerfile: old.dockerfile, files, note: `restored revision ${old.number}`,
  })
  return { ...saved, droppedFiles: gone }
}

/**
 * Build an image now (`manual`): its current revision, or `revisionId`. A
 * user image builds on `projectId`'s default image.
 */
export async function requestImageBuild(
  actor: Actor,
  imageId: string,
  opts: { revisionId?: string; noCache?: boolean; projectId?: string },
): Promise<ImageBuild[]> {
  const { image } = await loadImage(actor, imageId)
  if (image.userId && image.currentRevisionId !== (opts.revisionId ?? image.currentRevisionId)) {
    throw new ServerError('VALIDATION', 'a user image builds at its current revision')
  }
  const projectId = image.projectId ?? opts.projectId
  if (!projectId) throw new ServerError('VALIDATION', 'name the project a user image is built for')
  if (!image.projectId) await authorizeProject(actor, projectId)
  const project = await getProjectRow(projectId)
  const target = image.projectId
    ? await chainTarget(projectId, image.id, opts.revisionId)
    : await chainTarget(projectId, project?.defaultImageId)
  return queueManual(actor, target, opts.noCache)
}

/** Queue a chain's missing layers by hand, returning the builds started. */
async function queueManual(actor: Actor, target: ChainTarget, noCache?: boolean): Promise<ImageBuild[]> {
  const { buildIds } = await queueChain(target, { reason: 'manual', noCache, requestedBy: personId(actor) })
  const rows = await Promise.all(buildIds.map((id) => getImageBuild(id)))
  return Promise.all(rows.filter((r) => r !== undefined).map(buildView))
}

/** A build's row, once `actor` may see it. */
async function loadBuild(actor: Actor, buildId: string): Promise<NonNullable<Awaited<ReturnType<typeof getImageBuild>>>> {
  const row = isUuid(buildId) ? await getImageBuild(buildId) : undefined
  if (!row) throw new ServerError('NOT_FOUND', 'no such build')
  await authorizeProject(actor, row.projectId)
  return row
}

export async function getBuild(actor: Actor, buildId: string): Promise<ImageBuild> {
  return buildView(await loadBuild(actor, buildId))
}

/** Builds, newest first: a project's, or one image's. */
export async function listBuilds(actor: Actor, filter: { projectId?: string; imageId?: string }): Promise<ImageBuild[]> {
  if (filter.imageId) await loadImage(actor, filter.imageId)
  else if (filter.projectId) await authorizeProject(actor, filter.projectId)
  else throw new ServerError('VALIDATION', 'name a project or an image')
  const rows = await listImageBuilds({ ...filter, limit: 100 })
  const visible = filter.imageId && !filter.projectId
    ? await Promise.all(rows.map(async (r) => { try { await authorizeProject(actor, r.projectId); return r } catch { return null } }))
    : rows
  return Promise.all(visible.filter((r) => r !== null).map(buildView))
}

export async function buildLog(actor: Actor, buildId: string, offset: number): Promise<{ text: string; offset: number; done: boolean }> {
  return readBuildLog(await loadBuild(actor, buildId), offset)
}

export async function cancelBuild(actor: Actor, buildId: string): Promise<void> {
  const row = await loadBuild(actor, buildId)
  if (row.status !== 'queued' && row.status !== 'running') throw new ServerError('CONFLICT', 'this build has already ended')
  await cancelBuildJob(buildId)
}

/** Build a finished build's revision again, the same way. */
export async function retryBuild(actor: Actor, buildId: string, opts: { noCache?: boolean } = {}): Promise<ImageBuild[]> {
  const row = await loadBuild(actor, buildId)
  const image = await getImage(row.imageId)
  if (!image) throw new ServerError('NOT_FOUND', 'its image was deleted')
  const project = await getProjectRow(row.projectId)
  const target = image.projectId
    ? await chainTarget(row.projectId, image.id, row.revisionId)
    : await chainTarget(row.projectId, project?.defaultImageId)
  return queueManual(actor, target, opts.noCache ?? row.noCache)
}

/**
 * Allow a host a build was refused, with the rest of its registry's hosts,
 * for the build's project, then build again. Returns the hosts allowed
 * and the builds started.
 */
export async function allowBuildHost(
  actor: Actor,
  buildId: string,
  host: string,
): Promise<{ allowed: string[]; builds: ImageBuild[] }> {
  const row = await loadBuild(actor, buildId)
  const allowed = relatedRegistryHosts(host)
  for (const h of allowed) await addAllowedHostToProject(actor, row.projectId, h)
  return { allowed, builds: await retryBuild(actor, buildId) }
}

/** What a create launches: its image ref, and the image and revision behind it. */
export interface CreateImage {
  ref: string
  tag: string
  imageId?: string
  revisionId?: string
}

/**
 * The image a create launches (docs/image-builds.md "Behavior"). `imageId`
 * names an image (`STOCK_IMAGE_ID` the stock one); absent, the project's
 * default. A create takes the image's last built revision, under its
 * owner's user image as it is now (built first if that changed); with
 * `awaitBuild`, or when nothing is built yet, it builds the current
 * revision and waits, failing with that build. An explicit choice is
 * remembered as the project's last one (`STOCK_IMAGE_ID` for stock), so
 * a project that never chose follows its default.
 */
export async function imageForCreate(opts: {
  projectId: string
  imageId?: string
  awaitBuild?: boolean
  /** Remember the choice; a spare or a restart does not. */
  remember?: boolean
  /** Why it builds: `prewarm` for a spare, so it queues behind people. */
  reason?: Extract<ImageBuildReason, 'create' | 'prewarm'>
  requestedBy?: string
  onProgress?: (message: string) => void
}): Promise<CreateImage> {
  const project = await getProjectRow(opts.projectId)
  if (!project) throw new ServerError('NOT_FOUND', `project ${opts.projectId} not found`)
  if (opts.remember !== false && opts.imageId !== undefined && project.lastImageId !== opts.imageId) {
    await setProjectImageFields(opts.projectId, { lastImageId: opts.imageId })
  }
  const chosen = opts.imageId ?? project.defaultImageId ?? STOCK_IMAGE_ID
  const imageId = chosen === STOCK_IMAGE_ID ? undefined : chosen
  const driver = workspaceDriver()
  let target: ChainTarget | undefined
  if (imageId) {
    const image = await getImage(imageId)
    if (!image || image.projectId !== opts.projectId) throw new ServerError('NOT_FOUND', 'no such image in this project')
    if (!opts.awaitBuild && image.lastBuiltTag && image.lastBuiltRevisionId) {
      target = await chainTarget(opts.projectId, imageId, image.lastBuiltRevisionId)
      if (await chainFinalTag(target) === image.lastBuiltTag) {
        return { ref: driver.imageRef(image.lastBuiltTag), tag: image.lastBuiltTag, imageId, revisionId: image.lastBuiltRevisionId }
      }
    }
  }
  target ??= await chainTarget(opts.projectId, imageId)
  const { buildIds, done } = await queueChain(target, { reason: opts.reason ?? 'create', requestedBy: opts.requestedBy })
  if (buildIds.length > 0) {
    opts.onProgress?.(`Building image ${target.image ? `${target.image.name} revision ${target.revision!.number}` : 'yaac'}...`)
  }
  const outcome: ChainOutcome = await done
  if (!outcome.ok) throw new ServerError('CONFLICT', `the image build failed: ${outcome.error}`)
  return {
    ref: driver.imageRef(outcome.finalTag),
    tag: outcome.finalTag,
    ...(target.image ? { imageId: target.image.id, revisionId: target.revision!.id } : {}),
  }
}

/**
 * The tag a create of the project's last chosen image (else its default)
 * would launch now, without building: what its spare is kept on. Null
 * when that image has nothing built under the owner's current user image.
 */
export async function spareImageTag(projectId: string): Promise<string | null> {
  const project = await getProjectRow(projectId)
  if (!project) return null
  const chosen = project.lastImageId ?? project.defaultImageId ?? STOCK_IMAGE_ID
  if (chosen === STOCK_IMAGE_ID) return chainFinalTag(await chainTarget(projectId))
  const image = await getImage(chosen)
  if (!image?.lastBuiltTag || !image.lastBuiltRevisionId) return null
  const built = await chainFinalTag(await chainTarget(projectId, image.id, image.lastBuiltRevisionId))
  return built === image.lastBuiltTag ? built : null
}

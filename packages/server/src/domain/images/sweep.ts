/**
 * The image sweep and what image GC keeps (docs/image-builds.md
 * "Behavior", docs/image-gc.md).
 *
 * A save starts its own build, so the sweep's job is a changed trusted
 * chain: after a yaac upgrade every project image has a new tag. It
 * rebuilds each project's default image and the image its last create
 * used; any other image rebuilds when a create next names it. It starts
 * no pod itself: the builds queue like any other, behind people's.
 */
import { env, testEnv } from '@yaac/shared/env'
import { STOCK_IMAGE_ID } from '@yaac/shared/types'
import {
  listImageBuilds,
  listImageRevisions,
  listImages,
  listProjectRows,
  type ImageScope,
} from '#db'
import { workspaceDriver } from '#drivers/driver'
import { serverLog } from '#lib/log'
import { pruneBlobs } from './blobs'
import { buildChain, chainTarget, targetChain } from './builds'

/** How long a failed or cancelled chain holds off the sweep. A save (a
 *  new tag) or a retry lifts it at once. */
const FAILED_RETRY_MS = 10 * 60_000

/** Sweep builds in flight, by project and image (`stock` for none). */
const sweeping = new Set<string>()

/**
 * Reconcile step: queue a build for each project's default and last used
 * image whose chain the registry lacks. Off with `YAAC_IMAGE_PREWARM=0`,
 * and in e2e, where the global setup prebuilds the trusted chain and tests
 * build what they need. A failed or cancelled build of a tag holds the
 * sweep off it for a while, so a cancel is not undone on the next pass.
 */
export async function reconcileImageSweep(): Promise<void> {
  if (workspaceDriver().kind !== 'k8s' || testEnv.requirePrebuiltImages || !env.imagePrewarm) return
  const driver = workspaceDriver()
  for (const project of await listProjectRows()) {
    const chosen = project.lastImageId === STOCK_IMAGE_ID ? undefined : project.lastImageId
    for (const imageId of new Set([project.defaultImageId, chosen])) {
      const key = `${project.id} ${imageId ?? 'stock'}`
      if (sweeping.has(key)) continue
      try {
        const target = await chainTarget(project.id, imageId)
        const chain = await targetChain(target)
        const ended = await listImageBuilds({ projectId: project.id, statuses: ['failed', 'cancelled'], limit: 20 })
        const cutoff = Date.now() - FAILED_RETRY_MS
        if (ended.some((b) => chain.layers.some((l) => l.tag === b.tag) && (b.finishedAt?.getTime() ?? 0) > cutoff)) continue
        if ((await driver.missingImageLayers(chain)).length === 0) continue
        sweeping.add(key)
        void buildChain(target, { reason: 'prewarm' })
          .catch((err: unknown) => serverLog(`[image-sweep] ${project.id}: ${String(err)}`))
          .finally(() => sweeping.delete(key))
      } catch (err) {
        serverLog(`[image-sweep] ${project.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}

/** Succeeded builds kept per image, layer and project. */
const BUILDS_KEPT = 2

/**
 * Every tag image GC keeps: each image's two newest builds (per project
 * and layer), every build in progress, and each image's last built chain.
 */
export async function keptImageTags(): Promise<string[]> {
  const kept = new Set<string>()
  const counts = new Map<string, number>()
  for (const row of await listImageBuilds({ limit: 100_000 })) {
    if (row.status === 'queued' || row.status === 'running') kept.add(row.tag)
    if (row.status !== 'succeeded') continue
    const key = `${row.imageId}|${row.projectId}|${row.layer}`
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    if (n <= BUILDS_KEPT) kept.add(row.tag)
  }
  for (const project of await listProjectRows()) {
    for (const image of await listImages({ projectId: project.id })) {
      if (image.lastBuiltTag) kept.add(image.lastBuiltTag)
    }
  }
  return [...kept]
}

/** Revisions whose support-file bytes are kept beyond those a kept build used. */
const REVISIONS_KEPT = 2

/**
 * Drop support-file bytes no kept revision names: an image's two newest
 * revisions, and any older one a kept build was made from. Revision rows
 * are kept whole; a restore of an older one says which files are gone.
 */
export async function pruneImageBlobs(): Promise<void> {
  const keptRevisions = new Set<string>()
  const counts = new Map<string, number>()
  for (const row of await listImageBuilds({ statuses: ['succeeded', 'queued', 'running'], limit: 100_000 })) {
    const key = `${row.imageId}|${row.projectId}|${row.layer}`
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    if (n <= BUILDS_KEPT || row.status !== 'succeeded') keptRevisions.add(row.revisionId)
  }
  const projects = await listProjectRows()
  const scopes: ImageScope[] = [
    ...projects.map((p) => ({ projectId: p.id })),
    ...[...new Set(projects.map((p) => p.owner))].map((userId) => ({ userId })),
  ]
  for (const scope of scopes) {
    const keep = new Set<string>()
    for (const image of await listImages(scope)) {
      const revisions = await listImageRevisions(image.id)
      revisions.forEach((r, i) => {
        if (i < REVISIONS_KEPT || keptRevisions.has(r.id)) for (const { sha256 } of Object.values(r.files)) keep.add(sha256)
      })
    }
    const removed = await pruneBlobs(scope, keep)
    if (removed > 0) serverLog(`[image-gc] removed ${removed} unused support file(s)`)
  }
}


/**
 * Builds and pushes each project's image chain (from `resolveImageChain`),
 * running at most one build or push per tag at a time. Tags are content
 * hashes, so concurrent creates or projects needing the same layer share
 * one build. Module-level maps are enough locking because the server is a
 * single process. The first caller owns the build row; later callers
 * attach their project and await the same promise.
 */
import { engineForLayer } from './build-engine'
import { BuilderPodLease } from './builder-pod'
import { pushImageToRegistry, registryHasTag, registryRef } from '#drivers/k8s/container'
import { serverLog } from '#log'
import type { ImageLayerName } from '@yaac/shared/types'
import type { ProjectRef } from '#drivers/contract'
import {
  attachImageBuildProject,
  failImageBuild,
  finishImageBuild,
  type ImageBuildReason,
  type ImageLayer,
  ingestImageBuildLine,
  registerImageBuild,
  resolveImageChain,
} from '#drivers/k8s/image-engine'

interface BuildContext {
  project: ProjectRef
  reason: ImageBuildReason
  /**
   * Builder pod shared by the untrusted layers of one `ensureImage` call,
   * which owns and releases it.
   */
  lease: BuilderPodLease
}

const inflightBuilds = new Map<string, { id: string; promise: Promise<void> }>()
const inflightPushes = new Map<string, Promise<string>>()

/**
 * Tags confirmed to be in the registry during this server run (built, or
 * pushed). Tags are content hashes and never change, so each needs checking
 * only once. If the registry is wiped mid-run, the next pod fails fast with
 * ErrImagePull. `forgetVerifiedTags` clears them after GC.
 */
const realizedTags = new Set<string>()
const pushedTags = new Set<string>()

/**
 * True while this server is building or pushing an image. Builds write to
 * the registry, so main registry GC skips its collect while this is true.
 */
export function imageWorkInFlight(): boolean {
  return inflightBuilds.size > 0 || inflightPushes.size > 0
}

/**
 * Forget which tags were verified present. Main registry GC calls this after
 * retiring tags, so a retired tag is not handed to a pod.
 */
export function forgetVerifiedTags(): void {
  realizedTags.clear()
  pushedTags.clear()
}

/**
 * Build one layer, joining any in-flight build of the same tag. All callers
 * share the outcome, including a failure.
 */
export function buildLayerShared(layer: ImageLayer, ctx: BuildContext): Promise<void> {
  const existing = inflightBuilds.get(layer.tag)
  if (existing) {
    attachImageBuildProject(existing.id, ctx.project)
    return existing.promise
  }

  const id = registerImageBuild({
    tag: layer.tag,
    layer: layer.name,
    action: 'build',
    project: ctx.project,
    reason: ctx.reason,
  })
  const promise = runBuild(id, layer, ctx)
  // Set before any await so a same-tick caller joins this build.
  inflightBuilds.set(layer.tag, { id, promise })
  return promise
}

async function runBuild(
  id: string,
  layer: ImageLayer,
  ctx: BuildContext,
): Promise<void> {
  try {
    serverLog(`[build] starting ${layer.tag}`)
    await engineForLayer(layer.name).build(layer, {
      project: ctx.project,
      lease: ctx.lease,
      onLog: (line) => ingestImageBuildLine(id, line),
    })
    finishImageBuild(id)
    realizedTags.add(layer.tag)
  } catch (err) {
    failImageBuild(id, err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    inflightBuilds.delete(layer.tag)
  }
}

/**
 * Push a built tag to the local registry, joining any in-flight push of the
 * same tag. When the tag is already there, skips the push and creates no
 * build row (the prewarm sweep calls this every tick). Returns the
 * in-cluster ref.
 */
export async function pushImageShared(
  tag: string,
  ctx: { project: ProjectRef; reason: ImageBuildReason },
  opts: { compressionFormat?: 'zstd' | 'gzip' } = {},
): Promise<string> {
  const existing = inflightPushes.get(tag)
  if (existing) return existing

  if (pushedTags.has(tag)) return registryRef(tag)
  if (await registryHasTag(tag)) {
    pushedTags.add(tag)
    return registryRef(tag)
  }

  // Re-check after the await: another caller may have started the push.
  const raced = inflightPushes.get(tag)
  if (raced) return raced

  const id = registerImageBuild({
    tag,
    layer: 'push',
    action: 'push',
    project: ctx.project,
    reason: ctx.reason,
  })
  const promise = pushImageToRegistry(tag, {
    onLog: (line) => ingestImageBuildLine(id, line),
    compressionFormat: opts.compressionFormat,
  })
    .then((ref) => {
      finishImageBuild(id)
      pushedTags.add(tag)
      return ref
    })
    .catch((err: unknown) => {
      failImageBuild(id, err instanceof Error ? err.message : String(err))
      throw err
    })
    .finally(() => inflightPushes.delete(tag))
  inflightPushes.set(tag, promise)
  return promise
}

export interface EnsureImageOpts {
  /** What triggered the build; shown in the webapp's build list. */
  reason?: ImageBuildReason
  /** Fired before each missing layer starts building (1-based index). */
  onLayerStart?: (index: number, total: number, layer: ImageLayerName) => void
}

/**
 * Ensure a project's full image chain is in the registry, and return the
 * final image tag.
 *
 * Layer 1: yaac-base (Dockerfile.default: Ubuntu, system packages, Node).
 *   Skipped when Dockerfile.yaac is standalone (FROM isn't ${BASE_IMAGE}).
 * Layer 1a: yaac-tools (Dockerfile.tools: claude, codex, opencode, etc.),
 *   whenever the base is used.
 * Layer 1b (optional): yaac-nestable (Dockerfile.nestable: in-pod rootful
 *   podman and the docker CLI), only when `nestedContainers` is set.
 * Layer 2: yaac-proj-<id> from Dockerfile.yaac, when present: either layered
 *   on the layers above (`FROM ${BASE_IMAGE}`) or standalone.
 * Layer 3 (optional): yaac-user-<id> from ~/.yaac/Dockerfile.user.
 *
 * @param imagePrefix - Image name prefix; tests use their own.
 * @param requirePrebuilt - Throw instead of building a missing layer. Used
 *   by e2e tests so parallel workers fail fast.
 * @param nestedContainers - Include the nestable layer.
 */
export async function ensureImage(
  project: ProjectRef,
  imagePrefix?: string,
  requirePrebuilt = false,
  nestedContainers = false,
  opts: EnsureImageOpts = {},
): Promise<string> {
  const prefix = imagePrefix ?? 'yaac'
  const { layers, finalTag } = await resolveImageChain(project, prefix, nestedContainers)
  const reason = opts.reason ?? 'session'

  // One builder pod per call, created only if a layer needs building.
  const lease = new BuilderPodLease()
  try {
    for (const [i, layer] of layers.entries()) {
      // The registry decides whether a layer exists. If a build of the tag
      // is in flight, join it instead of checking.
      if (!inflightBuilds.has(layer.tag)) {
        if (realizedTags.has(layer.tag)) continue
        if (await registryHasTag(layer.tag)) {
          realizedTags.add(layer.tag)
          continue
        }
      }

      if (requirePrebuilt) {
        throw new Error(
          `Image ${layer.tag} is missing or stale. ` +
          'Restart the test run so the global setup can rebuild it.',
        )
      }

      opts.onLayerStart?.(i + 1, layers.length, layer.name)
      await buildLayerShared(layer, { project, reason, lease })
    }
  } finally {
    await lease.release()
  }

  return finalTag
}

/** Test helper: forget all in-flight builds, pushes, and verified tags. */
export function _clearBuildCoordinatorForTests(): void {
  inflightBuilds.clear()
  inflightPushes.clear()
  realizedTags.clear()
  pushedTags.clear()
}

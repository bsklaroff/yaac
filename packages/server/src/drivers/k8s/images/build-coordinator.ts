/**
 * Builds each project's image chain (from `resolveImageChain`), running at
 * most one build per tag at a time. Tags are content
 * hashes, so concurrent creates or projects needing the same layer share
 * one build. Module-level maps are enough locking because the server is a
 * single process. The first caller owns the build row; later callers
 * attach their project and await the same promise.
 */
import { BuilderPodLease, buildLayerInPod } from './builder-pod'
import { registryHasTag } from '#drivers/k8s/container'
import { serverLog } from '#log'
import type { ImageLayerName } from '@yaac/shared/types'
import {
  attachImageBuildProject,
  failImageBuild,
  finishImageBuild,
  type ImageBuildReason,
  type ImageLayer,
  ingestImageBuildLine,
  missingPrebuiltImage,
  registerImageBuild,
  resolveImageChain,
} from '#drivers/k8s/image-engine'

interface BuildContext {
  projectId: string
  reason: ImageBuildReason
  /**
   * Builder pod shared by the untrusted layers of one `ensureImage` call,
   * which owns and releases it.
   */
  lease: BuilderPodLease
}

/**
 * The yaac-shipped layers, built and pushed by `yaac cluster install`, so
 * the server only looks them up (docs/trust-split-builds.md). Every other
 * layer runs user- or agent-editable RUN steps and builds in a sandboxed
 * builder pod. This is an allowlist, so a new layer name is sandboxed by
 * default; `resolveImageChain()` assigns these names only to the
 * yaac-shipped Dockerfiles.
 */
const TRUSTED_LAYERS: ReadonlySet<ImageLayerName> = new Set(['base', 'tools', 'nestable'])

const inflightBuilds = new Map<string, { id: string; promise: Promise<void> }>()

/**
 * Tags confirmed to be in the registry during this server run. Tags are
 * content hashes and never change, so each needs checking only once. If
 * the registry is wiped mid-run, the next pod fails fast with
 * ErrImagePull. `forgetVerifiedTags` clears them after GC.
 */
const realizedTags = new Set<string>()

/**
 * True while this server is building an image. Builds write to the
 * registry, so main registry GC skips its collect while this is true.
 */
export function imageWorkInFlight(): boolean {
  return inflightBuilds.size > 0
}

/**
 * Forget which tags were verified present. Main registry GC calls this after
 * retiring tags, so a retired tag is not handed to a pod.
 */
export function forgetVerifiedTags(): void {
  realizedTags.clear()
}

/**
 * Build one layer, joining any in-flight build of the same tag. All callers
 * share the outcome, including a failure.
 */
function buildLayerShared(layer: ImageLayer, ctx: BuildContext): Promise<void> {
  const existing = inflightBuilds.get(layer.tag)
  if (existing) {
    attachImageBuildProject(existing.id, ctx.projectId)
    return existing.promise
  }

  const id = registerImageBuild({
    tag: layer.tag,
    layer: layer.name,
    projectId: ctx.projectId,
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
    // A missing trusted layer means a missing install, not a build to run.
    if (TRUSTED_LAYERS.has(layer.name)) throw missingPrebuiltImage(layer.name, layer.tag)
    serverLog(`[build] starting ${layer.tag}`)
    await buildLayerInPod(layer, {
      projectId: ctx.projectId,
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

interface EnsureImageOpts {
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
 * Layer 3 (optional): yaac-user-<id> from the project owner's Dockerfile.user.
 *
 * @param imagePrefix - Image name prefix; tests use their own.
 * @param requirePrebuilt - Throw instead of building a missing layer. Used
 *   by e2e tests so parallel workers fail fast.
 * @param nestedContainers - Include the nestable layer.
 */
export async function ensureImage(
  projectId: string,
  owner: string,
  imagePrefix?: string,
  requirePrebuilt = false,
  nestedContainers = false,
  opts: EnsureImageOpts = {},
): Promise<string> {
  const prefix = imagePrefix ?? 'yaac'
  const { layers, finalTag } = await resolveImageChain(projectId, owner, prefix, nestedContainers)
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
      await buildLayerShared(layer, { projectId, reason, lease })
    }
  } finally {
    await lease.release()
  }

  return finalTag
}

/** Test helper: forget all in-flight builds and verified tags. */
export function _clearBuildCoordinatorForTests(): void {
  inflightBuilds.clear()
  realizedTags.clear()
}

/**
 * Single-flight orchestration over the image dependency graph.
 *
 * `resolveImageChain` gives each project an ordered list of content-hash
 * tagged layers; this module realizes those layers (and registry pushes)
 * with at most one podman process per tag. Tags are content-addressed, so
 * two projects (or two concurrent worktree creates) that need the same step
 * coalesce onto one build and fan out again on their distinct downstream
 * layers.
 *
 * The server is a single process and every production caller is
 * server-side, so module-level maps are sufficient mutual exclusion (same
 * argument as the prewarm pool's in-flight counters). Winners own the
 * build-registry entry lifecycle (register → ingest log → finish/fail);
 * joiners only attach their project slug and await the shared promise.
 */
import {
  engineForLayer,
  TRUSTED_PARENT_COMPRESSION,
} from './build-engine'
import { BuilderPodLease } from './builder-pod'
import { pushImageToRegistry, registryHasTag, registryRef } from '#drivers/k8s/container'
import { serverLog } from '#log'
import type { ImageLayerName } from '@yaac/shared/types'
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
  projectSlug: string
  reason: ImageBuildReason
  /**
   * Builder-pod lease for trust-split untrusted layers, owned by the
   * ensureImage call that created it — adjacent untrusted layers of one
   * chain build in the same pod. Ignored by the host engine. Required so no
   * build path can reach the cluster engine without one.
   */
  lease: BuilderPodLease
}

const inflightBuilds = new Map<string, { id: string; promise: Promise<void> }>()
const inflightPushes = new Map<string, Promise<string>>()

/**
 * Tags verified present (image store / registry respectively) this server
 * run. Content-hash tags are immutable — nothing publishes new bytes under
 * an existing tag — so a verified tag never needs re-checking: this trades
 * a `podman image exists` child process (and a registry HEAD) per layer per
 * create for one per tag per run. The residual staleness (someone prunes
 * the podman store or wipes the registry mid-run) surfaces as a fail-fast
 * ErrImagePull on the next worktree pod, same as any missing immutable tag.
 */
const realizedTags = new Set<string>()
const pushedTags = new Set<string>()

/**
 * True while this server is building or pushing an image. Every build ends
 * in registry writes (its step cache, then its product), so the build-cache
 * collect stands down on it — the one pusher class the registry's own
 * filesystem signals see late.
 */
export function imageWorkInFlight(): boolean {
  return inflightBuilds.size > 0 || inflightPushes.size > 0
}

/**
 * Build one layer, coalescing with any in-flight build of the same tag.
 * The winner creates the build-registry entry and owns its lifecycle;
 * joiners attach their project slug and share the outcome (including a
 * failure, which rejects every waiter).
 */
export function buildLayerShared(layer: ImageLayer, ctx: BuildContext): Promise<void> {
  const existing = inflightBuilds.get(layer.tag)
  if (existing) {
    attachImageBuildProject(existing.id, ctx.projectSlug)
    return existing.promise
  }

  const id = registerImageBuild({
    tag: layer.tag,
    layer: layer.name,
    action: 'build',
    projectSlug: ctx.projectSlug,
    reason: ctx.reason,
  })
  const promise = runBuild(id, layer, ctx)
  // Set synchronously (before any await inside runBuild resolves) so a
  // same-tick caller joins instead of double-building.
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
      projectSlug: ctx.projectSlug,
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
 * Push a built tag to the local registry, coalescing concurrent pushes of
 * the same tag. Skips both the push and the registry entry when the tag is
 * already present (content-hash tags are immutable) — the background sweep
 * calls this every tick and must not mint a "succeeded push" row each time.
 * Returns the in-cluster ref, like `pushImageToRegistry`.
 */
export async function pushImageShared(
  tag: string,
  ctx: { projectSlug: string; reason: ImageBuildReason },
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
    projectSlug: ctx.projectSlug,
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
 * Ensures the full image chain is built for a project.
 *
 * Layer 1: yaac-base (Dockerfile.default — Ubuntu + system packages + Node)
 *   Skipped when Dockerfile.yaac is standalone (any FROM that isn't ${BASE_IMAGE}).
 * Layer 1a: yaac-tools (Dockerfile.tools — claude, codex, opencode, etc.)
 *   Included whenever the canonical base is in use.
 * Layer 1b (optional): yaac-nestable (Dockerfile.nestable — in-pod rootless
 *   podman + docker CLI/compose), only when `nestedContainers` is set.
 * Layer 2: yaac-base from Dockerfile.yaac — when present:
 *   - layered on Dockerfile.tools / Dockerfile.nestable (when Dockerfile.yaac
 *     uses `ARG BASE_IMAGE` + `FROM ${BASE_IMAGE}`)
 *   - or standalone (replaces the canonical base + tools + nestable)
 * Layer 3 (optional): yaac-user-<slug> (~/.yaac/Dockerfile.user, builds on top)
 *
 * Missing layers build through the single-flight coordinator, so concurrent
 * callers (simultaneous creates, the background prewarm sweep) never run
 * duplicate podman builds of the same tag.
 *
 * Returns the final image name to use for containers.
 *
 * @param imagePrefix - Override for image name prefix. Used by tests to
 *   build isolated images that don't interfere with the running application.
 * @param requirePrebuilt - When true, throw instead of building if the base
 *   image is missing or stale. Used by e2e tests so parallel workers fail
 *   fast instead of racing to build the same image.
 * @param nestedContainers - Include the nestable layer (from the project's
 *   `nestedContainers` config, passed by createWorktree).
 */
export async function ensureImage(
  projectSlug: string,
  imagePrefix?: string,
  requirePrebuilt = false,
  nestedContainers = false,
  opts: EnsureImageOpts = {},
): Promise<string> {
  const prefix = imagePrefix ?? 'yaac'
  const { layers, finalTag } = await resolveImageChain(projectSlug, prefix, nestedContainers)
  const reason = opts.reason ?? 'session'

  // One builder pod per request, shared by adjacent untrusted layers.
  // Created lazily on the first cluster-pod build; a no-op release when
  // every layer was already realized or host-built.
  const lease = new BuilderPodLease()
  try {
    for (const [i, layer] of layers.entries()) {
      const engine = engineForLayer(layer.name)
      // An in-flight build means the tag doesn't exist yet — join it rather
      // than trusting the exists check (podman commits the tag at the end).
      if (!inflightBuilds.has(layer.tag)) {
        if (realizedTags.has(layer.tag)) continue
        if (await engine.imageExists(layer.tag)) {
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

      // A cluster-pod build pulls its parent from the registry — push a
      // host-built parent first (HEAD-skipped when already present; a
      // cluster-pod parent was pushed by its own build).
      if (engine.kind === 'cluster-pod' && layer.buildArgs?.BASE_IMAGE) {
        await pushImageShared(layer.buildArgs.BASE_IMAGE, { projectSlug, reason }, {
          compressionFormat: TRUSTED_PARENT_COMPRESSION,
        })
      }

      opts.onLayerStart?.(i + 1, layers.length, layer.name)
      await buildLayerShared(layer, { projectSlug, reason, lease })
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

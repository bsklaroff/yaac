/**
 * Single-flight orchestration over the image dependency graph.
 *
 * `resolveImageChain` gives each project an ordered list of content-hash
 * tagged layers; this module realizes those layers (and registry pushes)
 * with at most one podman process per tag. Tags are content-addressed, so
 * two projects (or two concurrent session creates) that need the same step
 * coalesce onto one build and fan out again on their distinct downstream
 * layers.
 *
 * The daemon is a single process and every production caller is
 * daemon-side, so module-level maps are sufficient mutual exclusion (same
 * argument as the prewarm pool's in-flight counters). Winners own the
 * build-registry entry lifecycle (register → ingest log → finish/fail);
 * joiners only attach their project slug and await the shared promise.
 */
import {
  buildImage,
  resolveImageChain,
  type ImageLayer,
} from '@/lib/container/image-builder'
import { imageExists, removeImage } from '@/lib/container/runtime'
import { pushImageToRegistry, registryHasTag, registryRef } from '@/lib/k8s/registry'
import { daemonLog } from '@/daemon/log'
import {
  attachImageBuildProject,
  failImageBuild,
  finishImageBuild,
  ingestImageBuildLine,
  registerImageBuild,
  type ImageBuildReason,
} from '@/daemon/image-builds'
import type { ImageLayerName } from '@/shared/types'

export type { ImageBuildReason }

interface BuildContext {
  projectSlug: string
  reason: ImageBuildReason
  onLog?: (line: string) => void
}

const inflightBuilds = new Map<string, { id: string; promise: Promise<void> }>()
const inflightPushes = new Map<string, Promise<string>>()

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
  const promise = runBuild(id, layer, ctx, { noCache: false })
  // Set synchronously (before any await inside runBuild resolves) so a
  // same-tick caller joins instead of double-building.
  inflightBuilds.set(layer.tag, { id, promise })
  return promise
}

async function runBuild(
  id: string,
  layer: ImageLayer,
  ctx: BuildContext,
  opts: { noCache: boolean; preStep?: () => Promise<void> },
): Promise<void> {
  try {
    // The rebuild path removes the stale image inside the single-flight
    // slot, so the removal never races a concurrent build of the tag.
    if (opts.preStep) await opts.preStep()
    daemonLog(`[build] starting ${layer.tag}`)
    await buildImage(layer.tag, layer.dockerfile, layer.context, layer.buildArgs, {
      noCache: opts.noCache,
      onLog: (line) => {
        ingestImageBuildLine(id, line)
        ctx.onLog?.(line)
      },
    })
    finishImageBuild(id)
  } catch (err) {
    failImageBuild(id, err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    inflightBuilds.delete(layer.tag)
  }
}

/**
 * Force-rebuild one layer (`yaac project rebuild`): remove the existing
 * image and rebuild it, optionally with --no-cache. Waits out any in-flight
 * normal build of the tag first, then holds the single-flight slot itself —
 * so the removal never races a concurrent build, and a create/prewarm
 * arriving mid-rebuild joins the fresh build instead.
 */
export async function rebuildLayerExclusive(
  layer: ImageLayer,
  ctx: BuildContext,
  opts: { noCache: boolean },
): Promise<void> {
  // Wait for any in-flight build of this tag to drain; its outcome doesn't
  // matter (we're about to remove and rebuild), only that podman is done.
  for (;;) {
    const existing = inflightBuilds.get(layer.tag)
    if (!existing) break
    await existing.promise.catch(() => {})
  }

  const id = registerImageBuild({
    tag: layer.tag,
    layer: layer.name,
    action: 'build',
    projectSlug: ctx.projectSlug,
    reason: ctx.reason,
  })
  const promise = runBuild(id, layer, ctx, {
    noCache: opts.noCache,
    preStep: () => removeImage(layer.tag),
  })
  // Set synchronously (before any await inside runBuild resolves) so a
  // same-tick caller joins instead of double-building.
  inflightBuilds.set(layer.tag, { id, promise })
  return promise
}

/**
 * Push a built tag to the local registry, coalescing concurrent pushes of
 * the same tag. Skips both the push and the registry entry when the tag is
 * already present (content-hash tags are immutable) — the background sweep
 * calls this every tick and must not mint a "succeeded push" row each time.
 * `force` pushes even when the tag is present, for `yaac project rebuild`,
 * which changes image bytes under an unchanged content-hash tag.
 * Returns the in-cluster ref, like `pushImageToRegistry`.
 */
export async function pushImageShared(
  tag: string,
  ctx: { projectSlug: string; reason: ImageBuildReason },
  opts: { force?: boolean } = {},
): Promise<string> {
  const existing = inflightPushes.get(tag)
  if (existing) return existing

  if (!opts.force && await registryHasTag(tag)) return registryRef(tag)

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
    force: opts.force,
  })
    .then((ref) => {
      finishImageBuild(id)
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
 *   Included whenever the canonical base is in use. Rebuilt with --no-cache
 *   by `yaac project rebuild` to pick up new upstream agent CLI versions.
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
 *   `nestedContainers` config, passed by createSession).
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

  for (const [i, layer] of layers.entries()) {
    // An in-flight build means the tag doesn't exist yet — join it rather
    // than trusting imageExists (podman only commits the tag at the end).
    if (!inflightBuilds.has(layer.tag) && await imageExists(layer.tag)) continue

    if (requirePrebuilt) {
      throw new Error(
        `Image ${layer.tag} is missing or stale. ` +
        'Restart the test run so the global setup can rebuild it.',
      )
    }

    opts.onLayerStart?.(i + 1, layers.length, layer.name)
    await buildLayerShared(layer, { projectSlug, reason })
  }

  return finalTag
}

/**
 * Rebuild a project's tools layer and every layer downstream of it.
 *
 * The tools layer (Dockerfile.tools) installs the agent CLIs (claude, codex,
 * opencode, chrome-devtools-mcp) from upstream installers/registries; those
 * tools tick independently of the Dockerfile content, so the content-hash
 * tag never invalidates and a normal `ensureImage` would silently reuse a
 * stale cached layer. This forces a `--no-cache` rebuild of the tools layer
 * (re-fetching the latest upstream version of each CLI) and re-runs every
 * downstream layer (Dockerfile.yaac overlay / Dockerfile.user) so
 * they sit on the new tools image.
 *
 * The system base (Dockerfile.default — apt packages, Node, Playwright) is
 * left untouched: it's slow to rebuild and its content hash already
 * invalidates correctly when the Dockerfile changes.
 *
 * Returns the final image tag (same as `ensureImage`).
 *
 * @throws when the project uses a standalone Dockerfile.yaac (no tools layer
 *   in the chain) — there's nothing for this command to invalidate.
 */
export async function rebuildProjectImage(
  projectSlug: string,
  opts: {
    imagePrefix?: string
    onLog?: (line: string) => void
  } = {},
): Promise<string> {
  const prefix = opts.imagePrefix ?? 'yaac'
  const { layers, finalTag } = await resolveImageChain(projectSlug, prefix)

  const toolsIdx = layers.findIndex((l) => l.tag.startsWith(`${prefix}-tools:`))
  if (toolsIdx < 0) {
    throw new Error(
      `Project "${projectSlug}" uses a standalone Dockerfile.yaac (no tools ` +
      'layer in the image chain). `yaac project rebuild` has nothing to ' +
      'invalidate — rebuild your custom image directly with ' +
      '`podman build --no-cache`.',
    )
  }

  const emit = (msg: string): void => {
    daemonLog(`[rebuild ${projectSlug}] ${msg}`)
    opts.onLog?.(msg)
  }

  // Tools layer is rebuilt with --no-cache so the upstream agent CLI
  // installers re-execute. Downstream layers use the normal cache; their
  // RUN steps are unchanged, but FROM resolves to the new tools digest so
  // they're rebuilt cleanly. Each removal happens inside the layer's
  // single-flight slot, so concurrent creates join the fresh build instead
  // of racing the removed tag.
  for (let i = toolsIdx; i < layers.length; i++) {
    const layer = layers[i]
    const noCache = i === toolsIdx
    emit(`removing existing image ${layer.tag}`)
    emit(`building ${layer.tag}${noCache ? ' (no cache)' : ''}`)
    await rebuildLayerExclusive(
      layer,
      { projectSlug, reason: 'rebuild', onLog: opts.onLog },
      { noCache },
    )
  }

  emit(`done — final image is ${finalTag}`)
  return finalTag
}

/** Test helper: forget all in-flight builds and pushes. */
export function _clearBuildCoordinatorForTests(): void {
  inflightBuilds.clear()
  inflightPushes.clear()
}

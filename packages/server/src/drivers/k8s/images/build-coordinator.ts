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
import { imageExists } from '#drivers/k8s/container'
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
  onLog?: (line: string) => void
  /**
   * Builder-pod lease for trust-split untrusted layers, owned by the
   * ensureImage/rebuild call that created it — adjacent untrusted layers
   * of one chain build in the same pod. Ignored by the host engine.
   * Required so no build path can reach the cluster engine without one.
   */
  lease: BuilderPodLease
}

const inflightBuilds = new Map<string, { id: string; promise: Promise<void> }>()
const inflightPushes = new Map<string, Promise<string>>()

/**
 * Tags verified present (image store / registry respectively) this server
 * run. Content-hash tags are immutable, so a verified tag never needs
 * re-checking — this trades a `podman image exists` child process (and a
 * registry HEAD) per layer per create for one per tag per run. `yaac
 * project rebuild` changes bytes under unchanged tags, so the rebuild path
 * invalidates before removing and re-verifies after. The residual staleness
 * (someone prunes the podman store or wipes the registry mid-run) surfaces
 * as a fail-fast ErrImagePull on the next worktree pod, same as any missing
 * immutable tag.
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
    serverLog(`[build] starting ${layer.tag}`)
    await engineForLayer(layer.name).build(layer, {
      projectSlug: ctx.projectSlug,
      noCache: opts.noCache,
      lease: ctx.lease,
      onLog: (line) => {
        ingestImageBuildLine(id, line)
        ctx.onLog?.(line)
      },
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

  // The rebuild is about to remove the image — the verified-tag caches
  // must not vouch for it (or its registry copy, which the rebuild
  // force-pushes) until the fresh build lands.
  realizedTags.delete(layer.tag)
  pushedTags.delete(layer.tag)

  const id = registerImageBuild({
    tag: layer.tag,
    layer: layer.name,
    action: 'build',
    projectSlug: ctx.projectSlug,
    reason: ctx.reason,
  })
  const promise = runBuild(id, layer, ctx, {
    noCache: opts.noCache,
    preStep: () => engineForLayer(layer.name).remove(layer.tag),
  })
  // Set synchronously (before any await inside runBuild resolves) so a
  // same-tick caller joins instead of double-building.
  inflightBuilds.set(layer.tag, { id, promise })
  return promise
}

/**
 * Wait until no push of `tag` is in flight.
 *
 * A loop rather than one await because a third caller may start one while
 * we wait; each turn awaits a distinct promise, and the map entry is gone
 * by the time ours resolves (the stored promise includes the `finally`
 * that deletes it), so this settles as soon as the traffic does. The
 * identity check is a backstop against spinning if that ever stops
 * holding.
 *
 * A failed push resolves the wait rather than raising: it owns its own
 * feed row and error path, and the caller waiting behind it is about to
 * push the same tag anyway.
 */
async function settleInflightPush(tag: string): Promise<void> {
  let existing = inflightPushes.get(tag)
  while (existing) {
    await existing.catch(() => undefined)
    const next = inflightPushes.get(tag)
    if (next === existing) break
    existing = next
  }
}

/**
 * Push a built tag to the local registry, coalescing concurrent pushes of
 * the same tag. Skips both the push and the registry entry when the tag is
 * already present (content-hash tags are immutable) — the background sweep
 * calls this every tick and must not mint a "succeeded push" row each time.
 * `force` pushes even when the tag is present, for `yaac project rebuild`,
 * which changes image bytes under an unchanged content-hash tag; such a
 * call is the LAST word on the tag, so it waits out any push in flight
 * rather than joining it.
 * Returns the in-cluster ref, like `pushImageToRegistry`.
 */
export async function pushImageShared(
  tag: string,
  ctx: { projectSlug: string; reason: ImageBuildReason },
  opts: { force?: boolean; compressionFormat?: 'zstd' | 'gzip' } = {},
): Promise<string> {
  // A forced push must be the LAST word on the tag, so it never JOINS one
  // in flight. That push was started against the bytes the tag named
  // before the rebuild replaced them, so joining it would return its ref
  // and report a rebuild that published nothing — the exact silent
  // staleness `force` exists to prevent. Waiting for it, rather than
  // pushing alongside, keeps the one-push-per-tag guarantee intact.
  if (opts.force) await settleInflightPush(tag)
  else {
    const existing = inflightPushes.get(tag)
    if (existing) return existing
  }

  if (!opts.force && pushedTags.has(tag)) return registryRef(tag)
  if (!opts.force && await registryHasTag(tag)) {
    pushedTags.add(tag)
    return registryRef(tag)
  }

  // A force-push of a tag the host store never held (a cluster-pod-built
  // untrusted layer) is already satisfied: the builder pod force-pushed
  // the fresh bytes as part of its build. Pushing would fail — there is
  // nothing local to push.
  if (opts.force && !await imageExists(tag) && await registryHasTag(tag)) {
    return registryRef(tag)
  }

  // Re-check after the await: another caller may have started the push.
  // A forced call waits it out for the same reason as above rather than
  // taking its answer.
  const raced = inflightPushes.get(tag)
  if (raced) {
    if (!opts.force) return raced
    await settleInflightPush(tag)
  }

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
 * `nestedContainers` is required, with no default, for the same reason
 * `prewarmProjectImage`'s config is: it selects the CHAIN, and defaulting it
 * to false would rebuild `base → tools → user` for a nested project and
 * SUCCEED at it, while every one of that project's worktrees runs the
 * nestable chain's tag — minutes of work, a success report, and nothing the
 * user will ever execute. A caller that forgot should not compile.
 *
 * @throws when the project uses a standalone Dockerfile.yaac (no tools layer
 *   in the chain) — there's nothing for this command to invalidate.
 */
export async function rebuildProjectImage(
  projectSlug: string,
  opts: {
    nestedContainers: boolean
    imagePrefix?: string
    onLog?: (line: string) => void
  },
): Promise<string> {
  const prefix = opts.imagePrefix ?? 'yaac'
  const { layers, finalTag } = await resolveImageChain(projectSlug, prefix, opts.nestedContainers)

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
    serverLog(`[rebuild ${projectSlug}] ${msg}`)
    opts.onLog?.(msg)
  }

  // Tools layer is rebuilt with --no-cache so the upstream agent CLI
  // installers re-execute. Downstream layers use the normal cache; their
  // RUN steps are unchanged, but FROM resolves to the new tools digest so
  // they're rebuilt cleanly. Each removal happens inside the layer's
  // single-flight slot, so concurrent creates join the fresh build instead
  // of racing the removed tag.
  const lease = new BuilderPodLease()
  try {
    for (let i = toolsIdx; i < layers.length; i++) {
      const layer = layers[i]
      const noCache = i === toolsIdx
      const engine = engineForLayer(layer.name)
      // A cluster-pod layer pulls its parent from the registry. A rebuild
      // changes bytes under unchanged content-hash tags, so a host-built
      // parent that was itself just rebuilt (index >= toolsIdx) must be
      // FORCE-pushed — a HEAD-skip would hand the builder pod stale bytes.
      // A cluster-pod parent already force-pushed from its own builder pod.
      if (engine.kind === 'cluster-pod' && layer.buildArgs?.BASE_IMAGE) {
        const parentTag = layer.buildArgs.BASE_IMAGE
        const parentIdx = layers.findIndex((l) => l.tag === parentTag)
        const parentRebuilt = parentIdx >= toolsIdx
          && engineForLayer(layers[parentIdx].name).kind === 'host-podman'
        await pushImageShared(parentTag, { projectSlug, reason: 'rebuild' }, {
          force: parentRebuilt,
          compressionFormat: TRUSTED_PARENT_COMPRESSION,
        })
      }
      emit(`removing existing image ${layer.tag}`)
      emit(`building ${layer.tag}${noCache ? ' (no cache)' : ''}`)
      await rebuildLayerExclusive(
        layer,
        { projectSlug, reason: 'rebuild', onLog: opts.onLog, lease },
        { noCache },
      )
    }
  } finally {
    await lease.release()
  }

  emit(`done — final image is ${finalTag}`)
  return finalTag
}

/** Test helper: forget all in-flight builds, pushes, and verified tags. */
export function _clearBuildCoordinatorForTests(): void {
  inflightBuilds.clear()
  inflightPushes.clear()
  realizedTags.clear()
  pushedTags.clear()
}

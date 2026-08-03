/**
 * The build-engine seam: routes each image layer to the engine that
 * executes its `podman build`, keyed on layer trust
 * (docs/trust-split-builds.md).
 *
 * Routing is a WHITELIST: only the yaac-shipped layers — `base`, `tools`,
 * `nestable`, whose Dockerfiles live in the install's DOCKERFILES_DIR with
 * pinned upstreams — build on the host podman engine. Every other layer
 * name executes user/agent-editable RUN steps and builds in an ephemeral
 * runsc builder pod, so a malicious step at worst compromises a throwaway
 * sandbox. Whitelisting means a future layer name is sandboxed by default
 * rather than silently host-built.
 *
 * The trusted names cannot be faked: `resolveImageChain()` is the only
 * producer of `ImageLayer.name` and assigns `base`/`tools`/`nestable`
 * exclusively to the yaac-shipped Dockerfiles — `Dockerfile.yaac` is
 * always `project` (layered or standalone) and `Dockerfile.user` always
 * `user`, regardless of their content.
 *
 * The one exception is a nested install (`YAAC_NESTED=1`): its engine is
 * the session's in-pod podman, which IS the outer sandbox — an inner
 * builder pod would be a vcluster pod, unvalidated and strictly worse.
 *
 * The seam is build/imageExists/remove. Pushes are deliberately NOT routed
 * per layer: host products push through `pushImageShared` (which
 * coalesces + HEAD-skips), while a cluster-pod build's delta push is an
 * inseparable step of the build itself — the product only ever exists in
 * the registry.
 */
import { buildImage, type ImageLayer } from './image-builder'
import { imageExists, removeImage } from '#platform/container/runtime'
import { registryHasTag } from '#features/cluster/registry'
import { buildLayerInPod, type BuilderPodLease } from './builder-pod'
import { env } from '@yaac/shared/env'
import type { ImageLayerName } from '@yaac/shared/types'

export type BuildEngineKind = 'host-podman' | 'cluster-pod'

const TRUSTED_LAYERS: ReadonlySet<ImageLayerName> = new Set(['base', 'tools', 'nestable'])

/** True only for the yaac-shipped layers (pinned upstream Dockerfiles). */
export function isTrustedLayer(name: ImageLayerName): boolean {
  return TRUSTED_LAYERS.has(name)
}

/**
 * Which engine realizes a layer: whitelisted trusted layers on host
 * podman; everything else in a runsc builder pod (except nested installs,
 * whose in-pod engine is already the outer session's sandbox).
 */
export function engineKindForLayer(name: ImageLayerName): BuildEngineKind {
  if (isTrustedLayer(name) || env.nested) return 'host-podman'
  return 'cluster-pod'
}

export interface EngineBuildContext {
  /** Project whose chain is being built (keys the step-cache repo). */
  projectSlug: string
  /** Required, not defaulted: every build path decides this explicitly. */
  noCache: boolean
  onLog?: (line: string) => void
  /**
   * Shared builder pod for adjacent untrusted layers of one request.
   * Required: the coordinator always owns and releases one, so no engine
   * ever has to create or dispose of a pod itself.
   */
  lease: BuilderPodLease
}

export interface BuildEngine {
  kind: BuildEngineKind
  /** Realize the layer's tag (host store or, for cluster-pod, the registry). */
  build(layer: ImageLayer, ctx: EngineBuildContext): Promise<void>
  /** Whether the layer's tag is already realized where this engine looks. */
  imageExists(tag: string): Promise<boolean>
  /** Best-effort stale-tag removal before an exclusive rebuild. */
  remove(tag: string): Promise<void>
}

export const hostPodmanEngine: BuildEngine = {
  kind: 'host-podman',
  build: (layer, ctx) => buildImage(layer.tag, layer.dockerfile, layer.context, layer.buildArgs, {
    noCache: ctx.noCache,
    onLog: ctx.onLog,
  }),
  imageExists: (tag) => imageExists(tag),
  remove: (tag) => removeImage(tag),
}

export const clusterPodEngine: BuildEngine = {
  kind: 'cluster-pod',
  build: (layer, ctx) => buildLayerInPod(layer, ctx),
  // The registry is authoritative — the host store never sees these tags.
  imageExists: (tag) => registryHasTag(tag),
  // Nothing to remove host-side; a rebuild's in-pod --no-cache build
  // overwrites the unchanged content-hash tag in the registry directly.
  remove: () => Promise.resolve(),
}

export function engineForLayer(name: ImageLayerName): BuildEngine {
  return engineKindForLayer(name) === 'cluster-pod' ? clusterPodEngine : hostPodmanEngine
}

/**
 * Compression for trusted-layer pushes feeding builder-pod parent pulls:
 * zstd cuts the pod's empty-graphroot parent pull from 65.6s to 40.4s
 * (measured). Node containerd zstd pulls are validated live (session pods
 * pull product manifests referencing these blobs) — see the plan doc's
 * validation notes.
 */
export const TRUSTED_PARENT_COMPRESSION = 'zstd' as const

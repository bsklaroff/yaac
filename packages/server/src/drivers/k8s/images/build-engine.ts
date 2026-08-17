/**
 * The build-engine seam: routes each image layer to the engine that
 * realizes it, keyed on layer trust (docs/trust-split-builds.md).
 *
 * Routing is a WHITELIST: the yaac-shipped layers — `base`, `tools`,
 * `nestable`, whose Dockerfiles live in the install's DOCKERFILES_DIR with
 * pinned upstreams — are not built here at all. `yaac cluster install`
 * builds them on the machine running the CLI and pushes them, so the
 * server only ever looks their content-hash tag up in the registry. Every
 * other layer name executes user/agent-editable RUN steps and builds in an
 * ephemeral runsc builder pod, so a malicious step at worst compromises a
 * throwaway sandbox. Whitelisting means a future layer name is sandboxed by
 * default rather than silently trusted.
 *
 * The trusted names cannot be faked: `resolveImageChain()` is the only
 * producer of `ImageLayer.name` and assigns `base`/`tools`/`nestable`
 * exclusively to the yaac-shipped Dockerfiles — `Dockerfile.yaac` is
 * always `project` (layered or standalone) and `Dockerfile.user` always
 * `user`, regardless of their content.
 *
 * The seam is the build itself, and only that. Whether a layer is already
 * realized is not routed at all any more — the registry is where every
 * layer lands, whichever side produced it — and neither are pushes: a
 * cluster-pod build's delta push is an inseparable step of the build
 * itself, and a prebuilt layer was pushed by the install that built it.
 */
import { buildLayerInPod, type BuilderPodLease } from './builder-pod'
import type { ImageLayerName } from '@yaac/shared/types'
import { missingPrebuiltImage, type ImageLayer } from '#drivers/k8s/image-engine'

export type BuildEngineKind = 'prebuilt' | 'cluster-pod'

const TRUSTED_LAYERS: ReadonlySet<ImageLayerName> = new Set(['base', 'tools', 'nestable'])

/** True only for the yaac-shipped layers (pinned upstream Dockerfiles). */
export function isTrustedLayer(name: ImageLayerName): boolean {
  return TRUSTED_LAYERS.has(name)
}

/**
 * Which engine realizes a layer: whitelisted trusted layers come prebuilt
 * from the registry; everything else builds in a runsc builder pod.
 */
export function engineKindForLayer(name: ImageLayerName): BuildEngineKind {
  return isTrustedLayer(name) ? 'prebuilt' : 'cluster-pod'
}

export interface EngineBuildContext {
  /** Project whose chain is being built (keys the step-cache repo). */
  projectSlug: string
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
  /** Realize the layer's tag in the registry, where every pod pulls from. */
  build(layer: ImageLayer, ctx: EngineBuildContext): Promise<void>
}

/**
 * The trusted layers' "engine", which builds nothing: their tags are
 * install output, so a missing one is a missing install and the only
 * useful thing to do is say which command produces it.
 */
export const prebuiltEngine: BuildEngine = {
  kind: 'prebuilt',
  build: (layer) => Promise.reject(missingPrebuiltImage(layer.name, layer.tag)),
}

export const clusterPodEngine: BuildEngine = {
  kind: 'cluster-pod',
  build: (layer, ctx) => buildLayerInPod(layer, ctx),
}

export function engineForLayer(name: ImageLayerName): BuildEngine {
  return engineKindForLayer(name) === 'cluster-pod' ? clusterPodEngine : prebuiltEngine
}

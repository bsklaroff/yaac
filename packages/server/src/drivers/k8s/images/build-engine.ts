/**
 * Picks how each image layer is built, based on trust
 * (docs/trust-split-builds.md).
 *
 * The yaac-shipped layers (`base`, `tools`, `nestable`) are built and
 * pushed by `yaac cluster install`, so the server only looks them up. Every
 * other layer runs user- or agent-editable RUN steps and builds in an
 * ephemeral runsc builder pod. This is an allowlist, so a new layer name is
 * sandboxed by default. The trusted names cannot be faked:
 * `resolveImageChain()` assigns them only to the yaac-shipped Dockerfiles.
 */
import { buildLayerInPod, type BuilderPodLease } from './builder-pod'
import type { ImageLayerName } from '@yaac/shared/types'
import { missingPrebuiltImage, type ImageLayer } from '#drivers/k8s/image-engine'
import type { ProjectRef } from '#drivers/contract'

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
  /** Project whose chain is being built (its id keys the step-cache repo). */
  project: ProjectRef
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
 * Trusted layers are built by the install, so a missing tag means a missing
 * install. This "engine" just reports which command produces it.
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

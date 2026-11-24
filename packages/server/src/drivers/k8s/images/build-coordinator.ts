/**
 * The k8s driver's image verbs: resolve a chain's tags, say which of its
 * layers the registry lacks, and build those in one builder pod
 * (docs/image-builds.md). Which builds run, when, and their records are
 * `#domain/images`'; this module only builds what it is handed.
 */
import { BuilderPodLease, buildLayerInPod } from './builder-pod'
import {
  missingPrebuiltImage,
  registryRef,
  registryTagState,
  resolveImageChain,
} from '#drivers/k8s/cluster'
import { readBlockedHosts } from '#drivers/k8s/egress'
import { serverLog } from '#lib/log'
import type { ImageLayerName } from '@yaac/shared/types'
import type {
  ImageBuildOutcome,
  ImageBuildRequest,
  ImageChainSpec,
  ResolvedImageChain,
} from '#drivers/contract'

/**
 * The yaac-shipped layers, built and pushed by `yaac cluster install`, so
 * the server only looks them up (docs/image-builds.md). Every other layer
 * runs user- or agent-editable RUN steps and builds in a sandboxed builder
 * pod. This is an allowlist, so a new layer name is sandboxed by default;
 * `resolveImageChain()` assigns these names only to the yaac-shipped
 * Dockerfiles.
 */
const TRUSTED_LAYERS: ReadonlySet<ImageLayerName> = new Set(['base', 'tools'])

/** Builds running now, which main registry GC waits out. */
let buildsInFlight = 0

/**
 * Tags confirmed to be in the registry during this server run. Tags are
 * content hashes and never change, so each needs checking only once. If
 * the registry is wiped mid-run, the next pod fails fast with
 * ErrImagePull. `forgetVerifiedTags` clears them after GC.
 */
const realizedTags = new Set<string>()

/** How long the proxy takes to record a block (it debounces its writes). */
const BLOCKED_HOSTS_SETTLE_MS = 500

/**
 * True while this server is building an image. Builds write to the
 * registry, so main registry GC skips its collect while this is true.
 */
export function imageWorkInFlight(): boolean {
  return buildsInFlight > 0
}

/**
 * Forget which tags were verified present. Main registry GC calls this after
 * retiring tags, so a retired tag is not handed to a pod.
 */
export function forgetVerifiedTags(): void {
  realizedTags.clear()
}

/** An image chain's tags (`ImageChainSpec` is what `#domain` resolved). */
export async function resolveChain(spec: ImageChainSpec): Promise<ResolvedImageChain> {
  const { layers, finalTag } = await resolveImageChain(spec)
  return {
    layers: layers.map((l) => ({ name: l.name, tag: l.tag, ...(l.buildArgs?.BASE_IMAGE ? { parentTag: l.buildArgs.BASE_IMAGE } : {}) })),
    finalTag,
  }
}

/**
 * The untrusted layers the registry lacks, in chain order. A missing
 * yaac-shipped layer means a missing install, not a build to run, and a
 * registry that does not answer fails the call rather than counting as
 * missing.
 */
export async function missingImageLayers(chain: ResolvedImageChain): Promise<ImageLayerName[]> {
  const missing: ImageLayerName[] = []
  for (const { name, tag } of chain.layers) {
    if (realizedTags.has(tag)) continue
    const state = await registryTagState(tag)
    if (state === 'present') {
      realizedTags.add(tag)
      continue
    }
    // A registry that did not answer is not a missing layer.
    if (state !== 'absent') throw new Error(`the registry did not say whether it has ${tag}; try again`)
    if (TRUSTED_LAYERS.has(name)) throw missingPrebuiltImage(name, tag)
    missing.push(name)
  }
  return missing
}

/**
 * Build the requested layers of a chain in order, in one builder pod (so a
 * user layer finds its project layer already local), and push each. The
 * hosts the proxy refused are read before the pod's egress registration
 * is deleted with it.
 */
export async function buildImageLayers(request: ImageBuildRequest): Promise<ImageBuildOutcome> {
  const { layers } = await resolveImageChain(request.spec)
  const lease = new BuilderPodLease()
  const release = (): void => { void lease.release() }
  request.signal.addEventListener('abort', release, { once: true })
  buildsInFlight++
  let current: ImageLayerName | undefined
  try {
    for (const name of request.layers) {
      current = name
      // An abort before the listener above was attached never fires it.
      if (request.signal.aborted) throw new Error('cancelled')
      const layer = layers.find((l) => l.name === name)
      if (!layer || TRUSTED_LAYERS.has(name)) throw new Error(`no untrusted ${name} layer in this chain`)
      request.onLayerStart(name)
      serverLog(`[build] starting ${layer.tag}`)
      await buildLayerInPod(layer, {
        projectId: request.spec.projectId,
        egressId: request.egressId,
        allowedHosts: request.allowedHosts,
        noCache: request.noCache,
        cacheMaxDays: request.cacheMaxDays,
        lease,
        onLog: (line) => request.onLine(name, line),
      })
      realizedTags.add(layer.tag)
    }
    return { ok: true, blockedHosts: await blockedHostsOf(request.egressId) }
  } catch (err) {
    return {
      ok: false,
      error: request.signal.aborted ? 'cancelled' : err instanceof Error ? err.message : String(err),
      ...(current ? { failedLayer: current } : {}),
      blockedHosts: await blockedHostsOf(request.egressId),
    }
  } finally {
    request.signal.removeEventListener('abort', release)
    await lease.release()
    buildsInFlight--
  }
}

async function blockedHostsOf(egressId: string): Promise<string[]> {
  await new Promise((r) => setTimeout(r, BLOCKED_HOSTS_SETTLE_MS))
  return readBlockedHosts(egressId)
}

/** The ref a workspace launches for an image tag. */
export function imageRef(tag: string): string {
  return registryRef(tag)
}

/** Test helper: forget verified tags and in-flight builds. */
export function _clearBuildCoordinatorForTests(): void {
  realizedTags.clear()
  buildsInFlight = 0
}

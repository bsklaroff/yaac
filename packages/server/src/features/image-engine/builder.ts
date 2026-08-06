/**
 * The image builder seam: one interface over "realize this image", with two
 * backends behind it (docs/image-builds.md).
 *
 *  - `cluster-pod` — an ephemeral runsc builder pod runs `podman build`,
 *    and the product exists only as a registry push. This is the default,
 *    and it is what lets the server stop being a machine with a container
 *    engine on it (docs/plans/stock-k8s-multi-node.md §1, §5).
 *  - `host-podman` — `podman build` on the machine the server runs on, into
 *    that machine's image store. This is what every yaac install did before
 *    the seam existed. It survives as the BOOTSTRAP and NESTED backend, and
 *    as the one the test global setup drives directly.
 *
 * The two are not interchangeable in one respect, and every caller has to
 * know it: they realize an image in different PLACES. A host build leaves a
 * tag in the host store that has to be pushed before a pod can pull it; a
 * pod build leaves a tag in the registry and nothing on the host. So
 * `imageExists` answers "is it realized where THIS builder puts things",
 * and `publish` is a no-op for the pod builder rather than a second copy.
 *
 * Why one interface at all, rather than porting the callers to builder pods
 * outright: bootstrap and steady state need different backends (a nested
 * install has no cluster of its own to build in, and the test global setup
 * builds before any server exists), and the escape hatch is what keeps a
 * second engine — buildkit's no-global-lock concurrency, say — a swap
 * rather than a rewrite.
 */
import { env, testEnv } from '@yaac/shared/env'
import {
  ensureHostPodman,
  execFileAsync,
  imageExists as hostImageExists,
  pushImageToRegistry,
  registryHasTag,
  registryRef,
  removeImage as hostRemoveImage,
} from '#platform/container'
// Static, unlike the old `ensureContainerRuntime`'s deferred import: this
// folder already pulls `#platform/k8s` (and its ~2.2s of client-node ESM)
// in through builder-pod, so deferring it here would buy nothing.
import { ensureKubernetes } from '#platform/k8s'
import { serverLog } from '#log'
import { buildImage } from './image-builder'
import {
  BuilderPodLease,
  type BuildTrust,
  type EnsureBuilderHost,
  buildInPod,
  mirrorInPod,
} from './builder-pod'

export type ImageBuilderKind = 'cluster-pod' | 'host-podman'

/** One image build: a Dockerfile, its context, and where the product goes. */
export interface BuildRequest {
  /** Content-hash tag the build realizes. */
  tag: string
  dockerfile: string
  /** Build context directory; streamed into the pod, or read in place. */
  context: string
  buildArgs?: Record<string, string>
  /** Re-run every step (`yaac project rebuild`). Required, not defaulted:
   *  every build path decides this explicitly. */
  noCache: boolean
  /**
   * Whose content this build executes. It travels with the request rather
   * than being collapsed into `cacheRepo`, because the cluster backend
   * needs it for a second decision the repo name cannot express: a
   * `shipped` build may not run in a pod that has already executed a
   * `project` one (see `BuilderPodLease`).
   */
  trust: BuildTrust
  /** Registry repo for the step cache. Ignored by the host builder, which
   *  caches in the host engine's own store. */
  cacheRepo: string
  onLog?: (line: string) => void
}

/** Copy a digest-pinned upstream image into the registry under `tag`. */
export interface MirrorRequest {
  /** Upstream ref, digest-pinned — the digest IS the version pin. */
  upstream: string
  /** Local tag the mirror is stored (and pulled) under. */
  tag: string
  onLog?: (line: string) => void
}

export interface ImageBuilder {
  readonly kind: ImageBuilderKind
  /** Realize `req.tag` where this builder puts products. */
  build(req: BuildRequest): Promise<void>
  /** Mirror an upstream ref into the registry; returns its in-cluster ref. */
  mirror(req: MirrorRequest): Promise<string>
  /** Whether the tag is already realized where this builder looks. */
  imageExists(tag: string): Promise<boolean>
  /** Best-effort stale-tag removal before an exclusive rebuild. */
  remove(tag: string): Promise<void>
  /** Make a realized tag pullable in the cluster; returns its in-cluster
   *  ref. A no-op for `cluster-pod`, whose builds ARE registry pushes. */
  publish(tag: string, opts?: PublishOptions): Promise<string>
  /** Release the builder's resources (the pod, for `cluster-pod`). */
  close(): Promise<void>
}

export interface PublishOptions {
  onLog?: (line: string) => void
  /** Push even when the tag is present — for the one flow that changes
   *  bytes under an unchanged content-hash tag (`yaac project rebuild`). */
  force?: boolean
  compressionFormat?: 'zstd' | 'gzip'
}

/**
 * Which backend realizes builds on this install.
 *
 * `YAAC_IMAGE_BUILDER` overrides it wholesale — that is the escape hatch
 * for a host that would rather pay a machine's podman than the sandbox tax,
 * and it is how the test global setup asks for host builds.
 *
 * Otherwise: builder pods, except in a NESTED install, whose engine is the
 * session's own in-pod podman. Nested is not an optimization but the only
 * correct answer there — an inner builder pod would be a vcluster pod,
 * unvalidated and strictly worse than the sandbox the session already is.
 */
export function imageBuilderKind(): ImageBuilderKind {
  return env.imageBuilder ?? (env.nested ? 'host-podman' : 'cluster-pod')
}

/**
 * The once-per-process preflight for the image path, run on the session
 * create hot path. It is only here to print install instructions on first
 * contact: a runtime that disappears mid-run surfaces in whichever
 * podman/kubectl call needs it.
 *
 * The host engine is checked only when it is the one that builds. That is
 * the whole point of the seam — a `cluster-pod` install has no podman on
 * the server's machine to check, and telling its operator to
 * `apt install podman` would be wrong.
 */
export async function ensureImageBuildRuntime(): Promise<void> {
  if (runtimeVerified) return
  if (imageBuilderKind() === 'host-podman') await ensureHostPodman()
  await ensureKubernetes()
  runtimeVerified = true
}

let runtimeVerified = false

/** Test-only: forget the process-wide runtime verification. */
export function _resetImageBuildRuntimeForTests(): void {
  runtimeVerified = false
}

/**
 * The builder for this install. `ensureHost` is what stands the cluster
 * side up before a pod is created (`ensureClusterBuilderHost` in
 * `#features/cluster`) — injected because this folder sits below that
 * feature, which builds netd's image through a builder of its own.
 *
 * The returned builder owns a pod for its lifetime, so callers must
 * `close()` it — one builder per build REQUEST, shared by every layer of
 * the chain, which is what keeps a cold chain's intermediates local.
 */
export function imageBuilder(ensureHost: EnsureBuilderHost): ImageBuilder {
  return imageBuilderKind() === 'host-podman'
    ? hostPodmanBuilder()
    : clusterPodBuilder(ensureHost)
}

/** `imageBuilder`, scoped to one operation and closed for you. */
export async function withImageBuilder<T>(
  ensureHost: EnsureBuilderHost,
  fn: (builder: ImageBuilder) => Promise<T>,
): Promise<T> {
  const builder = imageBuilder(ensureHost)
  try {
    return await fn(builder)
  } finally {
    await builder.close()
  }
}

export function hostPodmanBuilder(): ImageBuilder {
  return {
    kind: 'host-podman',
    build: (req) => buildImage(req.tag, req.dockerfile, req.context, req.buildArgs, {
      noCache: req.noCache,
      onLog: req.onLog,
    }),
    mirror: async (req) => {
      await execFileAsync('podman', ['pull', req.upstream], { timeout: MIRROR_PULL_TIMEOUT_MS })
      const { stdout: arch } = await execFileAsync('podman', [
        'image', 'inspect', '--format', '{{.Architecture}}', req.upstream,
      ]).catch(() => ({ stdout: '' }))
      assertMirrorArch(req.upstream, arch)
      await execFileAsync('podman', ['tag', req.upstream, req.tag])
      return pushImageToRegistry(req.tag, { onLog: req.onLog })
    },
    imageExists: (tag) => hostImageExists(tag),
    remove: (tag) => hostRemoveImage(tag),
    publish: (tag, opts) => pushImageToRegistry(tag, opts),
    close: () => Promise.resolve(),
  }
}

export function clusterPodBuilder(ensureHost: EnsureBuilderHost): ImageBuilder {
  const lease = new BuilderPodLease(ensureHost)
  return {
    kind: 'cluster-pod',
    build: (req) => buildInPod(req, lease),
    mirror: async (req) => {
      await mirrorInPod(req, lease)
      return registryRef(req.tag)
    },
    // The registry is authoritative — a pod build's product never touches
    // a host store, and there is no other place for it to be.
    imageExists: (tag) => registryHasTag(tag),
    // Nothing to remove: a rebuild's in-pod build overwrites the unchanged
    // content-hash tag in the registry directly, and the pod it built in is
    // gone.
    remove: () => Promise.resolve(),
    publish: (tag) => Promise.resolve(registryRef(tag)),
    close: () => lease.release(),
  }
}

const MIRROR_PULL_TIMEOUT_MS = 600_000

/**
 * podman's GOARCH name for this host. The host builder mirrors into a
 * registry that cluster nodes pull from, so a mismatch here is a mismatch
 * there; the pod builder checks the node's own arch instead, which is the
 * question this one is approximating.
 */
export function hostImageArch(arch: string = process.arch): string {
  return arch === 'x64' ? 'amd64' : arch
}

/**
 * Throw when a mirrored upstream image is built for the wrong architecture,
 * naming the likely cause (a pin that points at a child manifest rather than
 * the index). An empty/unknown `actual` is accepted — the check must never be
 * the reason a mirror fails.
 */
export function assertMirrorArch(
  image: string,
  actual: string,
  expected: string = hostImageArch(),
): void {
  if (!actual.trim() || actual.trim() === expected) return
  throw new Error(
    `${image} is a ${actual.trim()} image but this host is ${expected}. `
    + 'Pin the multi-arch index digest, not one platform\'s child manifest.',
  )
}

export interface MirrorSpec {
  /** Upstream ref, digest-pinned. */
  upstream: string
  /** Local mirror tag; carries the pin, so a re-pin re-mirrors. */
  tag: string
  /** How the image is named in the missing-image error, e.g. `Envoy image`. */
  label: string
  requirePrebuilt?: boolean
}

/**
 * Mirror-or-skip for the digest-pinned upstream images (Envoy, `registry:2`,
 * the vcluster set, the check probe): present in the registry means the
 * exact bytes are there, because the mirror tag carries the pin.
 *
 * Takes the builder rather than making one, so a caller mirroring a SET of
 * images (the vcluster chart's) pays for one builder pod, not one per image.
 *
 * `requirePrebuilt` is the e2e contract — fail on a missing image rather
 * than race a mirror inside a test worker.
 */
export async function ensureMirroredImage(
  spec: MirrorSpec,
  builder: ImageBuilder,
): Promise<string> {
  if (await registryHasTag(spec.tag)) return registryRef(spec.tag)
  if (spec.requirePrebuilt ?? testEnv.requirePrebuiltImages) {
    throw new Error(
      `${spec.label} ${spec.tag} is missing. `
      + 'Restart the test run so the global setup can mirror it.',
    )
  }
  serverLog(`[mirror] copying ${spec.upstream} -> ${spec.tag}`)
  return builder.mirror({ upstream: spec.upstream, tag: spec.tag })
}

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'
import {
  PROJECT_DOCKERFILE,
  USER_DOCKERFILE,
  resolveProjectBuildDir,
  resolveUserBuildDir,
} from '#features/projects'
import { imageExists, runTrackedPodman } from '#platform/container'
import { collectContextFiles, isLayered, parseContainerIgnore } from '#platform/build-context'
import { sessionUid } from '#platform/k8s'
import { serverLog } from '#log'
import type { ImageLayerName } from '@yaac/shared/types'

export function stringHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export async function fileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8')
  return stringHash(content)
}

/**
 * Content hash for a root (FROM-scratch) session image layer: the
 * Dockerfile content plus the YAAC_UID build arg. Shared by the server's
 * layer resolution and the test global setup so both derive identical
 * tags.
 */
export async function baseImageHash(dockerfilePath: string): Promise<string> {
  // The base build also COPYs dockerfiles/streamd/ (the in-pod stream
  // daemon), so its source is part of the layer's content hash — editing
  // streamd retags the image just like a Dockerfile edit.
  const streamdHash = await contextHash(path.join(DOCKERFILES_DIR, 'streamd'))
  return stringHash(`${await fileHash(dockerfilePath)}:streamd=${streamdHash}:uid=${sessionUid()}`)
}

/**
 * Support files Dockerfile.tools COPYs from the dockerfiles build context.
 * opencode-models.json is the models.dev catalog emitted by
 * `pnpm gen:providers`, baked in as opencode's catalog cache.
 */
const TOOLS_SUPPORT_FILES = ['opencode-models.json'] as const

/**
 * Content hash of the tools layer's build inputs: Dockerfile.tools plus the
 * support files it COPYs. Folding the support files in means regenerating
 * the catalog re-tags the image just like a Dockerfile edit — a stale image
 * can never be reused. Shared by the server's layer resolution and the test
 * global setup so both derive identical tags.
 */
export async function toolsContentHash(): Promise<string> {
  const files = ['Dockerfile.tools', ...TOOLS_SUPPORT_FILES]
  const hashes = await Promise.all(
    files.map((f) => fileHash(path.join(DOCKERFILES_DIR, f))),
  )
  return stringHash(hashes.join(':'))
}

/**
 * Content hash of a build context, honoring the context's .containerignore
 * (the same file `podman build` consults) so dev-only files — tests,
 * node_modules — never churn image tags.
 */
export async function contextHash(dir: string): Promise<string> {
  let ignore = new Set<string>()
  try {
    ignore = parseContainerIgnore(await fs.readFile(path.join(dir, '.containerignore'), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const files = (await collectContextFiles(dir, '', ignore)).sort()
  const hasher = crypto.createHash('sha256')
  for (const rel of files) {
    hasher.update(rel)
    hasher.update(await fs.readFile(path.join(dir, rel)))
  }
  return hasher.digest('hex').slice(0, 16)
}

// We shell out to `podman build` instead of calling dockerode's buildImage
// (which would hit podman's Docker-compat /build endpoint) for two reasons:
//   1. The compat endpoint writes Docker v2 manifests while `podman build`
//      writes OCI manifests. Layer digests differ across formats, so a
//      dockerode build cannot reuse cache from a CLI build and vice versa.
//   2. The compat endpoint defaults to layers=false, discarding intermediate
//      layers — so even back-to-back dockerode builds rebuild from scratch.
// Staying on the CLI keeps one shared OCI cache chain across all builders.
// It is also why the in-cluster builder runs the podman CLI in a pod rather
// than a second build engine: the same manifest split would reappear at the
// seam between the two, and with it two incompatible caches.
export interface BuildOptions {
  noCache?: boolean
  onLog?: (line: string) => void
}

/**
 * Host build budgets, the pair the in-pod build gets from its idle budgets
 * plus BUILDER_ACTIVE_DEADLINE_SECONDS.
 *
 * Idle is the primary signal: `podman build` goes quiet only between the
 * progress ticks of one RUN step, so ten minutes without a byte means the
 * engine is wedged, however long the build has legitimately been running
 * (see streaming-proc.ts). It cannot be the only signal, because it never
 * fires on a build that is wedged but chatty — a RUN step retrying in a
 * loop, a download stuck at 3% still emitting ticks. That build holds the
 * image-store lock, which blocks and idle-kills every host build behind it,
 * so it gets a total backstop too. An hour, chosen the way the pod deadline
 * is — far above any honest build, far below never — and shorter than the
 * pod's, because the host layers are yaac-shipped Dockerfiles over pinned
 * upstreams rather than whatever a project's own Dockerfile does.
 */
const HOST_BUILD_IDLE_TIMEOUT_MS = 600_000
const HOST_BUILD_TOTAL_TIMEOUT_MS = 3600_000

export async function buildImage(
  imageName: string,
  dockerfile: string,
  context: string,
  buildArgs?: Record<string, string>,
  opts: BuildOptions = {},
): Promise<void> {
  const args = [
    'build',
    '-t', imageName,
    '-f', dockerfile,
  ]
  if (opts.noCache) args.push('--no-cache')

  for (const [key, value] of Object.entries(buildArgs ?? {})) {
    args.push('--build-arg', `${key}=${value}`)
  }
  args.push(context)

  // Tracked, not a bare spawn: an orphaned build survives the server, and
  // its tag lands in the store only at the end — so the next server would
  // see the tag missing and start a duplicate build alongside it.
  await runTrackedPodman(args, {
    tag: imageName,
    logPrefix: `[build ${imageName}] `,
    onLog: opts.onLog,
    idleTimeoutMs: HOST_BUILD_IDLE_TIMEOUT_MS,
    timeoutMs: HOST_BUILD_TOTAL_TIMEOUT_MS,
  })
}

/**
 * Build an image on the HOST engine if a tagged version does not already
 * exist there. The test global setup's prebuild path, and deliberately not
 * routed through `imageBuilder()`: the global setup runs on a developer
 * machine before any server exists, and prebuilding the e2e chain through
 * builder pods would put the sandbox tax (~3x on a cold chain) on the
 * critical path of every suite run. See docs/image-builds.md.
 */
export async function ensureImageByTag(tag: string, dockerfile: string, context: string, buildArgs?: Record<string, string>): Promise<void> {
  if (await imageExists(tag)) return
  serverLog(`[build] starting ${tag}`)
  await buildImage(tag, dockerfile, context, buildArgs)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export interface ImageLayer {
  tag: string
  /** Which chain step this is — the dependency the tag realizes. */
  name: ImageLayerName
  dockerfile: string
  context: string
  buildArgs?: Record<string, string>
  /** Hash of this layer's content, used for composing downstream hashes */
  contentHash: string
}

/**
 * Resolves the full image layer chain for a project without building anything.
 * Returns the ordered list of layers.
 *
 * `nestedContainers` inserts the nestable layer (in-pod rootless podman +
 * docker CLI) between tools and any layered Dockerfile.yaac. Skipped for a
 * standalone Dockerfile.yaac, which owns its own toolchain.
 */
export async function resolveImageChain(
  projectSlug: string,
  prefix: string,
  nestedContainers = false,
): Promise<{ layers: ImageLayer[]; finalTag: string }> {
  const layers: ImageLayer[] = []

  // Layer 1: <prefix>-base
  // Read Dockerfile.yaac from the per-machine build dir, or fall back to
  // Dockerfile.default. The build dir is the layer's whole build context:
  // support files next to the Dockerfile ship to the build and are part
  // of the layer's content hash, so editing one re-tags the image just
  // like a Dockerfile edit.
  const projectBuild = await resolveProjectBuildDir(projectSlug)
  const localDockerfile = path.join(projectBuild, PROJECT_DOCKERFILE)
  let yaacDockerfile: string | null = null
  let yaacContent: string | null = null

  if (await fileExists(localDockerfile)) {
    yaacDockerfile = localDockerfile
    yaacContent = await fs.readFile(localDockerfile, 'utf8')
  }

  const yaacIsLayered = yaacContent ? isLayered(yaacContent) : false
  const defaultDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  // The server uid is a build input (YAAC_UID arg, see sessionUid), so it
  // is folded into the root layer's content hash — a uid change must
  // invalidate the tag just like a Dockerfile edit.
  const uid = sessionUid()
  const defaultHash = await baseImageHash(defaultDockerfile)
  const defaultTag = `${prefix}-base:${defaultHash}`

  // We're on the canonical base unless Dockerfile.yaac replaces it standalone.
  // Tools (the agent CLI layer) sit on top of the canonical base only.
  const useDefaultBase = !yaacDockerfile || yaacIsLayered

  if (useDefaultBase) {
    layers.push({
      tag: defaultTag,
      name: 'base',
      dockerfile: defaultDockerfile,
      context: DOCKERFILES_DIR,
      buildArgs: { YAAC_UID: String(uid) },
      contentHash: defaultHash,
    })
  }

  // Layer 1a: <prefix>-tools (Dockerfile.tools) — agent CLIs (claude, codex,
  // opencode, chrome-devtools-mcp). Split out so `yaac project rebuild` can
  // re-fetch upstream versions with `podman build --no-cache` without
  // re-running the slow apt/Node base build. Skipped for a standalone
  // Dockerfile.yaac, which owns its own toolchain.
  let toolsTag: string | null = null
  let toolsHash: string | null = null
  if (useDefaultBase) {
    const toolsDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.tools')
    toolsHash = stringHash(`${defaultHash}:${await toolsContentHash()}`)
    toolsTag = `${prefix}-tools:${toolsHash}`
    layers.push({
      tag: toolsTag,
      name: 'tools',
      dockerfile: toolsDockerfile,
      context: DOCKERFILES_DIR,
      buildArgs: { BASE_IMAGE: defaultTag },
      contentHash: toolsHash,
    })
  }

  // Layer 1b (optional): <prefix>-nestable (Dockerfile.nestable) — in-pod
  // rootless podman + docker CLI + compose for `nestedContainers`
  // sessions. Sits on tools so a layered Dockerfile.yaac inherits it; a
  // standalone Dockerfile.yaac skips it (it owns its toolchain). The uid
  // shapes the layer's subuid ranges and socket path, but it is already
  // folded into the chain through the base hash.
  let nestableTag: string | null = null
  let nestableHash: string | null = null
  if (useDefaultBase && nestedContainers) {
    const nestableDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
    const nestableContentHash = await fileHash(nestableDockerfile)
    nestableHash = stringHash(`${toolsHash!}:${nestableContentHash}`)
    nestableTag = `${prefix}-nestable:${nestableHash}`
    layers.push({
      tag: nestableTag,
      name: 'nestable',
      dockerfile: nestableDockerfile,
      context: DOCKERFILES_DIR,
      buildArgs: { BASE_IMAGE: toolsTag!, YAAC_UID: String(uid) },
      contentHash: nestableHash,
    })
  }

  // Resolve the base layer tag (may be tools/nestable, layered yaac, or
  // standalone yaac). A standalone Dockerfile.yaac is a root layer like
  // Dockerfile.default: it owns its user setup, so it gets the YAAC_UID
  // build arg (honoring it is up to the Dockerfile) and the uid folded
  // into its hash. Layered variants inherit the uid through the parent's
  // hash chain.
  const parentTag = nestableTag ?? toolsTag
  const parentHash = nestableHash ?? toolsHash
  // The context hash covers the Dockerfile itself plus every support file
  // in the build dir.
  const projectContextHash = yaacDockerfile ? await contextHash(projectBuild) : null
  const baseHash = yaacIsLayered
    ? stringHash(`${parentHash!}:${projectContextHash!}`)
    : yaacDockerfile
      ? stringHash(`${projectContextHash!}:uid=${uid}`)
      : parentHash!
  const baseTag = yaacDockerfile
    ? `${prefix}-base:${baseHash}`
    : parentTag!

  if (yaacDockerfile) {
    layers.push({
      tag: baseTag,
      name: 'project',
      dockerfile: yaacDockerfile,
      context: projectBuild,
      buildArgs: yaacIsLayered
        ? { BASE_IMAGE: parentTag! }
        : { YAAC_UID: String(uid) },
      contentHash: baseHash,
    })
  }

  let effectiveTag = baseTag
  const effectiveHash = baseHash

  // Layer 2 (optional): <prefix>-user-<slug> (from ~/.yaac/build/
  // Dockerfile.user). Same containment rule as the project layer: the
  // build dir is the whole context, hashed as a unit.
  const userBuild = await resolveUserBuildDir()
  const userDockerfile = path.join(userBuild, USER_DOCKERFILE)
  if (await fileExists(userDockerfile)) {
    const userContent = await fs.readFile(userDockerfile, 'utf8')
    if (!isLayered(userContent)) {
      throw new Error(
        'Dockerfile.user must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}` ' +
        'so the parent image is injected via --build-arg. ' +
        'Example:\n  ARG BASE_IMAGE\n  FROM ${BASE_IMAGE}',
      )
    }
    const userHash = stringHash(`${effectiveHash}:${await contextHash(userBuild)}`)
    const userTag = `${prefix}-user-${projectSlug}:${userHash}`
    layers.push({
      tag: userTag,
      name: 'user',
      dockerfile: userDockerfile,
      context: userBuild,
      buildArgs: { BASE_IMAGE: effectiveTag },
      contentHash: userHash,
    })
    effectiveTag = userTag
  }

  return { layers, finalTag: effectiveTag }
}


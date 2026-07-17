import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { DOCKERFILES_DIR, getDataDir, projectConfigDir } from '@yaac/shared/project-paths'
import { imageExists } from '#lib/container/runtime'
import { serverLog, pipeToServerLog } from '#log'
import type { ImageLayerName } from '@yaac/shared/types'

export function stringHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * The uid baked into session images as the `yaac` user (YAAC_UID build
 * arg). Under gVisor there is no userns and no idmap, so numeric uids pass
 * through raw: a hostPath file owned by host uid N appears in-container as
 * uid N. Server-created dirs (worktrees, cache volumes, config mounts) are
 * owned by the server's uid — the in-container user must carry the same uid
 * to write them. Falls back to 1000 when there is no uid to mirror
 * (non-POSIX) or the server runs as root (uid 0 is taken inside the image).
 */
export function sessionUid(): number {
  const uid = process.getuid?.() ?? 1000
  return uid > 0 ? uid : 1000
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
  return stringHash(`${await fileHash(dockerfilePath)}:uid=${sessionUid()}`)
}

/**
 * Parse a .containerignore into the set of context-relative paths to skip.
 * The hash must exclude exactly what `podman build` excludes, so instead of
 * replicating podman's full glob matcher we support only literal paths
 * (`node_modules`, `test`, `a/b.txt`) and fail loudly on anything fancier —
 * a silently-mismatched pattern would let the image tag and the built image
 * drift apart.
 */
export function parseContainerIgnore(content: string): Set<string> {
  const patterns = new Set<string>()
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/[*?[\]!]/.test(line) || line.startsWith('/')) {
      throw new Error(
        `unsupported .containerignore pattern ${JSON.stringify(line)}: `
        + 'only literal context-relative paths are supported (contextHash '
        + "must match podman's exclusions exactly)",
      )
    }
    patterns.add(line.replace(/\/+$/, ''))
  }
  return patterns
}

/**
 * Recursively collect a build context's regular files (context-relative
 * paths), skipping ignored entries. Symlinks and empty directories are
 * excluded — matching `contextHash`, which defines what the content-hash
 * tag covers. Shared with the builder-pod context streamer so the bytes
 * shipped to a sandboxed build are exactly the bytes the tag hashed.
 */
export async function collectContextFiles(root: string, rel: string, ignore: Set<string>): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (ignore.has(childRel)) continue
    if (entry.isDirectory()) {
      out.push(...await collectContextFiles(root, childRel, ignore))
    } else if (entry.isFile()) {
      out.push(childRel)
    }
  }
  return out
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
export interface BuildOptions {
  noCache?: boolean
  onLog?: (line: string) => void
}

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

  await new Promise<void>((resolve, reject) => {
    const child = spawn('podman', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    })
    const prefix = `[build ${imageName}] `
    pipeToServerLog(child.stdout, prefix, opts.onLog)
    pipeToServerLog(child.stderr, prefix, opts.onLog)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`podman build exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

/**
 * Build an image if a tagged version does not already exist.
 * Used by test global setup to pre-build images with content-hash tags.
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

/**
 * Check whether a Dockerfile layers on top of the yaac base image.
 * A layered Dockerfile must declare `ARG BASE_IMAGE` and use `FROM ${BASE_IMAGE}`
 * so the parent image is always injected via --build-arg (no shared mutable tags).
 */
export function isLayered(dockerfileContent: string): boolean {
  return /^ARG\s+BASE_IMAGE\b/m.test(dockerfileContent)
    && /^FROM\s+\$\{BASE_IMAGE\}/m.test(dockerfileContent)
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
  // Read Dockerfile.yaac from the per-machine config dir, or fall back to Dockerfile.default.
  const localDockerfile = path.join(projectConfigDir(projectSlug), 'Dockerfile.yaac')
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
    const toolsContentHash = await fileHash(toolsDockerfile)
    toolsHash = stringHash(`${defaultHash}:${toolsContentHash}`)
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
  const baseHash = yaacIsLayered
    ? stringHash(`${parentHash!}:${stringHash(yaacContent!)}`)
    : yaacDockerfile
      ? stringHash(`${stringHash(yaacContent!)}:uid=${uid}`)
      : parentHash!
  const baseTag = yaacDockerfile
    ? `${prefix}-base:${baseHash}`
    : parentTag!

  if (yaacDockerfile) {
    const baseContext = path.dirname(yaacDockerfile)
    layers.push({
      tag: baseTag,
      name: 'project',
      dockerfile: yaacDockerfile,
      context: baseContext,
      buildArgs: yaacIsLayered
        ? { BASE_IMAGE: parentTag! }
        : { YAAC_UID: String(uid) },
      contentHash: baseHash,
    })
  }

  let effectiveTag = baseTag
  const effectiveHash = baseHash

  // Layer 2 (optional): <prefix>-user-<slug> (from ~/.yaac/Dockerfile.user)
  const userDockerfile = path.join(getDataDir(), 'Dockerfile.user')
  if (await fileExists(userDockerfile)) {
    const userContent = await fs.readFile(userDockerfile, 'utf8')
    if (!isLayered(userContent)) {
      throw new Error(
        'Dockerfile.user must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}` ' +
        'so the parent image is injected via --build-arg. ' +
        'Example:\n  ARG BASE_IMAGE\n  FROM ${BASE_IMAGE}',
      )
    }
    const userContentHash = stringHash(userContent)
    const userHash = stringHash(`${effectiveHash}:${userContentHash}`)
    const userTag = `${prefix}-user-${projectSlug}:${userHash}`
    layers.push({
      tag: userTag,
      name: 'user',
      dockerfile: userDockerfile,
      context: getDataDir(),
      buildArgs: { BASE_IMAGE: effectiveTag },
      contentHash: userHash,
    })
    effectiveTag = userTag
  }

  return { layers, finalTag: effectiveTag }
}


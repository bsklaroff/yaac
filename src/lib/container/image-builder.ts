import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { pack } from 'tar-stream'
import { DOCKERFILES_DIR, getDataDir, projectConfigDir } from '@/lib/project/paths'
import { imageExists, removeImage } from '@/lib/container/runtime'
import { daemonLog, pipeToDaemonLog } from '@/daemon/log'

interface TarEntry {
  name: string
  content: string
}

export async function packTar(entries: TarEntry[]): Promise<Buffer> {
  const p = pack()
  const chunks: Buffer[] = []
  p.on('data', (chunk: Buffer) => chunks.push(chunk))

  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      p.entry({ name: entry.name }, entry.content, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  p.finalize()
  await new Promise<void>((resolve) => p.on('end', resolve))

  return Buffer.concat(chunks)
}

export function stringHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export async function fileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8')
  return stringHash(content)
}

// node_modules is a dev-only artifact created by pnpm workspace installs; it
// is also excluded via .containerignore in contexts that contain it.
const CONTEXT_HASH_IGNORE = new Set(['node_modules'])

async function collectContextFiles(root: string, rel: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (CONTEXT_HASH_IGNORE.has(entry.name)) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...await collectContextFiles(root, childRel))
    } else if (entry.isFile()) {
      out.push(childRel)
    }
  }
  return out
}

export async function contextHash(dir: string): Promise<string> {
  const files = (await collectContextFiles(dir, '')).sort()
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
interface BuildOptions {
  noCache?: boolean
  onLog?: (line: string) => void
}

async function buildImage(
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

  // When running behind a TLS-intercepting proxy (e.g. inside a yaac
  // session), mount the custom CA cert so curl/apt inside the build
  // can verify connections through the proxy.
  const certFile = process.env.SSL_CERT_FILE
  if (certFile && existsSync(certFile)) {
    args.push('--volume', `${certFile}:${certFile}:ro`)
    args.push('--build-arg', `SSL_CERT_FILE=${certFile}`)
  }

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
    pipeToDaemonLog(child.stdout, prefix, opts.onLog)
    pipeToDaemonLog(child.stderr, prefix, opts.onLog)
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
  daemonLog(`[build] starting ${tag}`)
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
function isLayered(dockerfileContent: string): boolean {
  return /^ARG\s+BASE_IMAGE\b/m.test(dockerfileContent)
    && /^FROM\s+\$\{BASE_IMAGE\}/m.test(dockerfileContent)
}

interface ImageLayer {
  tag: string
  dockerfile: string
  context: string
  buildArgs?: Record<string, string>
  /** Hash of this layer's content, used for composing downstream hashes */
  contentHash: string
}

/**
 * Resolves the full image layer chain for a project without building anything.
 * Returns the ordered list of layers.
 */
async function resolveImageChain(
  projectSlug: string,
  prefix: string,
  nestedContainers: boolean,
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
  const defaultHash = await fileHash(defaultDockerfile)
  const defaultTag = `${prefix}-base:${defaultHash}`

  // We're on the canonical base unless Dockerfile.yaac replaces it standalone.
  // Tools (the agent CLI layer) sit on top of the canonical base only.
  const useDefaultBase = !yaacDockerfile || yaacIsLayered

  if (useDefaultBase) {
    layers.push({
      tag: defaultTag,
      dockerfile: defaultDockerfile,
      context: DOCKERFILES_DIR,
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
      dockerfile: toolsDockerfile,
      context: DOCKERFILES_DIR,
      buildArgs: { BASE_IMAGE: defaultTag },
      contentHash: toolsHash,
    })
  }

  // Resolve the base layer tag (may be tools-only, layered yaac, or standalone yaac).
  const baseHash = yaacIsLayered
    ? stringHash(`${toolsHash!}:${stringHash(yaacContent!)}`)
    : yaacDockerfile
      ? stringHash(yaacContent!)
      : toolsHash!
  const baseTag = yaacDockerfile
    ? `${prefix}-base:${baseHash}`
    : toolsTag!

  if (yaacDockerfile) {
    const baseContext = path.dirname(yaacDockerfile)
    layers.push({
      tag: baseTag,
      dockerfile: yaacDockerfile,
      context: baseContext,
      ...(yaacIsLayered ? { buildArgs: { BASE_IMAGE: toolsTag! } } : {}),
      contentHash: baseHash,
    })
  }

  // Layer 1.5 (optional): <prefix>-base-nestable (podman-in-podman support)
  let effectiveTag = baseTag
  let effectiveHash = baseHash
  if (nestedContainers) {
    const nestDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
    const nestContentHash = await fileHash(nestDockerfile)
    const nestHash = stringHash(`${baseHash}:${nestContentHash}`)
    const nestTag = `${prefix}-base-nestable:${nestHash}`
    layers.push({
      tag: nestTag,
      dockerfile: nestDockerfile,
      context: DOCKERFILES_DIR,
      buildArgs: { BASE_IMAGE: baseTag },
      contentHash: nestHash,
    })
    effectiveTag = nestTag
    effectiveHash = nestHash
  }

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
      dockerfile: userDockerfile,
      context: getDataDir(),
      buildArgs: { BASE_IMAGE: effectiveTag },
      contentHash: userHash,
    })
    effectiveTag = userTag
  }

  return { layers, finalTag: effectiveTag }
}

/**
 * Resolves the final image tag for a project without building anything.
 * Useful for fingerprinting — computes what the tag would be based on
 * current Dockerfile content and config.
 */
export async function resolveImageTag(projectSlug: string, imagePrefix?: string, nestedContainers = false): Promise<string> {
  const prefix = imagePrefix ?? 'yaac'
  const { finalTag } = await resolveImageChain(projectSlug, prefix, nestedContainers)
  return finalTag
}

/**
 * Ensures the full image chain is built for a project.
 *
 * Layer 1: yaac-base (Dockerfile.default — Ubuntu + system packages + Node)
 *   Skipped when Dockerfile.yaac is standalone (any FROM that isn't ${BASE_IMAGE}).
 * Layer 1a: yaac-tools (Dockerfile.tools — claude, codex, opencode, etc.)
 *   Included whenever the canonical base is in use. Rebuilt with --no-cache
 *   by `yaac project rebuild` to pick up new upstream agent CLI versions.
 * Layer 2: yaac-base from Dockerfile.yaac — when present:
 *   - layered on Dockerfile.tools (when Dockerfile.yaac uses `ARG BASE_IMAGE` + `FROM ${BASE_IMAGE}`)
 *   - or standalone (replaces the canonical base + tools)
 * Layer 3 (optional): yaac-base-nestable (Dockerfile.nestable, when nestedContainers)
 * Layer 4 (optional): yaac-user-<slug> (~/.yaac/Dockerfile.user, builds on top)
 *
 * Returns the final image name to use for containers.
 *
 * @param imagePrefix - Override for image name prefix. Used by tests to
 *   build isolated images that don't interfere with the running application.
 * @param requirePrebuilt - When true, throw instead of building if the base
 *   image is missing or stale. Used by e2e tests so parallel workers fail
 *   fast instead of racing to build the same image.
 * @param nestedContainers - When true, build the nestable layer (podman-in-podman support).
 */
export async function ensureImage(projectSlug: string, imagePrefix?: string, requirePrebuilt = false, nestedContainers = false): Promise<string> {
  const prefix = imagePrefix ?? 'yaac'
  const { layers, finalTag } = await resolveImageChain(projectSlug, prefix, nestedContainers)

  for (const layer of layers) {
    if (await imageExists(layer.tag)) continue

    if (requirePrebuilt) {
      throw new Error(
        `Image ${layer.tag} is missing or stale. ` +
        'Restart the test run so the global setup can rebuild it.',
      )
    }

    daemonLog(`[build] starting ${layer.tag}`)
    await buildImage(layer.tag, layer.dockerfile, layer.context, layer.buildArgs)
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
 * downstream layer (nestable / Dockerfile.yaac overlay / Dockerfile.user) so
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
    nestedContainers?: boolean
    onLog?: (line: string) => void
  } = {},
): Promise<string> {
  const prefix = opts.imagePrefix ?? 'yaac'
  const { layers, finalTag } = await resolveImageChain(
    projectSlug, prefix, opts.nestedContainers ?? false,
  )

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

  // Remove the existing tools image and everything downstream so podman
  // rebuilds them from scratch off the freshly-built tools layer.
  for (let i = toolsIdx; i < layers.length; i++) {
    emit(`removing existing image ${layers[i].tag}`)
    await removeImage(layers[i].tag)
  }

  // Tools layer is rebuilt with --no-cache so the upstream agent CLI
  // installers re-execute. Downstream layers use the normal cache; their
  // RUN steps are unchanged, but FROM resolves to the new tools digest so
  // they're rebuilt cleanly.
  for (let i = toolsIdx; i < layers.length; i++) {
    const layer = layers[i]
    const noCache = i === toolsIdx
    emit(`building ${layer.tag}${noCache ? ' (no cache)' : ''}`)
    await buildImage(layer.tag, layer.dockerfile, layer.context, layer.buildArgs, {
      noCache,
      onLog: opts.onLog,
    })
  }

  emit(`done — final image is ${finalTag}`)
  return finalTag
}

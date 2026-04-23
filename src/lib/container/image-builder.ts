import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { pack } from 'tar-stream'
import { DOCKERFILES_DIR, getDataDir, configOverrideDir, repoDir } from '@/lib/project/paths'
import { getDefaultBranch } from '@/lib/git'
import { execFileAsync, imageExists } from '@/lib/container/runtime'

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

export async function contextHash(dir: string): Promise<string> {
  const entries = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort()
  const hasher = crypto.createHash('sha256')
  for (const name of entries) {
    hasher.update(name)
    hasher.update(await fs.readFile(path.join(dir, name)))
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
async function buildImage(imageName: string, dockerfile: string, context: string, buildArgs?: Record<string, string>): Promise<void> {
  const args = [
    'build',
    '-t', imageName,
    '-f', dockerfile,
  ]

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
    const child = spawn('podman', args, { stdio: 'inherit', timeout: 600_000 })
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
  console.log(`Building ${tag}...`)
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

async function readFileFromRef(repoPath: string, ref: string, filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], { cwd: repoPath })
    return stdout
  } catch {
    return null
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
 * Returns the ordered list of layers and any temp dir that needs cleanup.
 */
async function resolveImageChain(
  projectSlug: string,
  prefix: string,
  nestedContainers: boolean,
): Promise<{ layers: ImageLayer[]; finalTag: string; tmpDir: string | null }> {
  const layers: ImageLayer[] = []

  // Layer 1: <prefix>-base
  // Priority: config-override/Dockerfile.yaac > repo Dockerfile.yaac (from remote ref) > Dockerfile.default
  const overrideDockerfile = path.join(configOverrideDir(projectSlug), 'Dockerfile.yaac')
  let yaacDockerfile: string | null = null
  let yaacContent: string | null = null
  let tmpDockerfileDir: string | null = null

  if (await fileExists(overrideDockerfile)) {
    yaacDockerfile = overrideDockerfile
    yaacContent = await fs.readFile(overrideDockerfile, 'utf8')
  } else {
    try {
      const repo = repoDir(projectSlug)
      const defaultBranch = await getDefaultBranch(repo)
      const content = await readFileFromRef(repo, `origin/${defaultBranch}`, 'Dockerfile.yaac')
      if (content) {
        tmpDockerfileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-dockerfile-'))
        yaacDockerfile = path.join(tmpDockerfileDir, 'Dockerfile.yaac')
        await fs.writeFile(yaacDockerfile, content)
        yaacContent = content
      }
    } catch {
      // git not available — fall through to default
    }
  }

  const yaacIsLayered = yaacContent ? isLayered(yaacContent) : false
  const defaultDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const defaultHash = await fileHash(defaultDockerfile)

  // When there's no Dockerfile.yaac or it layers on the default, include the default layer.
  if (!yaacDockerfile || yaacIsLayered) {
    const defaultTag = `${prefix}-base:${defaultHash}`
    layers.push({
      tag: defaultTag,
      dockerfile: defaultDockerfile,
      context: DOCKERFILES_DIR,
      contentHash: defaultHash,
    })
  }

  // Resolve the base layer tag (may be default-only, layered yaac, or standalone yaac).
  const baseHash = yaacIsLayered
    ? stringHash(`${defaultHash}:${stringHash(yaacContent!)}`)
    : yaacDockerfile
      ? stringHash(yaacContent!)
      : defaultHash
  const baseTag = `${prefix}-base:${baseHash}`

  if (yaacDockerfile) {
    const baseContext = path.dirname(yaacDockerfile)
    layers.push({
      tag: baseTag,
      dockerfile: yaacDockerfile,
      context: baseContext,
      ...(yaacIsLayered ? { buildArgs: { BASE_IMAGE: `${prefix}-base:${defaultHash}` } } : {}),
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

  return { layers, finalTag: effectiveTag, tmpDir: tmpDockerfileDir }
}

/**
 * Resolves the final image tag for a project without building anything.
 * Useful for fingerprinting — computes what the tag would be based on
 * current Dockerfile content and config.
 */
export async function resolveImageTag(projectSlug: string, imagePrefix?: string, nestedContainers = false): Promise<string> {
  const prefix = imagePrefix ?? 'yaac'
  const { finalTag, tmpDir } = await resolveImageChain(projectSlug, prefix, nestedContainers)
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  return finalTag
}

/**
 * Ensures the full image chain is built for a project.
 *
 * Layer 1: yaac-base — one of:
 *   - Dockerfile.default alone (no Dockerfile.yaac)
 *   - Dockerfile.yaac layered on Dockerfile.default (when Dockerfile.yaac uses `ARG BASE_IMAGE` + `FROM ${BASE_IMAGE}`)
 *   - Dockerfile.yaac standalone (when Dockerfile.yaac uses any other FROM, replaces default)
 * Layer 1.5 (optional): yaac-base-nestable (from Dockerfile.nestable, when nestedContainers is true)
 * Layer 2: yaac-user-<slug> (optional: from ~/.yaac/Dockerfile.user, builds on top)
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
  const { layers, finalTag, tmpDir } = await resolveImageChain(projectSlug, prefix, nestedContainers)

  try {
    for (const layer of layers) {
      if (await imageExists(layer.tag)) continue

      if (requirePrebuilt) {
        throw new Error(
          `Image ${layer.tag} is missing or stale. ` +
          'Restart the test run so the global setup can rebuild it.',
        )
      }

      console.log(`Building ${layer.tag}...`)
      await buildImage(layer.tag, layer.dockerfile, layer.context, layer.buildArgs)
    }
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  return finalTag
}

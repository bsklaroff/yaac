import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { PROJECT_DOCKERFILE, USER_DOCKERFILE, projectBuildDir, userBuildDir } from '#lib/build-dirs'
import { collectContextFiles, isLayered, parseContainerIgnore } from '#lib/build-context'
import type { ImageLayerName } from '@yaac/shared/types'

/**
 * Content-hash image tags: every workspace image chain (the yaac-shipped
 * layers and a project's own), and the hashes every other image tag
 * (proxy, netd, the server) is built from. A tag changes exactly when its
 * sources do, so a tag present in the registry never needs rebuilding.
 */

/** The prefix of every yaac-built repo name: `yaac`, or the test suite's
 *  own (`YAAC_IMAGE_PREFIX`) so its images never collide with an install's. */
export function imagePrefix(): string {
  return testEnv.imagePrefix ?? 'yaac'
}

export function stringHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export async function fileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8')
  return stringHash(content)
}

/**
 * Content hash of the base image layer: its Dockerfile plus the in-pod
 * daemons it COPYs (dockerfiles/streamd/ and dockerfiles/acpd/). Shared
 * with the test global setup so both derive identical tags. No uid goes
 * in, since the images work under any uid (docs/arbitrary-uid-images.md).
 */
export async function baseImageHash(dockerfilePath: string): Promise<string> {
  const streamdHash = await contextHash(path.join(DOCKERFILES_DIR, 'streamd'))
  const acpdHash = await contextHash(path.join(DOCKERFILES_DIR, 'acpd'))
  return stringHash(
    `${await fileHash(dockerfilePath)}:streamd=${streamdHash}:acpd=${acpdHash}`,
  )
}

/** Content hash of the tools layer's Dockerfile and the patch it copies
 *  in. Shared with the test global setup so both derive identical tags. */
export async function toolsContentHash(): Promise<string> {
  const files = ['Dockerfile.tools', 'agent-patches/pi-acp.js']
  const hashes = await Promise.all(files.map((f) => fileHash(path.join(DOCKERFILES_DIR, f))))
  return stringHash(hashes.join(':'))
}

/**
 * Content hash of a build context, skipping what its .containerignore
 * excludes (as `podman build` does) so dev-only files don't change tags.
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

export interface ImageLayer {
  tag: string
  /** Which chain step this is — the dependency the tag realizes. */
  name: ImageLayerName
  dockerfile: string
  context: string
  buildArgs?: Record<string, string>
  /** Hash of this layer's content, folded into downstream layers' hashes. */
  contentHash: string
}

/** The yaac-shipped layers, in dependency order. */
interface TrustedLayers {
  base: ImageLayer
  tools: ImageLayer
  nestable: ImageLayer
}

/**
 * The three layers yaac ships: the Ubuntu+Node base, the agent CLIs, and
 * the optional in-pod container engine. `yaac cluster install` builds these
 * (docs/trust-split-builds.md), never the server. Both the install and
 * `resolveImageChain` take their tags from here, so they always agree.
 */
export async function resolveTrustedLayers(prefix = imagePrefix()): Promise<TrustedLayers> {
  const baseDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const baseHash = await baseImageHash(baseDockerfile)
  const base: ImageLayer = {
    tag: `${prefix}-base:${baseHash}`,
    name: 'base',
    dockerfile: baseDockerfile,
    context: DOCKERFILES_DIR,
    contentHash: baseHash,
  }

  // Separate from base so a toolchain edit skips the slow apt/Node build.
  const toolsHash = stringHash(`${baseHash}:${await toolsContentHash()}`)
  const tools: ImageLayer = {
    tag: `${prefix}-tools:${toolsHash}`,
    name: 'tools',
    dockerfile: path.join(DOCKERFILES_DIR, 'Dockerfile.tools'),
    context: DOCKERFILES_DIR,
    buildArgs: { BASE_IMAGE: base.tag },
    contentHash: toolsHash,
  }

  // In-pod rootful podman + docker CLI + compose, for `nestedContainers`
  // workspaces.
  const nestableDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
  const nestableHash = stringHash(`${toolsHash}:${await fileHash(nestableDockerfile)}`)
  const nestable: ImageLayer = {
    tag: `${prefix}-nestable:${nestableHash}`,
    name: 'nestable',
    dockerfile: nestableDockerfile,
    context: DOCKERFILES_DIR,
    buildArgs: { BASE_IMAGE: tools.tag },
    contentHash: nestableHash,
  }

  return { base, tools, nestable }
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
 * Resolve a project's ordered image layer chain without building anything.
 *
 * The chain is base, tools, optionally nestable (for `nestedContainers`),
 * then the project's Dockerfile.yaac and its owner's Dockerfile.user if
 * present. A standalone (non-layered) Dockerfile.yaac replaces base, tools
 * and nestable, and owns its own uid setup (docs/arbitrary-uid-images.md).
 * Each layer's build dir is its whole context, so support files count
 * toward its hash.
 *
 * Project and user layers live in repos named by project id
 * (`<prefix>-proj-<id>`, `<prefix>-user-<id>`): a repo is what a registry
 * grant can scope, and ids are never reused, so a project added again
 * never picks up the old project's tags.
 */
export async function resolveImageChain(
  projectId: string,
  owner: string,
  nestedContainers = false,
): Promise<{ layers: ImageLayer[]; finalTag: string }> {
  const prefix = imagePrefix()
  const layers: ImageLayer[] = []

  const projectBuild = projectBuildDir(projectId)
  const localDockerfile = path.join(projectBuild, PROJECT_DOCKERFILE)
  let yaacDockerfile: string | null = null
  let yaacContent: string | null = null

  if (await fileExists(localDockerfile)) {
    yaacDockerfile = localDockerfile
    yaacContent = await fs.readFile(localDockerfile, 'utf8')
  }

  const yaacIsLayered = yaacContent ? isLayered(yaacContent) : false

  const useDefaultBase = !yaacDockerfile || yaacIsLayered
  const trusted = useDefaultBase ? await resolveTrustedLayers(prefix) : null

  let toolsTag: string | null = null
  let toolsHash: string | null = null
  if (trusted) {
    layers.push(trusted.base, trusted.tools)
    toolsTag = trusted.tools.tag
    toolsHash = trusted.tools.contentHash
  }

  let nestableTag: string | null = null
  let nestableHash: string | null = null
  if (trusted && nestedContainers) {
    layers.push(trusted.nestable)
    nestableTag = trusted.nestable.tag
    nestableHash = trusted.nestable.contentHash
  }

  const parentTag = nestableTag ?? toolsTag
  const parentHash = nestableHash ?? toolsHash
  const projectContextHash = yaacDockerfile ? await contextHash(projectBuild) : null
  const baseHash = yaacIsLayered
    ? stringHash(`${parentHash!}:${projectContextHash!}`)
    : yaacDockerfile
      ? stringHash(projectContextHash!)
      : parentHash!
  const baseTag = yaacDockerfile
    ? `${prefix}-proj-${projectId}:${baseHash}`
    : parentTag!

  if (yaacDockerfile) {
    layers.push({
      tag: baseTag,
      name: 'project',
      dockerfile: yaacDockerfile,
      context: projectBuild,
      ...(yaacIsLayered ? { buildArgs: { BASE_IMAGE: parentTag! } } : {}),
      contentHash: baseHash,
    })
  }

  let effectiveTag = baseTag
  const effectiveHash = baseHash

  const userBuild = userBuildDir(owner)
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
    const userTag = `${prefix}-user-${projectId}:${userHash}`
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


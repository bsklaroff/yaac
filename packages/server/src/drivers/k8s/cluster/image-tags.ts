import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DOCKERFILES_DIR } from '@yaac/shared/project-paths'
import { testEnv } from '@yaac/shared/env'
import { collectContextFiles, isLayered, parseContainerIgnore } from '#lib/build-context'
import type { ImageChainSpec } from '#drivers/contract'
import type { ImageLayerName } from '@yaac/shared/types'
import { NORMALIZE_STEP } from './normalize-step'

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
 * Content hash of the base image layer: its Dockerfile, which copies
 * nothing from its context, and the normalize step every build appends
 * (which the tools tag inherits through this one). Shared with the test
 * global setup so both derive identical tags. No uid goes in, since the
 * images work under any uid (docs/arbitrary-uid-images.md).
 */
export async function baseImageHash(dockerfilePath: string): Promise<string> {
  return stringHash(`${await fileHash(dockerfilePath)}:normalize=${stringHash(NORMALIZE_STEP)}`)
}

/** Content hash of the tools layer's Dockerfile and the patches folder it
 *  copies in. Shared with the test global setup so both derive identical
 *  tags. */
export async function toolsContentHash(): Promise<string> {
  const patches = await contextHash(path.join(DOCKERFILES_DIR, 'agent-patches'))
  return stringHash(`${await fileHash(path.join(DOCKERFILES_DIR, 'Dockerfile.tools'))}:agent-patches=${patches}`)
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
  /** A yaac-shipped layer's Dockerfile path; an untrusted layer's text. */
  dockerfile: string
  context: string
  buildArgs?: Record<string, string>
  /** Hash of this layer's content, folded into downstream layers' hashes. */
  contentHash: string
  /** An untrusted layer's build cache key (`ImageLayerSource.cacheKey`). */
  cacheKey?: string
}

/** The yaac-shipped layers, in dependency order. */
interface TrustedLayers {
  base: ImageLayer
  tools: ImageLayer
}

/**
 * The two layers yaac ships: the Ubuntu+Node base and the agent CLIs.
 * `yaac cluster install` builds these
 * (docs/image-builds.md), never the server. Both the install and
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

  return { base, tools }
}

/**
 * An image chain's layers, from the sources `#domain/images` resolved
 * (docs/image-builds.md "Images, revisions and builds"), without building or asking the registry.
 *
 * The chain is base and tools, then the project layer and its owner's user
 * layer when present. A standalone (non-layered) project layer replaces
 * base and tools, and owns its own uid setup (docs/arbitrary-uid-images.md).
 * Every untrusted layer's tag folds in the normalize step the builder
 * appends.
 *
 * Project and user layers live in repos named by project id
 * (`<prefix>-proj-<id>`, `<prefix>-user-<id>`): a repo is what a registry
 * grant can scope, and ids are never reused, so a project added again
 * never picks up the old project's tags.
 */
export async function resolveImageChain(spec: ImageChainSpec): Promise<{ layers: ImageLayer[]; finalTag: string }> {
  const prefix = imagePrefix()
  const project = spec.layers.find((l) => l.layer === 'project')
  const user = spec.layers.find((l) => l.layer === 'user')
  if (user && !isLayered(user.dockerfile)) {
    throw new Error(
      'Dockerfile.user must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}` '
      + 'so the parent image is injected via --build-arg. '
      + 'Example:\n  ARG BASE_IMAGE\n  FROM ${BASE_IMAGE}',
    )
  }
  const normalize = stringHash(NORMALIZE_STEP)
  const layers: ImageLayer[] = []
  let parent: { tag: string; hash: string } | null = null
  if (!project || isLayered(project.dockerfile)) {
    const { base, tools } = await resolveTrustedLayers(prefix)
    layers.push(base, tools)
    parent = { tag: tools.tag, hash: tools.contentHash }
  }
  for (const source of [project, user]) {
    if (!source) continue
    const hash = stringHash(`${parent ? `${parent.hash}:` : ''}${source.contentHash}:${normalize}`)
    const repo = source.layer === 'project' ? 'proj' : 'user'
    const tag = `${prefix}-${repo}-${spec.projectId}:${hash}`
    layers.push({
      tag,
      name: source.layer,
      dockerfile: source.dockerfile,
      context: source.contextDir,
      ...(parent ? { buildArgs: { BASE_IMAGE: parent.tag } } : {}),
      contentHash: hash,
      cacheKey: source.cacheKey,
    })
    parent = { tag, hash }
  }
  return { layers, finalTag: layers.at(-1)!.tag }
}

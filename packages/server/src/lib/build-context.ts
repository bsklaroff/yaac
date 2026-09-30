/**
 * Which files make up an OCI build context and how large it may get. Pure
 * filesystem code, no podman or cluster.
 *
 * In `#lib` because two features use it: the k8s image code hashes this file
 * set into a tag and streams it to a builder pod, and the build-files API
 * lists the same set and enforces the same size cap at upload time.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Size cap on a streamed build context. The build-files API enforces it at
 * upload time too, so an oversized folder fails there rather than at the
 * next build.
 */
export const BUILDER_CONTEXT_MAX_BYTES = 512 * 1024 ** 2

/**
 * Parse a .containerignore into the set of context-relative paths to skip.
 * The hash must exclude exactly what `podman build` excludes, so only
 * literal paths are supported; anything else throws rather than letting the
 * image tag and the built image silently disagree.
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
 * Recursively collect a build context's regular files as context-relative
 * paths, skipping ignored entries, symlinks and empty directories. The
 * content-hash tag and the builder-pod streamer both use this, so the bytes
 * shipped are exactly the bytes hashed.
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
 * Whether a Dockerfile layers onto the previous image in the chain: it must
 * both declare `ARG BASE_IMAGE` and use it in `FROM`.
 */
export function isLayered(dockerfileContent: string): boolean {
  return /^ARG\s+BASE_IMAGE\b/m.test(dockerfileContent)
    && /^FROM\s+\$\{BASE_IMAGE\}/m.test(dockerfileContent)
}

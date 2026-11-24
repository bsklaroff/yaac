/**
 * Which files make up an OCI build context and how large it may get. Pure
 * filesystem code, no podman or cluster.
 *
 * In `#lib` because two features use it: the k8s image code hashes and
 * streams build contexts, and `#domain/images` enforces the same size cap
 * when a revision is saved and imports old build dirs.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Size cap on a streamed build context. A save enforces it too, so an
 * oversized revision fails there rather than at its build.
 */
export const BUILDER_CONTEXT_MAX_BYTES = 512 * 1024 ** 2

/** Cap on one support file of an image, well under the context cap. */
export const MAX_IMAGE_FILE_BYTES = 50 * 1024 ** 2

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

/**
 * What an OCI build context is made of: which files are in it, and how big it
 * is allowed to get. Pure filesystem and text — no podman, no cluster, no
 * image tagging.
 *
 * A platform primitive rather than part of #features/images because two
 * features answer to it. Images hashes this set into a tag and streams it to
 * a sandboxed builder pod; projects lists the same set for the build-files
 * API and enforces the same cap at upload time, so a folder a build would
 * reject cannot be assembled in the first place. Housed in the images barrel,
 * that second consumer was a feature reaching sideways for a definition
 * neither of them owns.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Sanity cap on a streamed build context. Contexts are dedicated build dirs
 * (Dockerfile + user-managed support files); the build-files API mirrors this
 * cap at upload time so a folder that grows past it fails there rather than
 * at the next build.
 */
export const BUILDER_CONTEXT_MAX_BYTES = 512 * 1024 ** 2

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
 * Whether a Dockerfile layers onto the image below it in the chain, rather
 * than starting from its own base. Both halves are required: the ARG
 * declares the parameter, the FROM actually consumes it.
 */
export function isLayered(dockerfileContent: string): boolean {
  return /^ARG\s+BASE_IMAGE\b/m.test(dockerfileContent)
    && /^FROM\s+\$\{BASE_IMAGE\}/m.test(dockerfileContent)
}

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '#paths'
import { testEnv } from '#env'

const BUILD_ID_FILENAME = '.build-id'

/**
 * Top-level dist/ dirs the server re-reads at runtime rather than code, so
 * a running server picks up edits without a restart. Excluded from the
 * build id so editing a Dockerfile does not make `pnpm watch` restart the
 * server mid-create.
 */
const RUNTIME_DATA_DIRS = new Set(['dockerfiles', 'k8s'])

export function buildIdPath(rootDir: string = PACKAGE_ROOT): string {
  return path.join(rootDir, BUILD_ID_FILENAME)
}

/**
 * Content hash of the code in `rootDir`, used to detect a server running a
 * different build than the CLI. The build writes it to `dist/.build-id`,
 * and the server reports it in its lock and response headers.
 *
 * Entries are sorted by POSIX relative path so the hash is the same on
 * every machine. Skips `.build-id` itself and {@link RUNTIME_DATA_DIRS}.
 */
export async function computeBuildId(rootDir: string): Promise<string> {
  const entries: Array<{ rel: string; hash: string }> = []
  await collect(rootDir, '', entries)
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const outer = crypto.createHash('sha256')
  for (const { rel, hash } of entries) {
    outer.update(rel)
    outer.update('\0')
    outer.update(hash)
    outer.update('\0')
  }
  return outer.digest('hex')
}

async function collect(
  rootDir: string,
  relDir: string,
  out: Array<{ rel: string; hash: string }>,
): Promise<void> {
  const absDir = path.join(rootDir, relDir)
  const dirents = await fs.readdir(absDir, { withFileTypes: true })
  for (const ent of dirents) {
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      if (relDir === '' && RUNTIME_DATA_DIRS.has(ent.name)) continue
      await collect(rootDir, rel, out)
      continue
    }
    if (!ent.isFile()) continue
    if (relDir === '' && ent.name === BUILD_ID_FILENAME) continue
    const abs = path.join(rootDir, rel)
    const buf = await fs.readFile(abs)
    const hash = crypto.createHash('sha256').update(buf).digest('hex')
    out.push({ rel, hash })
  }
}

/**
 * Read the build id written by `scripts/write-build-id.ts`, or
 * `YAAC_BUILD_ID` when set (tests running from source have no
 * `.build-id`). Throws if the file is missing or empty.
 */
export async function readBuildId(rootDir: string = PACKAGE_ROOT): Promise<string> {
  const envOverride = testEnv.buildIdOverride
  if (envOverride) return envOverride

  const p = buildIdPath(rootDir)
  let raw: string
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch {
    throw new Error(
      `broken install: ${p} not found. Rebuild with \`pnpm build\` (or reinstall).`,
    )
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(`broken install: ${p} is empty. Rebuild with \`pnpm build\`.`)
  }
  return trimmed
}

export async function writeBuildId(rootDir: string, id: string): Promise<void> {
  await fs.writeFile(buildIdPath(rootDir), `${id}\n`, { mode: 0o644 })
}

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '#paths'
import { testEnv } from '#env'

const BUILD_ID_FILENAME = '.build-id'

/**
 * Top-level dist/ dirs that are runtime-READ data, not server code: the
 * server re-reads dockerfiles on every image-chain resolution and k8s/
 * image build contexts on every build, so a running server picks up
 * edits to them with no restart. Excluded from the buildId so a
 * dockerfile-only rebuild doesn't read as a version mismatch — `pnpm
 * watch` would otherwise bounce the server on every Dockerfile save,
 * severing in-flight worktree creates (each one's k8s Job survives as a
 * half-provisioned zombie pod).
 */
const RUNTIME_DATA_DIRS = new Set(['dockerfiles', 'k8s'])

export function buildIdPath(rootDir: string = PACKAGE_ROOT): string {
  return path.join(rootDir, BUILD_ID_FILENAME)
}

/**
 * Recursive content hash of the code shipped in `rootDir`. Used to
 * detect a server running from a different install than the CLI that's
 * trying to talk to it: the build script writes this into
 * `dist/.build-id`, the server echoes it into `.server.lock`, and the
 * CLI respawns the server on mismatch.
 *
 * Must be deterministic across machines and filesystems, so entries are
 * sorted by POSIX-style relpath. The `.build-id` file itself is
 * excluded — otherwise writing the hash would invalidate it — as are
 * the `RUNTIME_DATA_DIRS`, which don't affect server behavior.
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
 * Read the build-id written by `scripts/write-build-id.ts`. Resolves
 * relative to `PACKAGE_ROOT` which in bundled builds is `dist/`.
 *
 * Honors `YAAC_BUILD_ID` as a test-injection override (matches the
 * `YAAC_SERVER_URL` / `YAAC_SERVER_SECRET` pattern used elsewhere) so
 * that tests running directly from source — where no `dist/.build-id`
 * exists — can still exercise the server startup path. Production
 * never sets this var.
 *
 * Throws if the file is missing or empty — a broken install should
 * fail loudly rather than silently letting a stale server keep running.
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

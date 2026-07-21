import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** One file's POSIX-style path (relative to its root) and content hash. */
export interface HashEntry {
  rel: string
  hash: string
}

/** sha256 of a buffer, as a 64-char hex string. */
export function hashBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * Fold per-file `(rel, contentHash)` entries into one digest that
 * depends only on the set of files and their contents:
 *  - order-independent — entries are sorted by `rel` first, so the
 *    filesystem's readdir order can't change the result;
 *  - unambiguous across relpaths — `rel` and `hash` are written with
 *    NUL delimiters, so `{rel:'a', hash:'bc'}` and `{rel:'ab', hash:'c'}`
 *    can't fold to the same digest.
 * Deterministic across machines given the same inputs.
 */
export function combineHashes(entries: HashEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const outer = crypto.createHash('sha256')
  for (const { rel, hash } of sorted) {
    outer.update(rel)
    outer.update('\0')
    outer.update(hash)
    outer.update('\0')
  }
  return outer.digest('hex')
}

/**
 * Recursively collect `(rel, contentHash)` for every file under
 * `rootDir`, skipping any directory whose basename is in `skipDirs`. A
 * missing `rootDir` yields `[]` (an input tree may not exist on a
 * partial checkout). `rel` paths are POSIX-style; when `prefix` is set
 * each `rel` is prefixed with `"<prefix>/"`, which namespaces multiple
 * roots so identical relpaths across them stay distinct once combined.
 */
export async function collectFileHashes(
  rootDir: string,
  { prefix = '', skipDirs = new Set<string>() }: { prefix?: string; skipDirs?: Set<string> } = {},
): Promise<HashEntry[]> {
  const out: HashEntry[] = []
  await walk(rootDir, '', out, skipDirs)
  return prefix ? out.map((e) => ({ rel: `${prefix}/${e.rel}`, hash: e.hash })) : out
}

async function walk(
  rootDir: string,
  relDir: string,
  out: HashEntry[],
  skipDirs: Set<string>,
): Promise<void> {
  let dirents
  try {
    dirents = await fs.readdir(path.join(rootDir, relDir), { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of dirents) {
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      if (!skipDirs.has(ent.name)) await walk(rootDir, rel, out, skipDirs)
      continue
    }
    if (!ent.isFile()) continue
    out.push({ rel, hash: hashBuffer(await fs.readFile(path.join(rootDir, rel))) })
  }
}

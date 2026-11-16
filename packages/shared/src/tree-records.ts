/**
 * The two records the tree container and the server share
 * (docs/node-local-workspaces.md "The log"): the start instruction
 * the server writes for a life, and the manifest each checkpoint pass
 * replaces. Both live in the life's folder of the workspace's checkpoint
 * dir. The manifest is written in the agent's sandbox, so whoever reads it
 * checks it against `parseManifest` before trusting a field.
 */

/** A life's folder under the checkpoint dir. */
export const LIVES_DIR = 'lives'
/** Every bundle of a workspace, under the checkpoint dir. */
export const BUNDLES_DIR = 'bundles'
export const START_FILE = 'start.json'
export const MANIFEST_FILE = 'manifest.json'
/** A manifest larger than this is refused unread. */
export const MAX_MANIFEST_BYTES = 1024 * 1024

/** One checkout, as the server set it up for the life. */
export interface StartCheckout {
  /** Its repo's id, which names it in the checkpoint. */
  id: string
  /** Its folder under the tree, `''` at the root. */
  path: string
  /** Its git dir, as the tree container sees it. */
  gitDir: string
  /** The commit it was created at, which its main clone holds: what a
   *  checkpoint leans on, and what it checks out when its HEAD is unreadable. */
  commit: string
  /** Ignored paths kept anyway, relative to the checkout. */
  kept: string[]
}

export interface StartInstruction {
  version: 1
  life: string
  /** Who restored and checked-out files belong to. */
  uid: number
  gid: number
  checkouts: StartCheckout[]
  /** Paths under the tree that the workspace container mounts over (scratch
   *  dirs, volumes); never saved, made as empty folders at start. */
  excluded: string[]
  /** The manifest to restore from, relative to the checkpoint dir. */
  restore?: string
  /** If its chain does not verify, restore the newest state that does
   *  (the chain before the first unreadable bundle, else each checkout's
   *  HEAD) rather than refuse. */
  restoreNewestReadable?: boolean
}

/** What one entry of a checkpoint is. Units are listed outermost first. */
export type SavedUnit =
  | { kind: 'root' }
  | { kind: 'checkout'; path: string; id: string; head: string }
  | { kind: 'submodule'; path: string; checkout: string; gitDir: string; head: string }
  | { kind: 'repo'; path: string }

export interface Manifest {
  version: 1
  life: string
  takenAt: string
  /** Whether the life ended with this checkpoint. */
  final: boolean
  /** The pass commit: unit `n`'s files are its tree's entry `n`, a repo's
   *  git dir entry `n.git`. */
  pass: string
  /** Bundle paths relative to the checkpoint dir, oldest first. */
  bundles: string[]
  units: SavedUnit[]
  /** Repositories a pass could not save; they would not survive a stop. */
  unsaved: string[]
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isSha = (v: unknown): v is string => isStr(v) && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v)
/** A path relative to the tree: no `..`, not absolute. */
const isRel = (v: unknown): v is string =>
  isStr(v) && !v.startsWith('/') && !v.split('/').includes('..') && !v.includes('\0')

function unit(u: unknown): SavedUnit | null {
  if (typeof u !== 'object' || u === null) return null
  const o = u as Record<string, unknown>
  switch (o.kind) {
    case 'root': return { kind: 'root' }
    case 'checkout':
      return isRel(o.path) && isStr(o.id) && isSha(o.head) ? { kind: 'checkout', path: o.path, id: o.id, head: o.head } : null
    case 'submodule':
      return isRel(o.path) && isStr(o.checkout) && isRel(o.gitDir) && isSha(o.head)
        ? { kind: 'submodule', path: o.path, checkout: o.checkout, gitDir: o.gitDir, head: o.head }
        : null
    case 'repo': return isRel(o.path) && o.path !== '' ? { kind: 'repo', path: o.path } : null
    default: return null
  }
}

/** A manifest's text as a `Manifest`, or null when it is not one. */
export function parseManifest(text: string): Manifest | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null || o.version !== 1) return null
  const bundles = Array.isArray(o.bundles) && o.bundles.every((b) => isRel(b) && (b).startsWith(`${BUNDLES_DIR}/`))
    ? o.bundles as string[] : null
  const units = Array.isArray(o.units) ? o.units.map(unit) : null
  const unsaved = Array.isArray(o.unsaved) && o.unsaved.every(isStr) ? o.unsaved : null
  if (!isStr(o.life) || !isStr(o.takenAt) || typeof o.final !== 'boolean' || !isSha(o.pass)
    || !bundles || !units || units.some((u) => u === null) || !unsaved) return null
  return {
    version: 1, life: o.life, takenAt: o.takenAt, final: o.final, pass: o.pass, bundles,
    units: units as SavedUnit[], unsaved,
  }
}

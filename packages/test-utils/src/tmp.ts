import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ambientDataDir } from '@yaac/shared/paths'

let hermeticScratch = false

/**
 * Declare that this run never mounts scratch into a pod, so `testTmpBase`
 * can be the OS tmpdir. unit-setup passes `true`; this module's tests set
 * both values.
 */
export function setHermeticScratch(on: boolean): void {
  hermeticScratch = on
}

/**
 * Base directory for test scratch (data dirs, mock-git repo stores, CLI
 * scratch).
 *
 *  - Hermetic runs (`unit:*`, via {@link setHermeticScratch}) create no
 *    pods, so they use the OS tmpdir: local, fast, and off any
 *    virtiofs/network data dir that would upset timestamp assertions.
 *
 *  - api and e2e runs hostPath-mount scratch into pods, so it must have the
 *    same absolute path on the host and the node. On a kind host `/tmp` is
 *    the node's own tmpfs, so they use `<data dir>/e2e-tmp`, which
 *    `yaac cluster check` proves the node can see.
 *
 * Uses {@link ambientDataDir}, not `getDataDir()`, because each test's data
 * dir is created under this base.
 */
export function testTmpBase(): string {
  if (hermeticScratch) return os.tmpdir()
  return path.join(ambientDataDir(), 'e2e-tmp')
}

/** mkdtemp under the test temp base (see {@link testTmpBase}). */
export async function e2eMkdtemp(prefix: string): Promise<string> {
  const base = testTmpBase()
  await fs.mkdir(base, { recursive: true })
  return fs.mkdtemp(path.join(base, prefix))
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

/** Codes that mean "this subtree is not ours to delete" — never retryable. */
const UNREMOVABLE = new Set(['EACCES', 'EPERM'])

/**
 * Delete everything under `p` that this process is allowed to, and report
 * back the paths it could not. Never throws for permission reasons.
 */
async function salvageRemove(p: string): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(p, { withFileTypes: true })
  } catch (err) {
    const code = errnoOf(err)
    if (code === 'ENOENT') return []
    if (code === 'ENOTDIR') {
      try {
        await fs.rm(p, { force: true })
        return []
      } catch {
        return [p]
      }
    }
    if (UNREMOVABLE.has(code ?? '')) return [p]
    throw err
  }

  const stuck: string[] = []
  for (const entry of entries) {
    const child = path.join(p, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      stuck.push(...await salvageRemove(child))
    } else {
      try {
        await fs.rm(child, { force: true })
      } catch (err) {
        if (!UNREMOVABLE.has(errnoOf(err) ?? '')) throw err
        stuck.push(child)
      }
    }
  }

  if (stuck.length === 0) {
    try {
      await fs.rmdir(p)
    } catch (err) {
      const code = errnoOf(err)
      if (code === 'ENOENT') return []
      if (!UNREMOVABLE.has(code ?? '')) throw err
      return [p]
    }
  }
  return stuck
}

/**
 * Remove a scratch tree, tolerating subtrees this process cannot delete.
 *
 * e2e runs leave root-owned dirs in scratch (seen as a 0700 `libpod/` in
 * some e2e workspaces; the cause is not yet traced), which a plain
 * recursive remove fails on with EACCES.
 *
 * ENOTEMPTY is a race (a terminating pod still writing) and is retried.
 * EACCES/EPERM won't change, so everything else is deleted and the stuck
 * paths are returned. Callers should report them: they need root to clear.
 */
export async function removeScratchTree(dir: string): Promise<string[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return []
    } catch (err) {
      if (UNREMOVABLE.has(errnoOf(err) ?? '')) return salvageRemove(dir)
      if (attempt >= 9) throw err
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

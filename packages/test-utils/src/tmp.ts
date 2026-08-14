import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ambientDataDir } from '@yaac/shared/paths'

let hermeticScratch = false

/**
 * Declare that this run never mounts its scratch into a pod, so the base
 * below can be the OS tmpdir. Called by unit-setup, which the `unit:*`
 * projects load and nothing else — "unit tests must not touch podman or the
 * cluster" (AGENTS.md) is exactly the property that makes node visibility
 * irrelevant to them.
 *
 * Takes a boolean rather than being one-way so this module's own tests can
 * drive both branches; the only production caller passes `true`.
 */
export function setHermeticScratch(on: boolean): void {
  hermeticScratch = on
}

/**
 * Base directory for test scratch dirs (test data dirs, mock-git repo
 * stores, CLI scratch).
 *
 * Two audiences, split by the question the storage tiers in
 * packages/shared/src/paths.ts already ask — who has to see these bytes?
 *
 *  - Hermetic runs (the `unit:*` projects, via {@link setHermeticScratch})
 *    never create a pod, so nothing outside the test process has to see
 *    this. The OS tmpdir is both correct and better: local, fast, reaped by
 *    the OS. Unit assertions are timestamp-sensitive too, so they must NOT
 *    land on a virtiofs/network data dir — the same reason unit-setup
 *    strips YAAC_DATA_DIR.
 *
 *  - Everything else (api, e2e) hostPath-mounts paths under its data dir
 *    into pods, so the base must resolve to the SAME absolute path on the
 *    host and on the pod's node. `os.tmpdir()` carries no such guarantee:
 *    on a kind host `/tmp` is the node container's own tmpfs, and a pod
 *    mounting a host `/tmp/...` path hangs Pending. The data dir does carry
 *    it — it is the SHARED tier by definition, and `yaac cluster check`'s
 *    end-to-end probe mounts it into a pod on every setup precisely to
 *    prove the node can see it. Hanging scratch off it means any cluster
 *    that passes `cluster check` runs e2e with no TMPDIR and no
 *    kind-specific setup.
 *
 * {@link ambientDataDir} rather than `getDataDir()` because this is called
 * BEFORE any data dir exists — each test's data dir is created *under* this
 * base, so the override would be circular.
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
    // Cannot even list it: the whole subtree stays.
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
 * e2e runs leave root-owned directories under their scratch dirs — observed
 * as `libpod/` (mode 0700, uid 0, holding podman's `tmp/pause.pid`) in the
 * worktree of assorted e2e worktrees. Scratch is hostPath-mounted into pods,
 * so anything a pod writes as uid 0 lands on the host owned by root, and
 * emptying such a directory needs write+execute INSIDE it — which the test
 * user does not have. A plain recursive remove dies on EACCES.
 *
 * (What creates them is not established. It is NOT ordinary worktree
 * behavior: a developer's real data dir here holds hundreds of worktrees
 * and none of them has a `libpod/`. So treat this as a property of the e2e
 * harness, not a documented product behavior, until someone traces it.)
 *
 * Retrying cannot help, which is the distinction this draws: ENOTEMPTY IS a
 * race worth retrying (a terminating pod, or the detached teardown script,
 * still writing under a tree we just emptied), while EACCES/EPERM is a
 * standing fact about ownership. So it retries the former, and for the
 * latter deletes everything it can and RETURNS what it could not, rather
 * than failing a test over litter it has no authority to remove.
 *
 * Callers should surface a non-empty result: the leftovers need root to
 * clear, and a growing pile of them is the signal to go find the cause.
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

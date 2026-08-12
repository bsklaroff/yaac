/**
 * Deferred cluster attach for a NESTED server
 * (docs/vcluster-scale-to-zero.md). An inner yaac's `server start` runs
 * from the worktree's initCommands, and its boot-time cluster work
 * (namespace/registry ensure, informer caches, the reconciler) is
 * exactly what wakes a born-at-zero vcluster seconds after it was put
 * to sleep. A nested server that has no worktrees yet therefore ARMS its
 * cluster boot instead of running it, and the first thing that actually
 * needs the cluster fires it:
 *
 *   - explicitly, awaited, from worktree create (which needs the
 *     namespace to exist before it applies anything), and
 *   - as a backstop, fire-and-forget, from the kubectl runners — any
 *     cluster access at all means the vcluster is awake (or waking), so
 *     the caches and reconciler should be running.
 *
 * Single-fire: the armed closure runs at most once; later triggers (and
 * the closure's own kubectl calls) return the same in-flight promise.
 * The outer server never arms this — every helper is a cheap no-op when
 * nothing is armed.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getProjectsDir } from '@yaac/shared/project-paths'

let pending: (() => Promise<void>) | null = null
let inflight: Promise<void> | null = null
let settled = false

/** Arm the deferred boot (nested server start, before any cluster work). */
export function armDeferredClusterBoot(fn: () => Promise<void>): void {
  pending = fn
}

/**
 * Run the armed boot (once) and return its completion; resolved
 * immediately when nothing is armed. Boot errors are logged and
 * swallowed — callers proceed exactly as they would have on an eager
 * boot whose best-effort bootstrap failed.
 */
export function awaitDeferredClusterBoot(): Promise<void> {
  if (!inflight && pending) {
    const fn = pending
    pending = null
    inflight = fn().catch((err) => {
      console.warn(`[server] deferred cluster boot failed: ${String(err)}`)
    }).finally(() => {
      settled = true
    })
  }
  return inflight ?? Promise.resolve()
}

/**
 * True while an armed boot has not finished — armed and unfired, or
 * fired and still in flight. In that window the server has zero worktree
 * pods by construction (worktree create awaits the boot), so cluster
 * reads may answer empty instead of blocking on a still-waking
 * vcluster. Always false on the outer server (never armed).
 */
export function isDeferredClusterBootPending(): boolean {
  return pending !== null || (inflight !== null && !settled)
}

/** Fire-and-forget trigger — the kubectl choke-point backstop. */
export function triggerDeferredClusterBoot(): void {
  void awaitDeferredClusterBoot()
}

/** Reset the latch (tests only). */
export function _resetDeferredClusterBootForTests(): void {
  pending = null
  inflight = null
  settled = false
}

/**
 * True when any project has a per-worktree dir — the eager-boot signal
 * for a RESTARTING nested server (the dev-loop `pnpm watch` restarts it
 * on every source change): live worktrees need the caches, watchers, and
 * reconciler immediately, and their vcluster... is this vcluster, which
 * is already awake, so deferral would buy nothing anyway.
 */
export async function anyWorktreeDirsExist(
  projectsDir: string = getProjectsDir(),
): Promise<boolean> {
  let slugs: string[]
  try {
    slugs = await fs.readdir(projectsDir)
  } catch {
    return false
  }
  for (const slug of slugs) {
    // `worktrees` is the on-disk directory name, which the rename leaves alone.
    const worktrees = await fs.readdir(path.join(projectsDir, slug, 'sessions'))
      .catch(() => [] as string[])
    if (worktrees.length > 0) return true
  }
  return false
}

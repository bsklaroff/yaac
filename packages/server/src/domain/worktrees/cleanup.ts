import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { worktreeDriver } from '#drivers/driver'
import { inFlightWorktreeIds } from './provisioning'
import {
  applyWorktreeEvent,
  deleteSpareWorktreeRow,
  getWorktreeRow,
  listSpareWorktreeIds,
} from '#db'
import {
  clearWorktreeTerminating,
  evictWorktreeStatus,
  forgetLiveness,
  markWorktreeTerminating,
} from '#runtime/status'
import {
  cachedPackagesDir,
  opencodeDataDir,
  projectsRoots,
  repoDir,
  worktreeStateRoots,
  projectWorktreeStateRoots,
  worktreeDir,
  worktreeMetaDir,
  worktreeSessionStartsPath,
} from '@yaac/shared/project-paths'
import { deleteSessionStartsLog } from './session-starts'
import { shellQuote } from '#lib/shell'
import type { WorktreeDeathCause } from '@yaac/shared/types'
import type { TeardownTarget } from '#drivers/contract'
import { serverLog } from '#log'

/**
 * Absolute host path to `<cachedPackages>/modules/<worktreeId>` — the
 * per-worktree ephemeral-modules root whose subdirs back the
 * `/workspace/<relPath>` symlinks installed at worktree start. See
 * `installEphemeralModuleLinks` in `packages/server/src/worktree-create.ts`.
 */
export function worktreeModulesDir(projectSlug: string, worktreeId: string): string {
  return path.join(cachedPackagesDir(projectSlug), 'modules', worktreeId)
}

/**
 * Remove everything on disk that belongs to one worktree, in one call.
 *
 * The counterpart to a create: the checkout, git's admin dir for it, the
 * in-pod hook's session-starts log, and the
 * per-worktree opencode database. Every one of them is keyed by the worktree
 * id, which is what makes this a single function rather than a list each
 * caller has to remember — and `opencode-data` is here because until now
 * nothing removed it at all.
 *
 * NOT called by an ordinary stop. A stopped worktree is a checkout still on
 * disk, diff and all, waiting to be restarted; this is for the cases where the
 * worktree itself goes away — an unclaimed spare being reaped, and the two
 * failures that leave a checkout no row will ever name again: a fresh create
 * that gave up, and a claim that failed after mutating its spare. (A failed
 * *resume* is not one of those: its row is put back as the restart found it,
 * and its checkout is the work the user came back for.)
 *
 * The admin dir needs its `locked` file cleared first: worktree setup writes it
 * precisely so `git worktree prune` can never reap a live worktree from
 * outside its own pod (see buildWorktreeLinkExec), and it would otherwise
 * outlive the checkout it protects.
 *
 * Transcripts are deliberately left. The tool homes are shared across a
 * project, so a worktree resumed into a second worktree would lose its history
 * to the first one's deletion.
 *
 * Every path is still best-effort — a worktree that half-goes-away beats a
 * reap that aborts and leaves the rest for nobody — but the verdict is
 * REPORTED rather than swallowed. Callers delete the worktree's row next, and
 * the row is the last name anything has for these bytes: erasing it after a
 * failed rm is what turns a retryable leftover into a permanent one. `false`
 * therefore means "keep the row", and the caller that keeps it hands the
 * worktree to the stale reaper, which surfaces it as an ordinary stopped
 * worktree the user can see and delete.
 */
export async function deleteWorktreeState(
  projectSlug: string,
  worktreeId: string,
): Promise<boolean> {
  // Structural, not incidental: every id reaching here today is a
  // server-minted UUID or one read back off a row or a pod label, but an
  // empty one would resolve `worktreeDir` to the worktrees ROOT and take
  // every worktree of the project with it.
  if (!worktreeId) {
    serverLog(`[server] delete worktree state ${projectSlug}: refused an empty worktree id`)
    return false
  }
  const adminDir = path.join(repoDir(projectSlug), '.git', 'worktrees', worktreeId)
  const outcomes = await Promise.all([
    fs.rm(worktreeDir(projectSlug, worktreeId), { recursive: true, force: true }),
    fs.rm(path.join(adminDir, 'locked'), { force: true })
      .then(() => fs.rm(adminDir, { recursive: true, force: true })),
    fs.rm(opencodeDataDir(projectSlug, worktreeId), { recursive: true, force: true }),
    deleteSessionStartsLog(projectSlug, worktreeId),
  ].map((p) => p.then(() => true, (err: unknown) => {
    serverLog(`[server] delete worktree state ${projectSlug}/${worktreeId}: ${String(err)}`)
    return false
  })))
  return outcomes.every(Boolean)
}

/**
 * What a teardown addresses, from the identity a caller already holds.
 *
 * Assembling the struct is not deriving a name: every `jobName` reaching
 * these functions came out of the runtime in the first place (a
 * `findForTeardown`, a `RuntimeHandle`, the prewarm plan), so this only
 * re-packages what the runtime already said.
 */
function teardownTarget(params: {
  jobName: string
  projectSlug: string
  worktreeId: string
}): TeardownTarget {
  return {
    projectSlug: params.projectSlug,
    workspaceId: params.worktreeId,
    unitName: params.jobName,
  }
}

/**
 * Tear a running worktree's runtime down. Resolves `true` when the runtime
 * is really gone, `false` when it could not be confirmed — a unit still
 * shutting down may still be writing to /workspace, so callers that go on
 * to remove the checkout must gate on that.
 *
 * What stays here is bookkeeping about the WORKSPACE — the terminating
 * mark, the stop record, the evictions, and the directories a worktree owns
 * on disk. How the runtime itself comes down, and in what order, is
 * `destroy`'s (docs/layered-server.md).
 */
export async function cleanupWorktree(params: {
  jobName: string
  projectSlug: string
  worktreeId: string
  /** Why the worktree died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-worktree view can say so. */
  cause?: WorktreeDeathCause
}): Promise<boolean> {
  const { projectSlug, worktreeId, cause } = params

  // Mark terminating BEFORE evicting the status below: in the gap before
  // the runtime reports the workspace as going away, this is what keeps the
  // display path rendering "terminating…" instead of a stray waiting spell.
  markWorktreeTerminating(worktreeId)

  // Report the stop (and death cause, when a reaper supplied one) so the
  // deleted-worktree view can order by recency and say why the worktree went
  // away (best-effort; falls back to transcript mtime if unrecorded).
  await applyWorktreeEvent({
    type: 'worktree-stopped', projectSlug, worktreeId, cause,
  })

  // Drop any cached tmux-alive entry and the watcher-fed status-store row
  // so a subsequent caller doesn't see a stale value from this worktree (or,
  // in the worst case, a value belonging to a brand-new worktree with the
  // same id).
  forgetLiveness(projectSlug, worktreeId)
  evictWorktreeStatus(projectSlug, worktreeId)

  const runtimeGone = await worktreeDriver().destroy(teardownTarget(params))

  // Every removal below is gated on the verdict, for the same reason the
  // CHECKOUT removal callers chain off it is: these are mount sources — the
  // ephemeral-modules dir backing `/workspace/node_modules`, and the
  // per-worktree dirs holding the staged skills and worktree bin. A
  // workspace the runtime could not confirm gone may still be running on
  // them.
  //
  // `false` covers two cases and the worse one is not the obvious one. A
  // delete that timed out leaves a workspace in its grace period, and
  // removing its mounts is a narrowed race. A delete that never landed at
  // all — the runtime unreachable through every attempt — leaves it fully
  // alive and indefinitely so, and on the prewarm-reap path that spare is
  // still claimable: its row survives (gated on this same verdict) and its
  // agent is still up, so the next claim would hand a user a workspace
  // whose state dirs were rm'd out from under it.
  //
  // Keeping them costs nothing. The runtime's own sweep resumes the
  // teardown against the unit this left behind, and its detached script
  // removes exactly these dirs; the server-start orphan sweep collects them
  // too. Both are idempotent, so the only price is that they go later.
  if (runtimeGone) {
    // No-op when ephemeral modules were disabled for this worktree (the
    // dir won't exist).
    await fs.rm(worktreeModulesDir(projectSlug, worktreeId), {
      recursive: true,
      force: true,
    })
    for (const dir of worktreeStateRoots(projectSlug, worktreeId)) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  console.log(`Session ${worktreeId} cleaned up.`)
  return runtimeGone
}

/**
 * Stop routing for the worktree (in-process, fast), then spawn a detached
 * background process to do the slow runtime teardown so the calling process
 * can return immediately.
 */
export async function cleanupWorktreeDetached(params: {
  jobName: string
  projectSlug: string
  worktreeId: string
  /** Why the worktree died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-worktree view can say so. */
  cause?: WorktreeDeathCause
  /** Skip the deletion write, leaving whatever cause is already
   *  recorded intact. Set when the caller is *resuming* a teardown yaac
   *  already recorded — e.g. the stale reaper re-issuing the delete for a
   *  worktree whose in-memory terminating mark was lost to a server restart
   *  or the TTL. Re-recording there would overwrite the true cause (a plain
   *  user delete, or an earlier reaped death) with a spurious out-of-band
   *  reason. */
  preserveDeletedRecord?: boolean
}): Promise<void> {
  const { jobName, projectSlug, worktreeId, cause, preserveDeletedRecord } = params

  // Audit every teardown: the actual work below runs as a detached,
  // stdio-ignored child, so without this line a worktree reaped by the
  // reconciler vanishes with no trace in the server log.
  serverLog(
    `[server] session teardown: session=${worktreeId} job=${jobName} project=${projectSlug}`
    + (cause ? ` cause=${cause.reason}${cause.detail ? ` (${cause.detail})` : ''}` : ''),
  )

  // Mark terminating BEFORE evicting the status below (see cleanupWorktree).
  markWorktreeTerminating(worktreeId)

  // Report the stop (and death cause, when a reaper supplied one) so the
  // deleted-worktree view can order by recency and say why the worktree went
  // away (best-effort; falls back to transcript mtime if unrecorded). Skipped
  // when resuming a teardown yaac already recorded, so the existing cause
  // survives (see `preserveDeletedRecord`).
  if (!preserveDeletedRecord) {
    await applyWorktreeEvent({
      type: 'worktree-stopped', projectSlug, worktreeId, cause,
    })
  }

  forgetLiveness(projectSlug, worktreeId)
  evictWorktreeStatus(projectSlug, worktreeId)

  const runtime = worktreeDriver()
  const target = teardownTarget(params)

  // The half of a teardown that must happen in-process: host port forwards
  // and the egress registration are this server's own state as much as the
  // runtime's, and a detached shell could do neither.
  await runtime.deregisterWorkspace(worktreeId)

  const modulesDir = worktreeModulesDir(projectSlug, worktreeId)
  const ephemeralModulesRm = `rm -rf ${shellQuote(modulesDir)} 2>/dev/null || true`

  const worktreeDirRms = worktreeStateRoots(projectSlug, worktreeId).map(
    (dir) => `rm -rf ${shellQuote(dir)} 2>/dev/null || true`,
  )

  // The runtime's own teardown, then the dirs the worktree owns — which is
  // this layer's half, and the reason the script is composed here rather
  // than handed over whole. Every line on both sides tolerates having
  // already run, so a resumed teardown re-issues the lot.
  const script = [
    runtime.detachedTeardownCommand(target),
    ephemeralModulesRm,
    ...worktreeDirRms,
  ].join('; ')

  const spawnDetachedTeardown = (): void => {
    const child = spawn('sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  }

  // Salvage first: it reaches INTO the workspace, which the script above
  // destroys. Server-orchestrated rather than part of that script, and
  // bounded by its own timeouts so a wedged salvage can't strand the
  // teardown. If the server dies in this window the runtime survives and
  // the stale reaper resumes the (idempotent) teardown — the same recovery
  // as a lost detached script. Failures never block.
  void runtime.salvageImages(target)
    .catch(() => undefined)
    .then(() => { spawnDetachedTeardown() })
}

/**
 * How far before the sweep's own start a write still counts as "in use".
 * The data dir can sit on a mount with second-granularity timestamps (the
 * node-shared mount a nested worktree gets), so an mtime is a lower bound on
 * when the write happened, not the moment. The slack costs a genuine orphan
 * one extra sweep to collect; too little would cost a live worktree its dirs.
 */
const RECENT_WRITE_SLACK_MS = 10_000

/**
 * Is this worktree dir off-limits to the orphan sweep? Either the server is
 * still provisioning that worktree — its Job may not be applied yet, so no
 * cluster listing can vouch for it, and only the provisioning registry
 * knows — or the directory has been written since the sweep took its
 * listing, which is what a create staging into it looks like. Both mean
 * "in use", and the sweep only ever wants genuine leftovers.
 * Unreadable stat is treated as in-use: refusing to delete costs a stale dir
 * the next sweep collects, deleting wrongly costs a live worktree.
 */
async function inUseBySweep(dir: string, sid: string, sweepStartedAtMs: number): Promise<boolean> {
  if (inFlightWorktreeIds().includes(sid)) return true
  try {
    const st = await fs.stat(dir)
    return st.mtimeMs >= sweepStartedAtMs - RECENT_WRITE_SLACK_MS
  } catch {
    return true
  }
}

/**
 * Server-startup sweep: remove `.cached-packages/modules/<sid>`
 * directories whose worktree is no longer alive. Catches leftovers from
 * crashes, killed servers, and host reboots.
 */
let orphanModulesSwept = false

/** Test helper: let the once-per-server-life sweep run again. */
export function _resetOrphanModulesSweepForTests(): void {
  orphanModulesSwept = false
}

/** Suffix of the in-pod hook's log, as `worktreeSessionStartsPath` names it. */
const SESSION_STARTS_SUFFIX = '.session-starts.jsonl'

/**
 * Collect the worktree state of prewarmed spares whose pod is gone, and the
 * session-starts logs of worktrees that no longer exist.
 *
 * The reap path removes a spare's state with its pod, but only while it is
 * running: its plan is derived from live pods, so a spare whose pod died out
 * from under it — a crash, a reboot, the server down in that window — leaves
 * a checkout and a git admin dir that no other sweep can even see. Every
 * other sweep works from worktrees, and a spare is not one.
 *
 * The `spare` flag is what makes this answerable after the fact: the pod that
 * carried the label is gone, so the row is the only surviving record that
 * this checkout was never a worktree. A real worktree is never touched here —
 * a stopped one is a checkout the user is expected to restart into.
 */
async function gcOrphanSpares(
  slug: string,
  liveWorktreeIds: Set<string>,
  sweepStartedAtMs: number,
): Promise<void> {
  const spares = await listSpareWorktreeIds(slug).catch(() => undefined)
  // A failed read must not reap: every id would look like "not a spare" to
  // the log sweep below and like nothing at all to the spare sweep, and
  // guessing here deletes checkouts.
  if (spares === undefined) return
  for (const sid of spares) {
    if (liveWorktreeIds.has(sid)) continue
    if (await inUseBySweep(worktreeDir(slug, sid), sid, sweepStartedAtMs)) continue
    // The row goes only once the bytes actually did: it is the flag on this
    // row that lets the sweep recognize the checkout at all, so dropping it
    // after a failed rm would strand whatever is left for good. Keeping it
    // costs nothing — the next sweep retries.
    if (!await deleteWorktreeState(slug, sid)) continue
    await deleteSpareWorktreeRow(slug, sid).catch(() => { /* next sweep */ })
    console.log(`Removed orphan prewarmed spare ${slug}/${sid}`)
  }

  // A log whose worktree has no row is a delete that got half way: the row
  // and the log go together, so a survivor answers to nothing and nothing
  // else will ever name it again.
  let entries: string[] = []
  try {
    entries = await fs.readdir(worktreeMetaDir(slug))
  } catch {
    return // no meta dir → nothing to sweep
  }
  for (const name of entries) {
    if (!name.endsWith(SESSION_STARTS_SUFFIX)) continue
    const sid = name.slice(0, -SESSION_STARTS_SUFFIX.length)
    if (liveWorktreeIds.has(sid)) continue
    if (await getWorktreeRow(slug, sid) !== undefined) continue
    const log = worktreeSessionStartsPath(slug, sid)
    if (await inUseBySweep(log, sid, sweepStartedAtMs)) continue
    await fs.rm(log, { force: true }).catch(() => { /* next sweep */ })
  }
}

export async function gcOrphanEphemeralModuleDirs(): Promise<void> {
  // Once per server life: this collects what a previous process left
  // behind, so a second pass has nothing new to find.
  if (orphanModulesSwept) return
  orphanModulesSwept = true

  // Everything this sweep deletes belongs to a worktree that no longer
  // exists — and "no longer exists" is read from a cluster listing taken
  // here, seconds before the removals below. A create that stages its dirs
  // inside that gap looks exactly like an orphan: its Job is not applied
  // yet, so it is in no listing, and the sweep deletes the worktree dir and
  // ephemeral-modules dir out from under the pod that is about to mount
  // them. The pod then sits in ContainerCreating on FailedMount until the
  // create gives up. This runs fire-and-forget at server startup, and a
  // `worktree create` right after `server start` is the normal way to hit
  // it. Two guards below: a worktree the process is provisioning is never
  // swept, and neither is a directory touched since this listing was taken.
  const sweepStartedAtMs = Date.now()
  let liveWorktreeIds: Set<string>
  try {
    // Workspaces UNION the units holding no workspace: a unit mid-recreate
    // (workspace evicted, replacement not scheduled yet) appears only as a
    // stray, and must not have its dirs swept. Both reads reject rather
    // than resolving empty, so "I could not see" never reads as "nothing is
    // there" — which is what the catch below is for.
    const view = worktreeDriver().snapshot()
    const [workspaces, strays] = await Promise.all([view.workspaces(), view.strayUnits()])
    liveWorktreeIds = new Set(
      [...workspaces.map((w) => w.workspaceId), ...strays.map((s) => s.workspaceId)]
        .filter((id) => !!id),
    )
  } catch (err) {
    console.warn(`Orphan modules GC: failed to list live sessions: ${(err as Error).message}`)
    return
  }

  // Slugs from BOTH roots: a project whose shared half is already gone can
  // still have a node-local tree (pnpm store, opencode data) to sweep, and
  // enumerating only the shared root would never generate its slug.
  const slugLists = await Promise.all(
    projectsRoots().map((root) => fs.readdir(root).catch((): string[] => [])),
  )
  const projectSlugs = [...new Set(slugLists.flat())]
  if (!projectSlugs.length) return

  for (const slug of projectSlugs) {
    const modulesRoot = path.join(cachedPackagesDir(slug), 'modules')
    let entries: string[] = []
    try {
      entries = await fs.readdir(modulesRoot)
    } catch { /* missing modules dir → nothing to sweep there */ }
    for (const sid of entries) {
      if (liveWorktreeIds.has(sid)) continue
      const dir = path.join(modulesRoot, sid)
      if (await inUseBySweep(dir, sid, sweepStartedAtMs)) continue
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan ephemeral modules dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan modules GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }

    await gcOrphanSpares(slug, liveWorktreeIds, sweepStartedAtMs)

    // Per-session dirs live under `<slug>/sessions/<sid>` on both roots —
    // shared (the staged skills) and node-local;
    // `projectWorktreeStateRoots` owns that pairing and collapses to one
    // entry today. The `worktrees/` dir is unique to
    // this feature, so a flat readdir gives the worktree id list directly.
    for (const worktreesRoot of projectWorktreeStateRoots(slug)) {
      let worktreeEntries: string[] = []
      try {
        worktreeEntries = await fs.readdir(worktreesRoot)
      } catch { /* missing sessions dir → nothing to sweep there */ }
      for (const sid of worktreeEntries) {
        if (liveWorktreeIds.has(sid)) continue
        const dir = path.join(worktreesRoot, sid)
        if (await inUseBySweep(dir, sid, sweepStartedAtMs)) continue
        try {
          await fs.rm(dir, { recursive: true, force: true })
          console.log(`Removed orphan session dir ${dir}`)
        } catch (err) {
          console.warn(`Orphan session GC: failed to remove ${dir}: ${(err as Error).message}`)
        }
      }
    }
  }
}

/**
 * Tear a workspace's runtime down and make its id reusable — the whole of
 * what a restart needs before bringing the same workspace back up.
 *
 * Awaited rather than detached: a restart re-creates against this very id, so
 * the old runtime has to be gone before the new one is launched. `jobName:
 * null` means nothing was running (a stopped workspace being restarted), and
 * only the marks are cleared — which still has to happen, because a
 * terminating mark left by an earlier teardown would render the fresh
 * worktree as "stopping…".
 *
 * The one caller of `cleanupWorktree` that DISCARDS the verdict, deliberately.
 * The two things a `false` endangers elsewhere are both absent here: a restart
 * never removes the checkout (that is the work the user is coming back to),
 * and the dirs are now kept on `false` anyway. What is left is a launch
 * against a workspace that may not have finished going away, and the launch
 * already owns that case — its retry loop re-deletes the half-started unit
 * with a foreground cascade before each attempt. Failing the restart here
 * instead would turn a slow teardown into a user-visible error for something
 * the next attempt resolves on its own; the cost of absorbing it is one
 * burned attempt.
 */
export async function teardownForRestart(params: {
  jobName: string | null
  projectSlug: string
  workspaceId: string
}): Promise<void> {
  const { jobName, projectSlug, workspaceId } = params
  if (jobName) {
    await cleanupWorktree({ jobName, projectSlug, worktreeId: workspaceId })
  }
  clearWorktreeTerminating(workspaceId)
}

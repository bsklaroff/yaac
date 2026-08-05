import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  k8sNamespace,
  kubectlWithRetry,
  listSessionJobs,
  listSessionPods,
} from '#platform/k8s'
import { recordWorktreeStopped } from './worktree-store'
import { listProvisioning } from './provisioning'
import { evictSessionStatus, forgetLiveness, markSessionTerminating } from '#features/status'
import { proxyClient } from '#features/egress'
import { salvageSessionImages } from '#features/images'
import {
  buildVclusterCleanupShellCommand,
  getVclusterStatus,
  removeSessionVcluster,
  vclusterName,
} from '#features/cluster'
import {
  cachedPackagesDir,
  projectsRoots,
  sessionRoots,
  sessionsRoots,
} from '@yaac/shared/project-paths'
import { shellQuote } from '#platform/shell'
import type { SessionDeathCause } from '@yaac/shared/types'
import { stopSessionForwarders } from '#features/forwarders'
import { serverLog } from '#log'

/**
 * Absolute host path to `<cachedPackages>/modules/<sessionId>` — the
 * per-session ephemeral-modules root whose subdirs back the
 * `/workspace/<relPath>` symlinks installed at session start. See
 * `installEphemeralModuleLinks` in `packages/server/src/session-create.ts`.
 */
export function sessionModulesDir(projectSlug: string, sessionId: string): string {
  return path.join(cachedPackagesDir(projectSlug), 'modules', sessionId)
}

/**
 * Best-effort removal of the session's state from the proxy sidecar. If
 * the sidecar isn't running there's nothing to clean up. Errors are
 * swallowed so cleanup never blocks container teardown on a sidecar hiccup.
 */
async function removeSessionFromProxy(sessionId: string): Promise<void> {
  try {
    const attached = await proxyClient.attachIfRunning()
    if (!attached) return
    await proxyClient.removeSession(sessionId)
  } catch (err) {
    console.warn(
      `Failed to remove session ${sessionId} from proxy: ${(err as Error).message}`,
    )
  }
}

export async function cleanupSession(params: {
  jobName: string
  projectSlug: string
  sessionId: string
  /** Why the session died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-session view can say so. */
  cause?: SessionDeathCause
}): Promise<void> {
  const { jobName, projectSlug, sessionId, cause } = params

  // Mark terminating BEFORE evicting the status below: in the gap before
  // Kubernetes stamps the pod's deletionTimestamp, this is what keeps the
  // display path rendering "terminating…" instead of a stray waiting spell.
  markSessionTerminating(sessionId)

  // Stamp the deletion time (and death cause, when a reaper supplied one)
  // so the deleted-session view can order by recency and say why the
  // session went away (best-effort; falls back to transcript mtime if
  // unwritten).
  await recordWorktreeStopped(projectSlug, sessionId, cause)

  // Drop any cached tmux-alive entry and the watcher-fed status-store row
  // so a subsequent caller doesn't see a stale value from this session (or,
  // in the worst case, a value belonging to a brand-new session with the
  // same id).
  forgetLiveness(projectSlug, sessionId)
  evictSessionStatus(projectSlug, sessionId)

  stopSessionForwarders(sessionId)
  await removeSessionFromProxy(sessionId)

  // Salvage built image layers into the project's registry before the
  // pod (and its graphroot tmpfs) is destroyed. Best-effort, and the
  // in-pod survey self-gates on podman, so non-nested sessions (and
  // already-dead pods) no-op.
  await salvageSessionImages({ jobName, projectSlug, sessionId })

  // Delete the session Job; the pod's terminationGracePeriodSeconds (5s)
  // covers the graceful-stop window, so no separate stop step is needed.
  // --wait so the modules/session dirs below aren't yanked out from under
  // a still-terminating pod.
  try {
    await kubectlWithRetry([
      'delete', 'job', jobName, '-n', k8sNamespace(),
      '--ignore-not-found', '--wait=true', '--timeout=30s',
    ])
  } catch {
    // Job may already be gone, or deletion timed out — best-effort; the
    // background reconcile loop sweeps any leftover Job.
  }

  // Tear down the session's vcluster, if it had one. One cheap probe
  // gates the label-selector deletes so non-vcluster sessions pay a
  // single kubectl get. Best-effort: the background vcluster reconcile
  // sweeps anything this misses.
  try {
    if (await getVclusterStatus(sessionId)) {
      await removeSessionVcluster(vclusterName(sessionId))
    }
  } catch (err) {
    console.warn(`vcluster cleanup for ${sessionId} failed: ${(err as Error).message}`)
  }

  // Remove the per-session ephemeral-modules backing dir from
  // `.cached-packages/modules/<sid>`. No-op if the feature was disabled
  // for this session (dir won't exist).
  await fs.rm(sessionModulesDir(projectSlug, sessionId), {
    recursive: true,
    force: true,
  })

  // Remove the per-session dirs (vcluster kubeconfig, nested-yaac data,
  // staged skills / session bin). The pod is gone; the mount sources are
  // garbage now.
  for (const dir of sessionRoots(projectSlug, sessionId)) {
    await fs.rm(dir, { recursive: true, force: true })
  }

  console.log(`Session ${sessionId} cleaned up.`)
}

/**
 * Remove the session's state from the proxy sidecar (in-process, fast),
 * then spawn a detached background process to do the slow Job teardown
 * so the calling process can exit immediately.
 */
export async function cleanupSessionDetached(params: {
  jobName: string
  projectSlug: string
  sessionId: string
  /** Why the session died, when a reaper (not the user) is tearing it
   *  down — persisted so the deleted-session view can say so. */
  cause?: SessionDeathCause
  /** Skip the deletion write, leaving whatever cause is already
   *  recorded intact. Set when the caller is *resuming* a teardown yaac
   *  already recorded — e.g. the stale reaper re-issuing the delete for a
   *  session whose in-memory terminating mark was lost to a server restart
   *  or the TTL. Re-recording there would overwrite the true cause (a plain
   *  user delete, or an earlier reaped death) with a spurious out-of-band
   *  reason. */
  preserveDeletedRecord?: boolean
}): Promise<void> {
  const { jobName, projectSlug, sessionId, cause, preserveDeletedRecord } = params

  // Audit every teardown: the actual work below runs as a detached,
  // stdio-ignored child, so without this line a session reaped by the
  // reconciler vanishes with no trace in the server log.
  serverLog(
    `[server] session teardown: session=${sessionId} job=${jobName} project=${projectSlug}`
    + (cause ? ` cause=${cause.reason}${cause.detail ? ` (${cause.detail})` : ''}` : ''),
  )

  // Mark terminating BEFORE evicting the status below (see cleanupSession).
  markSessionTerminating(sessionId)

  // Stamp the deletion time (and death cause, when a reaper supplied one)
  // so the deleted-session view can order by recency and say why the
  // session went away (best-effort; falls back to transcript mtime if
  // unwritten). Skipped when resuming a teardown yaac already recorded, so
  // the existing cause survives (see `preserveDeletedRecord`).
  if (!preserveDeletedRecord) {
    await recordWorktreeStopped(projectSlug, sessionId, cause)
  }

  forgetLiveness(projectSlug, sessionId)
  evictSessionStatus(projectSlug, sessionId)

  stopSessionForwarders(sessionId)
  await removeSessionFromProxy(sessionId)

  const modulesDir = sessionModulesDir(projectSlug, sessionId)
  const ephemeralModulesRm = `rm -rf ${shellQuote(modulesDir)} 2>/dev/null || true`

  const sessionDirRms = sessionRoots(projectSlug, sessionId).map(
    (dir) => `rm -rf ${shellQuote(dir)} 2>/dev/null || true`,
  )

  const script = [
    `kubectl delete job ${jobName} -n ${k8sNamespace()} --ignore-not-found 2>/dev/null || true`,
    // vcluster teardown: pure label-selector deletes, so non-vcluster
    // sessions no-op (every line carries --ignore-not-found + `|| true`).
    buildVclusterCleanupShellCommand(vclusterName(sessionId)),
    ephemeralModulesRm,
    ...sessionDirRms,
  ].join('; ')

  const spawnDetachedTeardown = (): void => {
    const child = spawn('sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  }

  // Salvage first: it execs into the pod, which the Job delete destroys.
  // Server-orchestrated (survey exec → node-side writer load — see
  // salvageSessionImages) rather than part of the detached script, and
  // bounded by its own timeouts so a wedged salvage can't strand the
  // teardown. If the server dies in this window, the Job survives and the
  // stale reaper resumes the (idempotent) teardown — the same recovery as
  // a lost detached script. Failures are logged inside and never block.
  void salvageSessionImages({ jobName, projectSlug, sessionId })
    .catch(() => false)
    .then(() => { spawnDetachedTeardown() })
}

/**
 * How far before the sweep's own start a write still counts as "in use".
 * The data dir can sit on a mount with second-granularity timestamps (the
 * node-shared mount a nested session gets), so an mtime is a lower bound on
 * when the write happened, not the moment. The slack costs a genuine orphan
 * one extra sweep to collect; too little would cost a live session its dirs.
 */
const RECENT_WRITE_SLACK_MS = 10_000

/**
 * Is this session dir off-limits to the orphan sweep? Either the process is
 * still provisioning that session — its Job may not be applied yet, so no
 * cluster listing can vouch for it — or the directory has been written since
 * the sweep took its listing, which is what a create staging into it looks
 * like. Both mean "in use", and the sweep only ever wants genuine leftovers.
 * Unreadable stat is treated as in-use: refusing to delete costs a stale dir
 * the next sweep collects, deleting wrongly costs a live session.
 */
async function inUseBySweep(dir: string, sid: string, sweepStartedAtMs: number): Promise<boolean> {
  if (listProvisioning().some((p) => p.worktreeId === sid)) return true
  try {
    const st = await fs.stat(dir)
    return st.mtimeMs >= sweepStartedAtMs - RECENT_WRITE_SLACK_MS
  } catch {
    return true
  }
}

/**
 * Server-startup sweep: remove `.cached-packages/modules/<sid>`
 * directories whose session is no longer alive. Catches leftovers from
 * crashes, killed servers, and host reboots.
 */
export async function gcOrphanEphemeralModuleDirs(): Promise<void> {
  // Everything this sweep deletes belongs to a session that no longer
  // exists — and "no longer exists" is read from a cluster listing taken
  // here, seconds before the removals below. A create that stages its dirs
  // inside that gap looks exactly like an orphan: its Job is not applied
  // yet, so it is in no listing, and the sweep deletes the session dir and
  // ephemeral-modules dir out from under the pod that is about to mount
  // them. The pod then sits in ContainerCreating on FailedMount until the
  // create gives up. This runs fire-and-forget at server startup, and a
  // `worktree create` right after `server start` is the normal way to hit
  // it. Two guards below: a session the process is provisioning is never
  // swept, and neither is a directory touched since this listing was taken.
  const sweepStartedAtMs = Date.now()
  let liveSessionIds: Set<string>
  try {
    // Union of pod and Job session ids: a Job mid-recreate (pod evicted,
    // replacement not scheduled yet) only shows up in the Job list, and
    // must not have its dirs swept.
    const [pods, jobs] = await Promise.all([listSessionPods(), listSessionJobs()])
    liveSessionIds = new Set(
      [...pods.map((p) => p.sessionId), ...jobs.map((j) => j.sessionId)]
        .filter((id) => !!id),
    )
  } catch (err) {
    console.warn(`Orphan modules GC: failed to list session pods/jobs: ${(err as Error).message}`)
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
      if (liveSessionIds.has(sid)) continue
      const dir = path.join(modulesRoot, sid)
      if (await inUseBySweep(dir, sid, sweepStartedAtMs)) continue
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan ephemeral modules dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan modules GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }

    // Per-session dirs live under `<slug>/sessions/<sid>` on both roots —
    // shared (vcluster kubeconfig, nested-yaac data, staged skills) and
    // node-local; `sessionsRoots` owns that pairing and collapses to one
    // entry today. The `sessions/` dir is unique to
    // this feature, so a flat readdir gives the session id list directly.
    for (const sessionsRoot of sessionsRoots(slug)) {
      let sessionEntries: string[] = []
      try {
        sessionEntries = await fs.readdir(sessionsRoot)
      } catch { /* missing sessions dir → nothing to sweep there */ }
      for (const sid of sessionEntries) {
        if (liveSessionIds.has(sid)) continue
        const dir = path.join(sessionsRoot, sid)
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

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { workspaceDriver } from '#drivers/driver'
import { resolveEphemeralModulesPaths, resolveProjectConfig } from '#domain/projects'
import { forgetWorkspaceChanges } from './changes'
import { removeAgentHistory } from './history'
import { inFlightWorkspaceIds } from './provisioning'
import { applyWorkspaceEvent, listProjectRows } from '#db'
import {
  clearWorkspaceTerminating,
  evictWorkspaceStatus,
  forgetLiveness,
  markWorkspaceTerminating,
} from '#runtime/status'
import {
  acpLogDir,
  getProjectsDir,
  globalProjectPath,
  opencodeCheckpointDir,
  workspaceDir,
  workspaceStateDir,
} from '@yaac/shared/project-paths'
import { openRoot } from '#lib/confined-fs'
import { shellQuote } from '#lib/shell'
import type { WorkspaceDeathCause } from '@yaac/shared/types'
import type { RuntimeSnapshot, TeardownTarget } from '#drivers/contract'
import { serverLog } from '#lib/log'
import { ServerError } from '@yaac/shared/errors'
import { waitFor } from '@yaac/shared/wait-for'

/**
 * Record the stop. A teardown carries on if the write fails: a lost stop
 * stamp degrades a listing, while a skipped teardown leaks a runtime.
 */
async function recordStop(
  projectId: string,
  workspaceId: string,
  cause: WorkspaceDeathCause | undefined,
): Promise<void> {
  await applyWorkspaceEvent({ type: 'workspace-stopped', projectId, workspaceId, cause })
    .catch((err: unknown) => serverLog(`[server] record stop ${projectId}/${workspaceId}: ${String(err)}`))
}

/**
 * Detached teardown scripts still running, by workspace id. A restart waits
 * on these before relaunching into the same checkout: under containerless
 * the runtime forgets the workspace as soon as the stop returns, while the
 * script is still removing tmux and `node_modules`.
 */
const detachedTeardowns = new Map<string, Promise<void>>()

/** Resolves once no detached teardown is running for the workspace. */
function detachedTeardownSettled(workspaceId: string): Promise<void> {
  return detachedTeardowns.get(workspaceId) ?? Promise.resolve()
}

/** Whether a detached teardown is still running for the workspace. */
export function tearingDown(workspaceId: string): boolean {
  return detachedTeardowns.has(workspaceId)
}

/**
 * The ephemeral-modules paths inside the checkout, to remove at stop. Under
 * containerless they hold the real contents; under a pod they are empty
 * mount points. The restart's init commands rebuild them.
 *
 * Symlinks, and paths reached through a symlink leading out of the
 * checkout, are skipped: the checkout holds agent-written content, and
 * `rm -rf` through a link would delete host files.
 */
async function checkoutEphemeralPaths(
  projectId: string,
  workspaceId: string,
): Promise<Array<{ abs: string; remove: () => Promise<void> }>> {
  const checkout = await openRoot(workspaceDir(projectId, workspaceId), 'inside').catch(() => null)
  if (checkout === null) return []
  const config = await resolveProjectConfig(projectId).catch(() => null)
  const paths: Array<{ abs: string; remove: () => Promise<void> }> = []
  for (const rel of resolveEphemeralModulesPaths(config)) {
    const at = await checkout.parent(rel).catch(() => null)
    if (at === null) continue
    const stat = await fs.lstat(at.dir.child(at.name)).catch(() => null)
    await at.dir.close()
    if (stat === null || stat.isSymbolicLink()) continue
    // `remove` is confined to the checkout. `abs` is for the detached
    // script's `rm -rf`, which runs only after the runtime is gone.
    paths.push({ abs: path.join(checkout.real, rel), remove: () => checkout.removeTree(rel) })
  }
  return paths
}

/**
 * Remove everything on disk that belongs to one workspace: the checkout, the
 * opencode checkpoint, ACP records and agent history. Node-local working
 * copies are the driver's sweep's.
 *
 * Not used by an ordinary stop, which keeps the checkout for restart. Used
 * when the workspace itself goes away: a fresh create or warm that gave up,
 * or a reaped spare (`reapSpare`, which also covers a claim that failed
 * after changing its spare).
 *
 * Callers run this only once the pod is gone, so plain recursive `rm` is
 * safe (it does not follow links, and nothing can swap one in mid-walk).
 *
 * Best-effort per path, but returns `false` if anything failed. Callers then
 * keep whatever records the leftover bytes: a row, which the stale reaper
 * surfaces as a stopped workspace the user can delete, or a spare's unit,
 * which the next reap retries.
 */
export async function deleteWorkspaceState(
  projectId: string,
  workspaceId: string,
): Promise<boolean> {
  // An empty id would resolve to the workspaces root and delete them all.
  if (!workspaceId) {
    serverLog(`[server] delete workspace state ${projectId}: refused an empty workspace id`)
    return false
  }
  const outcomes = await Promise.all([
    fs.rm(workspaceDir(projectId, workspaceId), { recursive: true, force: true }),
    fs.rm(opencodeCheckpointDir(projectId, workspaceId), { recursive: true, force: true }),
    fs.rm(acpLogDir(projectId, workspaceId), { recursive: true, force: true }),
    removeAgentHistory(projectId, workspaceId),
  ].map((p) => p.then(() => true, (err: unknown) => {
    serverLog(`[server] delete workspace state ${projectId}/${workspaceId}: ${String(err)}`)
    return false
  })))
  return outcomes.every(Boolean)
}

/**
 * The workspace bookkeeping both teardowns start with. The terminating mark
 * goes first, so the UI shows "terminating…" until the runtime reports the
 * teardown; cached liveness and status are dropped so nothing stale
 * outlives the stop.
 */
async function beginTeardown(params: {
  jobName: string
  projectId: string
  workspaceId: string
  cause?: WorkspaceDeathCause
}): Promise<TeardownTarget> {
  const { jobName, projectId, workspaceId, cause } = params
  markWorkspaceTerminating(workspaceId)
  await recordStop(projectId, workspaceId, cause)
  forgetLiveness(projectId, workspaceId)
  evictWorkspaceStatus(projectId, workspaceId)
  forgetWorkspaceChanges(jobName)
  return { projectId, workspaceId, unitName: jobName }
}

/**
 * Tear down a running workspace. Resolves `false` if the runtime could not
 * be confirmed gone; a unit still shutting down may write to the checkout,
 * so callers removing it must check.
 *
 * This handles the workspace bookkeeping (terminating mark, stop record,
 * status eviction, per-workspace dirs); `destroy` handles the runtime, and
 * `keepRecord` is its option of that name.
 */
export async function cleanupWorkspace(params: {
  jobName: string
  projectId: string
  workspaceId: string
  keepRecord?: boolean
}): Promise<boolean> {
  const { projectId, workspaceId, keepRecord } = params
  const target = await beginTeardown(params)
  const runtimeGone = await workspaceDriver().destroy(target, keepRecord === true ? { keepRecord } : {})

  // Remove the workspace's mount sources only if the runtime is confirmed
  // gone; otherwise it may still be using them (an unreachable runtime may
  // leave a spare fully alive and claimable). The driver's sweep and the
  // orphan sweep remove them later.
  if (runtimeGone) {
    // Best-effort: a node still unmounting answers EBUSY.
    for (const p of await checkoutEphemeralPaths(projectId, workspaceId)) {
      await p.remove().catch((err: unknown) => {
        serverLog(`[server] remove ${p.abs} at stop: ${String(err)}`)
      })
    }
    await fs.rm(workspaceStateDir(projectId, workspaceId), { recursive: true, force: true })
  }

  console.log(`Session ${workspaceId} cleaned up.`)
  return runtimeGone
}

/**
 * Deregister the workspace in-process, then spawn a detached script for the
 * slow teardown so the caller returns immediately.
 */
export async function cleanupWorkspaceDetached(params: {
  jobName: string
  projectId: string
  workspaceId: string
  /** Why the workspace died, when a reaper is tearing it down. */
  cause?: WorkspaceDeathCause
}): Promise<void> {
  const { jobName, projectId, workspaceId, cause } = params

  // Register before the first await so a restart always waits for it.
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => { settle = resolve })
  detachedTeardowns.set(workspaceId, settled)
  void settled.then(() => {
    if (detachedTeardowns.get(workspaceId) === settled) detachedTeardowns.delete(workspaceId)
  })
  try {
    // The detached script's output is discarded, so log the teardown here.
    // The cause lands on the row only if no stop is recorded yet.
    serverLog(
      `[server] session teardown: session=${workspaceId} job=${jobName} project=${projectId}`
      + (cause
        ? ` reported cause=${cause.reason}${cause.detail ? ` (${cause.detail})` : ''}`
          + ', kept only if no stop is recorded yet'
        : ''),
    )

    const target = await beginTeardown(params)
    const runtime = workspaceDriver()

    // Forwards and egress registration are in-process state a shell script
    // cannot reach.
    await runtime.deregisterWorkspace(workspaceId)

    const ephemeralModulesRms = (await checkoutEphemeralPaths(projectId, workspaceId))
      .map((p) => `rm -rf ${shellQuote(p.abs)} 2>/dev/null || true`)

    const workspaceDirRm =
      `rm -rf ${shellQuote(workspaceStateDir(projectId, workspaceId))} 2>/dev/null || true`

    // The runtime's teardown, then the workspace's own dirs. Every command is
    // idempotent, so a resumed teardown can re-run it all.
    const script = [
      runtime.detachedTeardownCommand(target),
      ...ephemeralModulesRms,
      workspaceDirRm,
    ].join('; ')

    const spawnDetachedTeardown = (): void => {
      const child = spawn('sh', ['-c', script], {
        detached: true,
        stdio: 'ignore',
      })
      child.once('exit', settle)
      child.once('error', settle)
      child.unref()
    }

    // Salvage first, since it reaches into the workspace the script
    // destroys. It has its own timeouts and never blocks the teardown. If
    // the server dies meanwhile, the stale reaper resumes the teardown.
    void runtime.salvageImages(target)
      .catch(() => undefined)
      .then(() => { spawnDetachedTeardown() })
  } catch (err) {
    settle()
    throw err
  }
}

/**
 * How long before the listing a write still counts as "in use". The data
 * dir may be on a filesystem with coarse timestamps, so allow slack; too
 * little could delete a live workspace's dirs.
 */
const RECENT_WRITE_SLACK_MS = 10_000

/**
 * Whether the orphan sweep must skip this workspace dir: the workspace is
 * in flight or settled after the listing was read (so it may be missing
 * from it), or the dir was written since. An unreadable stat counts as in
 * use.
 */
async function inUseBySweep(dir: string, sid: string, listedAtMs: number): Promise<boolean> {
  if (inFlightWorkspaceIds(listedAtMs).includes(sid)) return true
  try {
    const st = await fs.stat(dir)
    return st.mtimeMs >= listedAtMs - RECENT_WRITE_SLACK_MS
  } catch {
    return true
  }
}

/**
 * Ids of every workspace the runtime holds, stray units included: one
 * mid-recreate appears only as a stray. Both reads reject rather than
 * resolve empty on failure, which a sweep would read as "nothing is live".
 */
async function liveWorkspaceIds(view: RuntimeSnapshot): Promise<Set<string>> {
  const [workspaces, strays] = await Promise.all([view.workspaces(), view.strayUnits()])
  return new Set(
    [...workspaces.map((w) => w.workspaceId), ...strays.map((s) => s.workspaceId)]
      .filter((id) => !!id),
  )
}

/**
 * The node-local tier of the orphan sweep, handed to the driver's
 * `reapNodeLocal` since those bytes are on whichever node the workspace ran
 * on. Workspaces in flight count as live.
 */
export async function reapOrphanNodeLocal(view: RuntimeSnapshot): Promise<void> {
  const workspaceIds = await liveWorkspaceIds(view)
  const projectIds = new Set((await listProjectRows()).map((r) => r.id))
  for (const id of inFlightWorkspaceIds(view.takenAtMs)) workspaceIds.add(id)
  await workspaceDriver().reapNodeLocal({ projectIds, workspaceIds })
}

/**
 * Remove the `sessions/<id>` staging dirs that workspaces which no longer
 * exist left behind in the global tier. Runs every resync. A checkout is
 * never removed here: on disk a dead spare's and a stopped workspace's look
 * the same, so spares' are removed by `reapSpare`, from their unit's mark.
 */
export async function gcOrphanEphemeralModuleDirs(view: RuntimeSnapshot): Promise<void> {
  // A create the listing missed looks like an orphan. `inUseBySweep`
  // guards against that.
  const live = await liveWorkspaceIds(view)

  const projectIds = await fs.readdir(getProjectsDir()).catch((): string[] => [])

  for (const projectId of projectIds) {
    // Per-workspace staging dirs (skills, workspace bin), one per id.
    const workspacesRoot = globalProjectPath(projectId, 'sessions')
    let workspaceEntries: string[] = []
    try {
      workspaceEntries = await fs.readdir(workspacesRoot)
    } catch { /* missing sessions dir → nothing to sweep there */ }
    for (const sid of workspaceEntries) {
      if (live.has(sid)) continue
      const dir = path.join(workspacesRoot, sid)
      if (await inUseBySweep(dir, sid, view.takenAtMs)) continue
      try {
        await fs.rm(dir, { recursive: true, force: true })
        console.log(`Removed orphan session dir ${dir}`)
      } catch (err) {
        console.warn(`Orphan session GC: failed to remove ${dir}: ${(err as Error).message}`)
      }
    }
  }
}

/** How long a restart waits for a unit its teardown could not confirm gone:
 *  longer than any grace period a driver gives a unit to stop. */
const RESTART_TEARDOWN_WAIT_MS = 90_000

/**
 * Tear down a workspace's runtime (awaited) so a restart can reuse its id.
 * `jobName: null` means nothing was running; only the terminating mark is
 * cleared, so the new workspace does not show as "stopping…".
 *
 * A unit still going away (a pod's preStop may hold it for its whole grace
 * period) is waited out for up to RESTART_TEARDOWN_WAIT_MS. Past that the
 * restart is refused: a launch against it would fail in a less obvious way.
 * This needs a `findForTeardown` that tracks the live unit, as k8s's does.
 * The containerless driver forgets a workspace when its destroy returns, so
 * there the wait passes at once and a tmux server that outlived the kill is
 * relaunched against.
 */
export async function teardownForRestart(params: {
  jobName: string | null
  projectId: string
  workspaceId: string
}): Promise<void> {
  const { jobName, projectId, workspaceId } = params
  // A detached teardown may still be running even when `jobName` is null.
  await detachedTeardownSettled(workspaceId)
  const gone = !jobName || await cleanupWorkspace({ jobName, projectId, workspaceId })
    || await waitFor(async () => await workspaceDriver().findForTeardown(workspaceId) === undefined,
      { timeoutMs: RESTART_TEARDOWN_WAIT_MS, intervalMs: 1_000 })
  if (!gone) {
    throw new ServerError('CONFLICT', `the previous runtime of ${workspaceId} is still shutting down; `
      + 'try the restart again in a moment')
  }
  clearWorkspaceTerminating(workspaceId)
}

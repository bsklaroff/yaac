/**
 * In-memory registry of workspaces being created or restarted. Included in
 * the server snapshot, so the webapp shows them as sidebar rows with live
 * progress that survive a reload. Failures stay until dismissed.
 *
 * While an entry exists, `buildSnapshot` hides the same-id workspace (its
 * pod lists before setup finishes), and also a claimed spare, which the entry
 * names as `claimedId` so clients know which workspace replaces the row.
 *
 * A provision the user stops (`stopProvisioning`) rolls back at the create's
 * next checkpoint (`throwIfProvisionStopped`), and its row is then dropped
 * rather than shown failed.
 */
import { notifyWorkspaceListChanged } from '#lib/notify'
import { isWorkspaceTerminating } from '#runtime/status'
import { getWorkspaceRow } from '#db'
import { authorizeProject, type Actor } from '#domain/access'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool, ProvisioningWorkspaceEntry } from '@yaac/shared/types'

export type ProvisioningKind = 'create' | 'restart'

interface ProvisioningEntry {
  workspaceId: string
  projectId: string
  /** Its first session's agent; absent for a workspace with none. */
  tool?: AgentTool
  kind: ProvisioningKind
  message: string
  error?: string
  /** Sidebar group, so the row shows in its section while provisioning. */
  groupId?: string
  title?: string
  /** The prompt a create opens with, shown with its failure. */
  prompt?: string
  /** The launch model and its display name. */
  model?: string
  modelName?: string
  /** The spare this create claimed (a different id). */
  claimedId?: string
  /** The requested base branch; a workspace queued after this one defaults
   *  to it before the row exists. Not sent to clients. */
  branch?: string
  /** Set by `stopProvisioning`; the next checkpoint throws. */
  stopping?: boolean
  startedAt: number
  /** Insertion order, to break `startedAt` ties. */
  seq: number
}

const entries = new Map<string, ProvisioningEntry>()
let nextSeq = 0

/**
 * Workspaces the user stopped while provisioning. One whose run finishes
 * anyway is torn down as it comes up, and the agent-alive probe then sees
 * the agent gone, which `reportAgentLaunchFailure` must not report as a
 * failed create or restart. Kept until the id provisions again.
 */
const stoppedIds = new Set<string>()

interface ProvisioningInput {
  workspaceId: string
  projectId: string
  tool?: AgentTool
  kind: ProvisioningKind
  message?: string
  groupId?: string
  title?: string
  prompt?: string
  model?: string
  modelName?: string
  branch?: string
}

/**
 * Ids a `deleteWorkspace` holds, from before it reads the workspace's state
 * until its rows are gone, so no restart or queued child can start on a
 * workspace whose files are being removed.
 */
const deleting = new Set<string>()

/** Whether a delete holds the id. */
export function deletionHeld(workspaceId: string): boolean {
  return deleting.has(workspaceId)
}

/** Refuse an id a delete holds (`CONFLICT`). */
export function refuseDeleting(workspaceId: string): void {
  if (deleting.has(workspaceId)) throw new ServerError('CONFLICT', `workspace ${workspaceId} is being deleted`)
}

/**
 * Hold an id for a delete, refusing one that is provisioning or already
 * held (`CONFLICT`). Synchronous, so nothing can register between the check
 * and the hold. Returns the release.
 */
export function claimDeletion(workspaceId: string): () => void {
  refuseLiveProvision(workspaceId)
  deleting.add(workspaceId)
  return () => { deleting.delete(workspaceId) }
}

/**
 * Refuse an id that is still provisioning or being deleted (`CONFLICT`). A
 * failed entry is not refused: registering again is a retry.
 */
export function refuseLiveProvision(workspaceId: string): void {
  refuseDeleting(workspaceId)
  const existing = entries.get(workspaceId)
  if (existing !== undefined && existing.error === undefined) {
    throw new ServerError('CONFLICT', `workspace ${workspaceId} is already provisioning`)
  }
}

/**
 * Track a new provision and push a snapshot. Re-registering an id replaces a
 * failed entry (a retry); a live one is a `CONFLICT`.
 */
export function registerProvisioning(input: ProvisioningInput): void {
  refuseLiveProvision(input.workspaceId)
  stoppedIds.delete(input.workspaceId)
  entries.set(input.workspaceId, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...(input.tool !== undefined ? { tool: input.tool } : {}),
    kind: input.kind,
    message: input.message ?? 'Starting…',
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modelName !== undefined ? { modelName: input.modelName } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    startedAt: Date.now(),
    seq: nextSeq++,
  })
  notifyWorkspaceListChanged()
}

/** Update an entry's progress message. No-op if absent or failed, so a late
 *  callback from a run that already threw (e.g. a background checkout still
 *  fetching) can neither resurrect a removed entry nor clear its error, and
 *  while stopping, so the row keeps reading "Stopping…". A retry
 *  re-registers, which replaces the failed entry. */
export function updateProvisioningMessage(workspaceId: string, message: string): void {
  const e = entries.get(workspaceId)
  if (!e || e.error !== undefined || e.stopping === true) return
  e.message = message
  notifyWorkspaceListChanged()
}

/** Record (or clear, on fallback to a cold create) the spare a create
 *  claimed. No-op if absent. */
export function claimProvisioning(workspaceId: string, claimedId: string | undefined): void {
  const e = entries.get(workspaceId)
  if (!e) return
  if (claimedId === undefined) delete e.claimedId
  else e.claimedId = claimedId
  notifyWorkspaceListChanged()
}

/** Mark an entry failed; kept until dismissed. Releases any claimed spare
 *  so the lingering row does not hide it. A stopped entry is dropped
 *  instead, since the user asked for it to go. No-op if absent. */
export function failProvisioning(workspaceId: string, error: string): void {
  const e = entries.get(workspaceId)
  if (!e) return
  if (e.stopping === true) {
    removeProvisioning(workspaceId)
    return
  }
  e.error = error
  delete e.claimedId
  notifyWorkspaceListChanged()
}

/**
 * Report an agent launch failure found after the create returned (the
 * unawaited agent-window probe), as a failed provisioning row.
 *
 * Waits for the create's run to finish first; otherwise its
 * success path could remove this row. The workspace itself is left to the
 * liveness watch and stale reaper.
 *
 * Not for an agent the user stopped, whose stop takes its windows down
 * too: one still being torn down is marked terminating, and after that the
 * stop is on the row with no death cause (a death the server observed
 * records one). A restart clears its stop record at the end of its run, so
 * the row is read once that has settled.
 */
export async function reportAgentLaunchFailure(input: {
  workspaceId: string
  projectId: string
  tool: AgentTool
  kind: ProvisioningKind
  error: string
  /** The create's prompt, shown beside the error so it can be reused. */
  prompt?: string
}): Promise<void> {
  await settledRun(input.workspaceId)
  // An existing entry is either the create's own failure (the real cause)
  // or a newer provision on this id; leave it.
  if (entries.has(input.workspaceId) || stoppedIds.has(input.workspaceId)) return
  if (isWorkspaceTerminating(input.workspaceId)) return
  const row = await getWorkspaceRow(input.projectId, input.workspaceId).catch(() => undefined)
  if (row === undefined || (row.stoppedAt !== undefined && row.deathReason === undefined)) return
  if (entries.has(input.workspaceId)) return
  registerProvisioning({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    tool: input.tool,
    kind: input.kind,
    message: input.error,
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
  })
  failProvisioning(input.workspaceId, input.error)
}

/**
 * In-flight provision runs by workspace id, for
 * `reportAgentLaunchFailure` and `stopProvisioning` to wait on. Each
 * resolves with the id the run left running (a claimed spare's, on success),
 * or undefined if it failed; none rejects.
 */
const runs = new Map<string, Promise<string | undefined>>()

/** Resolves once no provision run is in flight for this id. */
async function settledRun(workspaceId: string): Promise<void> {
  // Loop: a retry can start a new run under the same id.
  let run = runs.get(workspaceId)
  while (run !== undefined) {
    await run
    const next = runs.get(workspaceId)
    run = next === run ? undefined : next
  }
}

/**
 * Stop a create or restart still in flight. Returns undefined if nothing is
 * provisioning under this id. Otherwise resolves once the run settles, with
 * the id of the workspace it left running: one already past its last
 * checkpoint finishes anyway, and the caller stops it as a running one.
 */
export function stopProvisioning(workspaceId: string): {
  projectId: string
  ranAs: Promise<string | undefined>
} | undefined {
  const e = entries.get(workspaceId)
  if (e === undefined || e.error !== undefined) return undefined
  // A repeat stop: the first already waits on the run.
  if (e.stopping === true) return { projectId: e.projectId, ranAs: Promise.resolve(undefined) }
  e.stopping = true
  e.message = 'Stopping…'
  notifyWorkspaceListChanged()
  stoppedIds.add(workspaceId)
  const ranAs = runs.get(workspaceId) ?? Promise.resolve(undefined)
  // A claimed spare comes up under its own id.
  void ranAs.then((id) => { if (id !== undefined) stoppedIds.add(id) })
  return { projectId: e.projectId, ranAs }
}

/** Whether the user stopped this provision. */
function provisionStopped(workspaceId: string): boolean {
  return entries.get(workspaceId)?.stopping === true
}

/** What a create's checkpoint throws once the user has stopped it. */
export class ProvisionStoppedError extends ServerError {
  constructor() {
    super('CONFLICT', 'stopped before its agent started')
  }
}

/**
 * A create's checkpoint, placed before each step that would start something
 * new (the workspace row, the runtime, the agents), so a stopped provision
 * rolls back before its agent ever runs. No-op without an entry (a spare).
 */
export function throwIfProvisionStopped(workspaceId: string): void {
  if (provisionStopped(workspaceId)) throw new ProvisionStoppedError()
}

/** Drop an entry (resolved or dismissed); notifies only if one was removed. */
export function removeProvisioning(workspaceId: string): void {
  markSettled(workspaceId)
  if (entries.delete(workspaceId)) notifyWorkspaceListChanged()
}

/**
 * The user's "dismiss" on a failed entry; only its project's owner may.
 * Idempotent for an id with no entry.
 */
export async function dismissProvisioning(principal: Actor, workspaceId: string): Promise<void> {
  const e = entries.get(workspaceId)
  if (!e) return
  await authorizeProject(principal, e.projectId)
  removeProvisioning(workspaceId)
}

/**
 * Called with the project of a provision filed in a group that fails, since
 * that frees its slot if the group has a workspace limit
 * (docs/workspace-groups.md). An ungrouped one frees nothing anything waits
 * on. The queue sets it: it launches through here, so this cannot import it.
 */
let provisionFailed: (projectId: string) => void = () => {}

export function onProvisionFailed(fn: (projectId: string) => void): void {
  provisionFailed = fn
}

/** A create or restart that passed its checks and holds its row: called
 *  once, it runs the provision and settles the row. */
export type ProvisionRun<T> = (onProgress?: (message: string) => void) => Promise<T>

/**
 * Register a provisioning row (`CONFLICT` if this id is already
 * provisioning) and return the run that drives it. The run mirrors progress
 * into the row and to its `onProgress`; success drops the row (the ready
 * workspace replaces it), failure marks it failed and rethrows.
 */
export function provision<T extends { workspaceId: string }>(
  input: ProvisioningInput,
  run: (onProgress: (message: string) => void) => Promise<T>,
): ProvisionRun<T> {
  const { workspaceId } = input
  registerProvisioning(input)
  return async (onProgress) => {
    // Published before `run` starts, since the failure report is fired from
    // inside the run.
    let settle!: (ranAs: string | undefined) => void
    const settled = new Promise<string | undefined>((resolve) => { settle = resolve })
    runs.set(workspaceId, settled)
    let ranAs: string | undefined
    try {
      const result = await run((message) => {
        updateProvisioningMessage(workspaceId, message)
        onProgress?.(message)
      })
      ranAs = result.workspaceId
      noteWentLive(input, ranAs)
      // Drop the row before returning, so the snapshot shows the workspace.
      removeProvisioning(workspaceId)
      notifyWorkspaceListChanged()
      return result
    } catch (err) {
      failProvisioning(workspaceId, err instanceof Error ? err.message : String(err))
      if (input.groupId !== undefined) provisionFailed(input.projectId)
      throw err
    } finally {
      // Only if not already replaced by a newer run on the same id.
      if (runs.get(workspaceId) === settled) runs.delete(workspaceId)
      settle(ranAs)
    }
  }
}

/**
 * The settings of a create still in flight under its own id (not failed, no
 * claimed spare), which a workspace queued after it inherits before the row
 * exists.
 */
export function inFlightCreate(workspaceId: string): {
  projectId: string
  tool?: AgentTool
  model?: string
  branch?: string
  groupId?: string
} | undefined {
  const e = entries.get(workspaceId)
  if (e === undefined || e.kind !== 'create' || e.error !== undefined || e.claimedId !== undefined) {
    return undefined
  }
  return {
    projectId: e.projectId,
    ...(e.tool !== undefined ? { tool: e.tool } : {}),
    ...(e.model !== undefined ? { model: e.model } : {}),
    ...(e.branch !== undefined ? { branch: e.branch } : {}),
    ...(e.groupId !== undefined ? { groupId: e.groupId } : {}),
  }
}

/** The registry in wire form, oldest first. */
export function listProvisioning(): ProvisioningWorkspaceEntry[] {
  return [...entries.values()]
    .sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq)
    .map((e) => ({
      workspaceId: e.workspaceId,
      projectId: e.projectId,
      ...(e.tool !== undefined ? { tool: e.tool } : {}),
      kind: e.kind,
      message: e.message,
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.groupId !== undefined ? { groupId: e.groupId } : {}),
      ...(e.title !== undefined ? { title: e.title } : {}),
      ...(e.prompt !== undefined ? { prompt: e.prompt } : {}),
      ...(e.model !== undefined ? { model: e.model } : {}),
      ...(e.modelName !== undefined ? { modelName: e.modelName } : {}),
      ...(e.claimedId !== undefined ? { claimedId: e.claimedId } : {}),
      ...(e.stopping === true ? { stopping: true } : {}),
      createdAt: formatUtcTimestamp(e.startedAt),
    }))
}

/**
 * Prewarmed spares being created, workspace id → project id. A spare gets
 * no registry entry, since nothing shows it until a create claims it. The
 * prewarm reconciler counts these against its pool, and never claims or
 * reaps one mid-create.
 */
export const spawningSpares = new Map<string, string>()

/** A spare's create has returned, so it leaves `spawningSpares`. */
export function settleSpare(workspaceId: string): void {
  spawningSpares.delete(workspaceId)
  markSettled(workspaceId)
}

/**
 * When each create or warm last left the registry. A sweep's listing can
 * predate that, and then shows neither the entry nor the workspace that
 * replaced it. Kept far longer than any reconcile pass runs.
 */
const settledAt = new Map<string, number>()
const SETTLED_KEEP_MS = 10 * 60_000

function markSettled(workspaceId: string): void {
  const now = Date.now()
  for (const [id, at] of settledAt) if (at < now - SETTLED_KEEP_MS) settledAt.delete(id)
  settledAt.set(workspaceId, now)
}

/**
 * Provisions that succeeded lately, under the id they run as (a claimed
 * spare's, for a create that claimed one). A workspace-limit check that read
 * the rows and runtime before one settled finds it in neither, nor in the
 * registry any more, so it counts these instead (docs/workspace-groups.md).
 */
const wentLive: Array<{ workspaceId: string; projectId: string; groupId?: string; at: number }> = []

function noteWentLive(input: ProvisioningInput, ranAs: string): void {
  const now = Date.now()
  while (wentLive.length > 0 && wentLive[0].at < now - SETTLED_KEEP_MS) wentLive.shift()
  wentLive.push({
    workspaceId: ranAs,
    projectId: input.projectId,
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    at: now,
  })
}

/** The provisions that went live at or after `sinceMs`. */
export function wentLiveSince(sinceMs: number): Array<{ workspaceId: string; projectId: string; groupId?: string }> {
  return wentLive.filter((w) => w.at >= sinceMs)
}

/**
 * Ids a sweep acting on a listing taken at `listedAtMs` must not touch:
 * workspaces still being created or restarted, including a spare a create
 * has claimed, which runs under its own id, and a spare still being warmed;
 * and any of those that settled since the listing, which may not show it.
 * Failed entries are excluded; their rollback already ran.
 */
export function inFlightWorkspaceIds(listedAtMs: number): string[] {
  return [...entries.values()].filter((e) => e.error === undefined)
    .flatMap((e) => (e.claimedId !== undefined ? [e.workspaceId, e.claimedId] : [e.workspaceId]))
    .concat([...spawningSpares.keys()])
    .concat([...settledAt].filter(([, at]) => at >= listedAtMs).map(([id]) => id))
}

/** Test helper: drop all tracked entries. */
export function clearAllProvisioningForTests(): void {
  entries.clear()
  deleting.clear()
  stoppedIds.clear()
  runs.clear()
  spawningSpares.clear()
  settledAt.clear()
  wentLive.length = 0
}

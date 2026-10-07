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
import { notifyWorkspaceListChanged } from '#notify'
import { authorizeProject, type Actor } from '#domain/access'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { ServerError } from '@yaac/shared/errors'
import type { AgentTool, ProvisioningWorkspaceEntry } from '@yaac/shared/types'

export type ProvisioningKind = 'create' | 'restart'

interface ProvisioningEntry {
  workspaceId: string
  projectId: string
  tool: AgentTool
  kind: ProvisioningKind
  message: string
  error?: string
  /** Sidebar group, so the row shows in its section while provisioning. */
  groupId?: string
  title?: string
  /** The launch model and its display name. */
  model?: string
  modelName?: string
  /** The spare this create claimed (a different id). */
  claimedId?: string
  /** The requested base branch; a workspace queued after this one defaults
   *  to it before the row exists. Not sent to clients. */
  branch?: string
  /** Registered by the create route before provisioning starts. A run that
   *  fails while still reserved was refused up front (e.g. a bad model), so
   *  the entry is dropped rather than shown as failed; the caller already
   *  has the error. Cleared by `ensureProvisioning`. */
  reserved?: boolean
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
  tool: AgentTool
  kind: ProvisioningKind
  message?: string
  groupId?: string
  title?: string
  model?: string
  modelName?: string
  branch?: string
  reserved?: boolean
}

/**
 * Track a new provision and push a snapshot. Re-registering an id replaces a
 * failed entry (a retry); a live one is a `CONFLICT`.
 */
export function registerProvisioning(input: ProvisioningInput): void {
  stoppedIds.delete(input.workspaceId)
  const existing = entries.get(input.workspaceId)
  if (existing !== undefined && existing.error === undefined) {
    throw new ServerError('CONFLICT', `workspace ${input.workspaceId} is already provisioning`)
  }
  entries.set(input.workspaceId, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    tool: input.tool,
    kind: input.kind,
    message: input.message ?? 'Starting…',
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modelName !== undefined ? { modelName: input.modelName } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.reserved === true ? { reserved: true } : {}),
    startedAt: Date.now(),
    seq: nextSeq++,
  })
  notifyWorkspaceListChanged()
}

/**
 * Register, or update an existing entry's tool, group, title, model and branch
 * without changing its order, message or error (for callers the route may
 * already have registered).
 */
export function ensureProvisioning(input: ProvisioningInput): void {
  const e = entries.get(input.workspaceId)
  if (e === undefined) {
    registerProvisioning(input)
    return
  }
  e.tool = input.tool
  delete e.reserved
  if (input.groupId !== undefined) e.groupId = input.groupId
  if (input.title !== undefined) e.title = input.title
  if (input.model !== undefined) e.model = input.model
  if (input.modelName !== undefined) e.modelName = input.modelName
  if (input.branch !== undefined) e.branch = input.branch
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
 *  so the lingering row does not hide it. A stopped or still-reserved entry
 *  is dropped instead: the user asked for it to go, or the caller already
 *  has the error. No-op if absent. */
export function failProvisioning(workspaceId: string, error: string): void {
  const e = entries.get(workspaceId)
  if (!e) return
  if (e.stopping === true || e.reserved === true) {
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
 * Waits for the create's `runProvisioned` to finish first; otherwise its
 * success path could remove this row. The workspace itself is left to the
 * liveness watch and stale reaper.
 */
export async function reportAgentLaunchFailure(input: {
  workspaceId: string
  projectId: string
  tool: AgentTool
  kind: ProvisioningKind
  error: string
}): Promise<void> {
  await settledRun(input.workspaceId)
  // An existing entry is either the create's own failure (the real cause)
  // or a newer provision on this id; leave it.
  if (entries.has(input.workspaceId) || stoppedIds.has(input.workspaceId)) return
  registerProvisioning({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    tool: input.tool,
    kind: input.kind,
    message: input.error,
  })
  failProvisioning(input.workspaceId, input.error)
}

/**
 * In-flight `runProvisioned` calls by workspace id, for
 * `reportAgentLaunchFailure` and `stopProvisioning` to wait on. Each
 * resolves with the id the run left running (a claimed spare's, on success),
 * or undefined if it failed; none rejects.
 */
const runs = new Map<string, Promise<string | undefined>>()

/** Resolves once no `runProvisioned` is in flight for this id. */
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
 * Run a provisioning task, mirroring progress into its row. Success drops the
 * row (the ready workspace replaces it); failure marks it failed and
 * rethrows. The caller registers the row; without one, the updates are
 * no-ops. Used by the HTTP create/restart routes and the spawn reconciler.
 */
export async function runProvisioned<T extends { workspaceId: string }>(
  workspaceId: string,
  run: (onProgress: (message: string) => void) => Promise<T>,
): Promise<T> {
  // Published before `run` starts, since the failure report is fired from
  // inside the run.
  let settle!: (ranAs: string | undefined) => void
  const settled = new Promise<string | undefined>((resolve) => { settle = resolve })
  runs.set(workspaceId, settled)
  let ranAs: string | undefined
  try {
    const result = await run((message) => updateProvisioningMessage(workspaceId, message))
    ranAs = result.workspaceId
    // Drop the row before returning, so the snapshot shows the workspace.
    removeProvisioning(workspaceId)
    notifyWorkspaceListChanged()
    return result
  } catch (err) {
    failProvisioning(workspaceId, err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    // Only if not already replaced by a newer run on the same id.
    if (runs.get(workspaceId) === settled) runs.delete(workspaceId)
    settle(ranAs)
  }
}

/**
 * The settings of a create still in flight under its own id (not failed, no
 * claimed spare), which a workspace queued after it inherits before the row
 * exists.
 */
export function inFlightCreate(workspaceId: string): {
  projectId: string
  tool: AgentTool
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
    tool: e.tool,
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
      tool: e.tool,
      kind: e.kind,
      message: e.message,
      ...(e.error !== undefined ? { error: e.error } : {}),
      ...(e.groupId !== undefined ? { groupId: e.groupId } : {}),
      ...(e.title !== undefined ? { title: e.title } : {}),
      ...(e.model !== undefined ? { model: e.model } : {}),
      ...(e.modelName !== undefined ? { modelName: e.modelName } : {}),
      ...(e.claimedId !== undefined ? { claimedId: e.claimedId } : {}),
      ...(e.stopping === true ? { stopping: true } : {}),
      createdAt: formatUtcTimestamp(e.startedAt),
    }))
}

/**
 * Ids a sweep must not touch: workspaces still being created or restarted.
 * Failed entries are excluded; their rollback already ran.
 */
export function inFlightWorkspaceIds(): string[] {
  return [...entries.values()].filter((e) => e.error === undefined).map((e) => e.workspaceId)
}

/** Test helper: drop all tracked entries. */
export function clearAllProvisioningForTests(): void {
  entries.clear()
  stoppedIds.clear()
  runs.clear()
}

/**
 * Queued workspaces (docs/queued-workspaces.md): create requests that run
 * when their parent (a workspace or another entry) stops naturally, so they
 * chain to any depth.
 *
 * Settings are resolved when queued, so the sidebar shows exactly what will
 * launch. Launches go through `startWorkspace` without claiming a spare,
 * since children already point at the new id. Only `stopWorkspace` releases
 * children; a workspace that died holds them until the user runs or discards
 * them.
 */
import crypto from 'node:crypto'
import { resolveCreate } from './create'
import { resolveGroup } from './groups'
import {
  inFlightCreate,
  listProvisioning,
  ProvisionStoppedError,
  removeProvisioning,
  runProvisioned,
} from './provisioning'
import { resolveWorkspace } from './resolve'
import { startWorkspace } from './start'
import { agentPermissionMode } from './spawn-policy'
import { modelDisplayName } from '#domain/auth'
import { getDefaultBranch } from '#domain/git'
import {
  claimQueuedLaunch,
  deleteQueuedWorkspace,
  failQueuedLaunch,
  finishQueuedLaunch,
  firstAgentSession,
  getAgentSessionsFor,
  getProjectRow,
  getProjectWorkspaceRows,
  getQueuedWorkspaceRow,
  insertQueuedWorkspace,
  listQueuedWorkspaceRows,
  listWorkspaceRows,
  releaseQueuedChildren,
  releaseQueuedWorkspace,
  updateQueuedWorkspace as updateQueuedWorkspaceRow,
  type QueuedParent,
  type QueuedWorkspaceRow,
  type QueuedWorkspaceSettings,
} from '#db'
import { serverLog } from '#log'
import { ServerError } from '@yaac/shared/errors'
import { repoDir } from '@yaac/shared/project-paths'
import { formatUtcTimestamp } from '@yaac/shared/time'
import { normalizeTitle } from '@yaac/shared/titles'
import {
  MAX_PROMPT_LENGTH,
  toolSupportsPermissionMode,
  type AgentMode,
  type AgentTool,
  type HeldWorkspaceEntry,
  type PermissionMode,
  type QueuedWorkspaceEntry,
} from '@yaac/shared/types'

/** What a queue write asks for. Every field but the prompt is optional and
 *  resolved from the parent, then from the project's create defaults. */
export interface QueueRequest {
  /** A workspace id, or a queued entry's id — or a unique prefix of either. */
  parent: string
  prompt: string
  tool?: AgentTool
  model?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
  branch?: string
  /** The launched workspace's title; blank leaves it to be auto-titled. */
  title?: string
  /** A group id or name — a name matching none is created; null is the
   *  default list, absent the parent's. */
  group?: string | null
}

/**
 * Who is queueing. The user is unconstrained; an agent (`yaac-mama queue`)
 * may start nothing more permissive than itself, so it carries its own
 * recorded posture as the ceiling.
 */
export type QueueSource = 'user' | { ceiling: PermissionMode }

/** A resolved parent and the settings it supplies as defaults (absent when
 *  not yet known). */
interface ParentInfo {
  pointer: QueuedParent
  tool?: AgentTool
  mode?: AgentMode
  model?: string
  permissionMode?: PermissionMode
  branch?: string
  groupId?: string
}

/** Entries this process is launching. Any other claimed entry was
 *  interrupted by a server restart. */
const launching = new Set<string>()

/** Queue a create request under a workspace or another entry. */
export async function queueWorkspace(
  projectId: string,
  request: QueueRequest,
  source: QueueSource,
  generatedTitle?: string,
): Promise<QueuedWorkspaceEntry> {
  checkPrompt(request.prompt)
  const parent = await resolveParent(projectId, request.parent)
  const settings = await resolveSettings(projectId, parent, request, source)
  const row = await insertQueuedWorkspace(projectId, parent.pointer, settings, generatedTitle)
  return (await toEntries([row]))[0]
}

/**
 * Edit a queued entry's fields or parent. A new tool without a model or
 * permission mode re-resolves those. A parent that would form a cycle is
 * refused. An agent's edit is held to its ceiling, counting the stored
 * permission mode as requested.
 */
export async function updateQueuedWorkspace(
  id: string,
  patch: Partial<QueueRequest>,
  source: QueueSource,
): Promise<QueuedWorkspaceEntry> {
  const row = await editableRow(id)
  if (patch.prompt !== undefined) checkPrompt(patch.prompt)
  const parent = patch.parent !== undefined
    ? await resolveParent(row.projectId, patch.parent)
    : await parentInfo(row.projectId, pointerOf(row))
  const retooled = patch.tool !== undefined && patch.tool !== row.tool
  const settings = await resolveSettings(row.projectId, parent, {
    prompt: patch.prompt ?? row.prompt,
    tool: patch.tool ?? row.tool,
    mode: patch.mode ?? row.mode,
    branch: patch.branch ?? row.branch,
    title: patch.title ?? row.title ?? '',
    group: patch.group !== undefined ? patch.group : row.groupId ?? null,
    ...(patch.model !== undefined ? { model: patch.model } : retooled ? {} : { model: row.model }),
    ...(patch.permissionMode !== undefined
      ? { permissionMode: patch.permissionMode }
      : retooled ? {} : { permissionMode: row.permissionMode }),
  }, source)
  const updated = await updateQueuedWorkspaceRow(id, {
    ...settings,
    ...(patch.parent !== undefined ? { parent: parent.pointer } : {}),
  })
  if (!updated) throw launchingConflict()
  return (await toEntries([updated]))[0]
}

/** Discard an entry. Its children splice up to its own parent. */
export async function discardQueuedWorkspace(id: string): Promise<void> {
  await editableRow(id)
  if (!await deleteQueuedWorkspace(id)) throw launchingConflict()
}

/**
 * Run an entry now. Returns the new workspace id once the launch is claimed;
 * the launch continues detached as a provisioning row.
 */
export async function runQueuedWorkspace(id: string): Promise<{ workspaceId: string }> {
  await editableRow(id)
  const released = await releaseQueuedWorkspace(id)
  if (!released) throw launchingConflict()
  const workspaceId = await launch(released)
  if (workspaceId === undefined) throw launchingConflict()
  return { workspaceId }
}

/** Launch every entry waiting directly on a workspace that stopped. */
export async function startQueuedChildren(projectId: string, workspaceId: string): Promise<void> {
  for (const row of await releaseQueuedChildren(projectId, workspaceId)) {
    await launch(row)
  }
}

/**
 * Snapshot feed: entries not mid-launch (those show as provisioning rows),
 * oldest first. Entries whose parent workspace is gone are flagged
 * `orphaned`.
 */
export async function listQueuedWorkspaces(): Promise<QueuedWorkspaceEntry[]> {
  const rows = (await listQueuedWorkspaceRows()).filter((r) => r.launchWorkspaceId === undefined)
  return await toEntries(rows)
}

/** Snapshot feed: stopped workspaces that entries still wait on, so the
 *  entries have a row to nest under. */
export async function listHeldWorkspaces(): Promise<HeldWorkspaceEntry[]> {
  const waiting = (await listQueuedWorkspaceRows())
    .filter((r) => r.launchWorkspaceId === undefined && r.parentWorkspaceId !== undefined)
  if (waiting.length === 0) return []
  const parents = new Set(waiting.map((r) => `${r.projectId}/${r.parentWorkspaceId}`))
  const projectIds = [...new Set(waiting.map((r) => r.projectId))]
  const held = (await Promise.all(projectIds.map((projectId) => listWorkspaceRows(projectId)))).flat()
    .filter((w) => w.stoppedAt !== undefined && parents.has(`${w.projectId}/${w.workspaceId}`))
  const sessions = await getAgentSessionsFor(held)
  return held.map((w) => {
    const first = sessions.get(`${w.projectId}/${w.workspaceId}`)?.[0]
    return {
      workspaceId: w.workspaceId,
      projectId: w.projectId,
      tool: first?.tool ?? 'claude',
      ...(w.title !== undefined ? { title: w.title } : {}),
      ...(first?.firstPrompt !== undefined ? { prompt: first.firstPrompt } : {}),
      ...(w.groupId !== undefined ? { groupId: w.groupId } : {}),
      stoppedAt: formatUtcTimestamp((w.stoppedAt ?? w.createdAt).getTime()),
      ...(w.deathReason !== undefined ? { deathReason: w.deathReason } : {}),
      ...(w.deathDetail !== undefined ? { deathDetail: w.deathDetail } : {}),
    }
  })
}

/**
 * Whether this process has put back every launch a previous server left
 * claimed. Only then: a claimed launch seen later is this process's own.
 */
let restartLaunchesSwept = false

/**
 * The queue's backstop, run every resync:
 * - A released entry that never launched is launched. A release can be left
 *   so by a restart, or by a launch that threw while the server ran.
 * - Until it has once succeeded, a claimed launch not running here is
 *   marked failed rather than guessed at (a live workspace does not prove
 *   the launch finished). The stale reaper handles any half-made workspace.
 */
export async function reconcileQueuedWorkspaces(): Promise<void> {
  const rows = (await listQueuedWorkspaceRows()).filter((r) => r.launchWorkspaceId === undefined
    ? r.releasedAt !== undefined
    : !restartLaunchesSwept)
  let swept = true
  for (const row of rows) {
    // Per row: a "Run now" may have started since the read.
    if (launching.has(row.id)) continue
    try {
      if (row.launchWorkspaceId === undefined) await launch(row)
      else {
        await failQueuedLaunch(
          row.id, row.launchWorkspaceId,
          'interrupted by a server restart; run it again once you have checked what it left',
        )
      }
    } catch (err) {
      if (row.launchWorkspaceId !== undefined) swept = false
      serverLog(`[queue] reconciling queued workspace ${row.id.slice(0, 8)}... failed: ${String(err)}`)
    }
  }
  restartLaunchesSwept ||= swept
}

/**
 * Claim an entry's launch, then start it detached. Returns the new workspace
 * id, or undefined if another launcher claimed it. Claiming first means a
 * double-click or a race starts only one workspace.
 */
async function launch(row: QueuedWorkspaceRow): Promise<string | undefined> {
  if (launching.has(row.id)) return undefined
  launching.add(row.id)
  const workspaceId = crypto.randomUUID()
  let claimed = false
  try {
    claimed = await claimQueuedLaunch(row.id, workspaceId)
  } finally {
    if (!claimed) launching.delete(row.id)
  }
  if (!claimed) return undefined

  const title = row.title ?? row.generatedTitle
  void (async () => {
    try {
      await runProvisioned(workspaceId, (onProgress) => startWorkspace({
        projectId: row.projectId,
        workspaceId,
        tool: row.tool,
        model: row.model,
        mode: row.mode,
        permissionMode: row.permissionMode,
        branch: row.branch,
        prompt: row.prompt,
        ...(title !== undefined ? { title } : {}),
        ...(row.groupId !== undefined ? { groupId: row.groupId } : {}),
        rememberDefaults: false,
        // Children point at `workspaceId`; a spare has a different id.
        claimSpare: false,
      }, onProgress))
      await finishQueuedLaunch(row.id, workspaceId)
    } catch (err) {
      // Show the error on the queued row only, not as a provisioning row. A
      // stop is no error: the entry just goes back to waiting.
      const error = err instanceof ProvisionStoppedError ? null
        : err instanceof Error ? err.message : String(err)
      await failQueuedLaunch(row.id, workspaceId, error)
        .catch((e: unknown) => serverLog(`[queue] recording a failed launch failed: ${String(e)}`))
      removeProvisioning(workspaceId)
    } finally {
      launching.delete(row.id)
    }
  })()
  return workspaceId
}

/** An entry that exists and is not mid-launch — what every edit needs. */
async function editableRow(id: string): Promise<QueuedWorkspaceRow> {
  const row = await getQueuedWorkspaceRow(id)
  if (!row) throw new ServerError('NOT_FOUND', `no queued workspace ${id}`)
  if (row.launchWorkspaceId !== undefined || launching.has(id)) throw launchingConflict()
  return row
}

function launchingConflict(): ServerError {
  return new ServerError('CONFLICT', 'that queued workspace is launching')
}

function checkPrompt(prompt: string): void {
  if (prompt.trim() === '') {
    throw new ServerError('VALIDATION', 'a queued workspace needs a prompt — nobody is watching it start')
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ServerError('VALIDATION', `prompt exceeds ${MAX_PROMPT_LENGTH} characters`)
  }
}

function pointerOf(row: QueuedWorkspaceRow): QueuedParent {
  return row.parentQueuedId !== undefined
    ? { parentQueuedId: row.parentQueuedId }
    : { parentWorkspaceId: row.parentWorkspaceId ?? '' }
}

/**
 * Resolve a parent: a workspace or entry in the project, by id or unique
 * prefix. A launching entry resolves to its new workspace. The full id of a
 * create still in flight also works, so
 * `id=$(yaac-mama create …); yaac-mama queue --parent-workspace "$id"` does
 * not race the row write.
 */
async function resolveParent(projectId: string, parent: string): Promise<ParentInfo> {
  const target = parent.trim()
  const [workspace, entries] = await Promise.all([
    resolveWorkspace(target, { projectId }),
    listQueuedWorkspaceRows(projectId),
  ])
  const asWorkspace = (workspaceId: string): Promise<ParentInfo> =>
    parentInfo(projectId, { parentWorkspaceId: workspaceId })
  // A full id wins outright; only a prefix can be ambiguous.
  if (workspace.ok && workspace.workspaceId === target) return await asWorkspace(target)
  if (inFlightCreate(target)?.projectId === projectId) return await asWorkspace(target)
  let entry = entries.find((e) => e.id === target)
  if (entry === undefined) {
    const prefixed = target === '' ? [] : entries.filter((e) => e.id.startsWith(target))
    const workspaceMatches = workspace.ok ? 1 : workspace.reason === 'ambiguous' ? 2 : 0
    if (workspaceMatches + prefixed.length > 1) {
      throw new ServerError(
        'VALIDATION',
        `'${target}' matches more than one workspace or queued workspace in ${projectId} — use a longer prefix`,
      )
    }
    if (workspace.ok) return await asWorkspace(workspace.workspaceId)
    entry = prefixed[0]
  }
  if (entry === undefined) {
    throw new ServerError('NOT_FOUND', `no workspace or queued workspace '${target}' in ${projectId}`)
  }
  return {
    ...settingsOf(entry),
    pointer: entry.launchWorkspaceId !== undefined
      ? { parentWorkspaceId: entry.launchWorkspaceId }
      : { parentQueuedId: entry.id },
  }
}

/** A parent's defaults: an entry's stored settings, or a workspace's first
 *  conversation (current model) and row, falling back to what an in-flight
 *  create asked for. */
async function parentInfo(projectId: string, pointer: QueuedParent): Promise<ParentInfo> {
  if ('parentQueuedId' in pointer) {
    const entry = await getQueuedWorkspaceRow(pointer.parentQueuedId)
    return { pointer, ...(entry !== undefined ? settingsOf(entry) : {}) }
  }
  const workspaceId = pointer.parentWorkspaceId
  const [row, first] = await Promise.all([
    getProjectWorkspaceRows(projectId).then((rows) => rows.get(workspaceId)),
    firstAgentSession(projectId, workspaceId),
  ])
  const creating = inFlightCreate(workspaceId)
  const model = first?.model ?? row?.model ?? creating?.model
  const mode = first?.mode ?? row?.mode
  const tool = first?.tool ?? creating?.tool
  const branch = row?.baseBranch ?? creating?.branch
  const groupId = row !== undefined ? row.groupId : creating?.groupId
  return {
    pointer,
    ...(tool !== undefined ? { tool } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(row !== undefined ? { permissionMode: row.permissionMode } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  }
}

function settingsOf(entry: QueuedWorkspaceRow): Omit<ParentInfo, 'pointer'> {
  return {
    tool: entry.tool,
    mode: entry.mode,
    model: entry.model,
    permissionMode: entry.permissionMode,
    branch: entry.branch,
    ...(entry.groupId !== undefined ? { groupId: entry.groupId } : {}),
  }
}

/**
 * Resolve every setting: the request's, else the parent's (tool-specific ones
 * only for the same tool), else the project's create defaults. The group is
 * fixed now, so moving the parent later does not move it.
 */
async function resolveSettings(
  projectId: string,
  parent: ParentInfo,
  request: Omit<QueueRequest, 'parent'>,
  source: QueueSource,
): Promise<QueuedWorkspaceSettings> {
  const tool = request.tool ?? parent.tool ?? (await getProjectRow(projectId))?.lastTool ?? 'claude'
  const sameTool = tool === parent.tool
  // The UI mode is not tool-specific, so it is borrowed whatever the tool.
  // With the parent's tool unknown, borrow the permission mode (checked
  // below) but not the model.
  const compatible = sameTool || parent.tool === undefined
  const mode = request.mode ?? parent.mode
  const inherited = compatible ? parent.permissionMode : undefined

  // An agent's permission mode is capped at its own (`agentPermissionMode`).
  let permissionMode = request.permissionMode
  if (source !== 'user') {
    const resolved = agentPermissionMode(
      tool,
      source.ceiling,
      request.permissionMode,
      parent.permissionMode ?? source.ceiling,
    )
    if (!resolved.ok) throw new ServerError('VALIDATION', resolved.error)
    permissionMode = resolved.permissionMode
  } else if (
    permissionMode === undefined && inherited !== undefined
    && toolSupportsPermissionMode(tool, inherited)
  ) {
    permissionMode = inherited
  }

  const setup = await resolveCreate(projectId, {
    tool,
    ...(mode !== undefined ? { mode } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(request.model !== undefined
      ? { model: request.model }
      : sameTool && parent.model !== undefined ? { model: parent.model } : {}),
  })
  if (setup.model === undefined) {
    throw new ServerError('VALIDATION', `no model is known for ${setup.tool}; pick one`)
  }
  const title = normalizeTitle(request.title ?? '')
  const groupId = request.group === undefined ? parent.groupId
    : request.group === null ? undefined
    : (await resolveGroup(projectId, request.group, { create: true })).groupId
  return {
    prompt: request.prompt,
    tool: setup.tool,
    model: setup.model,
    mode: setup.mode,
    permissionMode: setup.permissionMode,
    branch: request.branch ?? parent.branch ?? await getDefaultBranch(repoDir(projectId)),
    ...(title !== '' ? { title } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  }
}

/** Wire entries, flagging the ones whose parent workspace is gone. */
async function toEntries(rows: QueuedWorkspaceRow[]): Promise<QueuedWorkspaceEntry[]> {
  if (rows.length === 0) return []
  const projectIds = [...new Set(rows.map((r) => r.projectId))]
  const known = new Set((await Promise.all(projectIds.map(async (projectId) =>
    [...(await getProjectWorkspaceRows(projectId)).keys()].map((id) => `${projectId}/${id}`)))).flat())
  for (const p of listProvisioning()) known.add(`${p.projectId}/${p.workspaceId}`)
  return rows.map((r) => {
    const modelName = modelDisplayName(r.tool, r.model)
    const orphaned = r.parentWorkspaceId !== undefined && !known.has(`${r.projectId}/${r.parentWorkspaceId}`)
    return {
      id: r.id,
      projectId: r.projectId,
      ...(r.parentWorkspaceId !== undefined ? { parentWorkspaceId: r.parentWorkspaceId } : {}),
      ...(r.parentQueuedId !== undefined ? { parentQueuedId: r.parentQueuedId } : {}),
      prompt: r.prompt,
      tool: r.tool,
      model: r.model,
      ...(modelName !== undefined ? { modelName } : {}),
      mode: r.mode,
      permissionMode: r.permissionMode,
      branch: r.branch,
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.generatedTitle !== undefined ? { generatedTitle: r.generatedTitle } : {}),
      ...(r.groupId !== undefined ? { groupId: r.groupId } : {}),
      createdAt: formatUtcTimestamp(r.createdAt.getTime()),
      ...(r.launchError !== undefined ? { launchError: r.launchError } : {}),
      ...(orphaned ? { orphaned: true } : {}),
    }
  })
}

/** Test helper: forget which launches this process is running. */
export function clearQueuedLaunchesForTests(): void {
  launching.clear()
  restartLaunchesSwept = false
}

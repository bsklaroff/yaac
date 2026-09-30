/**
 * Queued worktrees (docs/queued-worktrees.md): a create request saved to run
 * when its parent stops naturally. The parent is a worktree, or another
 * entry, so requests chain to any depth — each link a full worktree run.
 *
 * Every setting is resolved to a concrete value when an entry is queued, so
 * what the sidebar shows is exactly what will launch. A launch goes through
 * `startWorktree` like any other create, with the spare claim off: the
 * launch's claim has already pointed the entry's children at the id it
 * creates under, and a claimed spare would list under its own.
 *
 * `stopWorktree` is the only caller that releases — it is exactly the set of
 * natural stops, and a worktree that died never reaches it, so its children
 * wait under it (a held parent) until the user runs or discards them.
 */
import crypto from 'node:crypto'
import { resolveCreate } from './create'
import { resolveGroup } from './groups'
import { inFlightCreate, listProvisioning, removeProvisioning, runProvisioned } from './provisioning'
import { resolveWorktree } from './resolve'
import { startWorktree } from './start'
import { agentPermissionMode } from './spawn-policy'
import { modelDisplayName } from '#domain/auth'
import { getDefaultBranch } from '#domain/git'
import {
  claimQueuedLaunch,
  deleteQueuedWorktree,
  failQueuedLaunch,
  finishQueuedLaunch,
  firstAgentSession,
  getAgentSessionsFor,
  getProjectRow,
  getProjectWorktreeRows,
  getQueuedWorktreeRow,
  insertQueuedWorktree,
  listQueuedWorktreeRows,
  listWorktreeRows,
  releaseQueuedChildren,
  releaseQueuedWorktree,
  updateQueuedWorktree as updateQueuedWorktreeRow,
  type QueuedParent,
  type QueuedWorktreeRow,
  type QueuedWorktreeSettings,
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
  type HeldWorktreeEntry,
  type PermissionMode,
  type QueuedWorktreeEntry,
} from '@yaac/shared/types'

/** What a queue write asks for. Every field but the prompt is optional and
 *  resolved from the parent, then from the project's create defaults. */
export interface QueueRequest {
  /** A worktree id, or a queued entry's id — or a unique prefix of either. */
  parent: string
  prompt: string
  tool?: AgentTool
  model?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
  branch?: string
  /** The launched worktree's title; blank leaves it to be auto-titled. */
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

/** A resolved parent: where the entry points, and what its settings default
 *  to. The defaults are absent where the parent has not decided them yet (a
 *  worktree still provisioning, or one whose row is gone). */
interface ParentInfo {
  pointer: QueuedParent
  tool?: AgentTool
  mode?: AgentMode
  model?: string
  permissionMode?: PermissionMode
  branch?: string
  groupId?: string
}

/** Entries this process is launching, by id — claimed or about to be. The
 *  reconcile step leaves these alone; anything else holding a claim was
 *  interrupted by a server restart. */
const launching = new Set<string>()

/** Queue a create request under a worktree or another entry. */
export async function queueWorktree(
  projectSlug: string,
  request: QueueRequest,
  source: QueueSource,
  generatedTitle?: string,
): Promise<QueuedWorktreeEntry> {
  checkPrompt(request.prompt)
  const parent = await resolveParent(projectSlug, request.parent)
  const settings = await resolveSettings(projectSlug, parent, request, source)
  const row = await insertQueuedWorktree(projectSlug, parent.pointer, settings, generatedTitle)
  return (await toEntries([row]))[0]
}

/**
 * Edit a queued entry — any stored field, and its parent. A field the patch
 * names replaces the stored one; a new tool without a model or posture
 * re-resolves those for that tool, as queueing does. A parent that is the
 * entry itself or one of its descendants would close a cycle that never
 * runs, and is refused. An agent's edit is held to its ceiling like its
 * queue: the stored posture counts as asked for, so an entry above the
 * caller's own is refused rather than quietly lowered.
 */
export async function updateQueuedWorktree(
  id: string,
  patch: Partial<QueueRequest>,
  source: QueueSource,
): Promise<QueuedWorktreeEntry> {
  const row = await editableRow(id)
  if (patch.prompt !== undefined) checkPrompt(patch.prompt)
  const parent = patch.parent !== undefined
    ? await resolveParent(row.projectSlug, patch.parent)
    : await parentInfo(row.projectSlug, pointerOf(row))
  const retooled = patch.tool !== undefined && patch.tool !== row.tool
  const settings = await resolveSettings(row.projectSlug, parent, {
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
  const updated = await updateQueuedWorktreeRow(id, {
    ...settings,
    ...(patch.parent !== undefined ? { parent: parent.pointer } : {}),
  })
  if (!updated) throw launchingConflict()
  return (await toEntries([updated]))[0]
}

/** Discard an entry. Its children splice up to its own parent. */
export async function discardQueuedWorktree(id: string): Promise<void> {
  await editableRow(id)
  if (!await deleteQueuedWorktree(id)) throw launchingConflict()
}

/**
 * Run an entry now, whatever its parent is doing. Answers once the launch is
 * claimed, with the id the worktree is being created under; the launch
 * itself carries on detached and shows as a provisioning row.
 */
export async function runQueuedWorktree(id: string): Promise<{ worktreeId: string }> {
  await editableRow(id)
  const released = await releaseQueuedWorktree(id)
  if (!released) throw launchingConflict()
  const worktreeId = await launch(released)
  if (worktreeId === undefined) throw launchingConflict()
  return { worktreeId }
}

/**
 * A worktree stopped naturally: launch every entry waiting directly on it.
 * They start together, as siblings; an entry chained under one of them waits
 * for that one to launch and then stop in turn.
 */
export async function startQueuedChildren(projectSlug: string, worktreeId: string): Promise<void> {
  for (const row of await releaseQueuedChildren(projectSlug, worktreeId)) {
    await launch(row)
  }
}

/**
 * The snapshot feed: every entry not mid-launch (a launching one is its
 * provisioning row), oldest first. One whose parent worktree has neither a
 * row nor a provisioning entry is flagged `orphaned` so the sidebar has
 * somewhere to put it.
 */
export async function listQueuedWorktrees(): Promise<QueuedWorktreeEntry[]> {
  const rows = (await listQueuedWorktreeRows()).filter((r) => r.launchWorktreeId === undefined)
  return await toEntries(rows)
}

/**
 * The other snapshot feed: stopped worktrees that entries still wait on,
 * shown as stopped rows so their entries have something to nest under.
 */
export async function listHeldWorktrees(): Promise<HeldWorktreeEntry[]> {
  const waiting = (await listQueuedWorktreeRows())
    .filter((r) => r.launchWorktreeId === undefined && r.parentWorktreeId !== undefined)
  if (waiting.length === 0) return []
  const parents = new Set(waiting.map((r) => `${r.projectSlug}/${r.parentWorktreeId}`))
  const slugs = [...new Set(waiting.map((r) => r.projectSlug))]
  const held = (await Promise.all(slugs.map((slug) => listWorktreeRows(slug)))).flat()
    .filter((w) => w.stoppedAt !== undefined && parents.has(`${w.projectSlug}/${w.worktreeId}`))
  const sessions = await getAgentSessionsFor(held)
  return held.map((w) => {
    const first = sessions.get(`${w.projectSlug}/${w.worktreeId}`)?.[0]
    return {
      worktreeId: w.worktreeId,
      projectSlug: w.projectSlug,
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
 * The crash backstop. `stopWorktree` launches directly, so this only finds
 * what a server restart interrupted:
 *
 * - a claimed launch nothing in this process is running. It is put back with
 *   the error, prompt and all, rather than guessed at: the workspace exists
 *   long before a create is done (the agent respawned, the prompt typed), so
 *   a live one says nothing about whether the launch finished. A half-made
 *   worktree it leaves is the stale reaper's, as for any interrupted create;
 * - a release that never launched, which is launched.
 */
export async function reconcileQueuedWorktrees(): Promise<void> {
  const rows = (await listQueuedWorktreeRows())
    .filter((r) => r.launchWorktreeId !== undefined || r.releasedAt !== undefined)
  for (const row of rows) {
    // Checked per row rather than once with the read: a launch in this
    // process may have started (Run now) since. The store's claim guard
    // covers the rest of the gap.
    if (launching.has(row.id)) continue
    try {
      if (row.launchWorktreeId === undefined) await launch(row)
      else {
        await failQueuedLaunch(
          row.id, row.launchWorktreeId,
          'interrupted by a server restart; run it again once you have checked what it left',
        )
      }
    } catch (err) {
      serverLog(`[queue] reconciling queued worktree ${row.id.slice(0, 8)}... failed: ${String(err)}`)
    }
  }
}

/**
 * Claim an entry's launch and start it detached. Answers the worktree id it
 * is being created under, or undefined when another launcher has it.
 *
 * The claim comes first, before anything is provisioned under that id — it
 * is what makes a Run-now double-click, or a stop racing the reconcile step,
 * start one worktree rather than two.
 */
async function launch(row: QueuedWorktreeRow): Promise<string | undefined> {
  if (launching.has(row.id)) return undefined
  launching.add(row.id)
  const worktreeId = crypto.randomUUID()
  let claimed = false
  try {
    claimed = await claimQueuedLaunch(row.id, worktreeId)
  } finally {
    if (!claimed) launching.delete(row.id)
  }
  if (!claimed) return undefined

  const title = row.title ?? row.generatedTitle
  void (async () => {
    try {
      await runProvisioned(worktreeId, (onProgress) => startWorktree({
        projectSlug: row.projectSlug,
        worktreeId,
        tool: row.tool,
        model: row.model,
        mode: row.mode,
        permissionMode: row.permissionMode,
        branch: row.branch,
        prompt: row.prompt,
        ...(title !== undefined ? { title } : {}),
        ...(row.groupId !== undefined ? { groupId: row.groupId } : {}),
        rememberDefaults: false,
        // The children already point at `worktreeId`; a spare would list
        // under its own id and leave them waiting on nothing.
        claimSpare: false,
      }, onProgress))
      await finishQueuedLaunch(row.id, worktreeId)
    } catch (err) {
      // The error shows once, on the queued row the prompt is still on —
      // not a second time as a failed provisioning row.
      await failQueuedLaunch(row.id, worktreeId, err instanceof Error ? err.message : String(err))
        .catch((e: unknown) => serverLog(`[queue] recording a failed launch failed: ${String(e)}`))
      removeProvisioning(worktreeId)
    } finally {
      launching.delete(row.id)
    }
  })()
  return worktreeId
}

/** An entry that exists and is not mid-launch — what every edit needs. */
async function editableRow(id: string): Promise<QueuedWorktreeRow> {
  const row = await getQueuedWorktreeRow(id)
  if (!row) throw new ServerError('NOT_FOUND', `no queued worktree ${id}`)
  if (row.launchWorktreeId !== undefined || launching.has(id)) throw launchingConflict()
  return row
}

function launchingConflict(): ServerError {
  return new ServerError('CONFLICT', 'that queued worktree is launching')
}

function checkPrompt(prompt: string): void {
  if (prompt.trim() === '') {
    throw new ServerError('VALIDATION', 'a queued worktree needs a prompt — nobody is watching it start')
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new ServerError('VALIDATION', `prompt exceeds ${MAX_PROMPT_LENGTH} characters`)
  }
}

function pointerOf(row: QueuedWorktreeRow): QueuedParent {
  return row.parentQueuedId !== undefined
    ? { parentQueuedId: row.parentQueuedId }
    : { parentWorktreeId: row.parentWorktreeId ?? '' }
}

/**
 * Resolve what a request names as the parent: a worktree in the project, by
 * id or unique prefix (spares are not listed, so never match), or an entry,
 * the same way. A prefix matching both is ambiguous. An entry that is
 * launching resolves to the worktree it is becoming — a failed launch then
 * takes the new child back with its other children. So does the full id of
 * a create still in flight, which may not have recorded its row yet:
 * `id=$(yaac-mama create …); yaac-mama queue --parent-worktree "$id" …` must not
 * race it.
 */
async function resolveParent(projectSlug: string, parent: string): Promise<ParentInfo> {
  const target = parent.trim()
  const [worktree, entries] = await Promise.all([
    resolveWorktree(target, { projectSlug }),
    listQueuedWorktreeRows(projectSlug),
  ])
  const asWorktree = (worktreeId: string): Promise<ParentInfo> =>
    parentInfo(projectSlug, { parentWorktreeId: worktreeId })
  // A full id wins outright; only a prefix can be ambiguous.
  if (worktree.ok && worktree.worktreeId === target) return await asWorktree(target)
  if (inFlightCreate(target)?.projectSlug === projectSlug) return await asWorktree(target)
  let entry = entries.find((e) => e.id === target)
  if (entry === undefined) {
    const prefixed = target === '' ? [] : entries.filter((e) => e.id.startsWith(target))
    const worktreeMatches = worktree.ok ? 1 : worktree.reason === 'ambiguous' ? 2 : 0
    if (worktreeMatches + prefixed.length > 1) {
      throw new ServerError(
        'VALIDATION',
        `'${target}' matches more than one worktree or queued worktree in ${projectSlug} — use a longer prefix`,
      )
    }
    if (worktree.ok) return await asWorktree(worktree.worktreeId)
    entry = prefixed[0]
  }
  if (entry === undefined) {
    throw new ServerError('NOT_FOUND', `no worktree or queued worktree '${target}' in ${projectSlug}`)
  }
  return {
    ...settingsOf(entry),
    pointer: entry.launchWorktreeId !== undefined
      ? { parentWorktreeId: entry.launchWorktreeId }
      : { parentQueuedId: entry.id },
  }
}

/** The defaults a parent supplies. An entry's are its stored settings; a
 *  worktree's come off its first conversation (the current model, which
 *  follows a `/model` switch) and its row. A worktree still provisioning may
 *  have neither yet, so what its create asked for fills in. */
async function parentInfo(projectSlug: string, pointer: QueuedParent): Promise<ParentInfo> {
  if ('parentQueuedId' in pointer) {
    const entry = await getQueuedWorktreeRow(pointer.parentQueuedId)
    return { pointer, ...(entry !== undefined ? settingsOf(entry) : {}) }
  }
  const worktreeId = pointer.parentWorktreeId
  const [row, first] = await Promise.all([
    getProjectWorktreeRows(projectSlug).then((rows) => rows.get(worktreeId)),
    firstAgentSession(projectSlug, worktreeId),
  ])
  const creating = inFlightCreate(worktreeId)
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

function settingsOf(entry: QueuedWorktreeRow): Omit<ParentInfo, 'pointer'> {
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
 * Every setting, concrete: what the request named, else the parent's (the
 * tool-dependent ones only when the tool is the parent's), else what a
 * create in this project would resolve. The group too is decided here, as
 * its parent's group is now — moving the parent later leaves it where it is.
 */
async function resolveSettings(
  projectSlug: string,
  parent: ParentInfo,
  request: Omit<QueueRequest, 'parent'>,
  source: QueueSource,
): Promise<QueuedWorktreeSettings> {
  // The tool precedence a create has, with the parent's ahead of the
  // project's remembered one.
  const tool = request.tool ?? parent.tool ?? (await getProjectRow(projectSlug))?.lastTool ?? 'claude'
  const sameTool = tool === parent.tool
  // A parent whose tool is not known yet (no conversation, no provisioning
  // row) still has a mode and a posture, and a tool that cannot take them
  // is caught below; only its model is too tool-specific to borrow blind.
  const compatible = sameTool || parent.tool === undefined
  const mode = request.mode ?? (compatible ? parent.mode : undefined)
  const inherited = compatible ? parent.permissionMode : undefined

  // The user's posture: named, else the parent's where this tool has it,
  // else the create default. An agent's: named or inherited, and never
  // above its own (`agentPermissionMode`).
  let permissionMode = request.permissionMode
  if (source !== 'user') {
    const resolved = agentPermissionMode(
      tool,
      mode ?? 'tui',
      source.ceiling,
      request.permissionMode,
      parent.permissionMode ?? source.ceiling,
    )
    if (!resolved.ok) throw new ServerError('VALIDATION', resolved.error)
    permissionMode = resolved.permissionMode
  } else if (
    permissionMode === undefined && inherited !== undefined
    && toolSupportsPermissionMode(tool, inherited, mode ?? 'tui')
  ) {
    permissionMode = inherited
  }

  const setup = await resolveCreate(projectSlug, {
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
    : (await resolveGroup(projectSlug, request.group, { create: true })).groupId
  return {
    prompt: request.prompt,
    tool: setup.tool,
    model: setup.model,
    mode: setup.mode,
    permissionMode: setup.permissionMode,
    branch: request.branch ?? parent.branch ?? await getDefaultBranch(repoDir(projectSlug)),
    ...(title !== '' ? { title } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  }
}

/** Wire entries, flagging the ones whose parent worktree is gone. */
async function toEntries(rows: QueuedWorktreeRow[]): Promise<QueuedWorktreeEntry[]> {
  if (rows.length === 0) return []
  const slugs = [...new Set(rows.map((r) => r.projectSlug))]
  const known = new Set((await Promise.all(slugs.map(async (slug) =>
    [...(await getProjectWorktreeRows(slug)).keys()].map((id) => `${slug}/${id}`)))).flat())
  for (const p of listProvisioning()) known.add(`${p.projectSlug}/${p.worktreeId}`)
  return rows.map((r) => {
    const modelName = modelDisplayName(r.tool, r.model)
    const orphaned = r.parentWorktreeId !== undefined && !known.has(`${r.projectSlug}/${r.parentWorktreeId}`)
    return {
      id: r.id,
      projectSlug: r.projectSlug,
      ...(r.parentWorktreeId !== undefined ? { parentWorktreeId: r.parentWorktreeId } : {}),
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
}

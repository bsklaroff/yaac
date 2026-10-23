import { queuedParentId } from '#lib/queued'
import { durationText } from '#lib/time'
import type { AgentTool, DraftWorkspaceSettings, ServerSnapshot, ToolCreateDefaults } from '@yaac/shared/types'

/** Start values that are not a parent: a time, a delay, or a routine's
 *  schedule (docs/routines.md). */
export const START_AT = '\u0000at'
export const START_IN = '\u0000in'
export const SCHEDULE = '\u0000schedule'

/**
 * The new-workspace pane's form (`NewWorkspacePane`), kept in the ui store
 * and saved, so a reload brings back what was typed. There is at most one,
 * and it is dropped when the user leaves the pane (docs/draft-workspaces.md).
 *
 * Fields left unset show what an untouched create would use: the parent's
 * settings when Start names one, else the project's remembered defaults.
 */
export interface NewWorkspaceForm {
  projectId: string
  prompt: string
  title: string
  /** '' starts now; `START_AT`, `START_IN` or `SCHEDULE` start it at a
   *  time, after a delay or as a routine; anything else is the workspace or
   *  queued entry it waits on. For a routine, `title` is its name. */
  start: string
  /** `START_AT`'s time, as an ISO instant. */
  startAt?: string
  /** `START_IN`'s delay, as typed. */
  startIn?: string
  /** The timeout as typed; blank is none, or for a routine the next run. */
  timeout?: string
  /** `SCHEDULE`'s cron, its zone (absent: the user's), and whether Repeats
   *  shows it as Custom even when a preset would make it. */
  cron?: string
  timeZone?: string
  customCron?: boolean
  tool?: AgentTool
  /** Model, mode, posture and effort picks, which apply only to the agent
   *  they were made for. */
  picked?: { tool: AgentTool; picks: ToolCreateDefaults }
  branch?: string
  /** null is no group. */
  groupId?: string | null
  /** The saved draft it was opened on. */
  draftId?: string
  /** The queued entry it edits. */
  editId?: string
  /** The routine it edits. */
  editRoutineId?: string
}

/** What opens the pane on something other than a blank form: `parent` sets
 *  Start to after that workspace or queued entry stops, `draftId` reopens a
 *  draft, `editId` edits a queued entry and `routineId` a routine. */
export interface NewWorkspaceOpts {
  projectId: string
  parent?: string
  draftId?: string
  editId?: string
  routineId?: string
}

/** A typed prompt that leaving the pane would lose, as a draft to save. */
export interface PendingDraft {
  projectId: string
  /** The draft the pane was opened on, which a save replaces. */
  id?: string
  settings: DraftWorkspaceSettings
}

export function isNewWorkspaceForm(v: unknown): v is NewWorkspaceForm {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const f = v as Record<string, unknown>
  return typeof f.projectId === 'string' && typeof f.prompt === 'string' && typeof f.title === 'string'
    && typeof f.start === 'string'
}

/**
 * The form `opts` opens: a queued entry's, a routine's or a draft's every
 * field, or Start set to a parent. A draft's Start falls back to now if that
 * parent is gone or its time has passed, and its group counts as untouched
 * if it is what that Start would give. An entry or routine that is gone
 * opens empty, for the pane to say so.
 */
export function seedNewWorkspace(opts: NewWorkspaceOpts, snapshot: ServerSnapshot | undefined): NewWorkspaceForm {
  const blank: NewWorkspaceForm = { projectId: opts.projectId, prompt: '', title: '', start: opts.parent ?? '' }
  const queued = snapshot?.queuedWorkspaces ?? []
  const entry = opts.editId !== undefined ? queued.find((e) => e.id === opts.editId) : undefined
  const routine = opts.routineId !== undefined ? snapshot?.routines.find((r) => r.id === opts.routineId) : undefined
  const draft = opts.draftId !== undefined ? snapshot?.draftWorkspaces.find((d) => d.id === opts.draftId) : undefined
  if (opts.editId !== undefined && entry === undefined) return { ...blank, editId: opts.editId }
  if (opts.routineId !== undefined && routine === undefined) return { ...blank, editRoutineId: opts.routineId }
  const from = entry ?? routine ?? draft
  if (from === undefined) return blank

  let start = ''
  let groupId: string | null | undefined = from.groupId ?? null
  let startAt: string | undefined
  let cron: string | undefined
  let timeout: number | undefined
  if (draft !== undefined) {
    const parent = [
      ...(snapshot?.workspaces ?? []).map((w) => ({ id: w.workspaceId, groupId: w.groupId })),
      ...(snapshot?.heldWorkspaces ?? []).map((h) => ({ id: h.workspaceId, groupId: h.groupId })),
      ...(snapshot?.provisioning ?? []).map((p) => ({ id: p.workspaceId, groupId: p.groupId })),
      ...queued.map((e) => ({ id: e.id, groupId: e.groupId })),
    ].find((p) => p.id === draft.startAfter)
    start = parent?.id ?? ''
    if (draft.groupId === parent?.groupId) groupId = undefined
    if (draft.startAt !== undefined && Date.parse(draft.startAt) > Date.now()) [start, startAt] = [START_AT, draft.startAt]
    if (draft.cron !== undefined) [start, cron] = [SCHEDULE, draft.cron]
    timeout = draft.timeout
  } else if (entry !== undefined) {
    start = entry.startAt !== undefined ? START_AT : queuedParentId(entry)
    startAt = entry.startAt
    timeout = entry.timeoutMinutes
  } else if (routine !== undefined) {
    start = SCHEDULE
    cron = routine.cron
    timeout = routine.timeoutMinutes
  }
  const timeZone = routine?.timeZone ?? draft?.timeZone
  return {
    projectId: opts.projectId,
    prompt: from.prompt,
    title: routine?.name ?? (entry ?? draft)?.title ?? '',
    start,
    ...(startAt !== undefined ? { startAt } : {}),
    ...(cron !== undefined ? { cron } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(timeout !== undefined ? { timeout: durationText(timeout) } : {}),
    tool: from.tool,
    picked: {
      tool: from.tool,
      picks: {
        ...(from.model !== undefined ? { model: from.model } : {}),
        mode: from.mode,
        permissionMode: from.permissionMode,
        ...(from.effort !== undefined ? { effort: from.effort } : {}),
      },
    },
    ...(from.branch !== undefined ? { branch: from.branch } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(entry !== undefined ? { editId: entry.id } : routine !== undefined ? { editRoutineId: routine.id } : { draftId: from.id }),
  }
}

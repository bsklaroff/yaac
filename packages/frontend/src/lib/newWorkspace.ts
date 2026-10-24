import { queuedParentId } from '#lib/queued'
import type {
  AgentTool,
  DraftWorkspaceSettings,
  QueuedWorkspaceEntry,
  ServerSnapshot,
  ToolCreateDefaults,
} from '@yaac/shared/types'

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
  /** '' starts now, `START_WHEN_ROOM` once its group has room; anything
   *  else is the workspace or queued entry it waits on. */
  start: string
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
}

/** Start's value for an entry with no parent, which waits for room in a
 *  group with a workspace limit (docs/workspace-groups.md). */
export const START_WHEN_ROOM = '\u0000room'

/** The Start an existing entry has. */
export function entryStart(entry: QueuedWorkspaceEntry): string {
  return entry.parentWorkspaceId === undefined && entry.parentQueuedId === undefined
    ? START_WHEN_ROOM
    : queuedParentId(entry)
}

/** What opens the pane on something other than a blank form: `parent` sets
 *  Start to after that workspace or queued entry stops, `draftId` reopens a
 *  draft, and `editId` edits a queued entry. */
export interface NewWorkspaceOpts {
  projectId: string
  parent?: string
  draftId?: string
  editId?: string
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
 * The form `opts` opens: a queued entry's or a draft's every field, or Start
 * set to a parent. A draft's Start falls back to now if that parent is gone,
 * and its group counts as untouched if it is what that Start would give. An
 * entry that is gone opens empty, for the pane to say so.
 */
export function seedNewWorkspace(opts: NewWorkspaceOpts, snapshot: ServerSnapshot | undefined): NewWorkspaceForm {
  const blank: NewWorkspaceForm = { projectId: opts.projectId, prompt: '', title: '', start: opts.parent ?? '' }
  const queued = snapshot?.queuedWorkspaces ?? []
  const entry = opts.editId !== undefined ? queued.find((e) => e.id === opts.editId) : undefined
  const draft = opts.draftId !== undefined ? snapshot?.draftWorkspaces.find((d) => d.id === opts.draftId) : undefined
  if (opts.editId !== undefined && entry === undefined) return { ...blank, editId: opts.editId }
  const from = entry ?? draft
  if (from === undefined) return blank

  let start = ''
  let groupId: string | null | undefined = from.groupId ?? null
  if (draft !== undefined) {
    const parent = [
      ...(snapshot?.workspaces ?? []).map((w) => ({ id: w.workspaceId, groupId: w.groupId })),
      ...(snapshot?.heldWorkspaces ?? []).map((h) => ({ id: h.workspaceId, groupId: h.groupId })),
      ...(snapshot?.provisioning ?? []).map((p) => ({ id: p.workspaceId, groupId: p.groupId })),
      ...queued.map((e) => ({ id: e.id, groupId: e.groupId })),
    ].find((p) => p.id === draft.startAfter)
    start = parent?.id ?? ''
    if (draft.groupId === parent?.groupId) groupId = undefined
  } else if (entry !== undefined) start = entryStart(entry)
  return {
    projectId: opts.projectId,
    prompt: from.prompt,
    title: from.title ?? '',
    start,
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
    ...(entry !== undefined ? { editId: entry.id } : { draftId: from.id }),
  }
}

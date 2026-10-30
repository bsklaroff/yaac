import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChatIcon, CloseIcon, RenameIcon, SendIcon, TerminalIcon, TOOL_LABEL } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { EffortSelect, PermissionModeSelect } from '#components/ComposerSelect'
import { ChatBottomBar, COMPOSER_INPUT, ROUND_BUTTON } from '#components/ConversationView'
import { ContainerlessBadge } from '#components/ContainerlessBadge'
import { PaneBarActions, PaneOverflowMenu } from '#components/PaneBar'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { NumberInput } from '#components/ui/NumberInput'
import { Typeahead } from '#components/ui/Typeahead'
import { api } from '#lib/api'
import { dialogHoldsFocus } from '#lib/dialogFocus'
import { shownGroups } from '#lib/groups'
import { entryStart, SCHEDULE, START_AT, START_IN, START_WHEN_ROOM, type NewWorkspaceForm, type PendingDraft } from '#lib/newWorkspace'
import { compileRepeat, DEFAULT_REPEAT, EVERY_MINUTES, parseRepeat, REPEAT_KINDS, WEEK, type Repeat, type RepeatKind } from '#lib/routines'
import { useTimeZone, zonedInputInstant, zonedInputValue } from '#lib/time'
import { useProjectBranches } from '#lib/useProjectBranches'
import { clip, fetchFullPrompt, queuedDescendants, queuedInTreeOrder, queuedParentId, queuedTitle } from '#lib/queued'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { useCreateDefaults, useCreateWorkspace } from '#lib/useCreateDefaults'
import { useInlineEdit } from '#lib/useInlineRename'
import { useSnapshot } from '#lib/useSnapshot'
import { guardNewWorkspace, useUiStore, type LaunchPane } from '#lib/store'
import { focusRaisesKeyboard, useIsMobile } from '#lib/viewport'
import {
  AGENT_TOOLS,
  SUPPORTED_PERMISSION_MODES,
  effortFor,
  effortLabel,
  toolSupportsPermissionMode,
} from '@yaac/shared/types'
import { ServerError } from '@yaac/shared/errors'
import { cronError, formatInZone, isTimeZone, nextCronRuns, parseDuration } from '@yaac/shared/schedule'
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'
import type {
  AgentMode,
  AgentTool,
  DraftWorkspaceSettings,
  PermissionMode,
  QueuedWorkspaceEntry,
  ToolCreateDefaults,
  WorkspaceListEntry,
} from '@yaac/shared/types'

const MODE_COPY: Record<AgentMode, string> = { tui: 'Terminal', acp: 'Chat' }
const MODE_HELP: Record<AgentMode, string> = {
  tui: 'The agent\'s own terminal UI, in a terminal pane.',
  acp: 'The agent driven over the Agent Client Protocol, in a chat pane.',
}

const SELECT = 'min-w-0 flex-1 rounded-md border border-border bg-surface-2 h-[26px] px-1 text-xs text-text '
  + 'outline-none hover:bg-surface-3'

const INPUT = 'h-[26px] min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 text-xs text-text '
  + 'outline-none placeholder:text-text-faint focus:border-border-strong'

/** A note under a form row, lined up with the controls. */
const NOTE = '-mt-1 mb-1 pl-[92px] text-[11px] text-text-faint'

const BUTTON = 'flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs '
  + 'text-text-dim outline-none transition hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed '
  + 'disabled:opacity-50 max-md:py-2.5'

/** A parent's settings, used to fill untouched fields when Start names it.
 *  Absent for "Now", which uses the project's remembered defaults. */
interface Seed {
  tool?: AgentTool
  model?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
  effort?: string
  branch?: string
  groupId?: string
}

interface StartOption {
  /** '' is "Now"; anything else is the parent's id. */
  value: string
  label: string
  seed?: Seed
}

/** A live workspace's settings, from its first agent session and its row.
 *  The model is that session's current one, so a `/model` switch carries
 *  over to a child. */
function workspaceSeed(w: WorkspaceListEntry): Seed {
  const first = [...w.conversations].sort((a, b) => a.ordinal - b.ordinal)[0]
  return {
    tool: first?.tool ?? w.tool,
    ...(first?.mode !== undefined ? { mode: first.mode } : {}),
    ...(first?.model !== undefined ? { model: first.model } : {}),
    ...(w.permissionMode !== undefined ? { permissionMode: w.permissionMode } : {}),
    ...(w.effort !== undefined ? { effort: w.effort } : {}),
    ...(w.baseBranch !== undefined ? { branch: w.baseBranch } : {}),
    ...(w.groupId !== undefined ? { groupId: w.groupId } : {}),
  }
}

function entrySeed(e: QueuedWorkspaceEntry): Seed {
  return {
    tool: e.tool,
    model: e.model,
    mode: e.mode,
    permissionMode: e.permissionMode,
    ...(e.effort !== undefined ? { effort: e.effort } : {}),
    branch: e.branch,
    ...(e.groupId !== undefined ? { groupId: e.groupId } : {}),
  }
}

/** The Group dropdown's "+ New group" option, which swaps it for a name box. */
const NEW_GROUP = '\u0000new'
/** A new routine's untouched group: one the server makes, named after it. */
const ROUTINE_GROUP = '\u0000routine'

const workspaceName = (w: { title?: string; prompt?: string }): string =>
  clip(w.title || w.prompt || 'New workspace', 40)

const DRAFT_FIELDS = [
  'prompt', 'tool', 'mode', 'permissionMode', 'model', 'effort', 'branch', 'startAfter', 'title', 'groupId',
  'startAt', 'timeout', 'cron', 'timeZone',
] as const satisfies
  readonly (keyof DraftWorkspaceSettings)[]

/** Save `pending` as a draft. If the draft it was opened from has since
 *  been deleted, save a new one instead. */
async function keepDraft(pending: PendingDraft): Promise<void> {
  const save = (id?: string) => api.workspace.draft.save.$post({
    json: { project: pending.projectId, ...pending.settings, ...(id !== undefined ? { id } : {}) },
  })
  try {
    await save(pending.id)
  } catch (err) {
    if (pending.id === undefined || !(err instanceof ServerError && err.code === 'NOT_FOUND')) throw err
    await save()
  }
}

const blankForm = (projectId: string): NewWorkspaceForm => ({ projectId, prompt: '', title: '', start: '' })

/**
 * The main pane while no workspace is selected: a new workspace's prompt in
 * the chat composer, its permission mode and effort beside it as a chat's
 * are, and its other settings where the conversation would be. Sending
 * creates it now, or queues it to start after another workspace stops
 * (docs/queued-workspaces.md), at a time or after a delay; "On a schedule…"
 * turns it into a routine's form, whose title is the routine's name
 * (docs/routines.md). The same pane edits a queued entry or a routine, or
 * reopens a draft. Times are typed and shown in the user's zone.
 *
 * Send needs a prompt. A workspace starts without one only from a button
 * pressed for it: "Start without a prompt", or the bar's New Shell, Files and
 * Changes, which WorkspaceView's header holds for it (`bar`) as it does for
 * a workspace. Those start it now with whatever prompt is typed and open
 * that pane once it is up (`launches` in the store).
 *
 * The form lives in the ui store (`newWorkspace`), so it survives a reload.
 * Fields start on what an untouched create would use: the project's
 * remembered defaults (`useCreateDefaults`) for "Now", or the parent's
 * settings for a queued start. Changing Start re-seeds only untouched
 * fields; changing the agent reloads its own defaults. A title set here
 * means the workspace is not auto-titled.
 *
 * Leaving the pane with a typed prompt asks whether to keep it as a draft
 * (`LeaveNewWorkspaceDialog`, docs/draft-workspaces.md). Enter submits
 * (except on a button); Shift+Enter in the prompt is a newline.
 */
export function NewWorkspacePane({ projectId, bar }: {
  projectId: string
  /** The header element to render the title and pane buttons into. */
  bar: HTMLElement | null
}): JSX.Element {
  const stored = useUiStore((s) => s.newWorkspace)
  const setForm = useUiStore((s) => s.setNewWorkspace)
  const focusNonce = useUiStore((s) => s.focusNonce)
  const form = stored?.projectId === projectId ? stored : blankForm(projectId)
  const update = (patch: Partial<NewWorkspaceForm>): void => {
    const cur = useUiStore.getState().newWorkspace
    setForm({ ...(cur?.projectId === projectId ? cur : blankForm(projectId)), ...patch })
  }
  const { prompt, title, start } = form

  const snapshot = useSnapshot()
  const defaults = useCreateDefaults(projectId)
  const createWorkspace = useCreateWorkspace()
  const openSettings = useUiStore((s) => s.openSettings)
  const queryClient = useQueryClient()
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const isMobile = useIsMobile()

  // null = dropdown shown; a string = the "+ New group" name box.
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const newGroupRef = useRef<HTMLInputElement>(null)
  const naming = newGroup !== null
  useEffect(() => { if (naming) newGroupRef.current?.focus() }, [naming])
  // null = not typing; the field shows the chosen branch or model.
  const [branchQuery, setBranchQuery] = useState<string | null>(null)
  const [modelQuery, setModelQuery] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const zone = useTimeZone()
  const entries = (snapshot?.queuedWorkspaces ?? []).filter((e) => e.projectId === projectId)
  const editing = form.editId !== undefined ? entries.find((e) => e.id === form.editId) : undefined
  const editingRoutine = form.editRoutineId !== undefined
    ? (snapshot?.routines ?? []).find((r) => r.id === form.editRoutineId)
    : undefined
  const draft = form.draftId !== undefined
    ? (snapshot?.draftWorkspaces ?? []).find((d) => d.id === form.draftId)
    : undefined
  const fromRow = editing ?? draft

  // Replace the seeded preview with the whole prompt. Until it arrives the
  // prompt is read-only and nothing is sent, so a save can never cut it.
  const loadingPrompt = (fromRow ?? editingRoutine) !== undefined && form.savedPrompt === undefined
  const fromRowId = (fromRow ?? editingRoutine)?.id
  useEffect(() => {
    if (!loadingPrompt || fromRowId === undefined) return
    let current = true
    fetchFullPrompt(fromRowId).then(
      (full) => { if (current) update({ prompt: full, savedPrompt: full }) },
      (err: unknown) => { if (current) setError(err instanceof Error ? err.message : String(err)) },
    )
    return () => { current = false }
  }, [loadingPrompt, fromRowId])

  // Start options: now, each live workspace (newest first), each queued
  // entry in sidebar order, then a time, a delay or a schedule. An edit
  // excludes the entry and its descendants (a cycle could never start),
  // always offers its current parent, and cannot become a routine; a
  // routine stays one.
  const live = (snapshot?.workspaces ?? [])
    .filter((w) => w.projectId === projectId && !w.stopping)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const excluded = editing !== undefined
    ? new Set([editing.id, ...queuedDescendants(entries, editing.id)])
    : new Set<string>()
  const options: StartOption[] = editingRoutine !== undefined ? [{ value: SCHEDULE, label: 'On a schedule…' }] : [
    { value: '', label: 'Now' },
    ...live.map((w) => ({ value: w.workspaceId, label: `After “${workspaceName(w)}” stops`, seed: workspaceSeed(w) })),
    ...queuedInTreeOrder(entries).filter((e) => !excluded.has(e.id)).map((e) => ({
      value: e.id,
      label: `After queued “${clip(queuedTitle(e), 40)}” stops`,
      seed: entrySeed(e),
    })),
    { value: START_AT, label: 'At a time…' },
    { value: START_IN, label: 'After a delay…' },
    ...(editing === undefined ? [{ value: SCHEDULE, label: 'On a schedule…' }] : []),
  ]
  if (start !== '' && start !== START_WHEN_ROOM && !options.some((o) => o.value === start)) {
    const held = (snapshot?.heldWorkspaces ?? []).find((h) => h.workspaceId === start)
    const provisioning = (snapshot?.provisioning ?? []).find((p) => p.workspaceId === start)
    options.splice(1, 0, {
      value: start,
      label: held !== undefined ? `After “${workspaceName(held)}” stops (stopped)`
        : provisioning !== undefined ? 'After the new workspace stops'
        : 'Its current parent (gone)',
      ...(held !== undefined
        ? { seed: { tool: held.tool, ...(held.groupId !== undefined ? { groupId: held.groupId } : {}) } }
        : provisioning?.groupId !== undefined ? { seed: { groupId: provisioning.groupId } }
        : {}),
    })
  }
  const seed = options.find((o) => o.value === start)?.seed
  const queued = start !== ''
  const routineMode = start === SCHEDULE
  const afterParent = queued && start !== START_AT && start !== START_IN && !routineMode
  const startIn = start === START_IN ? parseDuration(form.startIn ?? '') : undefined
  const timeoutText = (form.timeout ?? '').trim()
  const timeout = timeoutText === '' ? undefined : parseDuration(timeoutText)

  // A routine's schedule, previewed as the server will fire it.
  const cron = (form.cron ?? compileRepeat(DEFAULT_REPEAT)).trim()
  const routineZone = form.timeZone ?? zone
  const upcoming = routineMode && isTimeZone(routineZone) && cronError(cron) === undefined
    ? nextCronRuns(cron, routineZone, new Date(), 4)
    : []
  const scheduleError = !routineMode ? undefined
    : !isTimeZone(routineZone) ? `Unknown time zone ${routineZone}`
    : cronError(cron) ?? (upcoming.length === 0 ? 'It never runs' : undefined)
  // A timeout past the shortest gap between runs lets them overlap.
  const gaps = upcoming.slice(1).map((d, i) => (d.getTime() - upcoming[i].getTime()) / 60_000)
  const overlaps = routineMode && timeout !== undefined && gaps.length > 0 && timeout > Math.min(...gaps)

  const groups = (snapshot?.workspaceGroups ?? [])
    .filter((g) => g.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  // A group deleted since it was chosen falls back to none.
  const wantedGroup = form.groupId !== undefined ? form.groupId : seed?.groupId ?? null
  const groupId = groups.some((g) => g.groupId === wantedGroup) ? wantedGroup : null
  // With no parent, an entry waits for room in a group with a workspace limit.
  const limited = groups.find((g) => g.groupId === groupId && g.workspaceLimit !== undefined)
  if (limited !== undefined || start === START_WHEN_ROOM) {
    options.splice(1, 0, {
      value: START_WHEN_ROOM,
      label: limited !== undefined ? `When “${clip(limited.name, 40)}” has room` : 'When its group has room',
    })
  }
  // Offer the sidebar's groups, groups queued workspaces will launch into
  // (the sidebar doesn't show those yet), and the current choice.
  const routineGroup = routineMode && editingRoutine === undefined && form.groupId === undefined
  const offeredGroups = shownGroups(groups, [
    ...(snapshot?.workspaces ?? []),
    ...(snapshot?.provisioning ?? []),
    ...(snapshot?.heldWorkspaces ?? []),
    ...entries,
    ...(groupId !== null ? [{ groupId }] : []),
  ])
  const newGroupName = newGroup === null ? '' : normalizeTitle(newGroup)
  const titleText = normalizeTitle(title)
  const titleEdit = useInlineEdit(title, (t) => update({ title: t }))

  const tool = form.tool ?? seed?.tool ?? defaults.lastTool
  const base = defaults.forTool(tool)
  const picks = form.picked?.tool === tool ? form.picked.picks : {}
  const setPicks = (patch: ToolCreateDefaults): void => update({ picked: { tool, picks: { ...picks, ...patch } } })
  // A seed's model/mode/posture apply only if it is for the same tool.
  const fromSeed = seed !== undefined && seed.tool === tool ? seed : undefined
  const model = picks.model ?? fromSeed?.model ?? base.model
  const mode = picks.mode ?? fromSeed?.mode ?? base.mode
  const seededPosture = fromSeed?.permissionMode !== undefined
    && toolSupportsPermissionMode(tool, fromSeed.permissionMode)
    ? fromSeed.permissionMode
    : undefined
  const permissionMode = picks.permissionMode ?? seededPosture ?? base.permissionMode
  const modelOption = base.models.find((m) => m.id === model)
  const modelName = modelOption?.name
  // Picked, seeded or remembered, where this model has it; else its default.
  // A model with no levels (or none known) has no effort.
  const efforts = modelOption?.efforts
  const effort = efforts !== undefined
    ? effortFor(efforts, picks.effort ?? fromSeed?.effort ?? base.effort)
    : undefined
  const signedIn = defaults.configured.has(tool)
  const needsGitAuth = defaults.ready && !defaults.hasGitCredential

  const { data: branchData, isError: branchesFailed } = useProjectBranches(projectId)

  // On open, refetch credentials; they may have changed via the CLI.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
  }, [queryClient])

  // Focus the prompt on open, so keys typed right after the shortcut land.
  useLayoutEffect(() => {
    if (!dialogHoldsFocus() && !focusRaisesKeyboard()) promptRef.current?.focus()
  }, [focusNonce])

  // Grow the prompt to fit, up to its CSS max-height.
  useLayoutEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [prompt])

  // Untouched branch: the parent's, else the project's last-used branch if
  // origin still has it, else origin's default. The last-used branch can't
  // be submitted until the branch list confirms it; if the list fails, it is
  // dropped and the server picks origin's default.
  const defaultBranch = branchData?.defaultBranch
  const lastBranch = defaults.lastBranch !== undefined && !branchesFailed
    && (branchData === undefined || branchData.branches.includes(defaults.lastBranch))
    ? defaults.lastBranch
    : undefined
  const branchValue = form.branch ?? seed?.branch ?? lastBranch ?? defaultBranch ?? ''
  const branchUnverified = branchData === undefined && lastBranch !== undefined
    && form.branch === undefined && seed?.branch === undefined

  // An untitled edit or draft is headed by the title generated from its
  // prompt until the prompt changes.
  const text = prompt.trim()
  const generatedTitle = text === form.savedPrompt ? fromRow?.generatedTitle : undefined
  const shownTitle = titleText || (routineMode ? 'New routine'
    : generatedTitle || (editing !== undefined ? 'Queued workspace' : 'New workspace'))
  // A draft keeps a delay as the time it comes to.
  const current: DraftWorkspaceSettings = {
    prompt: text,
    tool,
    mode,
    permissionMode,
    ...(model !== '' ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(branchValue !== '' ? { branch: branchValue } : {}),
    ...(afterParent && start !== START_WHEN_ROOM ? { startAfter: start } : {}),
    ...(start === START_AT && form.startAt !== undefined ? { startAt: form.startAt } : {}),
    ...(startIn !== undefined ? { startAt: new Date(Date.now() + startIn * 60_000).toISOString() } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(routineMode ? { cron, timeZone: routineZone } : {}),
    ...(titleText !== '' ? { title: titleText } : {}),
    ...(groupId !== null ? { groupId } : {}),
  }
  // Leaving loses a typed prompt on a create (not an edit of a queued
  // entry or routine), unless it matches the reopened draft exactly.
  const saved = draft !== undefined ? { ...draft, prompt: form.savedPrompt ?? draft.prompt } : undefined
  const pending: PendingDraft | null = form.editId === undefined && form.editRoutineId === undefined && text !== ''
    && (saved === undefined || DRAFT_FIELDS.some((k) => current[k] !== saved[k]))
    ? { projectId, settings: current, ...(draft !== undefined ? { id: draft.id } : {}) }
    : null
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => guardNewWorkspace(() => pendingRef.current), [])

  // Why nothing can be started, or null. Half-typed model/branch text is a
  // search, not a pick, so it blocks. A queued entry stores concrete
  // settings, so it also needs a model and a branch.
  const storesEntry = queued || editing !== undefined
  const blocked = !defaults.ready || loadingPrompt ? 'Loading…'
    : needsGitAuth ? 'Add git authentication first'
    : !signedIn ? `Sign in to ${TOOL_LABEL[tool]} first`
    : modelQuery !== null ? 'Pick a model from the list'
    : branchQuery !== null ? 'Pick a branch from the list'
    : branchUnverified ? 'Loading branches…'
    : !toolSupportsPermissionMode(tool, permissionMode) ? 'Pick a permission mode this agent offers'
    : storesEntry && model === '' ? 'Pick a model'
    : storesEntry && branchValue === '' ? 'Pick a branch'
    : newGroup !== null && newGroupName === '' ? 'Name the new group'
    : timeoutText !== '' && timeout === undefined ? 'Give the timeout as a duration like 1h30m'
    : start === START_AT && form.startAt === undefined ? 'Pick a start time'
    : start === START_IN && startIn === undefined ? 'Give the delay as a duration like 2h30m'
    : routineMode && titleText === '' ? 'Name the routine'
    : scheduleError ?? null
  const submitLabel = editing !== undefined || editingRoutine !== undefined ? 'Save'
    : routineMode ? 'Create routine' : queued ? 'Queue' : 'Create'

  // A routine needs a name, so its name box opens as soon as it is one.
  useEffect(() => { if (routineMode && titleText === '') titleEdit.start() }, [routineMode])

  /** Run `op`, showing its failure; the form is dropped once it succeeds. */
  const run = (op: Promise<unknown>): void => {
    setBusy(true)
    setError(null)
    op.then(() => setForm(null), (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const group = newGroup !== null ? { newGroup: newGroupName } : groupId !== null ? { groupId } : {}
  /** Why the workspace can't start now from a button, or null. */
  const startBlocked = blocked ?? (storesEntry ? 'Set Start to Now to start it here' : null)

  /** Create now, with the typed prompt if any, opening `pane` once it is up.
   *  The server deletes a source draft only once the create succeeds. */
  const startNow = (pane?: LaunchPane): void => {
    if (busy || startBlocked !== null) return
    setForm(null)
    createWorkspace({
      projectId,
      tool,
      mode,
      permissionMode,
      model,
      ...(modelName !== undefined ? { modelName } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(text !== '' ? { prompt: text } : {}),
      ...(titleText !== '' ? { title: titleText } : {}),
      ...(generatedTitle !== undefined ? { shownTitle: generatedTitle } : {}),
      ...(branchValue !== '' ? { branch: branchValue } : {}),
      ...group,
      ...(draft !== undefined && text !== '' ? { draftId: draft.id } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(pane !== undefined ? { pane } : {}),
    })
  }

  /** Create or save the routine, then show its pane. A draft it was made
   *  from is discarded once it exists. */
  const saveRoutine = (): void => {
    const settings = {
      name: titleText,
      cron,
      timeZone: routineZone,
      prompt: text,
      tool,
      model,
      mode,
      permissionMode,
      ...(effort !== undefined ? { effort } : {}),
      branch: branchValue,
    }
    const group = newGroup !== null ? newGroupName : groupId
    const show = (id: string): void => {
      setForm(null)
      useUiStore.getState().openRoutine(projectId, id)
    }
    run(editingRoutine !== undefined
      ? api.routine.update.$post({ json: { id: editingRoutine.id, ...settings, group, timeout: timeout ?? null } })
        .then(() => show(editingRoutine.id))
      : api.routine.create.$post({
        json: {
          project: projectId,
          ...settings,
          ...(routineGroup ? {} : { group }),
          ...(timeout !== undefined ? { timeout } : {}),
        },
      }).then((r) => {
        if (draft !== undefined) {
          api.workspace.draft.discard.$post({ json: { id: draft.id } })
            .catch((e: unknown) => console.error('draft discard failed', e))
        }
        show(r.id)
      }))
  }

  /** Send: create, queue or save the entry, which needs a prompt. */
  const submit = (): void => {
    if (busy || blocked !== null || text === '') return
    if (!storesEntry) {
      startNow()
      return
    }
    if (routineMode) {
      saveRoutine()
      return
    }
    const settings = {
      prompt: text,
      tool,
      model,
      mode,
      permissionMode,
      ...(effort !== undefined ? { effort } : {}),
      branch: branchValue,
      title: titleText,
      group: newGroup !== null ? newGroupName : groupId,
    }
    // Expand the sidebar section the entry lands in, if it is under a parent
    // or waits for room.
    const reveal = (e: QueuedWorkspaceEntry): void => {
      if (e.startAt === undefined) useUiStore.getState().setRevealQueued({ id: e.id, parent: queuedParentId(e) })
    }
    const when = start === START_AT ? { startAt: form.startAt ?? '' }
      : start === START_IN ? { startIn: startIn ?? 0 }
      : start === START_WHEN_ROOM ? {}
      : { parent: start }
    const moved = editing !== undefined && queued && (start === START_IN
      || (start === START_AT ? form.startAt !== editing.startAt : start !== entryStart(editing)))
    const queue = api.workspace.queue
    run(editing === undefined
      ? queue.create.$post({
        json: {
          project: projectId,
          ...when,
          ...settings,
          ...(timeout !== undefined ? { timeout } : {}),
          ...(draft !== undefined ? { draftId: draft.id } : {}),
        },
      }).then(reveal)
      : queue.update.$post({ json: {
        id: editing.id, ...settings, timeout: timeout ?? null,
        ...(moved ? start === START_WHEN_ROOM ? { parent: null } : when : {}),
      } })
        .then(async (e) => {
          // "Now" on a queued workspace is Save then Run now.
          if (!queued) await queue.run.$post({ json: { id: editing.id } })
          else if (moved) reveal(e)
        }))
  }

  // Enter submits, except on a button or Shift+Enter in the prompt. A
  // highlighted typeahead suggestion consumes Enter first.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.target instanceof HTMLButtonElement) return
    if (e.shiftKey && e.target instanceof HTMLTextAreaElement) return
    e.preventDefault()
    submit()
  }

  // The queued entry started or was discarded, or the routine deleted, since
  // it was opened.
  const routineGone = form.editRoutineId !== undefined && editingRoutine === undefined
  if ((form.editId !== undefined && editing === undefined) || routineGone) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
        <p className="text-sm font-medium text-text-dim">{routineGone ? 'Routine gone' : 'Queued workspace gone'}</p>
        <p className="text-xs text-text-faint">
          {routineGone ? 'It has been deleted.' : 'It has already started or been discarded.'}
        </p>
        <button type="button" onClick={() => setForm(null)} className={BUTTON}>Start a new workspace</button>
      </div>
    )
  }

  const sendTitle = blocked ?? (text === '' ? 'Type a prompt' : `${submitLabel} (Enter)`)

  return (
    <div onKeyDown={onKeyDown} className="@container flex h-full w-full flex-col bg-bg">
      {bar !== null && createPortal(
        <>
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-0.5">
            {titleEdit.editing ? (
              <input
                ref={titleEdit.inputRef}
                aria-label={routineMode ? 'Routine name' : 'Workspace title'}
                defaultValue={titleEdit.seed}
                placeholder={routineMode ? 'Routine name' : 'Generated from the prompt'}
                maxLength={MAX_TITLE_LENGTH}
                onKeyDown={(e) => {
                  // Enter and Escape finish the title, not the form.
                  if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation()
                  titleEdit.handleKeyDown(e)
                }}
                onBlur={titleEdit.handleBlur}
                className="no-drag min-w-0 flex-1 rounded border border-border-strong bg-bg px-1.5 py-0.5
                  font-medium text-text outline-none placeholder:font-normal placeholder:text-text-faint"
              />
            ) : (
              <>
                <h2 className="min-w-0 truncate font-medium text-text">{shownTitle}</h2>
                <button
                  type="button"
                  onClick={titleEdit.start}
                  title={routineMode ? 'Name routine' : 'Rename workspace'}
                  aria-label={routineMode ? 'Name routine' : 'Rename workspace'}
                  className="no-drag flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-faint
                    transition hover:bg-surface-2 hover:text-text"
                >
                  <RenameIcon size={12} />
                </button>
              </>
            )}
          </span>
          <ContainerlessBadge />
          {isMobile ? (
            <PaneOverflowMenu
              tool={tool}
              onNewShell={() => startNow('shell')}
              onOpenFiles={() => startNow('files')}
              onOpenChanges={() => startNow('changes')}
              {...(startBlocked !== null ? { disabled: startBlocked } : {})}
            />
          ) : (
            <PaneBarActions
              onNewShell={() => startNow('shell')}
              onOpenFiles={() => startNow('files')}
              onOpenChanges={() => startNow('changes')}
              {...(startBlocked !== null ? { disabled: startBlocked } : {})}
              titles={{
                shell: 'Start the workspace and open a shell',
                files: 'Start the workspace and browse its files',
                changes: 'Start the workspace and show its changes',
              }}
            />
          )}
        </>,
        bar,
      )}
      <div className="flex flex-1 overflow-y-auto px-4 py-4">
        <div className="m-auto w-full max-w-md">
          <Row label="Start">
            <select aria-label="Start" value={start} onChange={(e) => update({ start: e.target.value })} className={SELECT}>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Row>
          {start === START_AT && (
            <Row label="Time">
              <input
                type="datetime-local"
                aria-label={`Start time (${zone})`}
                value={form.startAt !== undefined ? zonedInputValue(form.startAt, zone) : ''}
                onChange={(e) => update({ startAt: zonedInputInstant(e.target.value, zone) })}
                className={INPUT}
              />
              <span className="shrink-0 pt-[5px] text-text-faint">{zone}</span>
            </Row>
          )}
          {start === START_IN && (
            <Row label="Delay">
              <input
                aria-label="Delay"
                value={form.startIn ?? ''}
                onChange={(e) => update({ startIn: e.target.value })}
                placeholder="e.g. 2h30m"
                className={INPUT}
              />
            </Row>
          )}
          {routineMode && (
            <RoutineSchedule
              cron={cron}
              custom={form.customCron === true}
              timeZone={routineZone}
              upcoming={upcoming}
              error={scheduleError}
              onChange={update}
            />
          )}

          <Row label="Group">
            {newGroup === null ? (
              <select
                aria-label="Group"
                value={routineGroup ? ROUTINE_GROUP : groupId ?? ''}
                onChange={(e) => {
                  if (e.target.value === NEW_GROUP) setNewGroup('')
                  else if (e.target.value === ROUTINE_GROUP) update({ groupId: undefined })
                  else update({ groupId: e.target.value === '' ? null : e.target.value })
                }}
                className={SELECT}
              >
                {routineMode && editingRoutine === undefined && (
                  <option value={ROUTINE_GROUP}>New group: {titleText || 'the routine’s name'}</option>
                )}
                <option value="">None</option>
                {offeredGroups.map((g) => <option key={g.groupId} value={g.groupId}>{g.name}</option>)}
                <option value={NEW_GROUP}>+ New group</option>
              </select>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <input
                  ref={newGroupRef}
                  aria-label="New group name"
                  value={newGroup}
                  maxLength={MAX_TITLE_LENGTH}
                  onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => {
                    // Escape goes back to the dropdown.
                    if (e.key !== 'Escape') return
                    e.preventDefault()
                    e.stopPropagation()
                    setNewGroup(null)
                  }}
                  placeholder="New group name"
                  className={INPUT}
                />
                <button
                  type="button"
                  onClick={() => setNewGroup(null)}
                  title="Pick an existing group"
                  aria-label="Pick an existing group"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-faint transition
                    hover:bg-surface-3 hover:text-text"
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            )}
          </Row>

          <Row label="Timeout">
            <input
              aria-label="Timeout"
              value={form.timeout ?? ''}
              onChange={(e) => update({ timeout: e.target.value })}
              placeholder={routineMode ? 'until next run' : 'No limit'}
              className={INPUT}
            />
          </Row>
          {overlaps && <div className={NOTE}>Runs may overlap</div>}

          <Row label="Base branch">
            <div className="min-w-0 flex-1">
              <BranchPicker
                branches={branchData?.branches ?? []}
                defaultBranch={defaultBranch}
                query={branchQuery ?? branchValue}
                onQueryChange={setBranchQuery}
                onSelect={(b) => { update({ branch: b }); setBranchQuery(null) }}
                showList={branchQuery !== null}
                placeholder={branchData ? '' : branchesFailed ? 'origin\'s default branch' : 'loading branches…'}
                ariaLabel="Base branch"
                autoHighlight
                onBlur={() => setBranchQuery(null)}
                onDismiss={() => setBranchQuery(null)}
              />
            </div>
          </Row>
          {queued && <div className={NOTE}>latest from origin when it starts</div>}

          <Row label="Agent">
            <select
              aria-label="Agent"
              value={tool}
              onChange={(e) => {
                // A different agent brings its own remembered defaults.
                const next = e.target.value as AgentTool
                update({ tool: next, picked: { tool: next, picks: {} } })
                setModelQuery(null)
              }}
              className={SELECT}
            >
              {AGENT_TOOLS.map((t) => (
                <option key={t} value={t}>
                  {TOOL_LABEL[t]}{defaults.configured.has(t) ? '' : ' (sign in)'}
                </option>
              ))}
            </select>
          </Row>

          {needsGitAuth ? (
            <Notice
              text="This project has no git credential"
              action="Add git authentication…"
              onClick={() => openSettings('credentials', undefined, projectId)}
            />
          ) : !defaults.ready || signedIn ? (
            <>
              <Row label="Model">
                <div className="min-w-0 flex-1">
                  <Typeahead
                    items={base.models.map((m) => ({
                      value: m.id,
                      label: m.name ?? m.id,
                      ...(m.name !== undefined ? { detail: m.id } : {}),
                    }))}
                    query={modelQuery ?? modelName ?? model}
                    onQueryChange={setModelQuery}
                    onSelect={(id) => { setPicks({ model: id }); setModelQuery(null) }}
                    showList={modelQuery !== null}
                    ariaLabel="Model"
                    autoHighlight
                    tag={(item) => item.value === base.defaultModel && <span>default</span>}
                    onBlur={() => setModelQuery(null)}
                    onDismiss={() => setModelQuery(null)}
                  />
                </div>
              </Row>
              <Row label="UI" title={MODE_HELP[mode]}>
                <select
                  aria-label="UI"
                  value={mode}
                  onChange={(e) => setPicks({ mode: e.target.value as AgentMode })}
                  className={SELECT}
                >
                  {(['tui', 'acp'] as const).map((m) => <option key={m} value={m}>{MODE_COPY[m]}</option>)}
                </select>
              </Row>
            </>
          ) : (
            <Notice
              text={`${TOOL_LABEL[tool]} has no credentials`}
              action={`Sign in to ${TOOL_LABEL[tool]}…`}
              onClick={() => openSettings('credentials', tool)}
            />
          )}

          {editing === undefined && editingRoutine === undefined && (
            <div className="mt-3 flex gap-2 px-1 max-md:flex-col">
              {!queued && (
                <button
                  type="button"
                  onClick={() => startNow()}
                  disabled={busy || blocked !== null || text !== ''}
                  title={blocked ?? (text !== ''
                    ? 'A prompt is typed: send it instead'
                    : `Start the ${MODE_COPY[mode].toLowerCase()} with nothing sent to the agent`)}
                  className={BUTTON}
                >
                  {mode === 'tui' ? <TerminalIcon size={12} /> : <ChatIcon size={12} />}
                  Start without a prompt
                </button>
              )}
              <button
                type="button"
                onClick={() => { if (pending !== null) run(keepDraft(pending)) }}
                disabled={busy || pending === null}
                title={pending !== null ? undefined : text === '' ? 'Type a prompt to save a draft' : 'No changes to save'}
                className={BUTTON}
              >
                Save draft
              </button>
            </div>
          )}
        </div>
      </div>

      <ChatBottomBar
        above={error !== null && <div className="mb-1.5 px-1 text-xs text-danger">{error}</div>}
        onClick={(e) => { if (e.target === e.currentTarget) promptRef.current?.focus() }}
      >
        <textarea
          ref={promptRef}
          aria-label="Prompt"
          rows={1}
          value={prompt}
          readOnly={loadingPrompt}
          onChange={(e) => update({ prompt: e.target.value })}
          placeholder={queued || editing !== undefined ? 'What should it do?' : 'Message the agent…'}
          className={COMPOSER_INPUT}
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="mr-auto flex min-w-0 items-center">
            {signedIn && (
              <PermissionModeSelect
                current={permissionMode}
                available={SUPPORTED_PERMISSION_MODES[tool]}
                disabled={false}
                onSelect={(m) => setPicks({ permissionMode: m })}
              />
            )}
            {signedIn && efforts !== undefined && effort !== undefined && (
              <EffortSelect
                current={effort}
                available={efforts.levels.map((l) => ({ value: l, name: effortLabel(l) }))}
                disabled={false}
                onSelect={(e) => setPicks({ effort: e })}
              />
            )}
            {routineMode && (
              <span className="ml-1 truncate text-[11px] text-text-faint" title={UNATTENDED}>{UNATTENDED}</span>
            )}
          </div>
          <button
            type="button"
            aria-label={submitLabel}
            title={sendTitle}
            onClick={() => submit()}
            disabled={busy || blocked !== null || text === ''}
            className={ROUND_BUTTON}
          >
            <SendIcon size={15} strokeWidth={2.5} />
          </button>
        </div>
      </ChatBottomBar>
    </div>
  )
}

const UNATTENDED = 'Runs start unattended. A run that asks for permission waits for you until it is stopped.'

const REPEAT_COPY: Record<RepeatKind, string> = {
  minutes: 'Every N minutes',
  hourly: 'Hourly',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
  monthly: 'Monthly',
}

const SMALL_INPUT = 'h-[26px] w-14 shrink-0 rounded-md border border-border bg-surface-2 px-1.5 text-xs text-text '
  + 'outline-none focus:border-border-strong'

/** Every zone this browser knows, for the routine zone picker. */
const ZONES = [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])].map((z) => ({ value: z, label: z }))

/**
 * A routine's Repeats row: a preset with its own inputs, or Custom with the
 * cron itself, and a chip for the zone the schedule is read in. Under it,
 * the cron a preset compiles to (clicking it switches to Custom) and the
 * next runs, or why the schedule is no good.
 */
function RoutineSchedule({ cron, custom, timeZone, upcoming, error, onChange }: {
  cron: string
  custom: boolean
  timeZone: string
  upcoming: Date[]
  error: string | undefined
  onChange: (patch: Pick<NewWorkspaceForm, 'cron' | 'customCron' | 'timeZone'>) => void
}): JSX.Element {
  const repeat = custom ? undefined : parseRepeat(cron)
  const set = (patch: Partial<Repeat>): void => onChange({ cron: compileRepeat({ ...(repeat ?? DEFAULT_REPEAT), ...patch }) })
  /** A number input that ignores values outside `min`–`max`. */
  const num = (label: string, value: number, min: number, max: number, apply: (n: number) => void): JSX.Element => (
    <NumberInput
      aria-label={label}
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isInteger(n) && n >= min && n <= max) apply(n)
      }}
      className="h-[26px] w-14 shrink-0 bg-surface-2"
    />
  )
  const pad = (n: number): string => String(n).padStart(2, '0')
  // null = the chip; a string = the zone picker's query.
  const [zoneQuery, setZoneQuery] = useState<string | null>(null)
  const picker = useRef<HTMLDivElement>(null)
  useEffect(() => { if (zoneQuery !== null) picker.current?.querySelector('input')?.focus() }, [zoneQuery !== null])

  return (
    <>
      <Row label="Repeats">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <select
            aria-label="Repeats"
            value={repeat?.kind ?? 'custom'}
            onChange={(e) => {
              const kind = e.target.value
              if (kind === 'custom') onChange({ customCron: true })
              else onChange({ customCron: false, cron: compileRepeat({ ...(parseRepeat(cron) ?? DEFAULT_REPEAT), kind: kind as RepeatKind }) })
            }}
            className={SELECT}
          >
            {REPEAT_KINDS.map((k) => <option key={k} value={k}>{REPEAT_COPY[k]}</option>)}
            <option value="custom">Custom (cron)</option>
          </select>
          {repeat === undefined ? (
            <input
              aria-label="Cron expression"
              value={cron}
              onChange={(e) => onChange({ cron: e.target.value })}
              placeholder="0 9 * * 1-5"
              className={clsx(INPUT, 'font-mono')}
            />
          ) : repeat.kind === 'minutes' ? (
            <select
              aria-label="Minutes between runs"
              value={repeat.every}
              onChange={(e) => set({ every: Number(e.target.value) })}
              className={SELECT}
            >
              {EVERY_MINUTES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )
            : repeat.kind === 'hourly' ? num('Minute past the hour', repeat.minute, 0, 59, (minute) => set({ minute }))
            : (
              <>
                {repeat.kind === 'weekly' && WEEK.map((d) => {
                  const on = repeat.days.includes(d.day)
                  return (
                    <button
                      key={d.day}
                      type="button"
                      aria-label={d.name}
                      aria-pressed={on}
                      // The last day stays on: a week of no days never runs.
                      onClick={() => { if (!on || repeat.days.length > 1) set({ days: on ? repeat.days.filter((x) => x !== d.day) : [...repeat.days, d.day] }) }}
                      className={clsx('h-[26px] w-6 shrink-0 rounded-md border text-[11px]', on
                        ? 'border-border-strong bg-surface-3 text-text'
                        : 'border-border text-text-faint hover:text-text-dim')}
                    >
                      {d.short}
                    </button>
                  )
                })}
                {repeat.kind === 'monthly' && num('Day of month', repeat.day, 1, 31, (day) => set({ day }))}
                <input
                  type="time"
                  aria-label="Time of day"
                  value={`${pad(repeat.hour)}:${pad(repeat.minute)}`}
                  onChange={(e) => {
                    const [hour, minute] = e.target.value.split(':').map(Number)
                    if (Number.isInteger(hour) && Number.isInteger(minute)) set({ hour, minute })
                  }}
                  className={clsx(SMALL_INPUT, 'w-auto')}
                />
              </>
            )}
          <button
            type="button"
            onClick={() => setZoneQuery('')}
            title="Change the time zone it runs in"
            aria-label={`Time zone: ${timeZone}`}
            className="h-[26px] shrink-0 rounded-md bg-surface-2 px-2 text-[11px] text-text-dim transition
              hover:bg-surface-3 hover:text-text"
          >
            {timeZone}
          </button>
        </div>
      </Row>
      {zoneQuery !== null && (
        <Row label="Time zone">
          <div ref={picker} className="min-w-0 flex-1">
            <Typeahead
              items={ZONES}
              query={zoneQuery}
              onQueryChange={setZoneQuery}
              onSelect={(z) => { onChange({ timeZone: z }); setZoneQuery(null) }}
              showList
              ariaLabel="Time zone"
              autoHighlight
              onBlur={() => setZoneQuery(null)}
              onDismiss={() => setZoneQuery(null)}
            />
          </div>
        </Row>
      )}
      <div className={NOTE}>
        {repeat !== undefined && (
          <button
            type="button"
            onClick={() => onChange({ customCron: true })}
            title="Edit it as cron"
            className="block font-mono hover:text-text-dim"
          >
            cron: {cron}
          </button>
        )}
        <p role="status" className={clsx(error !== undefined && 'text-danger')}>
          {error ?? `Next: ${upcoming.slice(0, 3).map((d) => formatInZone(d, timeZone)).join(' · ')}`}
        </p>
      </div>
    </>
  )
}

/** A form row: fixed-width label, then the control (which has its own
 *  aria-label). */
function Row({ label, title, children }: { label: string; title?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mb-1 flex items-start gap-2 px-1 py-0.5 text-xs text-text-dim" title={title}>
      <span className="w-[76px] shrink-0 pt-[5px]">{label}</span>
      {children}
    </div>
  )
}

/** What stops the form from creating, with the way to fix it. */
function Notice({ text, action, onClick }: { text: string; action: string; onClick: () => void }): JSX.Element {
  return (
    <div className="mb-1 flex items-center gap-2 px-1 py-0.5 text-xs text-text-faint">
      <span className="flex-1">{text}</span>
      <button type="button" onClick={onClick} className={BUTTON}>{action}</button>
    </div>
  )
}

/**
 * Asks, when the user navigates away from the new-workspace pane with a
 * typed prompt (`navigate` in the store), whether to save it as a draft.
 * Save keeps it in the sidebar, Discard drops it, and either then goes on;
 * Escape or "Keep editing" stays. Mounted once in App.
 */
export function LeaveNewWorkspaceDialog(): JSX.Element {
  const leaving = useUiStore((s) => s.leaving)
  const stay = useUiStore((s) => s.stayOnNewWorkspace)
  const save = useMutation({ mutationFn: keepDraft })
  // Kept through the close animation, when `leaving` is already null.
  const last = useRef(leaving)
  if (leaving !== null) last.current = leaving
  const editing = last.current?.draft.id !== undefined
  return (
    <ConfirmDialog
      open={leaving !== null}
      onOpenChange={(next) => { if (!next) { save.reset(); stay() } }}
      destructive={false}
      title={editing ? 'Save changes to this draft?' : 'Save as a draft?'}
      description={editing
        ? 'Discarding keeps the draft as it was saved.'
        : 'A draft keeps the prompt and settings in the sidebar, to create from later.'}
      cancelLabel="Keep editing"
      alternative={{ label: editing ? 'Discard changes' : 'Discard', onClick: () => leaving?.leave() }}
      confirmLabel={editing ? 'Save changes' : 'Save draft'}
      busy={save.isPending}
      error={save.error?.message}
      onConfirm={() => { if (leaving !== null) save.mutate(leaving.draft, { onSuccess: leaving.leave }) }}
    />
  )
}

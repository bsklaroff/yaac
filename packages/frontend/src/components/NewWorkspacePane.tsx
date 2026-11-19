import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChatIcon, CloseIcon, RenameIcon, RunIcon, SendIcon, SiteIcon, TerminalIcon, TOOL_LABEL, WorkflowIcon } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { AgentSettings, PermissionModeSelect } from '#components/ComposerSettings'
import { ChatBottomBar, COMPOSER_INPUT } from '#components/ConversationView'
import { ContainerlessBadge } from '#components/ContainerlessBadge'
import { PaneBarActions, PaneOverflowMenu } from '#components/PaneBar'
import { SiteForm } from '#components/SitePane'
import { StepList } from '#components/WorkflowPane'
import { api } from '#lib/api'
import { openSession } from '#lib/createWorkspace'
import { sessionTarget } from '#lib/panes'
import { dialogHoldsFocus } from '#lib/dialogFocus'
import { shownGroups } from '#lib/groups'
import { entryStart, SCHEDULE, START_AT, START_IN, START_WHEN_ROOM, type NewWorkspaceForm, type PendingDraft } from '#lib/newWorkspace'
import { compileRepeat, DEFAULT_REPEAT, EVERY_MINUTES, parseRepeat, REPEAT_KINDS, WEEK, type Repeat, type RepeatKind } from '#lib/routines'
import { useTimeZone, zonedInputInstant, zonedInputValue } from '#lib/time'
import { checkoutLabel } from '#lib/checkouts'
import { useStartSelection, type RepoRow } from '#lib/useStartSelection'
import { clip, fetchFullPrompt, queuedDescendants, queuedInTreeOrder, queuedParentId, queuedTitle } from '#lib/queued'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { useCreateDefaults, useCreateWorkspace } from '#lib/useCreateDefaults'
import { useInlineEdit } from '#lib/useInlineRename'
import { useSnapshot } from '#lib/useSnapshot'
import { useVolumes } from '#lib/volumes'
import { guardNewWorkspace, useUiStore, type LaunchPane } from '#lib/store'
import { focusRaisesKeyboard, useIsMobile } from '#lib/viewport'
import {
  AGENT_TOOLS,
  SUPPORTED_PERMISSION_MODES,
  effortFor,
  resolveAgentOptions,
  toolAgentOptions,
  toolSupportsPermissionMode,
} from '@yaac/shared/types'
import { ServerError } from '@yaac/shared/errors'
import { cronError, formatInZone, isTimeZone, nextCronRuns, parseDuration } from '@yaac/shared/schedule'
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'
import type {
  AgentMode,
  AgentOptions,
  AgentTool,
  DraftWorkspaceSettings,
  PermissionMode,
  QueuedWorkspaceEntry,
  RepoSelection,
  ToolCreateDefaults,
  WorkspaceListEntry,
} from '@yaac/shared/types'
import {
  cn, YButton, YCheckbox, YChip, YConfirm, YEmptyState, YInput, YNumberInput, YPageBody, YSection, YSelect, YSettingGroup,
  YSettingRow, YTabs, YTextArea, YTypeahead,
} from '#ui'

const MODE_COPY: Record<AgentMode, string> = { tui: 'Terminal', acp: 'Chat' }

/** A control's width in a setting row; full width on a phone, where the
 *  row stacks. */
const CONTROL = 'w-64 max-md:w-full'

/** The tabs: what the pane starts. */
const KINDS: Array<{ value: 'agent' | 'workflow' | 'site'; label: string; help: string; Icon: typeof ChatIcon }> = [
  { value: 'agent', label: 'Agent', help: 'A workspace with an agent to talk to', Icon: ChatIcon },
  { value: 'workflow', label: 'Workflow', help: 'An unattended run of a named workflow', Icon: WorkflowIcon },
  { value: 'site', label: 'Site', help: 'A site that publishes the project’s app', Icon: SiteIcon },
]

/** The workflow pickers' "+ New workflow…" option. */
const NEW_WORKFLOW = '\u0000new-workflow'


/** A parent's settings, used to fill untouched fields when Start names it.
 *  Absent for "Now", which uses the project's remembered defaults. */
interface Seed {
  tool?: AgentTool
  model?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
  effort?: string
  agentOptions?: AgentOptions
  /** What it started with: its repos at their base branches, their layout
   *  and its cwd. */
  selection?: RepoSelection
  groupId?: string
}

interface StartOption {
  /** '' is "Now"; anything else is the parent's id. */
  value: string
  label: string
  seed?: Seed
}

/** A live workspace's settings, from its first session and its row. The
 *  model is that session's current one, so a `/model` switch carries over
 *  to a child. */
function workspaceSeed(w: WorkspaceListEntry): Seed {
  const [first] = w.sessions
  return {
    ...(first !== undefined ? {
      tool: first.tool,
      mode: first.mode,
      permissionMode: first.permissionMode,
      ...(first.model !== undefined ? { model: first.model } : {}),
      ...(first.effort !== undefined ? { effort: first.effort } : {}),
      agentOptions: first.agentOptions,
    } : {}),
    selection: {
      repos: w.repos.map((r) => ({
        repo: r.repoId,
        ...(r.baseBranch !== undefined ? { branch: r.baseBranch } : r.startCommit !== undefined ? { commit: r.startCommit } : {}),
      })),
      nested: w.repos.some((r) => r.path !== ''),
      cwd: w.repos.find((r) => r.path === w.cwd)?.repoId ?? '.',
    },
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
    agentOptions: e.agentOptions,
    selection: e.selection,
    ...(e.groupId !== undefined ? { groupId: e.groupId } : {}),
  }
}

/** The Group dropdown's "+ New group" option, which swaps it for a name box. */
const NEW_GROUP = '\u0000new'
/** A new routine's or unattended run's untouched group: the one the server
 *  makes for the routine or workflow (docs/workspace-groups.md "Owned
 *  groups"). */
const OWN_GROUP = '\u0000own'

const workspaceName = (w: { title?: string; prompt?: string }): string =>
  clip(w.title || w.prompt || 'New workspace', 40)

const DRAFT_FIELDS = [
  'prompt', 'tool', 'mode', 'permissionMode', 'model', 'effort', 'agentOptions', 'repos', 'nested', 'cwd', 'startAfter',
  'title', 'groupId',
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
  const { prompt, title } = form

  const snapshot = useSnapshot()
  // Where the agent runs: a new workspace, or a running one of the project,
  // which takes only an agent's settings (docs/sessions.md). A workspace
  // with no agent starts now and takes no prompt.
  const inTarget = form.inWorkspace !== undefined
    ? (snapshot?.workspaces ?? []).find((w) => w.workspaceId === form.inWorkspace && !w.stopping)
    : undefined
  const inWorkspace = inTarget !== undefined
  const noAgent = form.noAgent === true && !inWorkspace
  // The tab: an agent workspace, an unattended run of a named workflow, or
  // a new site. The workflow is also what an agent workspace's Steps picks.
  const kind = inWorkspace ? undefined : form.kind
  const unattended = kind === 'workflow'
  const workflows = (snapshot?.workflows ?? []).filter((w) => w.projectId === projectId)
  const workflow = workflows.find((w) => w.name === form.workflow)
  const agentless = noAgent || unattended
  const start = inWorkspace || noAgent ? '' : form.start
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
  // What is being typed into each repo's branch field, by repo id; absent =
  // not typing, and the field shows the chosen branch.
  const [branchQueries, setBranchQueries] = useState<Record<string, string>>({})
  const setBranchQuery = (repoId: string, query: string | null): void => setBranchQueries(({ [repoId]: _, ...rest }) => (
    query === null ? rest : { ...rest, [repoId]: query }
  ))
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
        ? { seed: { ...(held.sessions[0] !== undefined ? { tool: held.sessions[0].tool } : {}), ...(held.groupId !== undefined ? { groupId: held.groupId } : {}) } }
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
  // (the sidebar doesn't show those yet), and the current choice. A new
  // routine, or a new unattended run, goes in a group of its own unless
  // another is picked: the routine's, or the workflow's.
  const ownGroupOffered = (routineMode && editingRoutine === undefined) || (unattended && !routineMode && editing === undefined)
  const ownGroup = ownGroupOffered && form.groupId === undefined && newGroup === null
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
  // Each picked, else seeded, else remembered (`base`), else off.
  const agentOptions = resolveAgentOptions(tool, { ...fromSeed?.agentOptions, ...picks.agentOptions }, base.agentOptions)
  // A request names them only for an agent that has any.
  const sentOptions = Object.keys(agentOptions).length > 0 ? { agentOptions } : {}
  const signedIn = defaults.configured.has(tool)

  // What it starts with: the project's repos, each included or not and at
  // a branch, their layout, and the cwd.
  const project = snapshot?.projects.find((p) => p.id === projectId)
  const selection = useStartSelection(project, form, seed?.selection, branchQueries)
  const setRepoPick = (repoId: string, pick: { included?: boolean; branch?: string }): void =>
    update({ repos: { ...form.repos, [repoId]: { ...form.repos?.[repoId], ...pick } } })
  const needsGitAuth = defaults.ready ? selection.needsCredential : undefined
  // A session in a running workspace starts in its root or one checkout.
  const sessionCwds = inTarget !== undefined && inTarget.repos.some((r) => r.path !== '')
    ? ['', ...inTarget.repos.map((r) => r.path).filter((p) => p !== '')]
    : []
  const sessionCwd = form.sessionCwd !== undefined && sessionCwds.includes(form.sessionCwd)
    ? form.sessionCwd
    : inTarget?.cwd ?? ''

  // Only a create now attaches a volume. A choice since deleted, or since
  // attached to another workspace, falls back to none.
  const volumes = useVolumes(projectId)
  const volume = volumes?.find((v) => v.name === form.volume && v.holder === undefined)?.name

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
    agentOptions,
    ...selection.request,
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
  const saved = draft !== undefined
    ? {
      ...draft,
      agentOptions: resolveAgentOptions(draft.tool, draft.agentOptions),
      prompt: form.savedPrompt ?? draft.prompt,
      // In the key order `current` builds its own, to compare as text.
      ...(draft.repos !== undefined ? {
        repos: draft.repos.map(({ repo, branch, commit }) => ({
          repo, ...(branch !== undefined ? { branch } : {}), ...(commit !== undefined ? { commit } : {}),
        })),
      } : {}),
    }
    : undefined
  const pending: PendingDraft | null = form.editId === undefined && form.editRoutineId === undefined && text !== ''
    && !inWorkspace && !agentless
    && (saved === undefined || DRAFT_FIELDS.some((k) => JSON.stringify(current[k]) !== JSON.stringify(saved[k])))
    ? { projectId, settings: current, ...(draft !== undefined ? { id: draft.id } : {}) }
    : null
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => guardNewWorkspace(() => pendingRef.current), [])

  // Why nothing can be started, or null. Half-typed branch text is a
  // search, not a pick, so it blocks. A queued entry stores concrete
  // settings, so it also needs a model and a branch.
  const storesEntry = queued || editing !== undefined
  // A workflow runs only in a workspace with each repo it names.
  const missingRepo = workflow?.repos.find((dir) => !selection.included.some((r) => r.repo.dir === dir))
  const blocked = !defaults.ready || loadingPrompt ? 'Loading…'
    : unattended && workflow === undefined ? 'Pick a workflow'
    : workflow !== undefined && missingRepo !== undefined && !inWorkspace ? `${workflow.name} runs in ${missingRepo}: include it`
    : needsGitAuth !== undefined && !inWorkspace ? 'Add git authentication first'
    : !agentless && !signedIn ? `Sign in to ${TOOL_LABEL[tool]} first`
    : !inWorkspace && selection.blocked(false) !== null ? selection.blocked(false)
    : !agentless && !toolSupportsPermissionMode(tool, permissionMode) ? 'Pick a permission mode this agent offers'
    : storesEntry && !unattended && model === '' ? 'Pick a model'
    : storesEntry && selection.blocked(true) !== null ? selection.blocked(true)
    : !inWorkspace && newGroup !== null && newGroupName === '' ? 'Name the new group'
    : !inWorkspace && timeoutText !== '' && timeout === undefined ? 'Give the timeout as a duration like 1h30m'
    : start === START_AT && form.startAt === undefined ? 'Pick a start time'
    : start === START_IN && startIn === undefined ? 'Give the delay as a duration like 2h30m'
    : routineMode && titleText === '' ? 'Name the routine'
    : scheduleError ?? null
  const submitLabel = editing !== undefined || editingRoutine !== undefined ? 'Save'
    : routineMode ? 'Create routine' : queued ? 'Queue' : unattended ? 'Run now' : inWorkspace ? 'Start session' : 'Create'
  // What it runs: an unattended run of the workflow, or an agent workspace
  // that starts with it in place of the project's init workflows.
  const runs = workflow === undefined ? {} : { workflow: workflow.name, ...(unattended ? { nonInteractive: true as const } : {}) }

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

  /** Open the session in the running workspace Where names, then show it
   *  there, focused once the snapshot lists it. */
  const openHere = (): void => {
    if (busy || blocked !== null || inTarget === undefined) return
    const { workspaceId } = inTarget
    run(openSession(workspaceId, {
      tool,
      mode,
      permissionMode,
      ...(model !== '' ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...sentOptions,
      ...(text !== '' ? { prompt: text } : {}),
      ...(sessionCwds.length > 0 ? { cwd: sessionCwd === '' ? '.' : sessionCwd } : {}),
    }).then((sessionId) => {
      const st = useUiStore.getState()
      st.selectWorkspace(workspaceId)
      st.focusTerminal(workspaceId, sessionTarget(sessionId))
    }))
  }

  /** Create now, with the typed prompt if any, opening `pane` once it is up.
   *  The server deletes a source draft only once the create succeeds. */
  const startNow = (pane?: LaunchPane): void => {
    if (inWorkspace) {
      openHere()
      return
    }
    if (busy || startBlocked !== null) return
    setForm(null)
    createWorkspace({
      projectId,
      ...runs,
      ...(unattended ? {} : noAgent ? { noSession: true } : {
        tool,
        mode,
        permissionMode,
        model,
        ...(modelName !== undefined ? { modelName } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...sentOptions,
        ...(text !== '' ? { prompt: text } : {}),
      }),
      ...(titleText !== '' ? { title: titleText } : {}),
      ...(generatedTitle !== undefined ? { shownTitle: generatedTitle } : {}),
      ...selection.request,
      ...group,
      ...(draft !== undefined && text !== '' ? { draftId: draft.id } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(pane !== undefined ? { pane } : {}),
      ...(volume !== undefined ? { volume } : {}),
    })
  }

  /** Create or save the routine, then show its pane. A draft it was made
   *  from is discarded once it exists. */
  const saveRoutine = (): void => {
    const settings = {
      name: titleText,
      cron,
      timeZone: routineZone,
      ...(unattended ? {} : {
        prompt: text,
        tool,
        model,
        mode,
        permissionMode,
        ...(effort !== undefined ? { effort } : {}),
        ...sentOptions,
      }),
      ...runs,
      ...selection.request,
    }
    const group = newGroup !== null ? newGroupName : groupId
    const show = (id: string): void => {
      setForm(null)
      useUiStore.getState().openObject(projectId, { kind: 'routine', id })
    }
    run(editingRoutine !== undefined
      ? api.routine.update.$post({ json: { id: editingRoutine.id, workflow: null, ...settings, group, timeout: timeout ?? null } })
        .then(() => show(editingRoutine.id))
      : api.routine.create.$post({
        json: {
          project: projectId,
          ...settings,
          ...(ownGroup ? {} : { group }),
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

  /** Send: create, queue or save the entry, which needs a prompt (unless it
   *  starts no agent). */
  const submit = (): void => {
    if (busy || blocked !== null || (text === '' && !agentless)) return
    if (!storesEntry) {
      startNow()
      return
    }
    if (routineMode) {
      saveRoutine()
      return
    }
    const settings = {
      ...(unattended ? {} : {
        prompt: text,
        tool,
        model,
        mode,
        permissionMode,
        ...(effort !== undefined ? { effort } : {}),
        ...sentOptions,
      }),
      ...runs,
      ...selection.request,
      title: titleText,
      ...(ownGroup ? {} : { group: newGroup !== null ? newGroupName : groupId }),
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

  // Enter submits, except on a button, Shift+Enter in the prompt, or in the
  // site form, which submits itself. A highlighted typeahead suggestion
  // consumes Enter first.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.target instanceof HTMLButtonElement || kind === 'site') return
    if (e.shiftKey && e.target instanceof HTMLTextAreaElement) return
    e.preventDefault()
    submit()
  }

  // The queued entry started or was discarded, or the routine deleted, since
  // it was opened.
  const routineGone = form.editRoutineId !== undefined && editingRoutine === undefined
  if ((form.editId !== undefined && editing === undefined) || routineGone) {
    return (
      <YEmptyState
        title={routineGone ? 'Routine gone' : 'Queued workspace gone'}
        description={routineGone ? 'It has been deleted.' : 'It has already started or been discarded.'}
        action={<YButton variant="primary" onClick={() => setForm(null)}>Start a new workspace</YButton>}
        className="h-full bg-surface"
      />
    )
  }

  const sendTitle = blocked ?? (text === '' && !noAgent ? 'Type a prompt' : `${submitLabel} (Enter)`)
  const fresh = form.editId === undefined && form.editRoutineId === undefined && form.draftId === undefined
  // Unknown until the first snapshot, so the Site tab never flashes on containerless.
  const hasSites = snapshot !== undefined && snapshot.driver !== 'containerless'
  const initWorkflows = workflows.filter((w) => w.init).map((w) => w.name)
  const showVolumes = !storesEntry && volumes !== undefined && volumes.length > 0
  const originNote = queued && selection.included.length > 0 ? 'Latest from origin when it starts' : undefined
  /** Pick the workflow it runs, ticking the repos it needs; "+ New
   *  workflow…" opens a new workflow's form instead. */
  const pickWorkflow = (name: string): void => {
    if (name === NEW_WORKFLOW) {
      useUiStore.getState().openObject(projectId, { kind: 'workflow', id: '' })
      return
    }
    const picked = workflows.find((w) => w.name === name)
    const needed = (project?.repos ?? []).filter((r) => picked?.repos.includes(r.dir) === true)
    update({
      workflow: picked?.name,
      repos: { ...form.repos, ...Object.fromEntries(needed.map((r) => [r.id, { ...form.repos?.[r.id], included: true }])) },
    })
  }

  return (
    <div onKeyDown={onKeyDown} className="@container flex h-full w-full flex-col bg-surface">
      {bar !== null && createPortal(
        <>
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-0.5">
            {inTarget !== undefined ? (
              <h2 className="min-w-0 truncate font-medium text-text">New session in “{workspaceName(inTarget)}”</h2>
            ) : kind === 'site' ? (
              <h2 className="min-w-0 truncate font-medium text-text">New site</h2>
            ) : titleEdit.editing ? (
              <YInput
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
                className="no-drag flex-1 font-medium placeholder:font-normal"
              />
            ) : (
              <>
                <h2 className="min-w-0 truncate font-medium text-text">{shownTitle}</h2>
                <YButton
                  variant="ghost"
                  size="sm"
                  icon={RenameIcon}
                  onClick={titleEdit.start}
                  title={routineMode ? 'Name routine' : 'Rename workspace'}
                  aria-label={routineMode ? 'Name routine' : 'Rename workspace'}
                  className="no-drag"
                />
              </>
            )}
          </span>
          <ContainerlessBadge />
          {inWorkspace || kind !== undefined ? null : isMobile ? (
            <PaneOverflowMenu
              label={noAgent ? 'No agent' : TOOL_LABEL[tool]}
              onNewShell={() => startNow('shell')}
              onOpenFiles={() => startNow('files')}
              onOpenChanges={() => startNow('changes')}
              onOpenCommits={() => startNow('commits')}
              {...(startBlocked !== null ? { disabled: startBlocked } : {})}
            />
          ) : (
            <PaneBarActions
              onNewShell={() => startNow('shell')}
              onOpenFiles={() => startNow('files')}
              onOpenChanges={() => startNow('changes')}
              onOpenCommits={() => startNow('commits')}
              {...(startBlocked !== null ? { disabled: startBlocked } : {})}
              titles={{
                shell: 'Start the workspace and open a shell',
                files: 'Start the workspace and browse its files',
                changes: 'Start the workspace and show its changes',
                commits: 'Start the workspace and show its commits',
              }}
            />
          )}
        </>,
        bar,
      )}
      <YPageBody className="gap-5 py-4">
        {fresh && !inWorkspace && (
          <YTabs
            ariaLabel="What to start"
            value={kind ?? 'agent'}
            onChange={(v) => update({ kind: v === 'agent' ? undefined : v })}
            tabs={KINDS.filter((k) => k.value !== 'site' || hasSites).map((k) => ({
              value: k.value,
              icon: k.Icon,
              label: <span title={k.help}>{k.label}</span>,
            }))}
          />
        )}
        {kind === 'site' && project !== undefined ? (
          <SiteForm project={project} onDone={(name) => { setForm(null); useUiStore.getState().openObject(projectId, { kind: 'site', id: name }) }} />
        ) : <>
          {unattended && (
            <YSection title="Workflow">
              <YSettingGroup>
                <YSettingRow
                  dense
                  label="Runs"
                  hint={workflow !== undefined && workflow.secrets.length > 0 && <>
                    Gets {workflow.secrets.join(', ')}; {routineMode ? 'saving approves the branch or commit each run starts at'
                      : queued ? 'when it starts, it approves the commit it runs' : 'running approves the commit it runs'}{' '}
                    for {workflow.secrets.length === 1 ? 'it' : 'them'}
                  </>}
                >
                  <YSelect aria-label="Workflow" value={workflow?.name ?? ''} onChange={(e) => pickWorkflow(e.target.value)} className={CONTROL}>
                    <option value="" disabled>Pick a workflow</option>
                    {workflows.map((w) => <option key={w.id} value={w.name}>{w.name}</option>)}
                    <option value={NEW_WORKFLOW}>+ New workflow…</option>
                  </YSelect>
                </YSettingRow>
                {workflow !== undefined && (
                  <YSettingRow dense label="Steps" stacked>
                    <aside aria-label="Its steps" className="text-md"><StepList steps={workflow.steps} /></aside>
                  </YSettingRow>
                )}
              </YSettingGroup>
            </YSection>
          )}

          <YSection title="Start">
            <YSettingGroup>
              {fresh && live.length > 0 && !unattended && (
                <YSettingRow dense label="Where">
                  <YSelect
                    aria-label="Where"
                    value={inTarget?.workspaceId ?? ''}
                    onChange={(e) => update({ inWorkspace: e.target.value === '' ? undefined : e.target.value })}
                    className={CONTROL}
                  >
                    <option value="">New workspace</option>
                    {live.map((w) => <option key={w.workspaceId} value={w.workspaceId}>In “{workspaceName(w)}”</option>)}
                  </YSelect>
                </YSettingRow>
              )}
              {!inWorkspace && !noAgent && (
                <YSettingRow dense label="When">
                  <YSelect aria-label="Start" value={start} onChange={(e) => update({ start: e.target.value })} className={CONTROL}>
                    {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </YSelect>
                </YSettingRow>
              )}
              {start === START_AT && (
                <YSettingRow dense label="Time" hint={`In ${zone}`}>
                  <YInput
                    type="datetime-local"
                    aria-label={`Start time (${zone})`}
                    value={form.startAt !== undefined ? zonedInputValue(form.startAt, zone) : ''}
                    onChange={(e) => update({ startAt: zonedInputInstant(e.target.value, zone) })}
                    className={CONTROL}
                  />
                </YSettingRow>
              )}
              {start === START_IN && (
                <YSettingRow dense label="Delay">
                  <YInput
                    aria-label="Delay"
                    value={form.startIn ?? ''}
                    onChange={(e) => update({ startIn: e.target.value })}
                    placeholder="e.g. 2h30m"
                    className={CONTROL}
                  />
                </YSettingRow>
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
              {!inWorkspace && <>
                <YSettingRow dense label="Group">
                  {newGroup === null ? (
                    <YSelect
                      aria-label="Group"
                      value={ownGroup ? OWN_GROUP : groupId ?? ''}
                      onChange={(e) => {
                        if (e.target.value === NEW_GROUP) setNewGroup('')
                        else if (e.target.value === OWN_GROUP) update({ groupId: undefined })
                        else update({ groupId: e.target.value === '' ? null : e.target.value })
                      }}
                      className={CONTROL}
                    >
                      {ownGroupOffered && (
                        <option value={OWN_GROUP}>
                          {routineMode ? `New group: ${titleText || 'the routine’s name'}` : `The workflow’s own: ${workflow?.name ?? 'its name'}`}
                        </option>
                      )}
                      <option value="">None</option>
                      {offeredGroups.map((g) => <option key={g.groupId} value={g.groupId}>{g.name}</option>)}
                      <option value={NEW_GROUP}>+ New group</option>
                    </YSelect>
                  ) : (
                    <div className={cn(CONTROL, 'flex items-center gap-1')}>
                      <YInput
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
                        className="flex-1"
                      />
                      <YButton
                        variant="ghost"
                        size="sm"
                        icon={CloseIcon}
                        onClick={() => setNewGroup(null)}
                        title="Pick an existing group"
                        aria-label="Pick an existing group"
                      />
                    </div>
                  )}
                </YSettingRow>
                <YSettingRow
                  dense
                  label="Timeout"
                  {...(overlaps ? { hint: <span className="text-warning">Runs may overlap</span> } : {})}
                >
                  <YInput
                    aria-label="Timeout"
                    value={form.timeout ?? ''}
                    onChange={(e) => update({ timeout: e.target.value })}
                    placeholder={routineMode ? 'until next run' : 'No limit'}
                    className={CONTROL}
                  />
                </YSettingRow>
              </>}
            </YSettingGroup>
          </YSection>

          {!inWorkspace && (selection.rows.length > 0 || showVolumes || !unattended) && (
            <YSection title="Code">
              <YSettingGroup>
                {selection.rows.length === 1 ? selection.rows[0].included && (
                  <YSettingRow dense label="Base branch" hint={originNote}>
                    <div className={CONTROL}>
                      <RepoBranch row={selection.rows[0]} lone onQuery={setBranchQuery} onPick={setRepoPick} />
                    </div>
                  </YSettingRow>
                ) : selection.rows.length > 1 && (
                  <YSettingRow dense label="Repos" hint={originNote} stacked>
                    <div className="flex flex-col gap-1.5">
                      {selection.rows.map((row) => (
                        <div key={row.repo.id} className="flex items-center gap-2">
                          <label className="flex h-control-sm w-40 shrink-0 items-center gap-1.5 truncate text-md" title={row.repo.remoteUrl}>
                            <YCheckbox checked={row.included} onCheckedChange={(included) => setRepoPick(row.repo.id, { included })} />
                            <span className="truncate font-mono text-text"><span className="sr-only">Include</span> {row.repo.dir}</span>
                          </label>
                          {row.included && (
                            <div className="min-w-0 flex-1">
                              <RepoBranch row={row} lone={false} onQuery={setBranchQuery} onPick={setRepoPick} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </YSettingRow>
                )}
                {selection.rows.length > 0 && (selection.rows.length === 1 || selection.included.length === 1) && (
                  <YSettingRow dense label="Checkout">
                    <YSelect
                      aria-label="Checkout"
                      value={selection.included.length === 0 ? 'none' : selection.nested ? 'nested' : 'root'}
                      onChange={(e) => {
                        const [only] = selection.rows
                        if (selection.rows.length === 1) setRepoPick(only.repo.id, { included: e.target.value !== 'none' })
                        if (e.target.value !== 'none') update({ nested: e.target.value === 'nested' })
                      }}
                      className={CONTROL}
                    >
                      <option value="root">At the workspace root</option>
                      <option value="nested">In {(selection.included[0] ?? selection.rows[0]).repo.dir}/</option>
                      {selection.rows.length === 1 && <option value="none">No repo</option>}
                    </YSelect>
                  </YSettingRow>
                )}
                {selection.nested && (
                  <YSettingRow dense label="Start in">
                    <YSelect aria-label="Start in" value={selection.cwd} onChange={(e) => update({ cwd: e.target.value })} className={CONTROL}>
                      <option value=".">Workspace root</option>
                      {selection.included.map((r) => <option key={r.repo.id} value={r.repo.id}>{r.repo.dir}/</option>)}
                    </YSelect>
                  </YSettingRow>
                )}
                {showVolumes && (
                  <YSettingRow dense label="Volume">
                    <YSelect
                      aria-label="Volume"
                      value={volume ?? ''}
                      onChange={(e) => update({ volume: e.target.value || undefined })}
                      className={CONTROL}
                    >
                      <option value="">None</option>
                      {volumes.map((v) => (
                        <option key={v.name} value={v.name} disabled={v.holder !== undefined}>
                          {v.name}{v.holder !== undefined
                            ? ` (attached to “${clip(v.holder.title || v.holder.workspaceId.slice(0, 8), 40)}”)`
                            : ''}
                        </option>
                      ))}
                    </YSelect>
                  </YSettingRow>
                )}
                {!unattended && (
                  <YSettingRow dense label="Steps">
                    <YSelect aria-label="Steps" value={workflow?.name ?? ''} onChange={(e) => pickWorkflow(e.target.value)} className={CONTROL}>
                      <option value="">{initWorkflows.length > 0 ? `Init workflows: ${initWorkflows.join(', ')}` : 'Init workflows (none)'}</option>
                      {workflows.map((w) => <option key={w.id} value={w.name}>Workflow {w.name}, in their place</option>)}
                    </YSelect>
                  </YSettingRow>
                )}
              </YSettingGroup>
            </YSection>
          )}

          {!unattended && (
            <YSection title="Agent">
              <YSettingGroup>
                {sessionCwds.length > 0 && (
                  <YSettingRow dense label="Start in">
                    <YSelect aria-label="Start in" value={sessionCwd} onChange={(e) => update({ sessionCwd: e.target.value })} className={CONTROL}>
                      {sessionCwds.map((p) => <option key={p} value={p}>{checkoutLabel(p)}</option>)}
                    </YSelect>
                  </YSettingRow>
                )}
                <YSettingRow dense label="Agent">
                  <YSelect
                    aria-label="Agent"
                    value={noAgent ? '' : tool}
                    onChange={(e) => {
                      if (e.target.value === '') {
                        update({ noAgent: true })
                        return
                      }
                      // A different agent brings its own remembered defaults.
                      const next = e.target.value as AgentTool
                      update({ noAgent: undefined, tool: next, picked: { tool: next, picks: {} } })
                    }}
                    className={CONTROL}
                  >
                    {AGENT_TOOLS.map((t) => (
                      <option key={t} value={t}>
                        {TOOL_LABEL[t]}{defaults.configured.has(t) ? '' : ' (sign in)'}
                      </option>
                    ))}
                    {fresh && !inWorkspace && <option value="">None</option>}
                  </YSelect>
                </YSettingRow>
                {noAgent ? null : needsGitAuth !== undefined && !inWorkspace ? (
                  <YSettingRow dense label={`${needsGitAuth.dir} has no git credential`}>
                    <YButton onClick={() => openSettings('repos', undefined, needsGitAuth.id)}>Add git authentication…</YButton>
                  </YSettingRow>
                ) : !defaults.ready || signedIn ? (
                  <YSettingRow dense label="UI">
                    <YSelect aria-label="UI" value={mode} onChange={(e) => setPicks({ mode: e.target.value as AgentMode })} className={CONTROL}>
                      {(['tui', 'acp'] as const).map((m) => <option key={m} value={m}>{MODE_COPY[m]}</option>)}
                    </YSelect>
                  </YSettingRow>
                ) : (
                  <YSettingRow dense label={`${TOOL_LABEL[tool]} has no credentials`}>
                    <YButton onClick={() => openSettings('credentials', tool)}>Sign in to {TOOL_LABEL[tool]}…</YButton>
                  </YSettingRow>
                )}
              </YSettingGroup>
            </YSection>
          )}

          {editing === undefined && editingRoutine === undefined && !unattended && !noAgent && (
            <div className="flex gap-2 max-md:flex-col">
              {!queued && (
                <YButton
                  icon={mode === 'tui' ? TerminalIcon : ChatIcon}
                  onClick={() => startNow()}
                  disabled={busy || blocked !== null || text !== ''}
                  title={blocked ?? (text !== ''
                    ? 'A prompt is typed: send it instead'
                    : `Start the ${MODE_COPY[mode].toLowerCase()} with nothing sent to the agent`)}
                >
                  Start without a prompt
                </YButton>
              )}
              {!inWorkspace && (
                <YButton
                  onClick={() => { if (pending !== null) run(keepDraft(pending)) }}
                  disabled={busy || pending === null}
                  title={pending !== null ? undefined : text === '' ? 'Type a prompt to save a draft' : 'No changes to save'}
                >
                  Save draft
                </YButton>
              )}
            </div>
          )}
        </>}
      </YPageBody>

      {kind === 'site' ? null : unattended ? (
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-line px-4 py-2.5">
          {error !== null && <span className="mr-auto min-w-0 truncate text-md text-danger" title={error}>{error}</span>}
          {error === null && routineMode && <span className="mr-auto truncate text-sm text-subtle">Each run starts unattended.</span>}
          <YButton
            variant="primary"
            {...(!queued && editing === undefined ? { icon: RunIcon } : {})}
            onClick={() => submit()}
            disabled={busy || blocked !== null}
            title={blocked ?? `${submitLabel} (Enter)`}
          >
            {submitLabel}
          </YButton>
        </div>
      ) : <ChatBottomBar
        above={error !== null && <div className="mb-1.5 px-1 text-md text-danger">{error}</div>}
        onClick={(e) => { if (e.target === e.currentTarget) promptRef.current?.focus() }}
      >
        <YTextArea
          bare
          ref={promptRef}
          aria-label="Prompt"
          rows={1}
          value={noAgent ? '' : prompt}
          readOnly={loadingPrompt || noAgent}
          onChange={(e) => update({ prompt: e.target.value })}
          placeholder={noAgent ? 'No agent, so no prompt: Create starts the workspace on its own'
            : queued || editing !== undefined ? 'What should it do?' : 'Message the agent…'}
          className={COMPOSER_INPUT}
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="mr-auto flex min-w-0 items-center">
            {signedIn && !noAgent && (
              <PermissionModeSelect
                current={permissionMode}
                available={SUPPORTED_PERMISSION_MODES[tool]}
                disabled={false}
                onSelect={(m) => setPicks({ permissionMode: m })}
              />
            )}
            {signedIn && !noAgent && (
              <AgentSettings
                disabled={false}
                model={base.models.length > 0
                  ? {
                    current: model !== '' ? model : undefined,
                    items: base.models,
                    onSelect: (id) => setPicks({ model: id }),
                    tag: (id) => id === base.defaultModel && 'default',
                  }
                  : undefined}
                effort={efforts !== undefined && effort !== undefined
                  ? { current: effort, available: efforts.levels, onSelect: (e) => setPicks({ effort: e }) }
                  : undefined}
                options={{
                  list: toolAgentOptions(tool),
                  value: agentOptions,
                  onChange: (o) => setPicks({ agentOptions: { ...picks.agentOptions, ...o } }),
                }}
              />
            )}
            {routineMode && (
              <span className="ml-1 truncate text-sm text-subtle" title={UNATTENDED}>{UNATTENDED}</span>
            )}
          </div>
          <YButton
            variant="primary"
            icon={SendIcon}
            aria-label={submitLabel}
            title={sendTitle}
            onClick={() => submit()}
            disabled={busy || blocked !== null || (text === '' && !noAgent)}
          />
        </div>
      </ChatBottomBar>}
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
    <YNumberInput
      aria-label={label}
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isInteger(n) && n >= min && n <= max) apply(n)
      }}
      className="w-14 shrink-0"
    />
  )
  const pad = (n: number): string => String(n).padStart(2, '0')
  // null = the chip; a string = the zone picker's query.
  const [zoneQuery, setZoneQuery] = useState<string | null>(null)
  const picker = useRef<HTMLDivElement>(null)
  useEffect(() => { if (zoneQuery !== null) picker.current?.querySelector('input')?.focus() }, [zoneQuery !== null])

  return (
    <>
      <YSettingRow dense label="Repeats" stacked>
        <div className="flex flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <YSelect
              aria-label="Repeats"
              value={repeat?.kind ?? 'custom'}
              onChange={(e) => {
                const kind = e.target.value
                if (kind === 'custom') onChange({ customCron: true })
                else onChange({ customCron: false, cron: compileRepeat({ ...(parseRepeat(cron) ?? DEFAULT_REPEAT), kind: kind as RepeatKind }) })
              }}
              className="w-44"
            >
              {REPEAT_KINDS.map((k) => <option key={k} value={k}>{REPEAT_COPY[k]}</option>)}
              <option value="custom">Custom (cron)</option>
            </YSelect>
            {repeat === undefined ? (
              <YInput
                aria-label="Cron expression"
                value={cron}
                onChange={(e) => onChange({ cron: e.target.value })}
                placeholder="0 9 * * 1-5"
                className="flex-1 font-mono"
              />
            ) : repeat.kind === 'minutes' ? (
              <YSelect
                aria-label="Minutes between runs"
                value={repeat.every}
                onChange={(e) => set({ every: Number(e.target.value) })}
                className="w-20"
              >
                {EVERY_MINUTES.map((n) => <option key={n} value={n}>{n}</option>)}
              </YSelect>
            )
              : repeat.kind === 'hourly' ? num('Minute past the hour', repeat.minute, 0, 59, (minute) => set({ minute }))
              : (
                <>
                  {repeat.kind === 'weekly' && WEEK.map((d) => {
                    const on = repeat.days.includes(d.day)
                    return (
                      <YChip
                        key={d.day}
                        aria-label={d.name}
                        aria-pressed={on}
                        selected={on}
                        // The last day stays on: a week of no days never runs.
                        onClick={() => { if (!on || repeat.days.length > 1) set({ days: on ? repeat.days.filter((x) => x !== d.day) : [...repeat.days, d.day] }) }}
                      >
                        {d.short}
                      </YChip>
                    )
                  })}
                  {repeat.kind === 'monthly' && num('Day of month', repeat.day, 1, 31, (day) => set({ day }))}
                  <YInput
                    type="time"
                    aria-label="Time of day"
                    value={`${pad(repeat.hour)}:${pad(repeat.minute)}`}
                    onChange={(e) => {
                      const [hour, minute] = e.target.value.split(':').map(Number)
                      if (Number.isInteger(hour) && Number.isInteger(minute)) set({ hour, minute })
                    }}
                    className="shrink-0"
                  />
                </>
              )}
            <YChip
              onClick={() => setZoneQuery('')}
              title="Change the time zone it runs in"
              aria-label={`Time zone: ${timeZone}`}
            >
              {timeZone}
            </YChip>
          </div>
          <div className="text-sm text-subtle">
            {repeat !== undefined && (
              <YButton variant="link" onClick={() => onChange({ customCron: true })} title="Edit it as cron" className="block font-mono">
                cron: {cron}
              </YButton>
            )}
            <p role="status" className={cn(error !== undefined && 'text-danger')}>
              {error ?? `Next: ${upcoming.slice(0, 3).map((d) => formatInZone(d, timeZone)).join(' · ')}`}
            </p>
          </div>
        </div>
      </YSettingRow>
      {zoneQuery !== null && (
        <YSettingRow dense label="Time zone">
          <div ref={picker} className={CONTROL}>
            <YTypeahead
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
        </YSettingRow>
      )}
    </>
  )
}

/** One repo's Base branch field: origin's branches, or a full commit id
 *  typed in, which is a start point of its own (docs/workspace-steps.md). */
function RepoBranch({ row, lone, onQuery, onPick }: {
  row: RepoRow
  /** The project's only repo, whose field needs no repo's name. */
  lone: boolean
  onQuery: (repoId: string, query: string | null) => void
  onPick: (repoId: string, pick: { branch: string }) => void
}): JSX.Element {
  const { id, dir } = row.repo
  return (
    <BranchPicker
      branches={row.branches ?? []}
      defaultBranch={row.defaultBranch}
      query={row.query ?? row.branch}
      onQueryChange={(q) => onQuery(id, q)}
      onSelect={(b) => { onPick(id, { branch: b }); onQuery(id, null) }}
      showList={row.query !== null}
      placeholder={row.branches ? '' : row.failed ? 'origin\'s default branch' : 'loading branches…'}
      ariaLabel={lone ? 'Base branch' : `Base branch of ${dir}`}
      autoHighlight
      onBlur={() => {
        if (row.typedCommit !== undefined) onPick(id, { branch: row.typedCommit })
        onQuery(id, null)
      }}
      onDismiss={() => onQuery(id, null)}
    />
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
    <YConfirm
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

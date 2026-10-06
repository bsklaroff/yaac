import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { CloseIcon, RenameIcon, TOOL_LABEL } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { Modal } from '#components/ui/Modal'
import { Typeahead } from '#components/ui/Typeahead'
import { api } from '#lib/api'
import { shownGroups } from '#lib/groups'
import { useProjectBranches } from '#lib/useProjectBranches'
import { clip, queuedDescendants, queuedInTreeOrder, queuedParentId, queuedTitle } from '#lib/queued'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { useCreateDefaults, useCreateWorkspace } from '#lib/useCreateDefaults'
import { useInlineEdit } from '#lib/useInlineRename'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore, type CreateWorkspaceDialogOpts } from '#lib/store'
import {
  AGENT_TOOLS,
  PERMISSION_MODE_COPY,
  SUPPORTED_PERMISSION_MODES,
  toolSupportsPermissionMode,
} from '@yaac/shared/types'
import { ServerError } from '@yaac/shared/errors'
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

/** Hover copy for the posture the dropdown is currently showing. */
const PERMISSION_MODE_HELP: Record<PermissionMode, string> = {
  bypass: 'The agent acts without ever asking.',
  auto: 'The agent acts without asking, but a reviewer model judges each action'
    + ' and blocks the dangerous ones. Claude gates this by subscription plan.',
  'accept-edits': 'The agent edits files in the workspace without asking, and still'
    + ' asks before running commands or reaching outside it.',
  manual: 'The agent asks before every action.',
  plan: 'The agent explores and plans read-only; it cannot edit until you approve a plan.',
  'read-only': 'The agent reads and explores freely inside a read-only sandbox, and asks before'
    + ' every edit and anything that reaches the network.',
}

const MODE_COPY: Record<AgentMode, string> = { tui: 'Terminal', acp: 'Chat' }
const MODE_HELP: Record<AgentMode, string> = {
  tui: 'The agent\'s own terminal UI, in a terminal pane.',
  acp: 'The agent driven over the Agent Client Protocol, in a chat pane.',
}

const SELECT = 'min-w-0 flex-1 rounded-md border border-border bg-surface-2 h-[26px] px-1 text-xs text-text '
  + 'outline-none hover:bg-surface-3'

/** A parent's settings, used to fill untouched fields when Start names it.
 *  Absent for "Now", which uses the project's remembered defaults. */
interface Seed {
  tool?: AgentTool
  model?: string
  mode?: AgentMode
  permissionMode?: PermissionMode
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
  const first = [...w.agentSessions].sort((a, b) => a.ordinal - b.ordinal)[0]
  return {
    tool: first?.tool ?? w.tool,
    ...(first?.mode !== undefined ? { mode: first.mode } : {}),
    ...(first?.model !== undefined ? { model: first.model } : {}),
    ...(w.permissionMode !== undefined ? { permissionMode: w.permissionMode } : {}),
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
    branch: e.branch,
    ...(e.groupId !== undefined ? { groupId: e.groupId } : {}),
  }
}

/** The Group dropdown's "+ New group" option, which swaps it for a name box. */
const NEW_GROUP = '\u0000new'

const workspaceName = (w: { title?: string; prompt?: string }): string =>
  clip(w.title || w.prompt || 'New workspace', 40)

const DRAFT_FIELDS = [
  'prompt', 'tool', 'mode', 'permissionMode', 'model', 'branch', 'startAfter', 'title', 'groupId',
] as const satisfies
  readonly (keyof DraftWorkspaceSettings)[]

/** A typed prompt that closing would lose, held while the user decides
 *  whether to save it as a draft. */
interface PendingDraft {
  projectId: string
  /** The draft the dialog was reopened on, which a save replaces. */
  id?: string
  settings: DraftWorkspaceSettings
}

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

/**
 * Modal for creating a workspace now, queueing one to start after another
 * stops, or editing a queued one (docs/queued-workspaces.md). Mounted once in
 * App and opened through the UI store (`openCreateWorkspace`).
 *
 * Fields start on what an untouched submit would use: the project's
 * remembered defaults (`useCreateDefaults`) for "Now", or the parent's
 * settings for a queued start. Changing Start re-seeds only untouched fields;
 * changing the agent reloads its own defaults. A title set here means the
 * workspace is not auto-titled.
 *
 * Enter submits (except on a button); Shift+Enter in the prompt is a newline.
 * A typed prompt can be saved as a draft with "Save draft", and dismissing
 * with one offers the same (docs/draft-workspaces.md).
 */
export function CreateWorkspaceDialog(): JSX.Element {
  const opts = useUiStore((s) => s.createWorkspaceDialog)
  const close = useUiStore((s) => s.closeCreateWorkspace)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // The form stays mounted through the close animation and remounts (new
  // key) on each open so it starts fresh.
  const last = useRef<{ opts: CreateWorkspaceDialogOpts; key: number } | null>(null)
  if (opts !== null && opts !== last.current?.opts) {
    last.current = { opts, key: (last.current?.key ?? 0) + 1 }
  }
  const [busy, setBusy] = useState(false)
  // What closing now would lose; kept current by the form.
  const draftRef = useRef<PendingDraft | null>(null)
  const [asking, setAsking] = useState<PendingDraft | null>(null)
  const shown = last.current

  return (
    <Modal
      open={opts !== null}
      onOpenChange={(next) => {
        if (next || busy) return
        if (draftRef.current !== null) setAsking(draftRef.current)
        else close()
      }}
      initialFocus={opts?.focus === 'prompt' ? promptRef : rootRef}
      className="flex w-[440px] flex-col"
    >
      {shown && (
        <CreateWorkspaceForm
          key={shown.key}
          opts={shown.opts}
          onClose={close}
          promptRef={promptRef}
          rootRef={rootRef}
          busy={busy}
          setBusy={setBusy}
          draftRef={draftRef}
        />
      )}
      {/* Nested in the modal so Escape returns to the form instead of
          closing both. */}
      <SaveDraftDialog
        pending={asking}
        onCancel={() => setAsking(null)}
        onDone={() => { setAsking(null); close() }}
      />
    </Modal>
  )
}

function CreateWorkspaceForm({
  opts,
  onClose,
  promptRef,
  rootRef,
  busy,
  setBusy,
  draftRef,
}: {
  opts: CreateWorkspaceDialogOpts
  onClose: () => void
  promptRef: RefObject<HTMLTextAreaElement | null>
  rootRef: RefObject<HTMLDivElement | null>
  busy: boolean
  setBusy: (busy: boolean) => void
  draftRef: RefObject<PendingDraft | null>
}): JSX.Element {
  const { projectId } = opts
  const snapshot = useSnapshot()
  const defaults = useCreateDefaults(projectId)
  const createWorkspace = useCreateWorkspace()
  const openSettings = useUiStore((s) => s.openSettings)
  const queryClient = useQueryClient()
  const driver = snapshot?.driver

  const entries = (snapshot?.queuedWorkspaces ?? []).filter((e) => e.projectId === projectId)
  const editing = opts.editId !== undefined ? entries.find((e) => e.id === opts.editId) : undefined
  // Captured once, so later snapshots don't overwrite the form's fields.
  const [initial] = useState(editing)
  const [draft] = useState(() => (snapshot?.draftWorkspaces ?? []).find((d) => d.id === opts.draftId))
  const from = initial ?? draft
  // A draft's saved Start, or "Now" if that parent no longer exists.
  const [draftStart] = useState(() => {
    const id = draft?.startAfter
    const known = id !== undefined && [
      ...(snapshot?.workspaces ?? []).map((w) => w.workspaceId),
      ...(snapshot?.heldWorkspaces ?? []).map((h) => h.workspaceId),
      ...(snapshot?.provisioning ?? []).map((p) => p.workspaceId),
      ...entries.map((e) => e.id),
    ].includes(id)
    return known ? id : ''
  })

  const [prompt, setPrompt] = useState(from?.prompt ?? '')
  const [title, setTitle] = useState(from?.title ?? '')
  const [start, setStart] = useState(initial !== undefined ? queuedParentId(initial)
    : draft !== undefined ? draftStart : opts.parent ?? '')
  // undefined = untouched (use the seeded group); null = no group. A draft
  // whose group equals what its Start would seed counts as untouched.
  const [groupPick, setGroupPick] = useState<string | null | undefined>(() => {
    if (initial !== undefined) return initial.groupId ?? null
    if (draft === undefined) return undefined
    const seeded = draftStart === '' ? undefined : [
      ...(snapshot?.workspaces ?? []).map((w) => ({ id: w.workspaceId, groupId: w.groupId })),
      ...(snapshot?.heldWorkspaces ?? []).map((h) => ({ id: h.workspaceId, groupId: h.groupId })),
      ...(snapshot?.provisioning ?? []).map((p) => ({ id: p.workspaceId, groupId: p.groupId })),
      ...entries.map((e) => ({ id: e.id, groupId: e.groupId })),
    ].find((c) => c.id === draftStart)?.groupId
    return draft.groupId === seeded ? undefined : draft.groupId ?? null
  })
  // null = dropdown shown; a string = the "+ New group" name box.
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const newGroupRef = useRef<HTMLInputElement>(null)
  // Not `autoFocus`, which can lose to the dialog's own focus handling.
  const naming = newGroup !== null
  useEffect(() => { if (naming) newGroupRef.current?.focus() }, [naming])
  // undefined = untouched (use the seeded branch).
  const [branchPick, setBranchPick] = useState<string | undefined>(from?.branch)
  // null = not typing; the field shows the chosen branch.
  const [branchQuery, setBranchQuery] = useState<string | null>(null)
  // Picks made in this dialog; unpicked fields show the seed. An edit or
  // draft starts with every field picked.
  const [toolPick, setToolPick] = useState<AgentTool | undefined>(from?.tool)
  // Picks apply only to the agent they were made for.
  const [picked, setPicked] = useState<{ tool?: AgentTool; picks: ToolCreateDefaults }>(from !== undefined
    ? {
      tool: from.tool,
      picks: {
        ...(from.model !== undefined ? { model: from.model } : {}),
        mode: from.mode,
        permissionMode: from.permissionMode,
      },
    }
    : { picks: {} })
  // null = not typing; the field shows the chosen model's name.
  const [modelQuery, setModelQuery] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set once a create, queue or save succeeds. The form stays clickable
  // through the close animation, so without this a further click repeats it.
  const [done, setDone] = useState(false)
  // A save from the Save draft button, which then shows "Saving…" in place
  // of Create's "…".
  const [savingDraft, setSavingDraft] = useState(false)
  const finish = (): void => {
    setDone(true)
    onClose()
  }

  // Start options: now, each live workspace (newest first), then each queued
  // entry in sidebar order. An edit excludes the entry and its descendants
  // (a cycle could never start) and always offers its current parent.
  const live = (snapshot?.workspaces ?? [])
    .filter((w) => w.projectId === projectId && !w.stopping)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const excluded = initial !== undefined
    ? new Set([initial.id, ...queuedDescendants(entries, initial.id)])
    : new Set<string>()
  const options: StartOption[] = [
    { value: '', label: 'Now' },
    ...live.map((w) => ({ value: w.workspaceId, label: `After “${workspaceName(w)}” stops`, seed: workspaceSeed(w) })),
    ...queuedInTreeOrder(entries).filter((e) => !excluded.has(e.id)).map((e) => ({
      value: e.id,
      label: `After queued “${clip(queuedTitle(e), 40)}” stops`,
      seed: entrySeed(e),
    })),
  ]
  if (start !== '' && !options.some((o) => o.value === start)) {
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

  const groups = (snapshot?.workspaceGroups ?? [])
    .filter((g) => g.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  // A group deleted since it was chosen falls back to none.
  const wantedGroup = groupPick !== undefined ? groupPick : seed?.groupId ?? null
  const groupId = groups.some((g) => g.groupId === wantedGroup) ? wantedGroup : null
  // Offer the sidebar's groups, groups queued workspaces will launch into
  // (the sidebar doesn't show those yet), and the current choice.
  const offeredGroups = shownGroups(groups, [
    ...(snapshot?.workspaces ?? []),
    ...(snapshot?.provisioning ?? []),
    ...(snapshot?.heldWorkspaces ?? []),
    ...entries,
    ...(groupId !== null ? [{ groupId }] : []),
  ])
  const newGroupName = newGroup === null ? '' : normalizeTitle(newGroup)
  const titleText = normalizeTitle(title)
  const titleEdit = useInlineEdit(title, setTitle)

  const tool = toolPick ?? seed?.tool ?? defaults.lastTool
  const base = defaults.forTool(tool)
  const picks = picked.tool === tool ? picked.picks : {}
  const setPicks = (update: (p: ToolCreateDefaults) => ToolCreateDefaults): void =>
    setPicked({ tool, picks: update(picks) })
  // A seed's model/mode/posture apply only if it is for the same tool.
  const fromSeed = seed !== undefined && seed.tool === tool ? seed : undefined
  const model = picks.model ?? fromSeed?.model ?? base.model
  const mode = picks.mode ?? fromSeed?.mode ?? base.mode
  const seededPosture = fromSeed?.permissionMode !== undefined
    && toolSupportsPermissionMode(tool, fromSeed.permissionMode)
    ? fromSeed.permissionMode
    : undefined
  const permissionMode = picks.permissionMode ?? seededPosture ?? base.permissionMode
  const modelName = base.models.find((m) => m.id === model)?.name
  const signedIn = defaults.configured.has(tool)
  const needsGitAuth = defaults.ready && !defaults.hasGitCredential

  const { data: branchData, isError: branchesFailed } = useProjectBranches(projectId)

  // On open, refetch credentials; they may have changed via the CLI.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
  }, [queryClient])

  // Focus as soon as the form mounts, before the dialog's own focus
  // handling, so keys typed right after the shortcut aren't lost.
  useLayoutEffect(() => {
    if (opts.focus === 'prompt') promptRef.current?.focus()
  }, [opts.focus, promptRef])

  // Auto-grow the prompt up to 240px, then scroll.
  useEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [prompt, promptRef])

  // Untouched branch: the parent's, else the project's last-used branch if
  // origin still has it, else origin's default. The last-used branch can't
  // be submitted until the branch list confirms it; if the list fails, it is
  // dropped and the server picks origin's default.
  const defaultBranch = branchData?.defaultBranch
  const lastBranch = defaults.lastBranch !== undefined && !branchesFailed
    && (branchData === undefined || branchData.branches.includes(defaults.lastBranch))
    ? defaults.lastBranch
    : undefined
  const branchValue = branchPick ?? seed?.branch ?? lastBranch ?? defaultBranch ?? ''
  const branchUnverified = branchData === undefined && lastBranch !== undefined
    && branchPick === undefined && seed?.branch === undefined

  // Closing loses a typed prompt on a create (not an edit of a queued
  // entry), unless it matches the reopened draft exactly.
  const text = prompt.trim()
  // An untitled edit or draft is headed by the title generated from its
  // prompt until the prompt changes. It is read from the live row, since
  // the title can land while the dialog is open.
  const fromRow = editing ?? (snapshot?.draftWorkspaces ?? []).find((d) => d.id === opts.draftId)
  const generatedTitle = text === from?.prompt ? fromRow?.generatedTitle : undefined
  const shownTitle = titleText || generatedTitle || 'New workspace'
  const current: DraftWorkspaceSettings = {
    prompt: text,
    tool,
    mode,
    permissionMode,
    ...(model !== '' ? { model } : {}),
    ...(branchValue !== '' ? { branch: branchValue } : {}),
    ...(start !== '' ? { startAfter: start } : {}),
    ...(titleText !== '' ? { title: titleText } : {}),
    ...(groupId !== null ? { groupId } : {}),
  }
  const unsaved = opts.editId === undefined && text !== '' && (draft === undefined
    || DRAFT_FIELDS.some((k) => current[k] !== draft[k]))
  const pending: PendingDraft | null = unsaved
    ? { projectId, settings: current, ...(draft !== undefined ? { id: draft.id } : {}) }
    : null
  useEffect(() => { draftRef.current = pending })
  // Also warn before a reload or tab close.
  useEffect(() => {
    if (!unsaved) return
    const hold = (e: BeforeUnloadEvent): void => { e.preventDefault() }
    window.addEventListener('beforeunload', hold)
    return () => window.removeEventListener('beforeunload', hold)
  }, [unsaved])

  // Why submit is disabled, or null. Half-typed model/branch text is a
  // search, not a pick, so it blocks. A queued entry stores concrete
  // settings, so it also needs a model, a branch and a prompt.
  const storesEntry = queued || initial !== undefined
  const blocked = !defaults.ready ? 'Loading…'
    : modelQuery !== null ? 'Pick a model from the list'
    : branchQuery !== null ? 'Pick a branch from the list'
    : branchUnverified ? 'Loading branches…'
    : !toolSupportsPermissionMode(tool, permissionMode) ? 'Pick a permission mode this agent offers'
    : storesEntry && prompt.trim() === '' ? 'A queued workspace needs a prompt'
    : storesEntry && model === '' ? 'Pick a model'
    : storesEntry && branchValue === '' ? 'Pick a branch'
    : newGroup !== null && newGroupName === '' ? 'Name the new group'
    : null

  // Save the typed prompt as a draft, then close and run `then`. Called bare
  // by the Save draft button, and with `then` by Create's hand-off.
  const saveDraft = (then?: () => void): void => {
    if (busy || done || pending === null) return
    setBusy(true)
    setSavingDraft(then === undefined)
    setError(null)
    keepDraft(pending)
      .then(() => { finish(); then?.() }, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => { setBusy(false); setSavingDraft(false) })
  }

  const submit = (): void => {
    if (busy || done) return
    // Missing credentials open Settings instead, saving any typed prompt as
    // a draft without asking.
    const handOff = (open: () => void): void => {
      if (pending !== null) {
        saveDraft(open)
        return
      }
      finish()
      open()
    }
    if (needsGitAuth) {
      handOff(() => openSettings('credentials', undefined, projectId))
      return
    }
    if (!signedIn) {
      handOff(() => openSettings('credentials', tool))
      return
    }
    if (blocked !== null) return
    // The server deletes the source draft only once the create succeeds.
    if (!storesEntry) {
      finish()
      createWorkspace(projectId, tool, {
        model,
        ...(modelName !== undefined ? { modelName } : {}),
        permissionMode,
        mode,
        ...(text !== '' ? { prompt: text } : {}),
        ...(titleText !== '' ? { title: titleText } : {}),
        ...(generatedTitle !== undefined ? { shownTitle: generatedTitle } : {}),
        ...(newGroup !== null ? { newGroup: newGroupName } : groupId !== null ? { groupId } : {}),
        ...(draft !== undefined ? { draftId: draft.id } : {}),
      }, branchValue !== '' ? branchValue : undefined)
      return
    }
    const settings = {
      prompt: text,
      tool,
      model,
      mode,
      permissionMode,
      branch: branchValue,
      title: titleText,
      group: newGroup !== null ? newGroupName : groupId,
    }
    setBusy(true)
    setError(null)
    // Expand the sidebar section the entry lands in.
    const reveal = (e: QueuedWorkspaceEntry): void =>
      useUiStore.getState().setRevealQueued({ id: e.id, parent: queuedParentId(e) })
    const moved = initial !== undefined && queued && start !== queuedParentId(initial)
    const queue = api.workspace.queue
    const op = initial === undefined
      ? queue.create.$post({
        json: { project: projectId, parent: start, ...settings, ...(draft !== undefined ? { draftId: draft.id } : {}) },
      }).then(reveal)
      : queue.update.$post({ json: { id: initial.id, ...settings, ...(moved ? { parent: start } : {}) } })
        .then(async (e) => {
          // "Now" on a queued workspace is Save then Run now.
          if (!queued) await queue.run.$post({ json: { id: initial.id } })
          else if (moved) reveal(e)
        })
    op.then(finish, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  // Enter submits, except on a button or Shift+Enter in the prompt. A
  // highlighted typeahead suggestion consumes Enter first.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.target instanceof HTMLButtonElement) return
    if (e.shiftKey && e.target instanceof HTMLTextAreaElement) return
    e.preventDefault()
    submit()
  }

  const pickModel = (id: string): void => {
    setPicks((p) => ({ ...p, model: id }))
    setModelQuery(null)
  }

  const submitLabel = needsGitAuth ? 'Add git authentication…'
    : !signedIn ? `Sign in to ${TOOL_LABEL[tool]}…`
    : initial !== undefined ? 'Save'
    : queued ? 'Queue' : 'Create'

  // The queued entry started or was discarded since the dialog opened.
  if (opts.editId !== undefined && initial === undefined) {
    return (
      <div ref={rootRef} tabIndex={-1} className="p-5 outline-none">
        <Dialog.Title className="text-sm font-semibold">Queued workspace gone</Dialog.Title>
        <Dialog.Description className="mt-1 text-xs text-text-dim">
          It has already started or been discarded.
        </Dialog.Description>
        <div className="mt-4 flex justify-end">
          <Dialog.Close className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
            hover:bg-surface-3 hover:text-text">
            Close
          </Dialog.Close>
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col outline-none">
      <div className="flex shrink-0 items-center justify-between px-4 pb-1 pt-3">
        {titleEdit.editing ? (
          <input
            ref={titleEdit.inputRef}
            aria-label="Workspace title"
            defaultValue={titleEdit.seed}
            placeholder="Generated from the prompt"
            maxLength={MAX_TITLE_LENGTH}
            onKeyDown={(e) => {
              // Enter and Escape finish the title, not the dialog.
              if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation()
              titleEdit.handleKeyDown(e)
            }}
            onBlur={titleEdit.handleBlur}
            className="mr-2 min-w-0 flex-1 rounded border border-border-strong bg-bg px-1.5 py-0.5
              text-sm font-semibold text-text outline-none placeholder:font-normal placeholder:text-text-faint"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-0.5">
            <Dialog.Title className="min-w-0 truncate text-sm font-semibold">{shownTitle}</Dialog.Title>
            <button
              type="button"
              onClick={titleEdit.start}
              title="Rename workspace"
              aria-label="Rename workspace"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-faint transition
                hover:bg-surface-2 hover:text-text"
            >
              <RenameIcon size={12} />
            </button>
          </div>
        )}
        <Dialog.Close
          aria-label="Close"
          className="flex h-6 w-6 items-center justify-center rounded text-text-faint transition
            hover:bg-surface-2 hover:text-text max-md:h-9 max-md:w-9"
        >
          <CloseIcon size={14} />
        </Dialog.Close>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="mx-1 mb-2 px-1">
          <textarea
            ref={promptRef}
            aria-label="Prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={storesEntry ? 'What should it do?' : 'What should it do? (optional)'}
            className="block max-h-[240px] w-full resize-none rounded-md border border-border bg-bg px-2.5 py-2
              text-sm text-text outline-none placeholder:text-text-faint focus:border-border-strong"
          />
        </div>

        <Row label="Start">
          <select
            aria-label="Start"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={SELECT}
          >
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Row>

        <Row label="Group">
          {newGroup === null ? (
            <select
              aria-label="Group"
              value={groupId ?? ''}
              onChange={(e) => {
                if (e.target.value === NEW_GROUP) setNewGroup('')
                else setGroupPick(e.target.value === '' ? null : e.target.value)
              }}
              className={SELECT}
            >
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
                  // Escape goes back to the dropdown, not out of the dialog.
                  if (e.key !== 'Escape') return
                  e.preventDefault()
                  e.stopPropagation()
                  setNewGroup(null)
                }}
                placeholder="New group name"
                className="h-[26px] min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 text-xs
                  text-text outline-none placeholder:text-text-faint focus:border-border-strong"
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

        <Row label="Base branch">
          <div className="min-w-0 flex-1">
            <BranchPicker
              branches={branchData?.branches ?? []}
              defaultBranch={defaultBranch}
              query={branchQuery ?? branchValue}
              onQueryChange={setBranchQuery}
              onSelect={(b) => { setBranchPick(b); setBranchQuery(null) }}
              showList={branchQuery !== null}
              placeholder={branchData ? '' : branchesFailed ? 'origin\'s default branch' : 'loading branches…'}
              ariaLabel="Base branch"
              autoHighlight
              onBlur={() => setBranchQuery(null)}
              onDismiss={() => setBranchQuery(null)}
            />
          </div>
        </Row>
        {queued && (
          <div className="-mt-1 mb-1 pl-[92px] text-[11px] text-text-faint">latest from origin when it starts</div>
        )}

        <Row label="Agent">
          <select
            aria-label="Agent"
            value={tool}
            onChange={(e) => {
              // A different agent brings its own remembered defaults.
              setToolPick(e.target.value as AgentTool)
              setPicked({ picks: {} })
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
          <div className="mx-1 mb-1 px-1 py-1 text-[11px] text-text-faint">
            This project has no git credential
          </div>
        ) : signedIn ? (
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
                  onSelect={pickModel}
                  showList={modelQuery !== null}
                  ariaLabel="Model"
                  autoHighlight
                  tag={(item) => item.value === base.defaultModel && <span>default</span>}
                  onBlur={() => setModelQuery(null)}
                  onDismiss={() => setModelQuery(null)}
                />
              </div>
            </Row>

            <Row label="Permissions" title={PERMISSION_MODE_HELP[permissionMode]}>
              <select
                aria-label="Permissions"
                value={permissionMode}
                onChange={(e) => setPicks((p) => ({ ...p, permissionMode: e.target.value as PermissionMode }))}
                className={SELECT}
              >
                {SUPPORTED_PERMISSION_MODES[tool].map((m) => (
                  <option key={m} value={m}>{PERMISSION_MODE_COPY[m]}</option>
                ))}
              </select>
            </Row>
            {permissionMode === 'bypass' && driver === 'containerless' && (
              <div className="-mt-1 mb-1 pl-[92px] text-[11px] text-text-faint">no sandbox — acts as you</div>
            )}

            <Row label="UI" title={MODE_HELP[mode]}>
              <select
                aria-label="UI"
                value={mode}
                onChange={(e) => setPicks((p) => ({ ...p, mode: e.target.value as AgentMode }))}
                className={SELECT}
              >
                {(['tui', 'acp'] as const).map((m) => (
                  <option key={m} value={m}>{MODE_COPY[m]}</option>
                ))}
              </select>
            </Row>
          </>
        ) : (
          <div className="mx-1 mb-1 px-1 py-1 text-[11px] text-text-faint">
            {TOOL_LABEL[tool]} has no credentials
          </div>
        )}

        {error && <div className="mx-2 mb-1 text-[11px] text-danger">{error}</div>}

        <div className="flex gap-2 p-1 max-md:flex-col-reverse">
          {opts.editId === undefined && (
            <button
              type="button"
              onClick={() => saveDraft()}
              disabled={busy || done || pending === null}
              title={pending !== null ? undefined : text === '' ? 'Type a prompt to save a draft' : 'No changes to save'}
              className="flex-1 rounded-md border border-border px-2 py-1.5 text-xs text-text-dim outline-none
                transition hover:bg-surface-3 hover:text-text disabled:cursor-not-allowed disabled:opacity-50
                max-md:py-2.5"
            >
              {savingDraft ? 'Saving…' : 'Save draft'}
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={busy || done || (!needsGitAuth && signedIn && blocked !== null)}
            title={!needsGitAuth && signedIn ? blocked ?? undefined : undefined}
            className="flex-1 rounded-md border border-border-strong bg-surface-3 px-2 py-1.5 text-xs font-medium
              text-text outline-none transition hover:bg-border-strong disabled:cursor-not-allowed disabled:opacity-50
              max-md:py-2.5"
          >
            {busy && !savingDraft ? `${submitLabel}…` : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A form row: fixed-width label, then the control (which has its own
 *  aria-label). */
function Row({ label, title, children }: { label: string; title?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mx-1 mb-1 flex items-start gap-2 px-1 py-0.5 text-xs text-text-dim" title={title}>
      <span className="w-[76px] shrink-0 pt-[5px]">{label}</span>
      {children}
    </div>
  )
}

/**
 * Asks whether to save a dismissed create's prompt as a draft. Escape or
 * "Keep editing" returns to the form. Save has initial focus, so
 * Escape then Enter keeps the text.
 */
function SaveDraftDialog({
  pending,
  onCancel,
  onDone,
}: {
  pending: PendingDraft | null
  onCancel: () => void
  onDone: () => void
}): JSX.Element {
  const save = useMutation({ mutationFn: keepDraft, onSuccess: onDone })
  const editing = pending?.id !== undefined
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(next) => { if (!next) { save.reset(); onCancel() } }}
      destructive={false}
      title={editing ? 'Save changes to this draft?' : 'Save as a draft?'}
      description={editing
        ? 'Discarding keeps the draft as it was saved.'
        : 'A draft keeps the prompt and settings in the sidebar, to create from later.'}
      cancelLabel="Keep editing"
      alternative={{ label: editing ? 'Discard changes' : 'Discard', onClick: onDone }}
      confirmLabel={editing ? 'Save changes' : 'Save draft'}
      busy={save.isPending}
      error={save.error?.message}
      onConfirm={() => { if (pending !== null) save.mutate(pending) }}
    />
  )
}

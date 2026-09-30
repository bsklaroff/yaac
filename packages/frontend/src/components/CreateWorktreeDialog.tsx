import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import clsx from 'clsx'
import { CloseIcon, RenameIcon, TOOL_LABEL } from '#lib/icons'
import { BranchPicker } from '#components/BranchPicker'
import { Modal } from '#components/ui/Modal'
import { Typeahead } from '#components/ui/Typeahead'
import { saveDraftWorktree } from '#lib/draftApi'
import { shownGroups } from '#lib/groups'
import { getProjectBranches, projectBranchesKey } from '#lib/projectApi'
import { queueWorktree, runQueuedWorktree, updateQueuedWorktree } from '#lib/queueApi'
import { clip, queuedDescendants, queuedInTreeOrder, queuedParentId, queuedTitle } from '#lib/queued'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { useCreateDefaults, useCreateWorktree } from '#lib/useCreateDefaults'
import { useInlineEdit } from '#lib/useInlineRename'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore, type CreateWorktreeDialogOpts } from '#lib/store'
import {
  AGENT_TOOLS,
  PERMISSION_MODE_COPY,
  supportedPermissionModes,
  toolSupportsPermissionMode,
} from '@yaac/shared/types'
import { ServerError } from '@yaac/shared/errors'
import { MAX_TITLE_LENGTH, normalizeTitle } from '@yaac/shared/titles'
import type {
  AgentMode,
  AgentTool,
  DraftWorktreeSettings,
  PermissionMode,
  QueuedWorktreeEntry,
  ToolCreateDefaults,
  WorktreeListEntry,
} from '@yaac/shared/types'

/** Hover copy for the posture the dropdown is currently showing. */
const PERMISSION_MODE_HELP: Record<PermissionMode, string> = {
  bypass: 'The agent acts without ever asking.',
  auto: 'The agent acts without asking, but a reviewer model judges each action'
    + ' and blocks the dangerous ones. Claude gates this by subscription plan.',
  'accept-edits': 'The agent edits files in the worktree without asking, and still'
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

/** What a Start choice fills the untouched fields with — a parent's own
 *  settings. Absent for "Now", which takes the project's create memory. */
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

/** A live worktree's settings, off its first conversation (the one that
 *  names the worktree's tool) and its row. The model is that conversation's
 *  current one, so a `/model` switch is what a child inherits. */
function worktreeSeed(w: WorktreeListEntry): Seed {
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

function entrySeed(e: QueuedWorktreeEntry): Seed {
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

const worktreeName = (w: { title?: string; prompt?: string }): string =>
  clip(w.title || w.prompt || 'New worktree', 40)

const DRAFT_FIELDS = [
  'prompt', 'tool', 'mode', 'permissionMode', 'model', 'branch', 'startAfter', 'title', 'groupId',
] as const satisfies
  readonly (keyof DraftWorktreeSettings)[]

/** A close that would lose a typed prompt, held while the user decides
 *  whether to keep it as a draft. */
interface PendingDraft {
  projectSlug: string
  /** The draft the dialog was reopened on, which a save replaces. */
  id?: string
  settings: DraftWorktreeSettings
}

/** Keep `pending` as a draft. One that has gone since the dialog opened
 *  (created from or discarded elsewhere) is saved anew, so the text always
 *  has somewhere to go. */
async function keepDraft(pending: PendingDraft): Promise<void> {
  try {
    await saveDraftWorktree(pending.projectSlug, pending.settings, pending.id)
  } catch (err) {
    if (pending.id === undefined || !(err instanceof ServerError && err.code === 'NOT_FOUND')) throw err
    await saveDraftWorktree(pending.projectSlug, pending.settings)
  }
}

/**
 * The create dialog — one centered modal for creating a worktree now,
 * queueing one to start after another stops, and editing a queued one
 * (docs/queued-worktrees.md). Mounted once, in App; opened through the UI
 * store (`openCreateWorktree`) by the + button, Alt+N, the sidebar's row
 * menus and the stop dialog.
 *
 * Every field opens on what an untouched submit would run. For "Now" that is
 * the project's create memory (`useCreateDefaults`); for a parent it is that
 * parent's own settings, with the branch being the one it forked from —
 * fetched fresh from origin when the queued worktree starts. Changing Start
 * re-seeds only the fields not touched here — the Group too, which follows
 * the parent's — and changing the agent reloads the rest from its own
 * memory, as the create form always has. A title set on the heading (its
 * pencil, like every other rename) is the worktree's (and a draft's) from the
 * start, so neither is auto-titled. The Group offers the groups the sidebar
 * shows and those queued worktrees will launch into, plus "+ New group",
 * which swaps the dropdown for a name box — the create or queue brings that
 * group into being (a draft keeps the group picked before it).
 *
 * Enter anywhere but on a button submits, and Shift+Enter in the prompt is a
 * newline, like the chat composer — so Alt+N, type, Enter is a create with
 * an opening prompt.
 *
 * Dismissing a create (×, Escape, a click outside) with a prompt typed asks
 * whether to save it as a draft (docs/draft-worktrees.md); a draft reopens
 * here, and creating or queueing from it discards it.
 */
export function CreateWorktreeDialog(): JSX.Element {
  const opts = useUiStore((s) => s.createWorktreeDialog)
  const close = useUiStore((s) => s.closeCreateWorktree)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // The form outlives the close so it can animate out, and remounts on each
  // open so every open starts from its own seed.
  const last = useRef<{ opts: CreateWorktreeDialogOpts; key: number } | null>(null)
  if (opts !== null && opts !== last.current?.opts) {
    last.current = { opts, key: (last.current?.key ?? 0) + 1 }
  }
  const [busy, setBusy] = useState(false)
  // What a dismissal right now would lose, kept current by the form.
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
        <CreateWorktreeForm
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
      {/* Inside the modal's tree, so it nests over it: Escape here returns
          to the form rather than dismissing both. */}
      <SaveDraftDialog
        pending={asking}
        onCancel={() => setAsking(null)}
        onDone={() => { setAsking(null); close() }}
      />
    </Modal>
  )
}

function CreateWorktreeForm({
  opts,
  onClose,
  promptRef,
  rootRef,
  busy,
  setBusy,
  draftRef,
}: {
  opts: CreateWorktreeDialogOpts
  onClose: () => void
  promptRef: RefObject<HTMLTextAreaElement | null>
  rootRef: RefObject<HTMLDivElement | null>
  busy: boolean
  setBusy: (busy: boolean) => void
  draftRef: RefObject<PendingDraft | null>
}): JSX.Element {
  const { projectSlug } = opts
  const snapshot = useSnapshot()
  const defaults = useCreateDefaults(projectSlug)
  const createWorktree = useCreateWorktree()
  const openSettings = useUiStore((s) => s.openSettings)
  const queryClient = useQueryClient()
  const driver = snapshot?.driver

  const entries = (snapshot?.queuedWorktrees ?? []).filter((e) => e.projectSlug === projectSlug)
  const editing = opts.editId !== undefined ? entries.find((e) => e.id === opts.editId) : undefined
  // Read once: the form's fields start from the entry (or draft) as it was
  // when the dialog opened, not from whatever a later snapshot says.
  const [initial] = useState(editing)
  const [draft] = useState(() => (snapshot?.draftWorktrees ?? []).find((d) => d.id === opts.draftId))
  const from = initial ?? draft
  // A draft's Start is where it would have waited when it was saved; a
  // parent that has gone since leaves it starting now.
  const [draftStart] = useState(() => {
    const id = draft?.startAfter
    const known = id !== undefined && [
      ...(snapshot?.worktrees ?? []).map((w) => w.worktreeId),
      ...(snapshot?.heldWorktrees ?? []).map((h) => h.worktreeId),
      ...(snapshot?.provisioning ?? []).map((p) => p.worktreeId),
      ...entries.map((e) => e.id),
    ].includes(id)
    return known ? id : ''
  })

  const [prompt, setPrompt] = useState(from?.prompt ?? '')
  const [title, setTitle] = useState(from?.title ?? '')
  const [start, setStart] = useState(initial !== undefined ? queuedParentId(initial)
    : draft !== undefined ? draftStart : opts.parent ?? '')
  // undefined = untouched: the field shows (and a submit uses) the seeded
  // group; null is the default list. An entry's group is its own, but a
  // draft's that is just what its Start would seed was never picked, so it
  // keeps following Start.
  const [groupPick, setGroupPick] = useState<string | null | undefined>(() => {
    if (initial !== undefined) return initial.groupId ?? null
    if (draft === undefined) return undefined
    const seeded = draftStart === '' ? undefined : [
      ...(snapshot?.worktrees ?? []).map((w) => ({ id: w.worktreeId, groupId: w.groupId })),
      ...(snapshot?.heldWorktrees ?? []).map((h) => ({ id: h.worktreeId, groupId: h.groupId })),
      ...(snapshot?.provisioning ?? []).map((p) => ({ id: p.worktreeId, groupId: p.groupId })),
      ...entries.map((e) => ({ id: e.id, groupId: e.groupId })),
    ].find((c) => c.id === draftStart)?.groupId
    return draft.groupId === seeded ? undefined : draft.groupId ?? null
  })
  // null = picking from the dropdown; a string is the "+ New group" box.
  const [newGroup, setNewGroup] = useState<string | null>(null)
  const newGroupRef = useRef<HTMLInputElement>(null)
  // Focused from here rather than by `autoFocus`, which can lose to the
  // dialog's own focus handling.
  const naming = newGroup !== null
  useEffect(() => { if (naming) newGroupRef.current?.focus() }, [naming])
  // undefined = untouched: the field shows (and a submit uses) the seeded
  // branch. An edit or a draft starts with its own.
  const [branchPick, setBranchPick] = useState<string | undefined>(from?.branch)
  // null = not editing: the branch field shows the chosen branch.
  const [branchQuery, setBranchQuery] = useState<string | null>(null)
  // What was picked in THIS dialog; anything unpicked shows the seed. An
  // edit or a draft starts with every field picked — they are its own.
  const [toolPick, setToolPick] = useState<AgentTool | undefined>(from?.tool)
  // Picks belong to the agent they were made for: a Start change that moves
  // the agent to another parent's leaves them behind.
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
  // null = not editing: the model field shows the chosen model's name.
  const [modelQuery, setModelQuery] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Start's choices: now, then after any live worktree (newest first), then
  // after any queued worktree in sidebar order. An edit also offers where
  // the entry already is — a held (stopped) parent is not otherwise
  // offered — and never the entry itself or anything under it, which would
  // be a chain that can never start.
  const live = (snapshot?.worktrees ?? [])
    .filter((w) => w.projectSlug === projectSlug && !w.stopping)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const excluded = initial !== undefined
    ? new Set([initial.id, ...queuedDescendants(entries, initial.id)])
    : new Set<string>()
  const options: StartOption[] = [
    { value: '', label: 'Now' },
    ...live.map((w) => ({ value: w.worktreeId, label: `After “${worktreeName(w)}” stops`, seed: worktreeSeed(w) })),
    ...queuedInTreeOrder(entries).filter((e) => !excluded.has(e.id)).map((e) => ({
      value: e.id,
      label: `After queued “${clip(queuedTitle(e), 40)}” stops`,
      seed: entrySeed(e),
    })),
  ]
  if (start !== '' && !options.some((o) => o.value === start)) {
    const held = (snapshot?.heldWorktrees ?? []).find((h) => h.worktreeId === start)
    const provisioning = (snapshot?.provisioning ?? []).find((p) => p.worktreeId === start)
    options.splice(1, 0, {
      value: start,
      label: held !== undefined ? `After “${worktreeName(held)}” stops (stopped)`
        : provisioning !== undefined ? 'After the new worktree stops'
        : 'Its current parent (gone)',
      ...(held !== undefined
        ? { seed: { tool: held.tool, ...(held.groupId !== undefined ? { groupId: held.groupId } : {}) } }
        : provisioning?.groupId !== undefined ? { seed: { groupId: provisioning.groupId } }
        : {}),
    })
  }
  const seed = options.find((o) => o.value === start)?.seed
  const queued = start !== ''

  const groups = (snapshot?.worktreeGroups ?? [])
    .filter((g) => g.projectSlug === projectSlug)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  // A group deleted since it was seeded or picked is the default list.
  const wantedGroup = groupPick !== undefined ? groupPick : seed?.groupId ?? null
  const groupId = groups.some((g) => g.groupId === wantedGroup) ? wantedGroup : null
  // Offered: the groups the sidebar shows, those a queued worktree will
  // launch into (a group made by queueing holds nothing else yet, and the
  // sidebar nests entries under their parent, not their group), and
  // whichever one is chosen.
  const offeredGroups = shownGroups(groups, [
    ...(snapshot?.worktrees ?? []),
    ...(snapshot?.provisioning ?? []),
    ...(snapshot?.heldWorktrees ?? []),
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
  // A seed's tool-dependent fields only carry over to the tool they belong to.
  const fromSeed = seed !== undefined && seed.tool === tool ? seed : undefined
  const model = picks.model ?? fromSeed?.model ?? base.model
  const mode = picks.mode ?? fromSeed?.mode ?? base.mode
  const seededPosture = fromSeed?.permissionMode !== undefined
    && toolSupportsPermissionMode(tool, fromSeed.permissionMode, mode)
    ? fromSeed.permissionMode
    : undefined
  const permissionMode = picks.permissionMode ?? seededPosture ?? base.permissionMode
  const modelName = base.models.find((m) => m.id === model)?.name
  const signedIn = defaults.configured.has(tool)
  // Only once the snapshot has said so — before it lands nothing creates anyway.
  const needsGitAuth = defaults.ready && !defaults.hasGitCredential

  const { data: branchData, isError: branchesFailed } = useQuery({
    queryKey: projectBranchesKey(projectSlug),
    queryFn: () => getProjectBranches(projectSlug),
  })

  // On open: re-pull credentials (may have changed CLI-side) and refresh the
  // branch list from the remote in the background — the instant local list
  // renders first, a just-pushed branch appears when the fetch lands.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY })
    getProjectBranches(projectSlug, { refresh: true })
      .then((fresh) => queryClient.setQueryData(projectBranchesKey(projectSlug), fresh))
      .catch(() => { /* stale-but-instant list stays */ })
  }, [projectSlug, queryClient])

  // Focused the moment the form is in the DOM, not when the dialog's own
  // focus handling gets to it a few frames later: Alt+N then typing straight
  // away is the flow this dialog exists for, and keys pressed in between
  // would land on nothing.
  useLayoutEffect(() => {
    if (opts.focus === 'prompt') promptRef.current?.focus()
  }, [opts.focus, promptRef])

  // The prompt grows with what is typed, up to a cap past which it scrolls.
  useEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [prompt, promptRef])

  // The branch an untouched submit uses: the parent's own for a queued one,
  // else the one this project was last created from — while origin still has
  // it — else origin's default. Until the list says whether origin has it,
  // the remembered branch is shown but cannot be sent; a list that fails to
  // load drops it, leaving the server to take origin's default.
  const defaultBranch = branchData?.defaultBranch
  const lastBranch = defaults.lastBranch !== undefined && !branchesFailed
    && (branchData === undefined || branchData.branches.includes(defaults.lastBranch))
    ? defaults.lastBranch
    : undefined
  const branchValue = branchPick ?? seed?.branch ?? lastBranch ?? defaultBranch ?? ''
  const branchUnverified = branchData === undefined && lastBranch !== undefined
    && branchPick === undefined && seed?.branch === undefined

  // What a dismissal would lose: a typed prompt on a create — never an edit
  // of a queued entry, which has its own Save — unless it is the reopened
  // draft exactly as saved.
  const text = prompt.trim()
  const current: DraftWorktreeSettings = {
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
    ? { projectSlug, settings: current, ...(draft !== undefined ? { id: draft.id } : {}) }
    : null
  useEffect(() => { draftRef.current = pending })
  // A reload or a closed tab would lose it too, with nobody asked.
  useEffect(() => {
    if (!unsaved) return
    const hold = (e: BeforeUnloadEvent): void => { e.preventDefault() }
    window.addEventListener('beforeunload', hold)
    return () => window.removeEventListener('beforeunload', hold)
  }, [unsaved])

  // Why the submit cannot run right now, or null when it can. Mid-edit model
  // or branch text blocks it: it is a search, not a pick, and submitting the
  // previous one instead would not be what the field shows. A queued worktree
  // stores every setting concrete, so it needs a model and a branch too — and
  // a prompt, since nobody is watching it start.
  const storesEntry = queued || initial !== undefined
  const blocked = !defaults.ready ? 'Loading…'
    : modelQuery !== null ? 'Pick a model from the list'
    : branchQuery !== null ? 'Pick a branch from the list'
    : branchUnverified ? 'Loading branches…'
    : !toolSupportsPermissionMode(tool, permissionMode, mode) ? 'Pick a permission mode this UI offers'
    : storesEntry && prompt.trim() === '' ? 'A queued worktree needs a prompt'
    : storesEntry && model === '' ? 'Pick a model'
    : storesEntry && branchValue === '' ? 'Pick a branch'
    : newGroup !== null && newGroupName === '' ? 'Name the new group'
    : null

  const submit = (): void => {
    if (busy) return
    // Missing credentials send the user to Settings instead. They asked to
    // create, so a typed prompt is kept as a draft on the way rather than
    // asked about.
    const handOff = (open: () => void): void => {
      if (pending === null) {
        onClose()
        open()
        return
      }
      setBusy(true)
      setError(null)
      keepDraft(pending)
        .then(() => { onClose(); open() }, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false))
    }
    if (needsGitAuth) {
      handOff(() => openSettings('credentials', undefined, projectSlug))
      return
    }
    if (!signedIn) {
      handOff(() => openSettings('credentials', tool))
      return
    }
    if (blocked !== null) return
    // The server deletes a draft this was made from once the create or queue
    // has succeeded, so a failed one keeps it.
    if (!storesEntry) {
      onClose()
      createWorktree(projectSlug, tool, {
        model,
        ...(modelName !== undefined ? { modelName } : {}),
        permissionMode,
        mode,
        ...(text !== '' ? { prompt: text } : {}),
        ...(titleText !== '' ? { title: titleText } : {}),
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
    // Open the sidebar set the entry lands in, as the server placed it.
    const reveal = (e: QueuedWorktreeEntry): void =>
      useUiStore.getState().setRevealQueued({ id: e.id, parent: queuedParentId(e) })
    const moved = initial !== undefined && queued && start !== queuedParentId(initial)
    const op = initial === undefined
      ? queueWorktree(projectSlug, start, settings, draft?.id).then(reveal)
      : updateQueuedWorktree(initial.id, { ...settings, ...(moved ? { parent: start } : {}) })
        .then(async (e) => {
          // "Now" on a queued worktree is Save then Run now.
          if (!queued) await runQueuedWorktree(initial.id)
          else if (moved) reveal(e)
        })
    op.then(onClose, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  // Enter anywhere in the dialog submits — except on a button, which has its
  // own Enter (a suggestion row, the submit itself), and Shift+Enter
  // in the prompt, which is a newline. A highlighted suggestion takes Enter
  // before it gets here (see Typeahead).
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

  // The entry started or was discarded since the dialog opened: there is
  // nothing left to edit.
  if (opts.editId !== undefined && initial === undefined) {
    return (
      <div ref={rootRef} tabIndex={-1} className="p-5 outline-none">
        <Dialog.Title className="text-sm font-semibold">Queued worktree gone</Dialog.Title>
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
            aria-label="Worktree title"
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
            <Dialog.Title className="min-w-0 truncate text-sm font-semibold">{titleText || 'New worktree'}</Dialog.Title>
            <button
              type="button"
              onClick={titleEdit.start}
              title="Rename worktree"
              aria-label="Rename worktree"
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
              // Another agent brings its own memory for the other three.
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
                {/* The terminal UI's postures are a superset of the chat
                    adapter's, so the list is per agent and a posture the
                    chosen UI lacks is shown but not pickable. */}
                {supportedPermissionModes(tool, 'tui').map((m) => {
                  const offered = toolSupportsPermissionMode(tool, m, mode)
                  return (
                    <option key={m} value={m} disabled={!offered}>
                      {PERMISSION_MODE_COPY[m]}{offered ? '' : ' (terminal only)'}
                    </option>
                  )
                })}
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
                {(['tui', 'acp'] as const).map((m) => {
                  // An adapter can offer fewer postures than its CLI
                  // (codex-acp has no plan mode), so the chat UI is only
                  // pickable under a posture it has.
                  const offered = toolSupportsPermissionMode(tool, permissionMode, m)
                  return (
                    <option key={m} value={m} disabled={!offered}>
                      {MODE_COPY[m]}
                      {offered ? '' : ` (no ${PERMISSION_MODE_COPY[permissionMode].toLowerCase()})`}
                    </option>
                  )
                })}
              </select>
            </Row>
          </>
        ) : (
          <div className="mx-1 mb-1 px-1 py-1 text-[11px] text-text-faint">
            {TOOL_LABEL[tool]} has no credentials
          </div>
        )}

        {error && <div className="mx-2 mb-1 text-[11px] text-[#d65858]">{error}</div>}

        <div className="p-1">
          <button
            type="button"
            onClick={submit}
            disabled={busy || (!needsGitAuth && signedIn && blocked !== null)}
            title={!needsGitAuth && signedIn ? blocked ?? undefined : undefined}
            className="w-full rounded-md border border-border-strong bg-surface-3 px-2 py-1.5 text-xs font-medium
              text-text outline-none transition hover:bg-border-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? `${submitLabel}…` : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One field of the form: a fixed label column, then the control (which
 *  carries its own aria-label). */
function Row({ label, title, children }: { label: string; title?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mx-1 mb-1 flex items-start gap-2 px-1 py-0.5 text-xs text-text-dim" title={title}>
      <span className="w-[76px] shrink-0 pt-[5px]">{label}</span>
      {children}
    </div>
  )
}

/**
 * Asked when a create with a prompt typed is dismissed: keep it as a draft in
 * the sidebar, or let it go. Escape (or Keep editing) goes back to the form.
 * Save takes initial focus, so Escape-then-Enter keeps what was typed.
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
  const saveRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = (): void => {
    if (pending === null) return
    setBusy(true)
    setError(null)
    keepDraft(pending)
      .then(onDone, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  const BUTTON = 'flex h-8 items-center rounded-md px-3 text-xs transition disabled:opacity-50'
  return (
    <AlertDialog.Root
      open={pending !== null}
      onOpenChange={(next) => { if (!next && !busy) { setError(null); onCancel() } }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 bg-black/40 transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <AlertDialog.Popup
          initialFocus={saveRef}
          className="fixed left-1/2 top-1/2 w-[400px] max-w-[calc(100vw-2rem)] -translate-x-1/2
            -translate-y-1/2 rounded-lg border border-border bg-surface-2 p-5 text-text shadow-[0_16px_48px_var(--shadow-color)]
            outline-none transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
            data-[ending-style]:scale-95 data-[ending-style]:opacity-0"
        >
          <AlertDialog.Title className="text-sm font-semibold">
            {pending?.id !== undefined ? 'Save changes to this draft?' : 'Save as a draft?'}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-xs leading-relaxed text-text-dim">
            {pending?.id !== undefined
              ? 'Discarding keeps the draft as it was saved.'
              : 'A draft keeps the prompt and settings in the sidebar, to create from later.'}
          </AlertDialog.Description>
          {error && <p className="mt-2 text-xs text-[#d65858]">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close
              disabled={busy}
              className={clsx(BUTTON, 'mr-auto text-text-dim hover:bg-surface-3 hover:text-text')}
            >
              Keep editing
            </AlertDialog.Close>
            <button
              type="button"
              disabled={busy}
              onClick={onDone}
              className={clsx(BUTTON, 'text-text-dim hover:bg-surface-3 hover:text-text')}
            >
              {pending?.id !== undefined ? 'Discard changes' : 'Discard'}
            </button>
            <button
              ref={saveRef}
              type="button"
              disabled={busy}
              onClick={save}
              className={clsx(BUTTON, 'bg-accent font-medium text-bg hover:brightness-110')}
            >
              {busy ? 'Saving…' : pending?.id !== undefined ? 'Save changes' : 'Save draft'}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

import {
  useRef,
  useState,
  type JSX,
  useLayoutEffect,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@base-ui/react/dialog'
import { CloseIcon, GroupRemoveIcon, LoadingIcon, RestartIcon } from '#lib/icons'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { StopWorkspaceDialog } from '#components/StopWorkspaceDialog'
import { RowMenu } from '#components/sidebar/RowMenu'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { Modal } from '#components/ui/Modal'
import { agentLabel, workspaceModel } from '#lib/agentLabel'
import { api } from '#lib/api'
import { dismissProvisioning, restartWorkspace } from '#lib/createWorkspace'
import { stopWorkspaceOptimistic } from '#lib/stopWorkspaceFlow'
import { useUiStore, isUnreadWaiting } from '#lib/store'
import { relativeAge } from '#lib/time'
import { useInlineRename } from '#lib/useInlineRename'
import { useProvisionWorkspace } from '#lib/useProvisionWorkspace'
import { patchStopped } from '#lib/useStoppedWorkspaces'
import { useIsMobile } from '#lib/viewport'
import { describeWorkspaceDeathReason } from '@yaac/shared/death-reason'
// The server refuses longer group names, so the name fields stop here.
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import type {
  StoppedWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'

/** Whether a workspace is stopping, per the server or an optimistic stop in
 *  flight. Its row stays in place but is greyed out and can't be selected
 *  or dragged (see WorkspaceRow). */
export function isTerminating(
  workspace: Pick<WorkspaceListEntry, 'workspaceId' | 'stopping'>,
  pendingDeleteIds: string[],
): boolean {
  return Boolean(workspace.stopping) || pendingDeleteIds.includes(workspace.workspaceId)
}

/** Drag support the list passes down to its rows. */
export interface SidebarDrag {
  /** A row's pointerdown; a press that never becomes a drag calls
   *  `onSelect` (see usePressDrag). */
  start: (e: ReactPointerEvent, workspace: WorkspaceListEntry, onSelect: () => void) => void
  /** The row being dragged right now, if any. */
  activeId: string | null
}

/** Row for a workspace still provisioning. Clicking it shows the progress in
 *  the main pane; a failed one has a dismiss ×. */
export function ProvisioningRow({ entry }: { entry: ProvisioningWorkspaceEntry }): JSX.Element {
  const selectedWorkspaceId = useUiStore((s) => s.selectedWorkspaceId)
  const selectWorkspace = useUiStore((s) => s.selectWorkspace)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)

  const dismiss = (): void => {
    void dismissProvisioning(entry.workspaceId).catch(() => { /* best-effort */ })
    removeOptimisticProvisioning(entry.workspaceId)
    if (selectedWorkspaceId === entry.workspaceId) selectWorkspace(null)
  }

  return (
    <div className="group relative mx-2">
      <button
        onClick={() => selectWorkspace(entry.workspaceId)}
        className={clsx(
          'flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2/60',
          selectedWorkspaceId === entry.workspaceId && 'bg-surface-2 hover:bg-surface-2',
        )}
      >
        {/* The dismiss × is always visible on touch, so leave room for it. */}
        <span className={clsx('flex items-center gap-2', entry.error && 'max-md:pr-9')}>
          <span className="truncate font-medium text-text-dim">
            {entry.kind === 'restart' ? 'Restarting workspace' : 'New workspace'}
          </span>
          <span className="ml-auto shrink-0 text-xs text-text-faint">{agentLabel(entry.tool, entry)}</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs text-text-faint">
          {entry.error ? (
            <span className="text-danger">failed</span>
          ) : (
            <>
              <LoadingIcon size={11} className="animate-spin" />
              <span className="truncate">{entry.message || 'starting…'}</span>
            </>
          )}
        </span>
      </button>

      {entry.error && (
        <button
          onClick={dismiss}
          title="Dismiss"
          aria-label="Dismiss"
          className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
            opacity-0 transition hover:bg-surface-3 hover:text-text group-hover:opacity-100
            max-md:h-7 max-md:w-7 max-md:opacity-100"
        >
          <CloseIcon size={14} />
        </button>
      )}
    </div>
  )
}

/**
 * A workspace title truncated with an ellipsis. On row hover it scrolls to
 * reveal the hidden tail; the distance is measured at the hovered width, so
 * titles that fit don't move.
 */
function MarqueeTitle({ text, hovered }: { text: string; hovered: boolean }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!hovered) {
      el.style.animation = ''
      return
    }
    const shift = Math.max(0, el.scrollWidth - el.clientWidth)
    if (shift === 0) {
      el.style.animation = ''
      return
    }
    // Roughly constant speed, with a minimum so short scrolls aren't a twitch.
    const duration = 1400 + shift * 34
    el.style.setProperty('--marquee-shift', `-${shift}px`)
    el.style.animation = `marquee ${duration}ms ease-in-out infinite`
  }, [hovered, text])

  return (
    <span className="relative min-w-0 flex-1 overflow-hidden">
      <span ref={ref} className={clsx('block font-medium', hovered ? 'whitespace-nowrap' : 'truncate')}>
        {text}
      </span>
    </span>
  )
}

/** How many of a workspace's agent sessions are active. Zero reads as the
 *  ordinary single-agent case. */
function openAgentCount(workspace: WorkspaceListEntry): number {
  return workspace.agentSessions.filter((a) => a.active).length
}

export function WorkspaceRow({
  workspace,
  shownGroups,
  drag,
  rowIds,
}: {
  workspace: WorkspaceListEntry
  shownGroups: WorkspaceGroupSummary[]
  drag: SidebarDrag
  /** The sidebar's selectable rows, so stopping this one selects the next. */
  rowIds: string[]
}): JSX.Element {
  const selectedWorkspaceId = useUiStore((s) => s.selectedWorkspaceId)
  const selectWorkspace = useUiStore((s) => s.selectWorkspace)
  const readWaiting = useUiStore((s) => s.readWaiting)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const openCreateWorkspace = useUiStore((s) => s.openCreateWorkspace)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [grouping, setGrouping] = useState(false)
  const [hovered, setHovered] = useState(false)
  const {
    editing: editingTitle,
    seed,
    inputRef,
    start: startRename,
    handleKeyDown: handleRenameKeyDown,
    handleBlur: handleRenameBlur,
  } = useInlineRename(workspace.workspaceId, workspace.title || workspace.prompt || '')
  // No hover on touch: the actions menu is always shown and the marquee
  // never runs.
  const isMobile = useIsMobile()
  const unread = isUnreadWaiting(workspace, readWaiting)
  const stopping = isTerminating(workspace, pendingDeleteIds)

  const onConfirmDelete = (): void => {
    setConfirmDelete(false)
    stopWorkspaceOptimistic(workspace, rowIds)
  }

  // A stopping row is a greyed, inert placeholder until the snapshot drops it.
  if (stopping) {
    return (
      <div className="mx-2">
        <div
          aria-disabled="true"
          className="flex w-full cursor-default flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm opacity-60"
        >
          <span className="flex items-center gap-2">
            <LoadingIcon size={11} className="shrink-0 animate-spin text-text-faint" />
            <span className="truncate font-medium text-text-dim">
              {workspace.title || workspace.prompt || 'New workspace'}
            </span>
          </span>
          <span className="flex items-center gap-2 text-xs text-text-faint">
            <span className="truncate">stopping…</span>
            <span className="ml-auto shrink-0">{agentLabel(workspace.tool, workspaceModel(workspace))}</span>
          </span>
        </div>
      </div>
    )
  }

  // The age, agent count and tool line, shown under the title or rename input.
  const metaLine = (
    <span className="flex items-center gap-2 text-xs text-text-faint">
      <span className="shrink-0">{relativeAge(workspace.createdAt)}</span>
      {/* Only shown for more than one active agent. */}
      {openAgentCount(workspace) > 1 && (
        <span
          className="shrink-0"
          title={`${openAgentCount(workspace)} agent workspaces open in this workspace`}
        >
          {openAgentCount(workspace)} agents
        </span>
      )}
      {/* Tool and model; hidden when the blocked-hosts badge takes the spot. */}
      {workspace.blockedHosts.length === 0 && (
        <span className="ml-auto shrink-0">
          {agentLabel(workspace.tool, workspaceModel(workspace))}
        </span>
      )}
    </span>
  )

  return (
    <div
      className="group relative mx-2"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {editingTitle ? (
        <div className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm">
          <span className="flex items-center gap-2">
            <input
              ref={inputRef}
              aria-label="Workspace row title"
              defaultValue={seed}
              placeholder="Workspace name"
              onKeyDown={handleRenameKeyDown}
              onBlur={handleRenameBlur}
              className="min-w-0 flex-1 rounded border border-border-strong bg-bg px-1.5 py-0.5
                text-sm font-medium text-text outline-none"
            />
          </span>
          {metaLine}
        </div>
      ) : (
        <>
          <button
            // A mouse press may become a drag; if not, the list calls the
            // select callback. Touch uses onClick.
            onPointerDown={(e) => drag.start(e, workspace, () => selectWorkspace(workspace.workspaceId))}
            onClick={() => selectWorkspace(workspace.workspaceId)}
            className={clsx(
              'flex w-full flex-col gap-0.5 rounded-lg px-2.5 text-left text-sm transition hover:bg-surface-2/60',
              // Taller on touch.
              'py-2 max-md:py-2.5',
              'cursor-grab active:cursor-grabbing max-md:cursor-pointer',
              drag.activeId === workspace.workspaceId && 'opacity-60',
              selectedWorkspaceId === workspace.workspaceId && 'bg-surface-2 hover:bg-surface-2',
            )}
          >
            {/* On hover (always on mobile) the title insets to clear the
                actions menu. */}
            <span className="flex items-center gap-2 group-hover:pr-8 max-md:pr-10">
              {/* Spinner while the agent is running. */}
              {workspace.status === 'running' && (
                <span className="braille-spinner shrink-0 text-emerald-400" aria-hidden>
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              )}
              {/* Unread dot: waiting and not yet viewed. */}
              {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
              <MarqueeTitle
                text={workspace.title || workspace.prompt || 'New workspace'}
                hovered={hovered && !isMobile}
              />
            </span>
            {metaLine}
          </button>

          {/* A sibling, since a button can't nest in the row button. Only the
              badge itself takes clicks. */}
          {workspace.blockedHosts.length > 0 && (
            <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1">
              <BlockedHostsBadge
                hosts={workspace.blockedHosts}
                workspaceId={workspace.workspaceId}
                iconSize={11}
                className="pointer-events-auto hover:bg-danger/25"
              />
            </span>
          )}

          {/* A sibling of the row button, inert until hover so it doesn't
              take clicks meant for the row. Always shown on mobile. */}
          <RowMenu
            label="Workspace actions"
            items={[
              { label: 'Rename', onSelect: startRename },
              { label: 'Move to group…', onSelect: () => setGrouping(true) },
              {
                label: 'Queue workspace after this…',
                onSelect: () => openCreateWorkspace({
                  projectSlug: workspace.projectSlug, parent: workspace.workspaceId, focus: 'prompt',
                }),
              },
              'separator',
              { label: 'Stop…', onSelect: () => setConfirmDelete(true) },
            ]}
          />
        </>
      )}

      <GroupDialog
        open={grouping}
        onOpenChange={setGrouping}
        workspace={workspace}
        shownGroups={shownGroups}
      />
      <StopWorkspaceDialog
        workspace={confirmDelete ? workspace : null}
        onOpenChange={setConfirmDelete}
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

/**
 * Dialog to create a group or move a workspace into an existing one. This
 * is how touch and keyboard users group workspaces; mouse users can drag.
 */
function GroupDialog({
  open,
  onOpenChange,
  workspace,
  shownGroups,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: WorkspaceListEntry
  /** The groups on screen, the same targets a drag has. */
  shownGroups: WorkspaceGroupSummary[]
}): JSX.Element {
  const move = useMutation({
    mutationFn: (op: () => Promise<unknown>) => op(),
    onSuccess: () => onOpenChange(false),
  })
  const busy = move.isPending
  const { projectSlug, workspaceId } = workspace

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const raw = new FormData(event.currentTarget).get('name')
    const name = (typeof raw === 'string' ? raw : '').trim()
    if (name) move.mutate(() => api.workspace.group.create.$post({ json: { projectSlug, workspaceId, name } }))
  }
  const moveTo = (groupId: string | null): void => {
    move.mutate(() => api.workspace['set-group'].$post({ json: { projectSlug, workspaceId, groupId } }))
  }

  const others = shownGroups.filter((g) => g.groupId !== workspace.groupId)

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!busy) { move.reset(); onOpenChange(next) } }}
      variant="form"
      className="w-[380px]"
    >
      <Dialog.Title className="text-sm font-semibold">Add to group</Dialog.Title>
      <Dialog.Description className="mt-1 text-xs text-text-dim">
        Groups collect workspaces at the bottom of the sidebar. Drag rows between them,
        and pin one to keep it when nothing inside is running.
      </Dialog.Description>
      <form onSubmit={create} className="mt-4 flex flex-col gap-3">
        <input
          name="name"
          autoFocus
          placeholder="New group name"
          maxLength={MAX_TITLE_LENGTH}
          className="rounded-md border border-border bg-bg px-3 py-2 text-xs text-text outline-none
            focus:border-border-strong"
        />
        {move.error && <p className="text-xs text-red-400">{move.error.message}</p>}
        <div className="flex justify-end gap-2">
          <Dialog.Close
            disabled={busy}
            className="flex h-8 items-center rounded-md px-3 text-xs text-text-dim transition
              hover:bg-surface-3 hover:text-text disabled:opacity-50"
          >
            Cancel
          </Dialog.Close>
          <button
            type="submit"
            disabled={busy}
            className="flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-bg transition
              hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </form>

      {(others.length > 0 || workspace.groupId !== undefined) && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-[11px] uppercase tracking-wide text-text-faint">Or move it to</p>
          <div className="mt-2 flex flex-col">
            {others.map((g) => (
              <button
                key={g.groupId}
                disabled={busy}
                onClick={() => moveTo(g.groupId)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-dim
                  transition hover:bg-surface-3 hover:text-text disabled:opacity-50"
              >
                <span className="truncate">{g.name}</span>
              </button>
            ))}
            {workspace.groupId !== undefined && (
              <button
                disabled={busy}
                onClick={() => moveTo(null)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-text-dim
                  transition hover:bg-surface-3 hover:text-text disabled:opacity-50"
              >
                <GroupRemoveIcon size={12} className="shrink-0" />
                <span>Remove from group</span>
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

/**
 * A stopped workspace's row in a group (ghost or held). Not selectable. Its
 * hover actions remove it from the group or restart it; a restart shows a
 * provisioning row in its place.
 */
export function DeletedWorkspaceRow({ entry }: { entry: StoppedWorkspaceEntry }): JSX.Element {
  const provision = useProvisionWorkspace()
  const queryClient = useQueryClient()
  const removeOptimisticStopped = useUiStore((s) => s.removeOptimisticStopped)
  const openStoppedOverlay = useUiStore((s) => s.openStoppedOverlay)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const onConfirmRestart = (): void => {
    setConfirmRestart(false)
    removeOptimisticStopped(entry.workspaceId)
    // Pass the group so the restarting row appears in the same place.
    provision(entry.projectSlug, entry.tool, 'restart', entry.workspaceId,
      (sid, onProgress) => restartWorkspace(sid, onProgress),
      entry.groupId)
  }

  // The stopped list isn't in the snapshot, so update the cached list
  // directly to show the change right away.
  const ungroup = (): void => {
    patchStopped(queryClient, entry.projectSlug,
      (e) => (e.workspaceId === entry.workspaceId ? { ...e, groupId: undefined } : e))
    removeOptimisticStopped(entry.workspaceId)
    api.workspace['set-group'].$post({ json: { projectSlug: entry.projectSlug, workspaceId: entry.workspaceId, groupId: null } })
      .catch((e: unknown) => console.error('group move failed', e))
  }

  const deletedLine = entry.deathReason
    ? `died${entry.stoppedAt ? ` ${relativeAge(entry.stoppedAt)}` : ''} — ${describeWorkspaceDeathReason(entry.deathReason)}`
    : entry.stoppedAt
      ? `stopped ${relativeAge(entry.stoppedAt)}`
      : `last active ${relativeAge(entry.lastActiveAt ?? entry.createdAt)}`

  return (
    <div className="group relative mx-2">
      {/* Opens the stopped-workspaces overlay on this workspace, which is where
          its conversation is readable. There is still nothing to *select* —
          it has no pane until it is restarted — so it stays out of the row
          cycle (`sidebarRowIds`) and reads as dimmed rather than active. */}
      <button
        type="button"
        onClick={() => openStoppedOverlay(entry.workspaceId)}
        title="Read this workspace's conversation"
        className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm opacity-60
          transition hover:bg-surface-2/50 hover:opacity-90 focus-visible:outline-none
          focus-visible:ring-1 focus-visible:ring-border-strong"
      >
        <span className="flex items-center gap-2 group-hover:pr-12 max-md:pr-14">
          <span className="truncate font-medium text-text-dim">
            {entry.title || entry.prompt || 'New workspace'}
          </span>
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="truncate">{deletedLine}</span>
          <span className="ml-auto shrink-0">{agentLabel(entry.tool, workspaceModel(entry))}</span>
        </span>
      </button>

      {/* Overlay buttons as on live rows: remove from group, then restart. */}
      {entry.groupId !== undefined && <button
        onClick={ungroup}
        title="Remove from group"
        aria-label="Remove from group"
        className="absolute right-8 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100
          max-md:right-9 max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
      >
        <GroupRemoveIcon size={13} />
      </button>}
      <button
        onClick={() => setConfirmRestart(true)}
        title="Restart workspace"
        aria-label="Restart workspace"
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100
          max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
      >
        <RestartIcon size={13} />
      </button>

      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        destructive={false}
        title="Restart this workspace?"
        description={entry.title || entry.prompt || 'New workspace'}
        confirmLabel="Restart"
        onConfirm={onConfirmRestart}
      />
    </div>
  )
}

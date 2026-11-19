import {
  useRef,
  useState,
  type JSX,
  useLayoutEffect,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import clsx from 'clsx'
import { useMutation } from '@tanstack/react-query'
import { CloseIcon, GroupRemoveIcon, LoadingIcon, RestartIcon, TimeoutIcon } from '#lib/icons'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { StatusMark } from '#components/StatusMark'
import { StopWorkspaceDialog } from '#components/StopWorkspaceDialog'
import { SidebarRow } from '#components/sidebar/SidebarRow'
import { agentLabel, workspaceAgentLabel } from '#lib/agentLabel'
import { api } from '#lib/api'
import { dismissProvisioning } from '#lib/createWorkspace'
import { stopProvisioning, stopWorkspaceOptimistic } from '#lib/stopWorkspaceFlow'
import { useUiStore, isSessionUnread, isUnreadWaiting, isUnseenDeath } from '#lib/store'
import { sessionTarget } from '#lib/panes'
import { isLocked } from '#lib/steps'
import { relativeAge, timeUntil, useNow } from '#lib/time'
import { useInlineRename } from '#lib/useInlineRename'
import { useReadOnly, useTeammateName, useWhoami } from '#lib/viewer'
import { useRerunStopped, useRestartStopped } from '#lib/useStoppedWorkspaces'
import { useIsMobile } from '#lib/viewport'
import { describeWorkspaceDeathReason } from '@yaac/shared/death-reason'
// The server refuses longer group names, so the name fields stop here.
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import type {
  SessionEntry,
  StoppedWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'
import { YButton, YConfirm, YDialog, YDialogClose, YDialogDescription, YDialogTitle, YInput, YStatus } from '#ui'

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
 *  the main pane. Its × stops it, or once failed, dismisses it. */
export function ProvisioningRow({ entry }: { entry: ProvisioningWorkspaceEntry }): JSX.Element {
  const selectedWorkspaceId = useUiStore((s) => s.selectedWorkspaceId)
  const selectWorkspace = useUiStore((s) => s.selectWorkspace)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const readOnly = useReadOnly()

  const dismiss = (): void => {
    void dismissProvisioning(entry.workspaceId).catch(() => { /* best-effort */ })
    removeOptimisticProvisioning(entry.workspaceId)
    if (selectedWorkspaceId === entry.workspaceId) selectWorkspace(null)
  }

  const title = entry.kind === 'restart' ? 'Restarting workspace' : entry.title ?? 'New workspace'
  return (
    <SidebarRow
      label={title}
      onSelect={() => selectWorkspace(entry.workspaceId)}
      selected={selectedWorkspaceId === entry.workspaceId}
      mark={entry.error ? <YStatus kind="fail" /> : <LoadingIcon size={11} className="animate-spin text-subtle" />}
      title={title}
      meta={(
        <>
          {entry.error ? <span className="text-danger">failed</span> : <span className="truncate">{entry.message || 'starting…'}</span>}
          <span className="ml-auto shrink-0">{agentLabel(entry.tool, entry)}</span>
        </>
      )}
      actions={!entry.stopping && !readOnly && (
        <YButton
          variant="ghost"
          size="sm"
          icon={CloseIcon}
          onClick={entry.error ? dismiss : () => stopProvisioning(entry.workspaceId)}
          title={entry.error ? 'Dismiss' : 'Stop'}
          aria-label={entry.error ? 'Dismiss' : 'Stop'}
          className="max-md:size-7"
        />
      )}
    />
  )
}

/**
 * A workspace title truncated with an ellipsis. On row hover it scrolls to
 * reveal the hidden tail; titles that fit don't move.
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

  return <span ref={ref} className={clsx('block', hovered ? 'whitespace-nowrap' : 'truncate')}>{text}</span>
}

/** Whether a press on a row landed on one of its own controls (its menu,
 *  the blocked-hosts badge) rather than on the row, so it is not a drag. */
function onControl(e: ReactPointerEvent): boolean {
  const hit = e.target instanceof Element ? e.target.closest('button') : null
  return hit !== null && hit.parentElement !== e.currentTarget
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
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
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
  const me = useWhoami()?.userId
  const unread = isUnreadWaiting(workspace, me)
  const teammate = useTeammateName()
  const stopping = isTerminating(workspace, pendingDeleteIds)
  const now = useNow()

  const onConfirmDelete = (): void => {
    setConfirmDelete(false)
    stopWorkspaceOptimistic(workspace, rowIds)
  }

  const title = workspace.title || workspace.prompt || 'New workspace'

  // A stopping row is a greyed, inert placeholder until the snapshot drops it.
  if (stopping) {
    return (
      <SidebarRow
        label={title}
        rowProps={{ 'aria-disabled': true }}
        className="cursor-default opacity-60"
        mark={<LoadingIcon size={11} className="animate-spin text-subtle" />}
        title={title}
        meta={<><span className="truncate">stopping…</span><span className="ml-auto shrink-0">{workspaceAgentLabel(workspace)}</span></>}
      />
    )
  }

  // The age, timeout, and agent count and tool, or the blocked-hosts badge
  // in their place.
  const meta = (
    <>
      <span className="shrink-0">{relativeAge(workspace.createdAt)}</span>
      {workspace.deadline !== undefined && (
        <span role="img" aria-label={`Stops in ${timeUntil(workspace.deadline, now)}`}
          title={`Stops in ${timeUntil(workspace.deadline, now)}`} className="shrink-0">
          <TimeoutIcon size={11} />
        </span>
      )}
      {/* Several sessions are counted here and listed under the row; one is
          named by its agent. */}
      {workspace.blockedHosts.length > 0 ? (
        <BlockedHostsBadge
          hosts={workspace.blockedHosts}
          workspaceId={workspace.workspaceId}
          iconSize={11}
          className="pointer-events-auto ml-auto hover:bg-danger/25"
        />
      ) : (
        <span className="ml-auto shrink-0">
          {workspace.sessions.length > 1 ? `${String(workspace.sessions.length)} sessions` : workspaceAgentLabel(workspace)}
        </span>
      )}
    </>
  )
  const select = (): void => selectWorkspace(workspace.workspaceId)

  return (
    <div>
      {editingTitle ? (
        <div className="flex flex-col gap-0.5 px-2.5 py-2">
          <YInput
            ref={inputRef}
            aria-label="Workspace row title"
            defaultValue={seed}
            placeholder="Workspace name"
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            className="font-medium"
          />
          <span className="flex items-center gap-2 text-sm text-subtle">{meta}</span>
        </div>
      ) : (
        <SidebarRow
          label={title}
          onSelect={select}
          selected={selectedWorkspaceId === workspace.workspaceId}
          rowProps={{
            // A mouse press may become a drag; if not, the list calls the
            // select callback. Touch uses the row's click.
            onPointerDown: (e) => { if (!onControl(e)) drag.start(e, workspace, select) },
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          }}
          className={clsx('cursor-grab active:cursor-grabbing max-md:cursor-pointer',
            drag.activeId === workspace.workspaceId && 'opacity-60')}
          mark={(
            <StatusMark
              status={workspace.status}
              asking={workspace.asking === true}
              unread={unread}
              {...(teammate !== undefined ? { owner: teammate } : {})}
            />
          )}
          title={<MarqueeTitle text={title} hovered={hovered && !isMobile} />}
          strong={unread || workspace.asking === true}
          meta={meta}
          menu={{
            label: 'Workspace actions',
            items: [
              ...isLocked(workspace) ? [] : [{
                label: 'New session…',
                onSelect: () => openNewWorkspace({ projectId: workspace.projectId, inWorkspace: workspace.workspaceId }),
              }],
              { label: 'Rename', onSelect: startRename },
              { label: 'Move to group…', onSelect: () => setGrouping(true) },
              {
                label: 'Queue workspace after this…',
                onSelect: () => openNewWorkspace({ projectId: workspace.projectId, parent: workspace.workspaceId }),
              },
              // A site's release is stopped only through its site.
              ...workspace.site !== undefined ? [] : ['separator' as const, { label: 'Stop…', onSelect: () => setConfirmDelete(true) }],
            ],
          }}
        />
      )}
      {workspace.sessions.length > 1 && workspace.sessions.map((s) => (
        <SessionRow key={s.sessionId} workspace={workspace} session={s} />
      ))}

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
 * One of a workspace's sessions, listed under its row when it has several:
 * its own status (a bold title while unread), its title or opening message,
 * and its agent. Clicking it opens the workspace on that session's pane.
 */
function SessionRow({ workspace, session }: { workspace: WorkspaceListEntry; session: SessionEntry }): JSX.Element {
  const me = useWhoami()?.userId
  const teammate = useTeammateName()
  const selectWorkspace = useUiStore((s) => s.selectWorkspace)
  const focusTerminal = useUiStore((s) => s.focusTerminal)
  const open = (): void => {
    selectWorkspace(workspace.workspaceId)
    focusTerminal(workspace.workspaceId, sessionTarget(session.sessionId))
  }
  const name = session.title ?? session.prompt?.split('\n')[0] ?? agentLabel(session.tool, session)
  return (
    <SidebarRow
      depth={1}
      label={name}
      onSelect={open}
      mark={(
        <StatusMark
          status={session.exited === true ? undefined : session.status}
          asking={session.asking === true}
          unread={isSessionUnread(session, me)}
          {...(teammate !== undefined ? { owner: teammate } : {})}
        />
      )}
      title={name}
      strong={isSessionUnread(session, me) || session.asking === true}
      trailing={(
        <span className="ml-auto shrink-0 text-subtle">
          {session.exited === true ? 'exited' : agentLabel(session.tool, session)}
        </span>
      )}
    />
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
  const { projectId, workspaceId } = workspace

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const raw = new FormData(event.currentTarget).get('name')
    const name = (typeof raw === 'string' ? raw : '').trim()
    if (name) move.mutate(() => api.workspace.group.create.$post({ json: { projectId, workspaceId, name } }))
  }
  const moveTo = (groupId: string | null): void => {
    move.mutate(() => api.workspace.group.move.$post({ json: { projectId, workspaceId, group: groupId } }))
  }

  const others = shownGroups.filter((g) => g.groupId !== workspace.groupId)

  return (
    <YDialog
      open={open}
      onOpenChange={(next) => { if (!busy) { move.reset(); onOpenChange(next) } }}
      variant="form"
      className="w-[380px]"
    >
      <YDialogTitle className="text-base font-semibold">Add to group</YDialogTitle>
      <YDialogDescription className="mt-1 text-md text-muted">
        Groups collect workspaces at the bottom of the sidebar. Drag rows between them,
        and pin one to keep it when nothing inside is running.
      </YDialogDescription>
      <form onSubmit={create} className="mt-4 flex flex-col gap-3">
        <YInput name="name" autoFocus placeholder="New group name" maxLength={MAX_TITLE_LENGTH} />
        {move.error && <p className="text-md text-danger">{move.error.message}</p>}
        <div className="flex justify-end gap-2">
          <YDialogClose disabled={busy} render={<YButton variant="ghost" />}>Cancel</YDialogClose>
          <YButton type="submit" variant="primary" disabled={busy}>{busy ? 'Creating…' : 'Create group'}</YButton>
        </div>
      </form>

      {(others.length > 0 || workspace.groupId !== undefined) && (
        <div className="mt-4 border-t border-line-strong pt-3">
          <p className="text-sm uppercase tracking-wide text-subtle">Or move it to</p>
          <div className="mt-2 flex flex-col">
            {others.map((g) => (
              <YButton
                variant="bare"
                key={g.groupId}
                disabled={busy}
                onClick={() => moveTo(g.groupId)}
                className="flex items-center gap-2 px-2 py-1.5 text-left text-md text-muted transition hover:bg-hover hover:text-text"
              >
                <span className="truncate">{g.name}</span>
              </YButton>
            ))}
            {workspace.groupId !== undefined && (
              <YButton
                variant="bare"
                disabled={busy}
                onClick={() => moveTo(null)}
                className="flex items-center gap-2 px-2 py-1.5 text-left text-md text-muted transition hover:bg-hover hover:text-text"
              >
                <GroupRemoveIcon size={12} className="shrink-0" />
                <span>Remove from group</span>
              </YButton>
            )}
          </div>
        </div>
      )}
    </YDialog>
  )
}

/**
 * A stopped workspace's row: in the Stopped section, or in a group as a
 * ghost or held row. Selecting it shows its conversation in the main pane.
 * It stays out of the Alt+J/K row cycle (`sidebarRowIds`) and reads as
 * dimmed until selected. Its hover action restarts it, which shows a
 * provisioning row in its place.
 */
export function StoppedWorkspaceRow({ entry }: { entry: StoppedWorkspaceEntry }): JSX.Element {
  const selected = useUiStore((s) => s.selectedWorkspaceId === entry.workspaceId)
  const selectWorkspace = useUiStore((s) => s.selectWorkspace)
  const restart = useRestartStopped()
  const rerun = useRerunStopped()
  const [confirmRestart, setConfirmRestart] = useState(false)
  const readOnly = useReadOnly()
  const me = useWhoami()?.userId
  const unseen = isUnseenDeath(entry, me)
  // A non-interactive workspace is rerun in a new one, never restarted
  // (docs/workspace-steps.md), and a site's release is neither: only its
  // site starts another (docs/public-sites.md).
  const reruns = entry.nonInteractive === true

  const stopLine = entry.deathReason
    ? `died ${relativeAge(entry.stoppedAt)} — ${describeWorkspaceDeathReason(entry.deathReason)}`
    : `${entry.stepsOutcome ?? (entry.endedAtNextRun ? 'ended at next run' : entry.timedOut ? 'timed out' : 'stopped')} `
      + relativeAge(entry.stoppedAt)

  const title = entry.title || entry.prompt || 'New workspace'

  return (
    <>
      <SidebarRow
        label={title}
        onSelect={() => selectWorkspace(entry.workspaceId)}
        selected={selected}
        rowProps={{ title: 'Read this workspace\'s conversation' }}
        className={selected ? undefined : unseen ? 'bg-warning/10 opacity-80 hover:bg-warning/15' : 'opacity-60 hover:opacity-90'}
        // Only an unseen death takes the mark's slot; the rest start at the edge.
        {...(unseen ? { mark: <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" /> } : {})}
        title={title}
        meta={(
          <>
            <span className={clsx('truncate', entry.stepsOutcome === 'failed' && 'text-danger')}>{stopLine}</span>
            <span className="ml-auto shrink-0">{workspaceAgentLabel(entry)}</span>
          </>
        )}
        actions={!readOnly && entry.site === undefined && (
          <YButton
            variant="ghost"
            size="sm"
            icon={RestartIcon}
            onClick={() => setConfirmRestart(true)}
            title={reruns ? 'Rerun its steps in a new workspace' : 'Restart workspace'}
            aria-label={reruns ? 'Rerun workspace' : 'Restart workspace'}
            className="max-md:size-7"
          />
        )}
      />

      <YConfirm
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        destructive={false}
        title={reruns ? 'Rerun this workspace’s steps?' : 'Restart this workspace?'}
        description={reruns
          ? 'A new non-interactive workspace runs them again at the commit this one ran at.'
          : title}
        confirmLabel={reruns ? 'Rerun' : 'Restart'}
        onConfirm={() => {
          setConfirmRestart(false)
          if (reruns) rerun(entry, false)
          else restart(entry)
        }}
      />
    </>
  )
}

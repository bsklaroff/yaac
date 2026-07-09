import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { Collapsible } from '@base-ui/react/collapsible'
import { ChevronIcon, CloseIcon, LoadingIcon, RestartIcon, SidebarIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { BlockedHostsBadge } from '@/frontend/components/BlockedHostsBadge'
import { GitAuthFailureBadge } from '@/frontend/components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '@/frontend/components/ImageBuildIndicator'
import { NewSessionButton } from '@/frontend/components/NewSessionButton'
import { ProjectActionsMenu } from '@/frontend/components/ProjectActionsMenu'
import { ConfirmDialog } from '@/frontend/components/ui/ConfirmDialog'
import { dismissProvisioning, restartSession } from '@/frontend/lib/createSession'
import { deleteSessionOptimistic } from '@/frontend/lib/deleteSessionFlow'
import { getDeletedSessions } from '@/frontend/lib/deletedApi'
import { useProvisionSession } from '@/frontend/lib/useProvisionSession'
import { isUnreadWaiting, useUiStore } from '@/frontend/store'
import type { DeletedSessionEntry, GitAuthFailure, ProvisioningSessionEntry, SessionListEntry } from '@/shared/types'

/** User-facing session groups, in triage order (Waiting first). */
const GROUPS: { status: SessionListEntry['status']; label: string; defaultOpen: boolean }[] = [
  { status: 'waiting', label: 'Waiting', defaultOpen: true },
  { status: 'running', label: 'Running', defaultOpen: true },
]

/**
 * The sidebar's selectable rows in display order — provisioning first, then
 * the session groups in triage order, minus mid-delete sessions. This is the
 * list the Alt+↑/↓ session-switch shortcut steps through (Workspace owns the
 * handler). Deleted rows are excluded: clicking those restarts, not selects.
 */
export function sidebarRowIds(
  provisioning: Pick<ProvisioningSessionEntry, 'sessionId'>[],
  sessions: Pick<SessionListEntry, 'sessionId' | 'status'>[],
  pendingDeleteIds: string[],
): string[] {
  const shown = sessions.filter((s) => !pendingDeleteIds.includes(s.sessionId))
  return [
    ...provisioning.map((p) => p.sessionId),
    ...GROUPS.flatMap((g) => shown.filter((s) => s.status === g.status).map((s) => s.sessionId)),
  ]
}

/** Human relative age from the session's UTC 'YYYY-MM-DD HH:MM:SS' time. */
function relativeAge(createdAt: string): string {
  const t = Date.parse(createdAt.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function Sidebar({
  projectSlug,
  projectRemoteUrl,
  sessions,
  provisioning,
  connected,
  gitAuthFailures,
}: {
  projectSlug: string | null
  /** Active project's git remote ('' until the snapshot hydrates) — the
   *  remove-project dialog's type-to-confirm text. */
  projectRemoteUrl: string
  sessions: SessionListEntry[]
  provisioning: ProvisioningSessionEntry[]
  connected: boolean
  /** The active project's rejected git credentials (project-wide flag). */
  gitAuthFailures: GitAuthFailure[]
}): JSX.Element {
  // Hide sessions whose delete is in flight (optimistic) until the snapshot
  // drops them, so the empty state keys off what's actually shown.
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const shown = sessions.filter((s) => !pendingDeleteIds.includes(s.sessionId))
  const visibleCount = shown.filter((s) => GROUPS.some((g) => g.status === s.status)).length

  return (
    <aside className="my-2 ml-2 flex w-64 flex-col overflow-hidden rounded-lg
      border border-hairline bg-surface text-text">
      <div className="flex h-11 shrink-0 items-center gap-2 pl-4 pr-2">
        {projectSlug
          ? <ProjectActionsMenu slug={projectSlug} remoteUrl={projectRemoteUrl} />
          : <span className="font-semibold tracking-tight">yaac</span>}
        <div className="ml-auto flex items-center gap-2">
          <ImageBuildIndicator />
          {!connected && <span className="text-xs text-amber-400/80">reconnecting…</span>}
          {/* Project-wide: the stored credential is the project's, so the
              flag lives on the project header, not on individual sessions. */}
          {gitAuthFailures.length > 0 && (
            <GitAuthFailureBadge
              failures={gitAuthFailures}
              iconSize={11}
              className="hover:bg-[#d65858]/25"
            />
          )}
          {projectSlug && <NewSessionButton projectSlug={projectSlug} />}
          <button
            onClick={toggleSidebar}
            title="Hide sidebar"
            aria-label="Hide sidebar"
            className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
              hover:bg-surface-2 hover:text-text-dim"
          >
            <SidebarIcon size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {!projectSlug && <Empty label="No project selected" />}
        {projectSlug && visibleCount === 0 && provisioning.length === 0 && (
          <Empty label="No sessions yet — start one with +" />
        )}
        {provisioning.map((p) => <ProvisioningRow key={p.sessionId} entry={p} />)}
        {GROUPS.map((g) => (
          <SessionGroup
            key={g.status}
            label={g.label}
            defaultOpen={g.defaultOpen}
            sessions={shown.filter((s) => s.status === g.status)}
          />
        ))}
        {projectSlug && (
          <DeletedGroup
            projectSlug={projectSlug}
            activeSignature={sessions.map((s) => s.sessionId).sort().join(',')}
          />
        )}
      </div>
    </aside>
  )
}

/**
 * Deleted sessions for the project (containers gone, transcripts kept).
 * Collapsed by default; lazy-loaded and re-fetched whenever the active-session
 * set changes (so a just-deleted session appears and a restarted one drops).
 * Clicking a row restarts it via the same optimistic "starting" flow.
 */
function DeletedGroup({
  projectSlug,
  activeSignature,
}: {
  projectSlug: string
  activeSignature: string
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [restarting, setRestarting] = useState<string[]>([])
  const [confirm, setConfirm] = useState<DeletedSessionEntry | null>(null)
  const provision = useProvisionSession()
  const optimisticDeleted = useUiStore((s) => s.optimisticDeleted)
  const removeOptimisticDeleted = useUiStore((s) => s.removeOptimisticDeleted)

  const { data } = useQuery({
    queryKey: ['deleted', projectSlug, activeSignature],
    queryFn: () => getDeletedSessions(projectSlug),
    staleTime: 2000,
  })

  // Once list-deleted catches up to an optimistic entry, drop the optimistic
  // copy (the fetched one takes over — same id, no flicker).
  useEffect(() => {
    if (!data) return
    const fetched = new Set(data.map((d) => d.sessionId))
    for (const e of optimisticDeleted) if (fetched.has(e.sessionId)) removeOptimisticDeleted(e.sessionId)
  }, [data, optimisticDeleted, removeOptimisticDeleted])

  // Merge optimistic just-deleted entries (for this project) ahead of the
  // fetched list, de-duped, minus any mid-restart.
  const fetchedIds = new Set((data ?? []).map((d) => d.sessionId))
  const merged = [
    ...optimisticDeleted.filter((e) => e.projectSlug === projectSlug && !fetchedIds.has(e.sessionId)),
    ...(data ?? []),
  ]
  const rows = merged.filter((d) => !restarting.includes(d.sessionId))
  // Hide the group entirely when there's nothing to show (and it's closed),
  // so it doesn't add weight for projects with no deleted sessions.
  if (rows.length === 0 && !open) return null

  const onConfirmRestart = (entry: DeletedSessionEntry): void => {
    setConfirm(null)
    setRestarting((r) => [...r, entry.sessionId])
    removeOptimisticDeleted(entry.sessionId)
    provision(projectSlug, entry.tool, 'restart', entry.sessionId,
      (sid, onProgress) => restartSession(sid, onProgress, { projectSlug, tool: entry.tool }))
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="py-1">
      <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium
        text-text-faint outline-none transition hover:text-text-dim">
        <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        <span>Deleted</span>
        <span className="text-text-faint/70">{rows.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {rows.length === 0 && (
          <div className="px-4 py-2 text-xs text-text-faint">No deleted sessions</div>
        )}
        {rows.map((d) => (
          <button
            key={d.sessionId}
            onClick={() => setConfirm(d)}
            title="Restart this session"
            className="group/d mx-2 flex w-[calc(100%-1rem)] flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left
              text-sm text-text-dim transition hover:bg-surface-2/60 hover:text-text"
          >
            <span className="flex items-center gap-2">
              <span className="truncate font-medium">{d.title || d.prompt || 'New session'}</span>
              <RestartIcon
                size={13}
                className="ml-auto shrink-0 text-text-faint opacity-0 transition-opacity group-hover/d:opacity-100"
              />
            </span>
            <span className="flex items-center gap-2 text-xs text-text-faint">
              <span className="truncate">{relativeAge(d.createdAt)}</span>
              <span className="ml-auto shrink-0">{TOOL_LABEL[d.tool]}</span>
            </span>
          </button>
        ))}
      </Collapsible.Panel>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(next) => { if (!next) setConfirm(null) }}
        destructive={false}
        title="Restart this session?"
        description={confirm
          ? `Recreates the container and resumes ${TOOL_LABEL[confirm.tool]} from where it left off${confirm.prompt ? `:\n“${confirm.prompt}”` : '.'}`
          : ''}
        confirmLabel="Restart"
        onConfirm={() => { if (confirm) onConfirmRestart(confirm) }}
      />
    </Collapsible.Root>
  )
}

/** Selectable row for a session that's still provisioning. Clicking it opens
 *  the provisioning status in the main pane; a failed one offers a dismiss ×. */
function ProvisioningRow({ entry }: { entry: ProvisioningSessionEntry }): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)

  const dismiss = (): void => {
    void dismissProvisioning(entry.sessionId).catch(() => { /* best-effort */ })
    removeOptimisticProvisioning(entry.sessionId)
    if (selectedSessionId === entry.sessionId) selectSession(null)
  }

  return (
    <div className="group relative mx-2">
      <button
        onClick={() => selectSession(entry.sessionId)}
        className={clsx(
          'flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2/60',
          selectedSessionId === entry.sessionId && 'bg-surface-2 hover:bg-surface-2',
        )}
      >
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-text-dim">
            {entry.kind === 'restart' ? 'Restarting session' : 'New session'}
          </span>
          <span className="ml-auto shrink-0 text-xs text-text-faint">{TOOL_LABEL[entry.tool]}</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs text-text-faint">
          {entry.error ? (
            <span className="text-[#d65858]">failed</span>
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
            opacity-0 transition hover:bg-surface-3 hover:text-text group-hover:opacity-100"
        >
          <CloseIcon size={14} />
        </button>
      )}
    </div>
  )
}

function SessionGroup({
  label,
  sessions,
  defaultOpen,
}: {
  label: string
  sessions: SessionListEntry[]
  defaultOpen: boolean
}): JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  if (sessions.length === 0) return null

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="py-1">
      <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium
        text-text-faint outline-none transition hover:text-text-dim">
        <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        <span>{label}</span>
        <span className="text-text-faint/70">{sessions.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {sessions.map((s) => <SessionRow key={s.sessionId} session={s} />)}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

function SessionRow({ session }: { session: SessionListEntry }): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)
  const readWaiting = useUiStore((s) => s.readWaiting)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const unread = isUnreadWaiting(session, readWaiting)

  // Close the dialog immediately; the shared flow hides the row
  // optimistically and restores it if the delete fails.
  const onConfirmDelete = (): void => {
    setConfirmDelete(false)
    deleteSessionOptimistic(session)
  }

  return (
    <div className="group relative mx-2">
      <button
        onClick={() => selectSession(session.sessionId)}
        className={clsx(
          'flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2/60',
          selectedSessionId === session.sessionId && 'bg-surface-2 hover:bg-surface-2',
        )}
      >
        <span className="flex items-center gap-2">
          {/* Live pulse: the session's agent is actively running. A square,
              so it can't be mistaken for the round unread bubble below. */}
          {session.status === 'running' && (
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="absolute h-full w-full animate-ping rounded-[2px] bg-emerald-400/60" />
              <span className="h-1.5 w-1.5 rounded-[2px] bg-emerald-400" />
            </span>
          )}
          {/* Unread bubble: this session started waiting and hasn't been viewed. */}
          {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
          <span className="truncate font-medium">{session.title || session.prompt || 'New session'}</span>
          {/* Tool name; on row hover it yields to the delete × in the same spot. */}
          <span className="ml-auto shrink-0 text-xs text-text-faint transition-opacity group-hover:opacity-0">
            {TOOL_LABEL[session.tool]}
          </span>
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="truncate">{relativeAge(session.createdAt)}</span>
        </span>
      </button>

      {/* Overlaid as a sibling for the same reason as the delete × below:
          the badge is a button and can't nest inside the row button. The
          wrapper is pointer-inert so only the badge itself takes clicks. */}
      {session.blockedHosts.length > 0 && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1">
          <BlockedHostsBadge
            hosts={session.blockedHosts}
            iconSize={11}
            className="pointer-events-auto hover:bg-[#d65858]/25"
          />
        </span>
      )}

      {/* Overlaid as a sibling (not nested in the row button) and pointer-inert
          until hover, so it can't swallow clicks meant for selecting the row. */}
      <button
        onClick={() => setConfirmDelete(true)}
        title="Delete session"
        aria-label="Delete session"
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <CloseIcon size={14} />
      </button>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete session?"
        description="Stops and removes the session's container. The session history and worktree will be saved, and can be restarted."
        confirmLabel="Delete"
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

function Empty({ label }: { label: string }): JSX.Element {
  return <div className="px-4 py-2 text-sm text-text-faint">{label}</div>
}

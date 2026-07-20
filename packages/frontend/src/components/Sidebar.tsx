import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Collapsible } from '@base-ui/react/collapsible'
import { BranchIcon, ChevronIcon, CloseIcon, LoadingIcon, PinIcon, RestartIcon, SidebarIcon, TOOL_LABEL } from '#lib/icons'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { DeletedSessionsButton } from '#components/DeletedSessionsButton'
import { EmptyState } from '#components/ui/EmptyState'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { NewSessionButton } from '#components/NewSessionButton'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { SkillsButton } from '#components/SkillsButton'
import { UsageBadge } from '#components/UsageBadge'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { dismissProvisioning, restartSession, setSessionBackground } from '#lib/createSession'
import { getDeletedSessions } from '#lib/deletedApi'
import { deleteSessionOptimistic } from '#lib/deleteSessionFlow'
import { useProvisionSession } from '#lib/useProvisionSession'
import { isUnreadWaiting, useUiStore } from '#store'
import { describeSessionDeathReason } from '@yaac/shared/death-reason'
import type { DeletedSessionEntry, GitAuthFailure, ProvisioningSessionEntry, SessionListEntry } from '@yaac/shared/types'

/** User-facing session groups keyed by status, in triage order (Waiting
 *  first). Background pins and terminating are orthogonal to status and get
 *  their own sections rendered after these (see sidebarSections). */
const GROUPS: { status: SessionListEntry['status']; label: string; defaultOpen: boolean }[] = [
  { status: 'waiting', label: 'Waiting', defaultOpen: true },
  { status: 'running', label: 'Running', defaultOpen: true },
]

/** A session is terminating when the server has marked it (its pod has a
 *  deletionTimestamp, or a delete was just issued) or a client-side optimistic
 *  delete is still in flight. Such rows get their own "Terminating" section and
 *  render as non-interactive, greyed placeholders (see SessionRow). */
function isTerminating(
  session: Pick<SessionListEntry, 'sessionId' | 'terminating'>,
  pendingDeleteIds: string[],
): boolean {
  return Boolean(session.terminating) || pendingDeleteIds.includes(session.sessionId)
}

/**
 * The sidebar's selectable rows in display order — provisioning first, then
 * the session groups in triage order, then the Background pins, minus
 * terminating sessions. This is the list the Alt+↑/↓ session-switch shortcut
 * steps through (Workspace owns the handler). Terminating rows (server-marked,
 * or a mid-flight optimistic delete) still render, greyed, but aren't
 * selectable — nor are deleted Background rows (nothing to open).
 */
export function sidebarRowIds(
  provisioning: Pick<ProvisioningSessionEntry, 'sessionId'>[],
  sessions: Pick<SessionListEntry, 'sessionId' | 'status' | 'terminating' | 'background'>[],
  pendingDeleteIds: string[],
): string[] {
  const shown = sessions.filter((s) => !isTerminating(s, pendingDeleteIds))
  const foreground = shown.filter((s) => !s.background)
  return [
    ...provisioning.map((p) => p.sessionId),
    ...GROUPS.flatMap((g) => foreground.filter((s) => s.status === g.status).map((s) => s.sessionId)),
    ...shown.filter((s) => s.background).map((s) => s.sessionId),
  ]
}

/** One collapsible section in the sidebar. */
export interface SidebarSection {
  label: string
  defaultOpen: boolean
  sessions: SessionListEntry[]
  /** Deleted-but-pinned rows (Background section only) — rendered after the
   *  active rows as non-selectable placeholders with a restart action. */
  deleted?: DeletedSessionEntry[]
}

/**
 * Sidebar sections in render order: the status groups (Waiting, then Running)
 * holding live sessions, then Background holding every pinned session —
 * whatever its state: running, waiting, terminating, or deleted (the
 * `deletedBackground` rows) — then a Terminating section for unpinned
 * sessions on their way out. Status is orthogonal to both pins and
 * termination, so a pinned or terminating session leaves its status group.
 * Empty sections are kept in the list; SessionGroup renders nothing for them.
 */
export function sidebarSections(
  sessions: SessionListEntry[],
  pendingDeleteIds: string[],
  deletedBackground: DeletedSessionEntry[] = [],
): SidebarSection[] {
  const foreground = sessions.filter((s) => !s.background)
  const background = sessions.filter((s) => Boolean(s.background))
  const live = foreground.filter((s) => !isTerminating(s, pendingDeleteIds))
  const terminating = foreground.filter((s) => isTerminating(s, pendingDeleteIds))
  return [
    ...GROUPS.map((g) => ({
      label: g.label,
      defaultOpen: g.defaultOpen,
      sessions: live.filter((s) => s.status === g.status),
    })),
    { label: 'Background', defaultOpen: true, sessions: background, deleted: deletedBackground },
    { label: 'Terminating', defaultOpen: true, sessions: terminating },
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
  // Sessions on their way out stay visible as greyed "terminating…" rows
  // (SessionRow styles them) rather than vanishing, so the list doesn't jump.
  // They move to their own "Terminating" section instead of lingering under
  // Waiting/Running. The empty state keys off whether any section has rows,
  // terminating included.
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const optimisticDeleted = useUiStore((s) => s.optimisticDeleted)
  // Re-fetch the deleted list whenever the active set changes (a just-deleted
  // session appears, a restarted one drops).
  const activeSignature = sessions.map((s) => s.sessionId).sort().join(',')

  // Deleted sessions feed the Background section's pinned-but-deleted rows.
  // Same query key as DeletedSessionsButton, so the two share one fetch.
  const { data: deletedList } = useQuery({
    queryKey: ['deleted', projectSlug, activeSignature],
    queryFn: () => getDeletedSessions(projectSlug ?? '', 100),
    enabled: !!projectSlug,
    staleTime: 2000,
  })
  // Pinned deleted rows: optimistic just-deleted entries ahead of the fetched
  // list (de-duped), minus anything active again — a session mid-termination
  // is still in the snapshot (its Background row renders the terminating
  // placeholder), and one mid-restart has a provisioning row instead.
  const activeIds = new Set(sessions.map((s) => s.sessionId))
  const provisioningIds = new Set(provisioning.map((p) => p.sessionId))
  const fetchedIds = new Set((deletedList ?? []).map((d) => d.sessionId))
  const deletedBackground = [
    ...optimisticDeleted.filter((e) => e.projectSlug === projectSlug && !fetchedIds.has(e.sessionId)),
    ...(deletedList ?? []),
  ].filter((d) => d.background && !activeIds.has(d.sessionId) && !provisioningIds.has(d.sessionId))

  const sections = sidebarSections(sessions, pendingDeleteIds, deletedBackground)
  const visibleCount = sections.reduce(
    (n, sec) => n + sec.sessions.length + (sec.deleted?.length ?? 0), 0,
  )

  return (
    <aside className="my-2 ml-2 flex w-64 flex-col overflow-hidden rounded-lg
      border border-hairline bg-surface text-text">
      <div className="shrink-0">
        <div className="titlebar-drag flex h-11 items-center gap-2 pl-4 pr-2">
          <div className="no-drag flex min-w-0 flex-1 items-center">
            {projectSlug
              ? <ProjectActionsMenu slug={projectSlug} remoteUrl={projectRemoteUrl} />
              : <span className="font-semibold tracking-tight">yaac</span>}
          </div>
          <div className="flex shrink-0 items-center gap-2 no-drag">
            {!connected && <span className="text-xs text-amber-400/80">reconnecting…</span>}
            {projectSlug && <SkillsButton projectSlug={projectSlug} />}
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
        {/* Status chits sit on their own row below the name so a long project
            name gets the full width of the header strip above. Collapses to
            nothing (empty:hidden) when no chit has anything to show. */}
        <div className="flex items-center gap-2 px-4 pb-2 empty:hidden">
          <UsageBadge />
          <ImageBuildIndicator projectSlug={projectSlug} />
          {/* Project-wide: the stored credential is the project's, so the
              flag lives on the project header, not on individual sessions. */}
          {gitAuthFailures.length > 0 && (
            <GitAuthFailureBadge
              failures={gitAuthFailures}
              iconSize={11}
              className="hover:bg-[#d65858]/25"
            />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {!projectSlug && (
          <EmptyState
            compact
            className="py-10"
            title="No project selected"
            description="Pick a project from the rail on the left."
          />
        )}
        {projectSlug && visibleCount === 0 && provisioning.length === 0 && (
          <EmptyState
            compact
            className="py-10"
            title="No sessions yet"
            description="Start one with the + above."
          />
        )}
        {provisioning.map((p) => <ProvisioningRow key={p.sessionId} entry={p} />)}
        {sections.map((section) => (
          <SessionGroup
            key={section.label}
            label={section.label}
            defaultOpen={section.defaultOpen}
            sessions={section.sessions}
            deleted={section.deleted}
          />
        ))}
        {projectSlug && <DeletedSessionsButton projectSlug={projectSlug} activeSignature={activeSignature} />}
      </div>
    </aside>
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
  deleted = [],
  defaultOpen,
}: {
  label: string
  sessions: SessionListEntry[]
  /** Deleted-but-pinned rows, rendered after the active ones (Background). */
  deleted?: DeletedSessionEntry[]
  defaultOpen: boolean
}): JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  if (sessions.length === 0 && deleted.length === 0) return null

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="py-1">
      <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium
        text-text-faint outline-none transition hover:text-text-dim">
        <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        <span>{label}</span>
        <span className="text-text-faint/70">{sessions.length + deleted.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {sessions.map((s) => <SessionRow key={s.sessionId} session={s} />)}
        {deleted.map((d) => <DeletedSessionRow key={d.sessionId} entry={d} />)}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/**
 * Session title that fills the row's width, truncating with an ellipsis when it
 * doesn't fit. On row hover it un-clips and marquee-scrolls the full text (the
 * row has already inset its right edge to clear the delete ×). The scroll
 * distance is measured live at the hovered width, so titles that do fit stay
 * put and the animation always reveals exactly the hidden tail.
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
    // Constant-ish reveal speed (~55px/s across the two scroll legs), floored so
    // a short overflow still reads as a deliberate scroll, not a twitch.
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

function SessionRow({ session }: { session: SessionListEntry }): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)
  const readWaiting = useUiStore((s) => s.readWaiting)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hovered, setHovered] = useState(false)
  const unread = isUnreadWaiting(session, readWaiting)
  // The container is being torn down — server-marked, or an optimistic delete
  // not yet reflected in the snapshot. Either way the row is on its way out
  // and the Sidebar has already routed it into the "Terminating" section.
  const terminating = isTerminating(session, pendingDeleteIds)

  // Close the dialog immediately; the shared flow marks the row terminating
  // optimistically and restores it if the delete fails.
  const onConfirmDelete = (): void => {
    setConfirmDelete(false)
    deleteSessionOptimistic(session)
  }

  // Pin/unpin to the Background section. The server pushes a fresh snapshot,
  // so the row regroups without optimistic state.
  const toggleBackground = (): void => {
    void setSessionBackground(session.projectSlug, session.sessionId, !session.background)
      .catch((e: unknown) => console.error('background toggle failed', e))
  }

  // A terminating row is a non-interactive, greyed placeholder: no pulse, no
  // unread bubble, no delete × — just a spinner and a "terminating…" line. It
  // vanishes when the snapshot drops the session.
  if (terminating) {
    return (
      <div className="mx-2">
        <div
          aria-disabled="true"
          className="flex w-full cursor-default flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm opacity-60"
        >
          <span className="flex items-center gap-2">
            <LoadingIcon size={11} className="shrink-0 animate-spin text-text-faint" />
            <span className="truncate font-medium text-text-dim">
              {session.title || session.prompt || 'New session'}
            </span>
          </span>
          <span className="flex items-center gap-2 text-xs text-text-faint">
            <span className="truncate">terminating…</span>
            <span className="ml-auto shrink-0">{TOOL_LABEL[session.tool]}</span>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className="group relative mx-2"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={() => selectSession(session.sessionId)}
        className={clsx(
          'flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2/60',
          selectedSessionId === session.sessionId && 'bg-surface-2 hover:bg-surface-2',
        )}
      >
        {/* Title fills the row; only on hover does it inset to clear the pin
            + delete buttons and marquee-scroll when it's too long to fit. */}
        <span className="flex items-center gap-2 group-hover:pr-12">
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
          <MarqueeTitle text={session.title || session.prompt || 'New session'} hovered={hovered} />
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="shrink-0">{relativeAge(session.createdAt)}</span>
          {/* The remote branch this session's worktree tracks. */}
          {session.baseBranch && (
            <span className="flex min-w-0 items-center gap-1" title={`Tracking origin/${session.baseBranch}`}>
              <BranchIcon size={10} className="shrink-0" />
              <span className="truncate font-mono text-[11px]">{session.baseBranch}</span>
            </span>
          )}
          {/* Tool name moved off the title line so the title can run full-width;
              hidden when the blocked-hosts badge claims the bottom-right. */}
          {session.blockedHosts.length === 0 && (
            <span className="ml-auto shrink-0">{TOOL_LABEL[session.tool]}</span>
          )}
        </span>
      </button>

      {/* Overlaid as a sibling for the same reason as the delete × below:
          the badge is a button and can't nest inside the row button. The
          wrapper is pointer-inert so only the badge itself takes clicks. */}
      {session.blockedHosts.length > 0 && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1">
          <BlockedHostsBadge
            hosts={session.blockedHosts}
            sessionId={session.sessionId}
            iconSize={11}
            className="pointer-events-auto hover:bg-[#d65858]/25"
          />
        </span>
      )}

      {/* Overlaid as siblings (not nested in the row button) and pointer-inert
          until hover, so they can't swallow clicks meant for selecting the row. */}
      <button
        onClick={toggleBackground}
        title={session.background ? 'Remove from background' : 'Move to background'}
        aria-label={session.background ? 'Remove from background' : 'Move to background'}
        className="absolute right-8 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <PinIcon size={13} className={clsx(session.background && 'rotate-45')} />
      </button>
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

/**
 * A pinned session whose container is gone — the Background section keeps its
 * row (deleted sessions still appear in the full "Deleted sessions" overlay
 * too). Non-selectable: there's nothing to open until it's restarted. Hover
 * offers the same pin toggle as live rows (unpinning drops the row) and a
 * restart, which reuses the deleted-overlay flow: a provisioning row replaces
 * this one while the container is recreated.
 */
function DeletedSessionRow({ entry }: { entry: DeletedSessionEntry }): JSX.Element {
  const provision = useProvisionSession()
  const queryClient = useQueryClient()
  const removeOptimisticDeleted = useUiStore((s) => s.removeOptimisticDeleted)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const onConfirmRestart = (): void => {
    setConfirmRestart(false)
    removeOptimisticDeleted(entry.sessionId)
    provision(entry.projectSlug, entry.tool, 'restart', entry.sessionId,
      (sid, onProgress) => restartSession(sid, onProgress, { projectSlug: entry.projectSlug, tool: entry.tool }))
  }

  // The deleted list isn't snapshot-pushed, so clear the pin in the cached
  // query (and any optimistic copy) for an instant regroup; the server write
  // makes it durable.
  const unpin = (): void => {
    queryClient.setQueriesData<DeletedSessionEntry[]>(
      { queryKey: ['deleted', entry.projectSlug] },
      (old) => old?.map((e) => (e.sessionId === entry.sessionId ? { ...e, background: undefined } : e)),
    )
    removeOptimisticDeleted(entry.sessionId)
    void setSessionBackground(entry.projectSlug, entry.sessionId, false)
      .catch((e: unknown) => console.error('background toggle failed', e))
  }

  const deletedLine = entry.deathReason
    ? `died${entry.deletedAt ? ` ${relativeAge(entry.deletedAt)}` : ''} — ${describeSessionDeathReason(entry.deathReason)}`
    : entry.deletedAt
      ? `deleted ${relativeAge(entry.deletedAt)}`
      : 'deleted'

  return (
    <div className="group relative mx-2">
      <div className="flex w-full cursor-default flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm opacity-60">
        <span className="flex items-center gap-2 group-hover:pr-12">
          <span className="truncate font-medium text-text-dim">
            {entry.title || entry.prompt || 'New session'}
          </span>
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="truncate">{deletedLine}</span>
          <span className="ml-auto shrink-0">{TOOL_LABEL[entry.tool]}</span>
        </span>
      </div>

      {/* Same overlay-button pattern as live rows: pin toggle left of the
          action slot, which here restarts instead of deletes. */}
      <button
        onClick={unpin}
        title="Remove from background"
        aria-label="Remove from background"
        className="absolute right-8 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <PinIcon size={13} className="rotate-45" />
      </button>
      <button
        onClick={() => setConfirmRestart(true)}
        title="Restart session"
        aria-label="Restart session"
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <RestartIcon size={13} />
      </button>

      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        destructive={false}
        title="Restart this session?"
        description={(entry.deathReason ? `This session died: ${describeSessionDeathReason(entry.deathReason)}. ` : '')
          + `Recreates the container and resumes ${TOOL_LABEL[entry.tool]} from where it left off.`}
        confirmLabel="Restart"
        onConfirm={onConfirmRestart}
      />
    </div>
  )
}

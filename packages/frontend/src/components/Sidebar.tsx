import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { Collapsible } from '@base-ui/react/collapsible'
import { BranchIcon, ChevronIcon, CloseIcon, LoadingIcon, SidebarIcon, TOOL_LABEL } from '#lib/icons'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { DeletedSessionsButton } from '#components/DeletedSessionsButton'
import { EmptyState } from '#components/ui/EmptyState'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { NewSessionButton } from '#components/NewSessionButton'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { UsageBadge } from '#components/UsageBadge'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { dismissProvisioning } from '#lib/createSession'
import { deleteSessionOptimistic } from '#lib/deleteSessionFlow'
import { isUnreadWaiting, useUiStore } from '#store'
import type { GitAuthFailure, ProvisioningSessionEntry, SessionListEntry } from '@yaac/shared/types'

/** User-facing session groups, in triage order (Waiting first). */
const GROUPS: { status: SessionListEntry['status']; label: string; defaultOpen: boolean }[] = [
  { status: 'waiting', label: 'Waiting', defaultOpen: true },
  { status: 'running', label: 'Running', defaultOpen: true },
]

/**
 * The sidebar's selectable rows in display order — provisioning first, then
 * the session groups in triage order, minus terminating sessions. This is the
 * list the Alt+↑/↓ session-switch shortcut steps through (Workspace owns the
 * handler). Terminating rows (server-marked, or a mid-flight optimistic
 * delete) still render, greyed, but aren't selectable.
 */
export function sidebarRowIds(
  provisioning: Pick<ProvisioningSessionEntry, 'sessionId'>[],
  sessions: Pick<SessionListEntry, 'sessionId' | 'status' | 'terminating'>[],
  pendingDeleteIds: string[],
): string[] {
  const shown = sessions.filter((s) => !s.terminating && !pendingDeleteIds.includes(s.sessionId))
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
  // Sessions on their way out stay visible as greyed "terminating…" rows
  // (SessionRow styles them) rather than vanishing, so the list doesn't jump.
  // The empty state keys off whether any group has rows, terminating included.
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const visibleCount = sessions.filter((s) => GROUPS.some((g) => g.status === s.status)).length
  // Re-fetch the deleted list whenever the active set changes (a just-deleted
  // session appears, a restarted one drops).
  const activeSignature = sessions.map((s) => s.sessionId).sort().join(',')

  return (
    <aside className="my-2 ml-2 flex w-64 flex-col overflow-hidden rounded-lg
      border border-hairline bg-surface text-text">
      <div className="titlebar-drag flex h-11 shrink-0 items-center gap-2 pl-4 pr-2">
        <div className="no-drag flex min-w-0 items-center">
          {projectSlug
            ? <ProjectActionsMenu slug={projectSlug} remoteUrl={projectRemoteUrl} />
            : <span className="font-semibold tracking-tight">yaac</span>}
        </div>
        <div className="ml-auto flex items-center gap-2 no-drag">
          <UsageBadge />
          <ImageBuildIndicator projectSlug={projectSlug} />
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
          {projectSlug && <DeletedSessionsButton projectSlug={projectSlug} activeSignature={activeSignature} />}
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
        {GROUPS.map((g) => (
          <SessionGroup
            key={g.status}
            label={g.label}
            defaultOpen={g.defaultOpen}
            sessions={sessions.filter((s) => s.status === g.status)}
          />
        ))}
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
  // not yet reflected in the snapshot. Either way the row is on its way out.
  const terminating = session.terminating || pendingDeleteIds.includes(session.sessionId)

  // Close the dialog immediately; the shared flow marks the row terminating
  // optimistically and restores it if the delete fails.
  const onConfirmDelete = (): void => {
    setConfirmDelete(false)
    deleteSessionOptimistic(session)
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
        {/* Title fills the row; only on hover does it inset to clear the delete
            × and marquee-scroll when it's too long to fit. */}
        <span className="flex items-center gap-2 group-hover:pr-6">
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

import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { Collapsible } from '@base-ui/react/collapsible'
import { BlockedIcon, ChevronIcon, CloseIcon, TOOL_ICON } from '@/frontend/lib/icons'
import { NewSessionButton } from '@/frontend/components/NewSessionButton'
import { ProjectActionsMenu } from '@/frontend/components/ProjectActionsMenu'
import { ConfirmDialog } from '@/frontend/components/ui/ConfirmDialog'
import { deleteSession } from '@/frontend/lib/createSession'
import { useUiStore } from '@/frontend/store'
import type { SessionListEntry } from '@/shared/types'

/**
 * User-facing session groups, in triage order (Waiting first). Prewarm is
 * deliberately excluded — it's a background hot-spare the daemon manages, not
 * a session the user acts on, so it never appears in the sidebar.
 */
const GROUPS: { status: SessionListEntry['status']; label: string; defaultOpen: boolean }[] = [
  { status: 'waiting', label: 'Waiting', defaultOpen: true },
  { status: 'running', label: 'Running', defaultOpen: true },
]

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
  sessions,
  connected,
}: {
  projectSlug: string | null
  sessions: SessionListEntry[]
  connected: boolean
}): JSX.Element {
  // Prewarm spares are hidden, so the empty state keys off visible sessions.
  const visibleCount = sessions.filter((s) => GROUPS.some((g) => g.status === s.status)).length

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-surface text-text">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        {projectSlug
          ? <ProjectActionsMenu slug={projectSlug} />
          : <span className="font-semibold tracking-tight">yaac</span>}
        <div className="ml-auto flex items-center gap-2">
          {!connected && <span className="text-xs text-amber-400/80">reconnecting…</span>}
          {projectSlug && <NewSessionButton projectSlug={projectSlug} />}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {!projectSlug && <Empty label="No project selected" />}
        {projectSlug && visibleCount === 0 && <Empty label="No sessions yet — start one with +" />}
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
      <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-semibold uppercase
        tracking-wide text-text-faint outline-none transition hover:text-text-dim">
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
  const ToolIcon = TOOL_ICON[session.tool]
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const onConfirmDelete = (): void => {
    setBusy(true)
    void deleteSession(session.sessionId)
      .then(() => {
        if (selectedSessionId === session.sessionId) selectSession(null)
        setConfirmDelete(false)
      })
      .catch((e: unknown) => console.error('delete failed', e))
      .finally(() => setBusy(false))
  }

  return (
    <div className="group relative">
      <button
        onClick={() => selectSession(session.sessionId)}
        className={clsx(
          'flex w-full flex-col gap-0.5 px-4 py-2 text-left text-sm transition hover:bg-surface-2',
          selectedSessionId === session.sessionId && 'bg-surface-2',
        )}
      >
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{session.prompt || 'New session'}</span>
          {/* Tool glyph normally; on row hover it yields to the delete × in the same spot. */}
          <ToolIcon size={14} className="ml-auto shrink-0 text-text-dim transition-opacity group-hover:opacity-0" />
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="truncate">{relativeAge(session.createdAt)}</span>
          {session.blockedHosts.length > 0 && (
            <span
              className="ml-auto flex shrink-0 items-center gap-0.5 text-[#d65858]"
              title={`${session.blockedHosts.length} blocked host(s)`}
            >
              <BlockedIcon size={11} />
              {session.blockedHosts.length}
            </span>
          )}
        </span>
      </button>

      {/* Overlaid as a sibling (not nested in the row button) and pointer-inert
          until hover, so it can't swallow clicks meant for selecting the row. */}
      <button
        onClick={() => setConfirmDelete(true)}
        title="Delete session"
        aria-label="Delete session"
        className="absolute right-3.5 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <CloseIcon size={14} />
      </button>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        busy={busy}
        title="Delete session?"
        description="Stops and removes the session's container and worktree. This can't be undone."
        confirmLabel="Delete"
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

function Empty({ label }: { label: string }): JSX.Element {
  return <div className="px-4 py-2 text-sm text-text-faint">{label}</div>
}

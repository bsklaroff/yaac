import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { Collapsible } from '@base-ui/react/collapsible'
import { BlockedIcon, ChevronIcon, CloseIcon, LoadingIcon, RestartIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { NewSessionButton } from '@/frontend/components/NewSessionButton'
import { ProjectActionsMenu } from '@/frontend/components/ProjectActionsMenu'
import { ConfirmDialog } from '@/frontend/components/ui/ConfirmDialog'
import { deleteSession, restartSession } from '@/frontend/lib/createSession'
import { getDeletedSessions } from '@/frontend/lib/deletedApi'
import { useProvisionSession } from '@/frontend/lib/useProvisionSession'
import { useUiStore, type CreatingSession } from '@/frontend/store'
import type { DeletedSessionEntry, SessionListEntry } from '@/shared/types'

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
  // Hide sessions whose delete is in flight (optimistic) until the snapshot
  // drops them. Prewarm spares are also hidden, so the empty state keys off
  // what's actually shown.
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const creating = useUiStore((s) => s.creating)
  const shown = sessions.filter((s) => !pendingDeleteIds.includes(s.sessionId))
  const visibleCount = shown.filter((s) => GROUPS.some((g) => g.status === s.status)).length

  // Show a "starting" row the instant create is clicked, until the real
  // session lands in the snapshot (then App clears `creating`). Skip it if the
  // real row is already present, to avoid a one-frame duplicate.
  const showCreating = !!creating
    && creating.projectSlug === projectSlug
    && !(creating.sessionId && shown.some((s) => s.sessionId === creating.sessionId))

  return (
    <aside className="flex h-full w-64 flex-col text-text">
      <div className="flex h-11 shrink-0 items-center gap-2 pl-4 pr-2">
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
        {projectSlug && visibleCount === 0 && !showCreating && (
          <Empty label="No sessions yet — start one with +" />
        )}
        {showCreating && creating && <CreatingRow creating={creating} />}
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
    provision(projectSlug, entry.tool, (onProgress) => restartSession(entry.sessionId, onProgress))
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="py-1">
      <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-semibold
        tracking-wide text-text-faint outline-none transition hover:text-text-dim">
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
              <span className="truncate font-medium">{d.prompt || 'New session'}</span>
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

/** Immediate, non-interactive row for a session that's still provisioning. */
function CreatingRow({ creating }: { creating: CreatingSession }): JSX.Element {
  return (
    <div className="mx-2 flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-sm">
      <span className="flex items-center gap-2">
        <span className="truncate font-medium text-text-dim">New session</span>
        <span className="ml-auto shrink-0 text-xs text-text-faint">{TOOL_LABEL[creating.tool]}</span>
      </span>
      <span className="flex items-center gap-1.5 text-xs text-text-faint">
        {creating.error ? (
          <span className="text-[#d65858]">failed</span>
        ) : (
          <>
            <LoadingIcon size={11} className="animate-spin" />
            <span className="truncate">{creating.message || 'starting…'}</span>
          </>
        )}
      </span>
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
      <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-semibold
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
  const beginDelete = useUiStore((s) => s.beginDelete)
  const endDelete = useUiStore((s) => s.endDelete)
  const addOptimisticDeleted = useUiStore((s) => s.addOptimisticDeleted)
  const removeOptimisticDeleted = useUiStore((s) => s.removeOptimisticDeleted)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Optimistic: hide the row and close the dialog immediately, then fire the
  // delete. The daemon's cleanup is detached (a stop can take ~10s), so we
  // can't wait for the snapshot to drop it. On failure, restore the row.
  const onConfirmDelete = (): void => {
    const id = session.sessionId
    setConfirmDelete(false)
    beginDelete(id)
    if (selectedSessionId === id) selectSession(null)
    // A session with history (a prompt → a transcript) will appear in the
    // Deleted group once cleanup lands; show it there immediately.
    if (session.prompt) {
      addOptimisticDeleted({
        sessionId: id,
        projectSlug: session.projectSlug,
        tool: session.tool,
        createdAt: session.createdAt,
        prompt: session.prompt,
      })
    }
    void deleteSession(id).catch((e: unknown) => {
      console.error('delete failed', e)
      endDelete(id)
      removeOptimisticDeleted(id)
    })
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
          <span className="truncate font-medium">{session.prompt || 'New session'}</span>
          {/* Tool name; on row hover it yields to the delete × in the same spot. */}
          <span className="ml-auto shrink-0 text-xs text-text-faint transition-opacity group-hover:opacity-0">
            {TOOL_LABEL[session.tool]}
          </span>
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

import { useLayoutEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Collapsible } from '@base-ui/react/collapsible'
import { BranchIcon, ChevronIcon, CloseIcon, LoadingIcon, PinIcon, RestartIcon, SidebarIcon, TOOL_LABEL } from '#lib/icons'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { StoppedWorktreesButton } from '#components/StoppedWorktreesButton'
import { EmptyState } from '#components/ui/EmptyState'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { NewWorktreeButton } from '#components/NewWorktreeButton'
import { ProjectActionsMenu } from '#components/ProjectActionsMenu'
import { SkillsButton } from '#components/SkillsButton'
import { UsageBadge } from '#components/UsageBadge'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { dismissProvisioning, restartWorktree, setWorktreeBackground } from '#lib/createWorktree'
import { getStoppedWorktrees } from '#lib/stoppedApi'
import { stopWorktreeOptimistic } from '#lib/stopWorktreeFlow'
import { useProvisionWorktree } from '#lib/useProvisionWorktree'
import { isUnreadWaiting, useUiStore } from '#store'
import { describeWorktreeDeathReason } from '@yaac/shared/death-reason'
import type { StoppedWorktreeEntry, GitAuthFailure, ProvisioningWorktreeEntry, WorktreeListEntry } from '@yaac/shared/types'

/** User-facing worktree groups keyed by status, in triage order (Waiting
 *  first). Background pins and stopping are orthogonal to status and get
 *  their own sections rendered after these (see sidebarSections). */
const GROUPS: { status: WorktreeListEntry['status']; label: string; defaultOpen: boolean }[] = [
  { status: 'waiting', label: 'Waiting', defaultOpen: true },
  { status: 'running', label: 'Running', defaultOpen: true },
]

/** A worktree is stopping when the server has marked it (its pod has a
 *  deletionTimestamp, or a delete was just issued) or a client-side optimistic
 *  delete is still in flight. Such rows get their own "Terminating" section and
 *  render as non-interactive, greyed placeholders (see WorktreeRow). */
function isTerminating(
  worktree: Pick<WorktreeListEntry, 'worktreeId' | 'stopping'>,
  pendingDeleteIds: string[],
): boolean {
  return Boolean(worktree.stopping) || pendingDeleteIds.includes(worktree.worktreeId)
}

/**
 * The sidebar's selectable rows in display order — provisioning first, then
 * the worktree groups in triage order, then the Background pins, minus
 * stopping worktrees. This is the list the Alt+↑/↓ worktree-switch shortcut
 * steps through (Workspace owns the handler). Terminating rows (server-marked,
 * or a mid-flight optimistic delete) still render, greyed, but aren't
 * selectable — nor are deleted Background rows (nothing to open).
 */
export function sidebarRowIds(
  provisioning: Pick<ProvisioningWorktreeEntry, 'worktreeId'>[],
  worktrees: Pick<WorktreeListEntry, 'worktreeId' | 'status' | 'stopping' | 'background'>[],
  pendingDeleteIds: string[],
): string[] {
  const shown = worktrees.filter((s) => !isTerminating(s, pendingDeleteIds))
  const foreground = shown.filter((s) => !s.background)
  return [
    ...provisioning.map((p) => p.worktreeId),
    ...GROUPS.flatMap((g) => foreground.filter((s) => s.status === g.status).map((s) => s.worktreeId)),
    ...shown.filter((s) => s.background).map((s) => s.worktreeId),
  ]
}

/** One collapsible section in the sidebar. */
export interface SidebarSection {
  label: string
  defaultOpen: boolean
  worktrees: WorktreeListEntry[]
  /** Deleted-but-pinned rows (Background section only) — rendered after the
   *  active rows as non-selectable placeholders with a restart action. */
  deleted?: StoppedWorktreeEntry[]
}

/**
 * Sidebar sections in render order: the status groups (Waiting, then Running)
 * holding live worktrees, then Background holding every pinned worktree —
 * whatever its state: running, waiting, stopping, or deleted (the
 * `deletedBackground` rows) — then a Terminating section for unpinned
 * worktrees on their way out. Status is orthogonal to both pins and
 * termination, so a pinned or stopping worktree leaves its status group.
 * Empty sections are kept in the list; WorktreeGroup renders nothing for them.
 */
export function sidebarSections(
  worktrees: WorktreeListEntry[],
  pendingDeleteIds: string[],
  deletedBackground: StoppedWorktreeEntry[] = [],
): SidebarSection[] {
  const foreground = worktrees.filter((s) => !s.background)
  const background = worktrees.filter((s) => Boolean(s.background))
  const live = foreground.filter((s) => !isTerminating(s, pendingDeleteIds))
  const stopping = foreground.filter((s) => isTerminating(s, pendingDeleteIds))
  return [
    ...GROUPS.map((g) => ({
      label: g.label,
      defaultOpen: g.defaultOpen,
      worktrees: live.filter((s) => s.status === g.status),
    })),
    { label: 'Background', defaultOpen: true, worktrees: background, deleted: deletedBackground },
    { label: 'Terminating', defaultOpen: true, worktrees: stopping },
  ]
}

/** Human relative age from the worktree's UTC 'YYYY-MM-DD HH:MM:SS' time. */
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
  worktrees,
  provisioning,
  connected,
  gitAuthFailures,
}: {
  projectSlug: string | null
  /** Active project's git remote ('' until the snapshot hydrates) — the
   *  remove-project dialog's type-to-confirm text. */
  projectRemoteUrl: string
  worktrees: WorktreeListEntry[]
  provisioning: ProvisioningWorktreeEntry[]
  connected: boolean
  /** The active project's rejected git credentials (project-wide flag). */
  gitAuthFailures: GitAuthFailure[]
}): JSX.Element {
  // Worktrees on their way out stay visible as greyed "stopping…" rows
  // (WorktreeRow styles them) rather than vanishing, so the list doesn't jump.
  // They move to their own "Terminating" section instead of lingering under
  // Waiting/Running. The empty state keys off whether any section has rows,
  // stopping included.
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const optimisticStopped = useUiStore((s) => s.optimisticStopped)
  // Re-fetch the deleted list whenever the active set changes (a just-deleted
  // worktree appears, a restarted one drops).
  const activeSignature = worktrees.map((s) => s.worktreeId).sort().join(',')

  // Deleted worktrees feed the Background section's pinned-but-deleted rows.
  // Same query key as StoppedWorktreesButton, so the two share one fetch.
  const { data: deletedList } = useQuery({
    queryKey: ['deleted', projectSlug, activeSignature],
    queryFn: () => getStoppedWorktrees(projectSlug ?? '', 100),
    enabled: !!projectSlug,
    staleTime: 2000,
  })
  // Pinned deleted rows: optimistic just-deleted entries ahead of the fetched
  // list (de-duped), minus anything active again — a worktree mid-termination
  // is still in the snapshot (its Background row renders the stopping
  // placeholder), and one mid-restart has a provisioning row instead.
  const activeIds = new Set(worktrees.map((s) => s.worktreeId))
  const provisioningIds = new Set(provisioning.map((p) => p.worktreeId))
  const fetchedIds = new Set((deletedList ?? []).map((d) => d.worktreeId))
  const deletedBackground = [
    ...optimisticStopped.filter((e) => e.projectSlug === projectSlug && !fetchedIds.has(e.worktreeId)),
    ...(deletedList ?? []),
  ].filter((d) => d.background && !activeIds.has(d.worktreeId) && !provisioningIds.has(d.worktreeId))

  const sections = sidebarSections(worktrees, pendingDeleteIds, deletedBackground)
  const visibleCount = sections.reduce(
    (n, sec) => n + sec.worktrees.length + (sec.deleted?.length ?? 0), 0,
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
            {projectSlug && <NewWorktreeButton projectSlug={projectSlug} />}
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
              flag lives on the project header, not on individual worktrees. */}
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
            title="No worktrees yet"
            description="Start one with the + above."
          />
        )}
        {provisioning.map((p) => <ProvisioningRow key={p.worktreeId} entry={p} />)}
        {sections.map((section) => (
          <WorktreeGroup
            key={section.label}
            label={section.label}
            defaultOpen={section.defaultOpen}
            worktrees={section.worktrees}
            deleted={section.deleted}
          />
        ))}
        {projectSlug && <StoppedWorktreesButton projectSlug={projectSlug} activeSignature={activeSignature} />}
      </div>
    </aside>
  )
}

/** Selectable row for a worktree that's still provisioning. Clicking it opens
 *  the provisioning status in the main pane; a failed one offers a dismiss ×. */
function ProvisioningRow({ entry }: { entry: ProvisioningWorktreeEntry }): JSX.Element {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId)
  const selectWorktree = useUiStore((s) => s.selectWorktree)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)

  const dismiss = (): void => {
    void dismissProvisioning(entry.worktreeId).catch(() => { /* best-effort */ })
    removeOptimisticProvisioning(entry.worktreeId)
    if (selectedWorktreeId === entry.worktreeId) selectWorktree(null)
  }

  return (
    <div className="group relative mx-2">
      <button
        onClick={() => selectWorktree(entry.worktreeId)}
        className={clsx(
          'flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2/60',
          selectedWorktreeId === entry.worktreeId && 'bg-surface-2 hover:bg-surface-2',
        )}
      >
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-text-dim">
            {entry.kind === 'restart' ? 'Restarting worktree' : 'New worktree'}
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

function WorktreeGroup({
  label,
  worktrees,
  deleted = [],
  defaultOpen,
}: {
  label: string
  worktrees: WorktreeListEntry[]
  /** Deleted-but-pinned rows, rendered after the active ones (Background). */
  deleted?: StoppedWorktreeEntry[]
  defaultOpen: boolean
}): JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  if (worktrees.length === 0 && deleted.length === 0) return null

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="py-1">
      <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium
        text-text-faint outline-none transition hover:text-text-dim">
        <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        <span>{label}</span>
        <span className="text-text-faint/70">{worktrees.length + deleted.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {worktrees.map((s) => <WorktreeRow key={s.worktreeId} worktree={s} />)}
        {deleted.map((d) => <DeletedWorktreeRow key={d.worktreeId} entry={d} />)}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/**
 * Worktree title that fills the row's width, truncating with an ellipsis when it
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

/** How many of a worktree's agent worktrees are currently open. A worktree
 *  from an older server (or one whose registry tick hasn't landed) reports
 *  none, which reads as the ordinary single-agent case. */
function openAgentCount(worktree: WorktreeListEntry): number {
  return worktree.agentSessions.filter((a) => a.active).length
}

function WorktreeRow({ worktree }: { worktree: WorktreeListEntry }): JSX.Element {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId)
  const selectWorktree = useUiStore((s) => s.selectWorktree)
  const readWaiting = useUiStore((s) => s.readWaiting)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hovered, setHovered] = useState(false)
  const unread = isUnreadWaiting(worktree, readWaiting)
  // The container is being torn down — server-marked, or an optimistic delete
  // not yet reflected in the snapshot. Either way the row is on its way out
  // and the Sidebar has already routed it into the "Terminating" section.
  const stopping = isTerminating(worktree, pendingDeleteIds)

  // Close the dialog immediately; the shared flow marks the row stopping
  // optimistically and restores it if the delete fails.
  const onConfirmDelete = (): void => {
    setConfirmDelete(false)
    stopWorktreeOptimistic(worktree)
  }

  // Pin/unpin to the Background section. The server pushes a fresh snapshot,
  // so the row regroups without optimistic state.
  const toggleBackground = (): void => {
    void setWorktreeBackground(worktree.projectSlug, worktree.worktreeId, !worktree.background)
      .catch((e: unknown) => console.error('background toggle failed', e))
  }

  // A stopping row is a non-interactive, greyed placeholder: no pulse, no
  // unread bubble, no delete × — just a spinner and a "stopping…" line. It
  // vanishes when the snapshot drops the worktree.
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
              {worktree.title || worktree.prompt || 'New worktree'}
            </span>
          </span>
          <span className="flex items-center gap-2 text-xs text-text-faint">
            <span className="truncate">stopping…</span>
            <span className="ml-auto shrink-0">{TOOL_LABEL[worktree.tool]}</span>
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
        onClick={() => selectWorktree(worktree.worktreeId)}
        className={clsx(
          'flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-surface-2/60',
          selectedWorktreeId === worktree.worktreeId && 'bg-surface-2 hover:bg-surface-2',
        )}
      >
        {/* Title fills the row; only on hover does it inset to clear the pin
            + delete buttons and marquee-scroll when it's too long to fit. */}
        <span className="flex items-center gap-2 group-hover:pr-12">
          {/* Braille spinner: the worktree's agent is actively running. The
              cycling glyph reads as "working" and can't be mistaken for the
              round unread bubble below (which is a solid, still dot). */}
          {worktree.status === 'running' && (
            <span className="braille-spinner shrink-0 text-emerald-400" aria-hidden>
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
          {/* Unread bubble: this worktree started waiting and hasn't been viewed. */}
          {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
          <MarqueeTitle text={worktree.title || worktree.prompt || 'New worktree'} hovered={hovered} />
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="shrink-0">{relativeAge(worktree.createdAt)}</span>
          {/* Only when a worktree holds more than one live conversation —
              one is the overwhelmingly common case and a column of "1
              agent" would be pure noise. */}
          {openAgentCount(worktree) > 1 && (
            <span
              className="shrink-0"
              title={`${openAgentCount(worktree)} agent worktrees open in this worktree`}
            >
              {openAgentCount(worktree)} agents
            </span>
          )}
          {/* The remote branch this worktree's worktree tracks. */}
          {worktree.baseBranch && (
            <span className="flex min-w-0 items-center gap-1" title={`Tracking origin/${worktree.baseBranch}`}>
              <BranchIcon size={10} className="shrink-0" />
              <span className="truncate font-mono text-[11px]">{worktree.baseBranch}</span>
            </span>
          )}
          {/* Tool name moved off the title line so the title can run full-width;
              hidden when the blocked-hosts badge claims the bottom-right. */}
          {worktree.blockedHosts.length === 0 && (
            <span className="ml-auto shrink-0">{TOOL_LABEL[worktree.tool]}</span>
          )}
        </span>
      </button>

      {/* Overlaid as a sibling for the same reason as the delete × below:
          the badge is a button and can't nest inside the row button. The
          wrapper is pointer-inert so only the badge itself takes clicks. */}
      {worktree.blockedHosts.length > 0 && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1">
          <BlockedHostsBadge
            hosts={worktree.blockedHosts}
            worktreeId={worktree.worktreeId}
            iconSize={11}
            className="pointer-events-auto hover:bg-[#d65858]/25"
          />
        </span>
      )}

      {/* Overlaid as siblings (not nested in the row button) and pointer-inert
          until hover, so they can't swallow clicks meant for selecting the row. */}
      <button
        onClick={toggleBackground}
        title={worktree.background ? 'Remove from background' : 'Move to background'}
        aria-label={worktree.background ? 'Remove from background' : 'Move to background'}
        className="absolute right-8 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <PinIcon size={13} className={clsx(worktree.background && 'rotate-45')} />
      </button>
      <button
        onClick={() => setConfirmDelete(true)}
        title="Delete worktree"
        aria-label="Delete worktree"
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100"
      >
        <CloseIcon size={14} />
      </button>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete worktree?"
        description="Stops and removes the worktree's container. The worktree history and worktree will be saved, and can be restarted."
        confirmLabel="Delete"
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

/**
 * A pinned worktree whose container is gone — the Background section keeps its
 * row (deleted worktrees still appear in the full "Deleted worktrees" overlay
 * too). Non-selectable: there's nothing to open until it's restarted. Hover
 * offers the same pin toggle as live rows (unpinning drops the row) and a
 * restart, which reuses the deleted-overlay flow: a provisioning row replaces
 * this one while the container is recreated.
 */
function DeletedWorktreeRow({ entry }: { entry: StoppedWorktreeEntry }): JSX.Element {
  const provision = useProvisionWorktree()
  const queryClient = useQueryClient()
  const removeOptimisticStopped = useUiStore((s) => s.removeOptimisticStopped)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const onConfirmRestart = (): void => {
    setConfirmRestart(false)
    removeOptimisticStopped(entry.worktreeId)
    provision(entry.projectSlug, entry.tool, 'restart', entry.worktreeId,
      (sid, onProgress) => restartWorktree(sid, onProgress, { projectSlug: entry.projectSlug, tool: entry.tool }))
  }

  // The deleted list isn't snapshot-pushed, so clear the pin in the cached
  // query (and any optimistic copy) for an instant regroup; the server write
  // makes it durable.
  const unpin = (): void => {
    queryClient.setQueriesData<StoppedWorktreeEntry[]>(
      { queryKey: ['deleted', entry.projectSlug] },
      (old) => old?.map((e) => (e.worktreeId === entry.worktreeId ? { ...e, background: undefined } : e)),
    )
    removeOptimisticStopped(entry.worktreeId)
    void setWorktreeBackground(entry.projectSlug, entry.worktreeId, false)
      .catch((e: unknown) => console.error('background toggle failed', e))
  }

  const deletedLine = entry.deathReason
    ? `died${entry.stoppedAt ? ` ${relativeAge(entry.stoppedAt)}` : ''} — ${describeWorktreeDeathReason(entry.deathReason)}`
    : entry.stoppedAt
      ? `deleted ${relativeAge(entry.stoppedAt)}`
      : 'deleted'

  return (
    <div className="group relative mx-2">
      <div className="flex w-full cursor-default flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm opacity-60">
        <span className="flex items-center gap-2 group-hover:pr-12">
          <span className="truncate font-medium text-text-dim">
            {entry.title || entry.prompt || 'New worktree'}
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
        title="Restart worktree"
        aria-label="Restart worktree"
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
        title="Restart this worktree?"
        description={(entry.deathReason ? `This worktree died: ${describeWorktreeDeathReason(entry.deathReason)}. ` : '')
          + `Recreates the container and resumes ${TOOL_LABEL[entry.tool]} from where it left off.`}
        confirmLabel="Restart"
        onConfirm={onConfirmRestart}
      />
    </div>
  )
}

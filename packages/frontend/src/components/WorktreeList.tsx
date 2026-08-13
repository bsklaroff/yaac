import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Collapsible } from '@base-ui/react/collapsible'
import { Dialog } from '@base-ui/react/dialog'
import {
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  GroupAddIcon,
  GroupRemoveIcon,
  LoadingIcon,
  PinIcon,
  RenameIcon,
  RestartIcon,
  TOOL_LABEL,
} from '#lib/icons'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { StoppedWorktreesButton } from '#components/StoppedWorktreesButton'
import { EmptyState } from '#components/ui/EmptyState'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { dismissProvisioning, restartWorktree } from '#lib/createWorktree'
import {
  createWorktreeGroup,
  deleteWorktreeGroup,
  renameWorktreeGroup,
  setWorktreeGroup,
  setWorktreeGroupPinned,
} from '#lib/groupApi'
import { useInlineEdit, useInlineRename } from '#lib/useInlineRename'
import { getStoppedWorktrees } from '#lib/stoppedApi'
import { stopWorktreeOptimistic } from '#lib/stopWorktreeFlow'
import { useProvisionWorktree } from '#lib/useProvisionWorktree'
import { useIsMobile } from '#lib/viewport'
import { isUnreadWaiting, useUiStore } from '#store'
import { describeWorktreeDeathReason } from '@yaac/shared/death-reason'
import type {
  StoppedWorktreeEntry,
  ProvisioningWorktreeEntry,
  WorktreeGroupSummary,
  WorktreeListEntry,
} from '@yaac/shared/types'

/** A worktree is stopping when the server has marked it (its pod has a
 *  deletionTimestamp, or a delete was just issued) or a client-side optimistic
 *  delete is still in flight. Such a row stays exactly where it sits — in the
 *  default list or in its group — but renders as a non-interactive, greyed
 *  placeholder and can't be selected or dragged (see WorktreeRow). */
function isTerminating(
  worktree: Pick<WorktreeListEntry, 'worktreeId' | 'stopping'>,
  pendingDeleteIds: string[],
): boolean {
  return Boolean(worktree.stopping) || pendingDeleteIds.includes(worktree.worktreeId)
}

/** Newest first, by the UTC 'YYYY-MM-DD HH:MM:SS' stamp — which compares
 *  lexicographically — with the id as a stable tiebreak for worktrees created
 *  inside the same second. */
function byCreatedAt<T extends { createdAt: string; worktreeId: string }>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt) || b.worktreeId.localeCompare(a.worktreeId)
}

/** One group's section of the list. */
export interface SidebarGroupSection {
  group: WorktreeGroupSummary
  /** Live (and terminating) members, newest first. */
  members: WorktreeListEntry[]
  /** Stopped members, newest first — ghost rows rendered after the live ones. */
  ghosts: StoppedWorktreeEntry[]
}

export interface SidebarLayout {
  /** Ungrouped worktrees, newest first. Terminating rows sit in place. */
  defaultList: WorktreeListEntry[]
  /** The groups that are shown, newest group first. */
  groups: SidebarGroupSection[]
}

/**
 * The sidebar's shape: every ungrouped worktree newest first, then one section
 * per shown group, also newest first — so the worktree or group just created is
 * at the top of whatever it belongs to, and the ungrouped list stays above the
 * sections. Nothing is bucketed by status — a worktree's own markers (the
 * running spinner, the unread dot, the stopping placeholder) say what state it
 * is in, and its position says where the user filed it.
 *
 * A group is shown when it is pinned or holds at least one live worktree, and
 * a shown group lists ALL its members: live ones as ordinary rows, stopped
 * ones as ghost rows with a restart action. So an unpinned group whose
 * worktrees have all stopped simply disappears — its row survives on the
 * server, and restarting a member brings the whole section back — while
 * pinning keeps it on screen as somewhere to restart into.
 *
 * `stopped` is the project's stopped listing, already de-duped against the
 * active and provisioning ids by the caller; only entries belonging to a shown
 * group are rendered, the rest live in the "Stopped worktrees" overlay. A
 * worktree naming a group that no longer exists falls back to the default
 * list, which is what a snapshot arriving mid-delete looks like.
 */
export function sidebarLayout(
  worktrees: WorktreeListEntry[],
  groups: WorktreeGroupSummary[],
  stopped: StoppedWorktreeEntry[] = [],
): SidebarLayout {
  const known = new Set(groups.map((g) => g.groupId))
  const filedIn = (entry: { groupId?: string }): string | null =>
    entry.groupId !== undefined && known.has(entry.groupId) ? entry.groupId : null
  const live = [...worktrees].sort(byCreatedAt)
  const ghosts = [...stopped].sort(byCreatedAt)
  const sections = [...groups]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.groupId.localeCompare(a.groupId))
    .map((group) => ({
      group,
      members: live.filter((w) => filedIn(w) === group.groupId),
      ghosts: ghosts.filter((d) => filedIn(d) === group.groupId),
    }))
    .filter((s) => s.group.pinned || s.members.length > 0)
  return { defaultList: live.filter((w) => filedIn(w) === null), groups: sections }
}

/**
 * The list's selectable rows in display order — provisioning first, then the
 * ungrouped worktrees, then each shown group's live members. This is the list
 * the Alt+↑/↓ worktree-switch shortcut steps through (Workspace owns the
 * handler). Terminating rows (server-marked, or a mid-flight optimistic
 * delete) still render, greyed, but aren't selectable — nor are ghost rows,
 * which have nothing to open until they're restarted.
 */
export function sidebarRowIds(
  provisioning: Pick<ProvisioningWorktreeEntry, 'worktreeId'>[],
  worktrees: WorktreeListEntry[],
  groups: WorktreeGroupSummary[],
  pendingDeleteIds: string[],
): string[] {
  // Built on the layout itself, so the cycle can't drift from what is drawn.
  const layout = sidebarLayout(worktrees, groups)
  const selectable = (list: WorktreeListEntry[]): string[] =>
    list.filter((w) => !isTerminating(w, pendingDeleteIds)).map((w) => w.worktreeId)
  return [
    ...provisioning.map((p) => p.worktreeId),
    ...selectable(layout.defaultList),
    ...layout.groups.flatMap((s) => selectable(s.members)),
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

/** Pointer travel that turns a press on a row into a drag rather than a
 *  selection — the same threshold the pane tabs use. */
const DRAG_THRESHOLD = 5

interface DragState {
  worktreeId: string
  projectSlug: string
  /** The group it started in; null for the default list. */
  from: string | null
  startX: number
  startY: number
  /** The press has travelled far enough to be a drag. */
  active: boolean
  /** The drop zone under the pointer: a group id, null for the default list,
   *  or undefined when the pointer is over neither. */
  over?: string | null
}

/** What a row needs to take part in dragging, handed down from the list. */
interface SidebarDrag {
  /** Track a press on a row. A press that never crosses the threshold calls
   *  `onSelect` instead, so a row stays a click target. */
  start: (e: ReactPointerEvent, worktree: WorktreeListEntry, onSelect: () => void) => void
  /** The row being dragged right now, if any. */
  activeId: string | null
}

/**
 * The scrollable body of the worktree list: provisioning rows, the ungrouped
 * worktrees, the group sections, and the stopped-worktrees entry point.
 *
 * Chrome-free on purpose — the desktop `Sidebar` wraps it in its fixed-width
 * card and the mobile worktrees screen gives it the whole viewport, and both
 * get the same rows in the same order (which is also the order
 * `sidebarRowIds` promises the Alt+K/J cycle).
 */
export function WorktreeList({
  projectSlug,
  worktrees,
  groups,
  provisioning,
}: {
  projectSlug: string | null
  worktrees: WorktreeListEntry[]
  /** The active project's groups, from the snapshot. */
  groups: WorktreeGroupSummary[]
  provisioning: ProvisioningWorktreeEntry[]
}): JSX.Element {
  // A mid-flight optimistic delete doesn't move a row any more — it greys it
  // where it sits — so the list itself has no use for pendingDeleteIds; each
  // row reads it for its own placeholder.
  const optimisticStopped = useUiStore((s) => s.optimisticStopped)
  // Only for the empty-state copy: there is no rail on a phone to point at.
  const isMobile = useIsMobile()
  // Re-fetch the deleted list whenever the active set changes (a just-deleted
  // worktree appears, a restarted one drops).
  const activeSignature = worktrees.map((s) => s.worktreeId).sort().join(',')

  // Stopped worktrees feed the groups' ghost rows. Same query key as
  // StoppedWorktreesButton, so the two share one fetch.
  const { data: deletedList } = useQuery({
    queryKey: ['deleted', projectSlug, activeSignature],
    queryFn: () => getStoppedWorktrees(projectSlug ?? '', 100),
    enabled: !!projectSlug,
    staleTime: 2000,
  })
  // Optimistic just-stopped entries ahead of the fetched list (de-duped),
  // minus anything active again — a worktree mid-termination is still in the
  // snapshot (its row renders the stopping placeholder), and one mid-restart
  // has a provisioning row instead. Which of these are drawn at all is the
  // layout's call: only members of a shown group become ghost rows.
  const activeIds = new Set(worktrees.map((s) => s.worktreeId))
  const provisioningIds = new Set(provisioning.map((p) => p.worktreeId))
  const fetchedIds = new Set((deletedList ?? []).map((d) => d.worktreeId))
  const stopped = [
    ...optimisticStopped.filter((e) => e.projectSlug === projectSlug && !fetchedIds.has(e.worktreeId)),
    ...(deletedList ?? []),
  ].filter((d) => !activeIds.has(d.worktreeId) && !provisioningIds.has(d.worktreeId))

  const layout = sidebarLayout(worktrees, groups, stopped)
  const visibleCount = layout.defaultList.length
    + layout.groups.reduce((n, s) => n + s.members.length + s.ghosts.length, 0)

  // --- row drag (move a worktree between the default list and groups) ---
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  // How to take the in-flight drag's window listeners back down, so an unmount
  // mid-drag (switching projects, say) doesn't leave them attached to a list
  // that is gone.
  const detachDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => { detachDrag.current?.() }, [])
  // Every drop zone that is currently on screen, keyed by the group it files
  // into (null = the default list). Rects are read live on each move, so a
  // section growing or collapsing mid-drag can't leave a stale target.
  const zones = useRef(new Map<string | null, HTMLElement>())
  const zoneRef = (groupId: string | null) => (el: HTMLDivElement | null): void => {
    if (el) zones.current.set(groupId, el)
    else zones.current.delete(groupId)
  }
  const zoneAt = (x: number, y: number): string | null | undefined => {
    for (const [groupId, el] of zones.current) {
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return groupId
    }
    return undefined
  }

  // A row is both a drag handle and a click target, so the press is tracked
  // here rather than left to the button: below the threshold it selects, above
  // it moves the worktree. Mouse only — a pointerdown that preventDefaults
  // would fight the scroll on touch, where the group dialog is the way to move
  // a worktree.
  const startDrag = (
    e: ReactPointerEvent,
    worktree: WorktreeListEntry,
    onSelect: () => void,
  ): void => {
    if (e.pointerType !== 'mouse') return
    // Suppresses the compatibility click, which is why the sub-threshold case
    // below has to call `onSelect` itself.
    e.preventDefault()
    const init: DragState = {
      worktreeId: worktree.worktreeId,
      projectSlug: worktree.projectSlug,
      from: layout.groups.some((s) => s.group.groupId === worktree.groupId)
        ? worktree.groupId ?? null
        : null,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    }
    // Write the ref directly too: a move can fire before React re-renders,
    // which is when the ref would otherwise sync.
    dragRef.current = init
    setDrag(init)

    const onMove = (ev: globalThis.PointerEvent): void => {
      const d = dragRef.current
      if (!d) return
      if (!d.active && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) <= DRAG_THRESHOLD) return
      const next: DragState = { ...d, active: true, over: zoneAt(ev.clientX, ev.clientY) }
      dragRef.current = next
      setDrag(next)
    }
    const detach = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      detachDrag.current = null
    }
    const clear = (): void => {
      detach()
      dragRef.current = null
      setDrag(null)
    }
    const onUp = (): void => {
      const d = dragRef.current
      clear()
      if (!d) return
      if (!d.active) { onSelect(); return }
      if (d.over === undefined || d.over === d.from) return
      // Not optimistic: the server pushes a snapshot and the row regroups,
      // the same way the rename does. A group deleted mid-drag answers
      // NOT_FOUND, and the snapshot already has the worktree where it belongs.
      void setWorktreeGroup(d.projectSlug, d.worktreeId, d.over)
        .catch((e: unknown) => console.error('group move failed', e))
    }
    // A cancelled pointer (the OS took it, a native drag started) is not a
    // drop: it only puts the row back. Without it the listeners would stay
    // armed and the next unrelated pointerup anywhere would run `onUp` against
    // whatever zone the pointer had since wandered over — a move nobody made.
    const onCancel = (): void => { clear() }
    detachDrag.current = detach
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  const rowDrag: SidebarDrag = { start: startDrag, activeId: drag?.active ? drag.worktreeId : null }
  /** Whether a drop here would actually move the dragged worktree. */
  const dropTarget = (groupId: string | null): boolean =>
    Boolean(drag?.active) && drag?.over === groupId && drag.over !== drag.from
  // What a row's dialog can move it into: the sections actually on screen, so
  // it offers exactly the drop targets a drag has. A hidden group is one whose
  // worktrees have all stopped, and moving a live worktree into it would make
  // it reappear somewhere the user was not told about.
  const shownGroups = layout.groups.map((s) => s.group)

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {!projectSlug && (
        <EmptyState
          compact
          className="py-10"
          title="No project selected"
          description={isMobile
            ? 'Go back and pick a project.'
            : 'Pick a project from the rail on the left.'}
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

      {/* The default list is a drop zone in its own right — dragging a row out
          of a group and onto it files the worktree back under no group. It
          keeps a placeholder while a drag is in flight so an empty list is
          still somewhere to drop. */}
      <div
        ref={zoneRef(null)}
        role="group"
        aria-label="Ungrouped worktrees"
        className={clsx('py-1', dropTarget(null) && 'rounded-lg bg-surface-2/40 ring-1 ring-accent/40')}
      >
        {layout.defaultList.map((s) => (
          <WorktreeRow key={s.worktreeId} worktree={s} shownGroups={shownGroups} drag={rowDrag} />
        ))}
        {drag?.active && layout.defaultList.length === 0 && (
          <p className="mx-2 rounded-lg border border-dashed border-border px-2.5 py-3 text-center text-xs text-text-faint">
            Ungrouped
          </p>
        )}
      </div>

      {layout.groups.map((section) => (
        <GroupSection
          key={section.group.groupId}
          section={section}
          shownGroups={shownGroups}
          drag={rowDrag}
          dropTarget={dropTarget(section.group.groupId)}
          zoneRef={zoneRef(section.group.groupId)}
        />
      ))}

      {projectSlug && <StoppedWorktreesButton projectSlug={projectSlug} activeSignature={activeSignature} />}
    </div>
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
        {/* The dismiss × never hides on touch, so the tool label insets clear
            of it there rather than only on hover. */}
        <span className={clsx('flex items-center gap-2', entry.error && 'max-md:pr-9')}>
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
 * One named group: a collapsible section holding its live rows and then its
 * ghost rows, and a whole-section drop zone. The header carries the same
 * overlay actions a worktree row does — rename inline, pin (keep the section
 * when nothing in it is live), and delete, which needs no confirmation
 * because it only releases the worktrees back to the default list.
 */
function GroupSection({
  section,
  shownGroups,
  drag,
  dropTarget,
  zoneRef,
}: {
  section: SidebarGroupSection
  /** The groups on screen — a member row's dialog can move it into any. */
  shownGroups: WorktreeGroupSummary[]
  drag: SidebarDrag
  /** A drop here would move the dragged worktree into this group. */
  dropTarget: boolean
  zoneRef: (el: HTMLDivElement | null) => void
}): JSX.Element {
  const { group, members, ghosts } = section
  const [open, setOpen] = useState(true)
  const {
    editing,
    seed,
    inputRef,
    start: startRename,
    handleKeyDown,
    handleBlur,
  } = useInlineEdit(group.name, (next) => {
    void renameWorktreeGroup(group.projectSlug, group.groupId, next)
      .catch((e: unknown) => console.error('group rename failed', e))
  })

  const togglePinned = (): void => {
    void setWorktreeGroupPinned(group.projectSlug, group.groupId, !group.pinned)
      .catch((e: unknown) => console.error('group pin failed', e))
  }
  const remove = (): void => {
    void deleteWorktreeGroup(group.projectSlug, group.groupId)
      .catch((e: unknown) => console.error('group delete failed', e))
  }

  return (
    <div
      ref={zoneRef}
      role="group"
      aria-label={group.name}
      className={clsx('py-1', dropTarget && 'rounded-lg bg-surface-2/40 ring-1 ring-accent/40')}
    >
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <div className="group relative">
          {editing ? (
            <div className="px-3 py-1">
              <input
                ref={inputRef}
                aria-label="Group name"
                defaultValue={seed}
                placeholder="Group name"
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                className="w-full rounded border border-border-strong bg-bg px-1.5 py-0.5
                  text-xs font-medium text-text outline-none"
              />
            </div>
          ) : (
            <>
              <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium
                text-text-faint outline-none transition hover:text-text-dim group-hover:pr-20">
                <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
                {/* Pinned is a property of the group, not a hover action's
                    state, so it stays visible next to the name. */}
                {group.pinned && <PinIcon size={10} className="shrink-0 rotate-45" />}
                <span className="truncate">{group.name}</span>
                <span className="text-text-faint/70">{members.length + ghosts.length}</span>
              </Collapsible.Trigger>

              {/* Overlaid as siblings (the trigger is itself a button) and
                  pointer-inert until hover, exactly like the row actions. */}
              <button
                onClick={startRename}
                title="Rename group"
                aria-label="Rename group"
                className="absolute right-14 top-0.5 flex h-5 w-5 items-center justify-center rounded text-text-faint
                  opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
                  group-hover:pointer-events-auto group-hover:opacity-100
                  max-md:right-16 max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
              >
                <RenameIcon size={12} />
              </button>
              <button
                onClick={togglePinned}
                title={group.pinned ? 'Unpin group' : 'Pin group (keep it when nothing is running)'}
                aria-label={group.pinned ? 'Unpin group' : 'Pin group'}
                className="absolute right-8 top-0.5 flex h-5 w-5 items-center justify-center rounded text-text-faint
                  opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
                  group-hover:pointer-events-auto group-hover:opacity-100
                  max-md:right-9 max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
              >
                <PinIcon size={12} className={clsx(group.pinned && 'rotate-45')} />
              </button>
              <button
                onClick={remove}
                title="Delete group (its worktrees move back to the list above)"
                aria-label="Delete group"
                className="absolute right-2 top-0.5 flex h-5 w-5 items-center justify-center rounded text-text-faint
                  opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
                  group-hover:pointer-events-auto group-hover:opacity-100
                  max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
              >
                <CloseIcon size={13} />
              </button>
            </>
          )}
        </div>
        <Collapsible.Panel>
          {members.map((s) => (
            <WorktreeRow key={s.worktreeId} worktree={s} shownGroups={shownGroups} drag={drag} />
          ))}
          {ghosts.map((d) => <DeletedWorktreeRow key={d.worktreeId} entry={d} />)}
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
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

function WorktreeRow({
  worktree,
  shownGroups,
  drag,
}: {
  worktree: WorktreeListEntry
  shownGroups: WorktreeGroupSummary[]
  drag: SidebarDrag
}): JSX.Element {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId)
  const selectWorktree = useUiStore((s) => s.selectWorktree)
  const readWaiting = useUiStore((s) => s.readWaiting)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
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
  } = useInlineRename(worktree.worktreeId, worktree.title || worktree.prompt || '')
  // Touch has no hover, so the row's overlay actions (rename, group, delete)
  // are always shown on mobile and the marquee never runs — a long title simply
  // stays truncated, and the pane header shows it in full.
  const isMobile = useIsMobile()
  const unread = isUnreadWaiting(worktree, readWaiting)
  // The container is being torn down — server-marked, or an optimistic delete
  // not yet reflected in the snapshot. The row stays where it is and renders
  // as a placeholder until the snapshot drops the worktree.
  const stopping = isTerminating(worktree, pendingDeleteIds)

  // Close the dialog immediately; the shared flow marks the row stopping
  // optimistically and restores it if the delete fails.
  const onConfirmDelete = (): void => {
    setConfirmDelete(false)
    stopWorktreeOptimistic(worktree)
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

  // The age/agents/branch/tool line, unchanged whether the title above it is
  // the marquee display or the rename input.
  const metaLine = (
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
              aria-label="Worktree row title"
              defaultValue={seed}
              placeholder="Worktree name"
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
            // Dragging is tracked from the press so the row can be both a
            // handle and a click target; the list calls this select back when
            // the press turns out not to be a drag. Touch never starts one, so
            // its click still fires here.
            onPointerDown={(e) => drag.start(e, worktree, () => selectWorktree(worktree.worktreeId))}
            onClick={() => selectWorktree(worktree.worktreeId)}
            className={clsx(
              'flex w-full flex-col gap-0.5 rounded-lg px-2.5 text-left text-sm transition hover:bg-surface-2/60',
              // A taller row on touch: the whole thing is the tap target.
              'py-2 max-md:py-2.5',
              'cursor-grab active:cursor-grabbing max-md:cursor-pointer',
              drag.activeId === worktree.worktreeId && 'opacity-60',
              selectedWorktreeId === worktree.worktreeId && 'bg-surface-2 hover:bg-surface-2',
            )}
          >
            {/* Title fills the row; only on hover does it inset to clear the
                rename + group + delete buttons and marquee-scroll when it's too
                long to fit. On mobile those buttons never hide, so the inset
                is permanent. */}
            <span className="flex items-center gap-2 group-hover:pr-20 max-md:pr-24">
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
              <MarqueeTitle
                text={worktree.title || worktree.prompt || 'New worktree'}
                hovered={hovered && !isMobile}
              />
            </span>
            {metaLine}
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
              until hover, so they can't swallow clicks meant for selecting the row.
              Touch has no hover: below md they are always live and always visible,
              with a bigger target. Also revealed on focus-visible, so keyboard
              users can see and reach them without a mouse. */}
          <button
            onClick={startRename}
            title="Rename worktree"
            aria-label="Rename worktree"
            className="absolute right-14 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
              opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
              group-hover:pointer-events-auto group-hover:opacity-100
              focus-visible:pointer-events-auto focus-visible:opacity-100
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent
              max-md:right-16 max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
          >
            <RenameIcon size={13} />
          </button>
          <button
            onClick={() => setGrouping(true)}
            title="Add to group"
            aria-label="Add to group"
            className="absolute right-8 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
              opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
              group-hover:pointer-events-auto group-hover:opacity-100
              max-md:right-9 max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
          >
            <GroupAddIcon size={13} />
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            title="Delete worktree"
            aria-label="Delete worktree"
            className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
              opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
              group-hover:pointer-events-auto group-hover:opacity-100
              max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
          >
            <CloseIcon size={14} />
          </button>
        </>
      )}

      <GroupDialog
        open={grouping}
        onOpenChange={setGrouping}
        worktree={worktree}
        shownGroups={shownGroups}
      />
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
 * Name-a-group popup: the way a group is created, and — once a project has
 * some — the way a worktree is filed into an existing one without a mouse.
 * Dragging the row is the quicker path, but it is the only one touch and
 * keyboard users don't have.
 */
function GroupDialog({
  open,
  onOpenChange,
  worktree,
  shownGroups,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktree: WorktreeListEntry
  /** Where this worktree can be moved: the groups the sidebar is showing,
   *  which is exactly the set a drag could drop it on. */
  shownGroups: WorktreeGroupSummary[]
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (op: Promise<unknown>, failure: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await op
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : failure)
    } finally {
      setBusy(false)
    }
  }

  const create = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const raw = new FormData(event.currentTarget).get('name')
    const name = (typeof raw === 'string' ? raw : '').trim()
    if (!name) return
    void run(
      createWorktreeGroup(worktree.projectSlug, worktree.worktreeId, name),
      'failed to create group',
    )
  }

  const moveTo = (groupId: string | null): void => {
    void run(
      setWorktreeGroup(worktree.projectSlug, worktree.worktreeId, groupId),
      'failed to move worktree',
    )
  }

  const others = shownGroups.filter((g) => g.groupId !== worktree.groupId)

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/60 backdrop-blur-[1px] transition-opacity duration-150
          data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 w-[380px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2
          rounded-lg border border-border bg-surface-2 p-5 text-text shadow-[0_16px_48px_var(--shadow-color)] outline-none
          transition duration-150 data-[starting-style]:scale-95 data-[starting-style]:opacity-0
          data-[ending-style]:scale-95 data-[ending-style]:opacity-0">
          <Dialog.Title className="text-sm font-semibold">Add to group</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-text-dim">
            Groups collect worktrees at the bottom of the sidebar. Drag rows between them,
            and pin one to keep it when nothing inside is running.
          </Dialog.Description>
          <form onSubmit={create} className="mt-4 flex flex-col gap-3">
            <input
              name="name"
              autoFocus
              placeholder="New group name"
              className="rounded-md border border-border bg-bg px-3 py-2 text-xs text-text outline-none
                focus:border-border-strong"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
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

          {(others.length > 0 || worktree.groupId !== undefined) && (
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
                {worktree.groupId !== undefined && (
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
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * A stopped member of a shown group — the group keeps its row so the worktree
 * can be restarted from where it was filed (they also appear in the full
 * "Stopped worktrees" overlay). Non-selectable: there's nothing to open until
 * it's restarted. Hover offers removal from the group (which drops the row)
 * and a restart, which reuses the deleted-overlay flow: a provisioning row
 * replaces this one while the container is recreated.
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

  // The stopped list isn't snapshot-pushed, so clear the membership in the
  // cached query (and any optimistic copy) for an instant regroup; the server
  // write makes it durable.
  const ungroup = (): void => {
    queryClient.setQueriesData<StoppedWorktreeEntry[]>(
      { queryKey: ['deleted', entry.projectSlug] },
      (old) => old?.map((e) => (e.worktreeId === entry.worktreeId ? { ...e, groupId: undefined } : e)),
    )
    removeOptimisticStopped(entry.worktreeId)
    void setWorktreeGroup(entry.projectSlug, entry.worktreeId, null)
      .catch((e: unknown) => console.error('group move failed', e))
  }

  const deletedLine = entry.deathReason
    ? `died${entry.stoppedAt ? ` ${relativeAge(entry.stoppedAt)}` : ''} — ${describeWorktreeDeathReason(entry.deathReason)}`
    : entry.stoppedAt
      ? `stopped ${relativeAge(entry.stoppedAt)}`
      : 'stopped'

  return (
    <div className="group relative mx-2">
      <div className="flex w-full cursor-default flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm opacity-60">
        <span className="flex items-center gap-2 group-hover:pr-12 max-md:pr-14">
          <span className="truncate font-medium text-text-dim">
            {entry.title || entry.prompt || 'New worktree'}
          </span>
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="truncate">{deletedLine}</span>
          <span className="ml-auto shrink-0">{TOOL_LABEL[entry.tool]}</span>
        </span>
      </div>

      {/* Same overlay-button pattern as live rows: leave the group on the left
          of the action slot, which here restarts instead of deletes. */}
      <button
        onClick={ungroup}
        title="Remove from group"
        aria-label="Remove from group"
        className="absolute right-8 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100
          max-md:right-9 max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
      >
        <GroupRemoveIcon size={13} />
      </button>
      <button
        onClick={() => setConfirmRestart(true)}
        title="Restart worktree"
        aria-label="Restart worktree"
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
        title="Restart this worktree?"
        description={(entry.deathReason ? `This worktree died: ${describeWorktreeDeathReason(entry.deathReason)}. ` : '')
          + `Recreates the container and resumes ${TOOL_LABEL[entry.tool]} from where it left off.`}
        confirmLabel="Restart"
        onConfirm={onConfirmRestart}
      />
    </div>
  )
}

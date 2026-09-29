import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import clsx from 'clsx'
import { useQueryClient } from '@tanstack/react-query'
import { Collapsible } from '@base-ui/react/collapsible'
import { Dialog } from '@base-ui/react/dialog'
import { Menu } from '@base-ui/react/menu'
import {
  ChevronIcon,
  CloseIcon,
  DraftIcon,
  GroupRemoveIcon,
  LoadingIcon,
  MoreIcon,
  PinIcon,
  QueuedIcon,
  RenameIcon,
  RestartIcon,
} from '#lib/icons'
import { agentLabel, worktreeModel } from '#lib/agentLabel'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { StoppedWorktreesButton } from '#components/StoppedWorktreesButton'
import { StopWorktreeDialog } from '#components/StopWorktreeDialog'
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
import { useOpenerFocus } from '#lib/useOpenerFocus'
import { discardDraftWorktree } from '#lib/draftApi'
import { discardQueuedWorktree, runQueuedWorktree } from '#lib/queueApi'
import { clip, queuedChildren, queuedParentId, queuedTitle } from '#lib/queued'
import { stopWorktreeOptimistic } from '#lib/stopWorktreeFlow'
import { useProvisionWorktree } from '#lib/useProvisionWorktree'
import { patchStopped, useStoppedWorktrees } from '#lib/useStoppedWorktrees'
import { useIsMobile } from '#lib/viewport'
import { isUnreadWaiting, isUnseenDeath, useUiStore } from '#lib/store'
import { describeWorktreeDeathReason } from '@yaac/shared/death-reason'
// A group name is stored under this cap, and the routes refuse a longer one
// — so the fields that mint names stop there rather than taking a name the
// server will not keep.
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import type {
  DraftWorktreeEntry,
  HeldWorktreeEntry,
  StoppedWorktreeEntry,
  ProvisioningWorktreeEntry,
  QueuedWorktreeEntry,
  WorktreeGroupSummary,
  WorktreeListEntry,
} from '@yaac/shared/types'
import { relativeAge } from '#lib/time'

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
  /** Members still provisioning — a create filed here, or a member being
   *  restarted — rendered above the live rows. */
  provisioning: ProvisioningWorktreeEntry[]
  /** Live (and terminating) members, newest first. */
  members: WorktreeListEntry[]
  /** Held members — stopped, with queued worktrees still waiting on them —
   *  newest first, as stopped rows after the live ones. */
  held: StoppedWorktreeEntry[]
  /** The other stopped members, newest first — ghost rows at the foot of the
   *  section, collapsed behind a count by default. */
  ghosts: StoppedWorktreeEntry[]
}

export interface SidebarLayout {
  /** Ungrouped provisioning rows, in the order they were started — the top of
   *  the list. A provisioning row that names a group is in that section
   *  instead. */
  provisioning: ProvisioningWorktreeEntry[]
  /** Ungrouped worktrees, newest first. Terminating rows sit in place. */
  defaultList: WorktreeListEntry[]
  /** Ungrouped held worktrees — stopped, with queued worktrees still waiting
   *  on them — newest first, as stopped rows after the live ones. */
  defaultHeld: StoppedWorktreeEntry[]
  /** The groups that are shown, newest group first. */
  groups: SidebarGroupSection[]
  /** Queued worktrees by the id they wait on, each nested under that row. */
  queuedChildren: Map<string, QueuedWorktreeEntry[]>
  /** Queued worktrees with no row on screen to nest under — a parent whose
   *  own create failed — shown at the top of the list. */
  orphans: QueuedWorktreeEntry[]
}

/** A held worktree as the stopped row that draws it. */
function heldAsStopped(h: HeldWorktreeEntry): StoppedWorktreeEntry {
  return {
    worktreeId: h.worktreeId,
    projectSlug: h.projectSlug,
    tool: h.tool,
    createdAt: h.stoppedAt,
    stoppedAt: h.stoppedAt,
    ...(h.prompt !== undefined ? { prompt: h.prompt } : {}),
    ...(h.title !== undefined ? { title: h.title } : {}),
    agentSessions: [],
    ...(h.deathReason !== undefined ? { deathReason: h.deathReason } : {}),
    ...(h.deathDetail !== undefined ? { deathDetail: h.deathDetail } : {}),
    seen: true,
    ...(h.groupId !== undefined ? { groupId: h.groupId } : {}),
  }
}

/**
 * The sidebar's shape: every ungrouped worktree newest first, then one section
 * per shown group, also newest first — so the worktree or group just created is
 * at the top of whatever it belongs to, and the ungrouped list stays above the
 * sections. Nothing is bucketed by status — a worktree's own markers (the
 * running spinner, the unread dot, the stopping placeholder) say what state it
 * is in, and its position says where the user filed it.
 *
 * A provisioning row is filed the same way: one that names a group leads that
 * group's section rather than the whole list. That is what keeps a restart in
 * place — the worktree is out of the snapshot while its container is recreated,
 * so its restarting row is all there is to hold its section, and a row that
 * jumped to the top would read as somewhere else entirely.
 *
 * A group is shown when it is pinned, holds at least one live worktree, or has
 * one provisioning into it, and a shown group lists ALL its members: live ones
 * as ordinary rows, stopped ones as ghost rows with a restart action, folded
 * behind a count at the foot of the section so they don't crowd it. So an
 * unpinned group whose worktrees have all stopped simply disappears — its row
 * survives on the server, and restarting a member brings the whole section
 * back — while pinning keeps it on screen as somewhere to restart into.
 *
 * `stopped` is the project's stopped listing, already de-duped against the
 * active and provisioning ids by the caller; only entries belonging to a shown
 * group are rendered, the rest live in the "Stopped worktrees" overlay. A
 * worktree naming a group that no longer exists falls back to the default
 * list, which is what a snapshot arriving mid-delete looks like.
 *
 * A `held` worktree — stopped, with queued worktrees still waiting on it —
 * is the exception: it keeps a stopped row in its normal place, the default
 * list included, and holds its group on screen as a live member would, so
 * what is queued under it stays visible until it has run or been discarded —
 * which is also why it is never folded away with the ghosts.
 * Each queued worktree nests under the row it waits on; one whose parent has
 * no row here goes to the top of the list (`orphans`).
 */
export function sidebarLayout(
  worktrees: WorktreeListEntry[],
  groups: WorktreeGroupSummary[],
  stopped: StoppedWorktreeEntry[] = [],
  provisioning: ProvisioningWorktreeEntry[] = [],
  queued: QueuedWorktreeEntry[] = [],
  held: HeldWorktreeEntry[] = [],
): SidebarLayout {
  const known = new Set(groups.map((g) => g.groupId))
  const filedIn = (entry: { groupId?: string }): string | null =>
    entry.groupId !== undefined && known.has(entry.groupId) ? entry.groupId : null
  const live = [...worktrees].sort(byCreatedAt)
  // The stopped listing's row wins over the snapshot's slimmer held entry.
  const stoppedIds = new Set(stopped.map((d) => d.worktreeId))
  const heldIds = new Set(held.map((h) => h.worktreeId))
  const heldRows = [
    ...stopped.filter((d) => heldIds.has(d.worktreeId)),
    ...held.filter((h) => !stoppedIds.has(h.worktreeId)).map(heldAsStopped),
  ].sort(byCreatedAt)
  const ghosts = stopped.filter((d) => !heldIds.has(d.worktreeId)).sort(byCreatedAt)
  // Provisioning rows keep the order they were started in (the caller's merge
  // already sorts them oldest-first): they have no place among the live rows
  // to sort into, and a row moving under the pointer while it provisions is
  // exactly what this ordering is here to avoid.
  const sections = [...groups]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.groupId.localeCompare(a.groupId))
    .map((group) => ({
      group,
      provisioning: provisioning.filter((p) => filedIn(p) === group.groupId),
      members: live.filter((w) => filedIn(w) === group.groupId),
      held: heldRows.filter((d) => filedIn(d) === group.groupId),
      ghosts: ghosts.filter((d) => filedIn(d) === group.groupId),
    }))
    .filter((s) => s.group.pinned || s.members.length > 0 || s.provisioning.length > 0 || s.held.length > 0)
  const defaultHeld = heldRows.filter((d) => filedIn(d) === null)

  const onScreen = new Set([
    ...provisioning.map((p) => p.worktreeId),
    ...live.map((w) => w.worktreeId),
    ...defaultHeld.map((d) => d.worktreeId),
    ...sections.flatMap((s) => s.held.map((d) => d.worktreeId)),
  ])
  const queuedIds = new Set(queued.map((e) => e.id))
  return {
    provisioning: provisioning.filter((p) => filedIn(p) === null),
    defaultList: live.filter((w) => filedIn(w) === null),
    defaultHeld,
    groups: sections,
    queuedChildren: queuedChildren(queued),
    orphans: queued.filter((e) => e.parentQueuedId !== undefined
      ? !queuedIds.has(e.parentQueuedId)
      : e.orphaned === true || !onScreen.has(e.parentWorktreeId ?? '')),
  }
}

/**
 * The list's selectable rows in display order — the ungrouped provisioning
 * rows, then the ungrouped worktrees, then each shown group's own provisioning
 * rows and live members. This is the list the Alt+↑/↓ worktree-switch shortcut
 * steps through (Workspace owns the handler). Terminating rows (server-marked,
 * or a mid-flight optimistic delete) still render, greyed, but aren't
 * selectable — nor are ghost rows, which have nothing to open until they're
 * restarted.
 */
export function sidebarRowIds(
  provisioning: ProvisioningWorktreeEntry[],
  worktrees: WorktreeListEntry[],
  groups: WorktreeGroupSummary[],
  pendingDeleteIds: string[],
): string[] {
  // Built on the layout itself, so the cycle can't drift from what is drawn.
  const layout = sidebarLayout(worktrees, groups, [], provisioning)
  const selectable = (list: WorktreeListEntry[]): string[] =>
    list.filter((w) => !isTerminating(w, pendingDeleteIds)).map((w) => w.worktreeId)
  return [
    ...layout.provisioning.map((p) => p.worktreeId),
    ...selectable(layout.defaultList),
    ...layout.groups.flatMap((s) => [
      ...s.provisioning.map((p) => p.worktreeId),
      ...selectable(s.members),
    ]),
  ]
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
 * The scrollable body of the worktree list: the ungrouped provisioning rows,
 * the ungrouped worktrees, the group sections (each leading with its own
 * provisioning rows), and the stopped-worktrees entry point.
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
  queued = [],
  held = [],
  drafts = [],
}: {
  projectSlug: string | null
  worktrees: WorktreeListEntry[]
  /** The active project's groups, from the snapshot. */
  groups: WorktreeGroupSummary[]
  provisioning: ProvisioningWorktreeEntry[]
  /** The active project's queued worktrees, and the stopped worktrees they
   *  still wait on. */
  queued?: QueuedWorktreeEntry[]
  held?: HeldWorktreeEntry[]
  /** The active project's draft worktrees. */
  drafts?: DraftWorktreeEntry[]
}): JSX.Element {
  // A mid-flight optimistic delete doesn't move a row any more — it greys it
  // where it sits — so the list needs pendingDeleteIds only to keep the
  // already-deleting rows out of the delete successor order; each row reads it
  // again for its own placeholder.
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  // Only for the empty-state copy: there is no rail on a phone to point at.
  const isMobile = useIsMobile()
  // Only members of a shown group become ghost rows — the layout's call; the
  // rest are in the overlay behind the entry point at the foot of the list.
  const stopped = useStoppedWorktrees(projectSlug, worktrees, provisioning)

  const layout = sidebarLayout(worktrees, groups, stopped, provisioning, queued, held)
  // Display order of the selectable rows, so a stop from a row's menu can hand
  // the selection to the row below it. Same list the Alt+K/J cycle steps through.
  const rowIds = sidebarRowIds(provisioning, worktrees, groups, pendingDeleteIds)
  const visibleCount = layout.defaultList.length + layout.defaultHeld.length + layout.orphans.length
    + layout.groups.reduce((n, s) => n + s.members.length + s.held.length + s.ghosts.length, 0)
  // What a queued row's discard needs to say about the row its children would
  // move under.
  const names = new Map<string, QueueParent>([
    ...provisioning.map((p) => [p.worktreeId, { name: 'New worktree', kind: 'live' }] as const),
    ...worktrees.map((w) => [w.worktreeId, { name: w.title || w.prompt || 'New worktree', kind: 'live' }] as const),
    ...held.map((h) => [h.worktreeId, { name: h.title || h.prompt || 'New worktree', kind: 'held' }] as const),
    ...queued.map((e) => [e.id, { name: queuedTitle(e), kind: 'queued' }] as const),
  ])
  // Held here rather than in each set, so a set stays open while its
  // worktree moves between sections (stops, restarts, changes group). Sets
  // start collapsed; only the one the user just queued into opens itself.
  const [expandedQueues, setExpandedQueues] = useState<ReadonlySet<string>>(new Set())
  const setOpen = (id: string, open: boolean): void => setExpandedQueues((prev) => {
    const next = new Set(prev)
    if (open) next.add(id)
    else next.delete(id)
    return next
  })
  const revealQueued = useUiStore((s) => s.revealQueued)
  useEffect(() => {
    if (revealQueued === null) return
    const byId = new Map(queued.map((e) => [e.id, e]))
    const landed = byId.get(revealQueued.id)
    // Not in the snapshot yet, or still under the parent it is moving from.
    if (landed === undefined || queuedParentId(landed) !== revealQueued.parent) return
    // The set is the whole chain's, so open the one its top entry nests in.
    let top = revealQueued.id
    for (let e = byId.get(top); e !== undefined; e = byId.get(e.parentQueuedId ?? '')) top = queuedParentId(e)
    setExpandedQueues((prev) => prev.has(top) ? prev : new Set([...prev, top]))
    useUiStore.getState().setRevealQueued(null)
  }, [revealQueued, queued])
  // Forget a set once it empties, so the next one queued under that worktree
  // starts collapsed like any other.
  const queuedParents = [...layout.queuedChildren.keys()].join('\n')
  useEffect(() => {
    const parents = new Set(queuedParents.split('\n'))
    setExpandedQueues((prev) => {
      const kept = [...prev].filter((id) => parents.has(id))
      return kept.length === prev.size ? prev : new Set(kept)
    })
  }, [queuedParents])
  const queueContext: QueueContextValue = {
    children: layout.queuedChildren,
    parent: (id) => names.get(id) ?? { name: '', kind: 'gone' },
    expanded: expandedQueues,
    setOpen,
  }

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
    <QueueContext.Provider value={queueContext}>
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
        {projectSlug && visibleCount === 0 && provisioning.length === 0 && queued.length === 0
          && drafts.length === 0 && (
          <EmptyState
            compact
            className="py-10"
            title="No worktrees yet"
            description="Start one with the + above."
          />
        )}
        {drafts.length > 0 && <DraftsSection drafts={drafts} />}
        {layout.orphans.map((e) => (
          <Fragment key={e.id}>
            <QueuedWorktreeRow entry={e} depth={0} />
            <QueuedRows parentId={e.id} depth={1} />
          </Fragment>
        ))}
        {layout.provisioning.map((p) => (
          <Fragment key={p.worktreeId}>
            <ProvisioningRow entry={p} />
            <QueuedSet parentId={p.worktreeId} />
          </Fragment>
        ))}

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
            <Fragment key={s.worktreeId}>
              <WorktreeRow worktree={s} shownGroups={shownGroups} drag={rowDrag} rowIds={rowIds} />
              <QueuedSet parentId={s.worktreeId} />
            </Fragment>
          ))}
          {layout.defaultHeld.map((d) => (
            <Fragment key={d.worktreeId}>
              <DeletedWorktreeRow entry={d} />
              <QueuedSet parentId={d.worktreeId} />
            </Fragment>
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
            rowIds={rowIds}
            dropTarget={dropTarget(section.group.groupId)}
            zoneRef={zoneRef(section.group.groupId)}
          />
        ))}

        {projectSlug && <StoppedWorktreesButton projectSlug={projectSlug} stopped={stopped} />}
      </div>
    </QueueContext.Provider>
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
          <span className="ml-auto shrink-0 text-xs text-text-faint">{agentLabel(entry.tool, entry)}</span>
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
 * One named group: a collapsible section holding its live rows, its held
 * rows, and then its ghost rows behind their own expander, and a
 * whole-section drop zone. The header carries the same
 * overlay actions a worktree row does — rename inline, pin (keep the section
 * when nothing in it is live), and delete, which needs no confirmation
 * because it only releases the worktrees back to the default list.
 */
function GroupSection({
  section,
  shownGroups,
  drag,
  rowIds,
  dropTarget,
  zoneRef,
}: {
  section: SidebarGroupSection
  /** The groups on screen — a member row's dialog can move it into any. */
  shownGroups: WorktreeGroupSummary[]
  drag: SidebarDrag
  /** The whole sidebar's rows in display order, for a member's delete. */
  rowIds: string[]
  /** A drop here would move the dragged worktree into this group. */
  dropTarget: boolean
  zoneRef: (el: HTMLDivElement | null) => void
}): JSX.Element {
  const { group, provisioning, members, held, ghosts } = section
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
                maxLength={MAX_TITLE_LENGTH}
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
                <span className="text-text-faint/70">
                  {provisioning.length + members.length + held.length + ghosts.length}
                </span>
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
          {/* Leads the section, as provisioning rows lead the whole list: a
              worktree being restarted has no live row to sit next to, and its
              placeholder belongs where the worktree is filed. */}
          {provisioning.map((p) => (
            <Fragment key={p.worktreeId}>
              <ProvisioningRow entry={p} />
              <QueuedSet parentId={p.worktreeId} />
            </Fragment>
          ))}
          {members.map((s) => (
            <Fragment key={s.worktreeId}>
              <WorktreeRow worktree={s} shownGroups={shownGroups} drag={drag} rowIds={rowIds} />
              <QueuedSet parentId={s.worktreeId} />
            </Fragment>
          ))}
          {held.map((d) => (
            <Fragment key={d.worktreeId}>
              <DeletedWorktreeRow entry={d} />
              <QueuedSet parentId={d.worktreeId} />
            </Fragment>
          ))}
          {ghosts.length > 0 && <StoppedSet ghosts={ghosts} />}
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  )
}

/** A group's stopped members, folded behind a count at the foot of the
 *  section — closed by default, so a long-lived group stays as short as its
 *  live rows. It comes back closed whenever it remounts: the group collapsed,
 *  dropped off screen, or ran out of stopped members. A death the user has
 *  not read yet is counted on the trigger, as `QueuedSet` counts a failed
 *  launch, or a closed fold would hide which group it happened in. */
function StoppedSet({ ghosts }: { ghosts: StoppedWorktreeEntry[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const n = ghosts.length
  const died = ghosts.filter(isUnseenDeath).length
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="mx-2 flex items-center gap-1 px-2.5 py-1 text-xs
        text-text-faint outline-none transition hover:text-text-dim">
        <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        {n} stopped worktree{n === 1 ? '' : 's'}
        {died > 0 && <span className="text-[#d65858]">· {died} died</span>}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {ghosts.map((d) => <DeletedWorktreeRow key={d.worktreeId} entry={d} />)}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/**
 * Worktree title that fills the row's width, truncating with an ellipsis when it
 * doesn't fit. On row hover it un-clips and marquee-scrolls the full text (the
 * row has already inset its right edge to clear its actions menu). The scroll
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
  rowIds,
}: {
  worktree: WorktreeListEntry
  shownGroups: WorktreeGroupSummary[]
  drag: SidebarDrag
  /** The sidebar's rows in display order — deleting this one moves the
   *  selection to the next of them. */
  rowIds: string[]
}): JSX.Element {
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId)
  const selectWorktree = useUiStore((s) => s.selectWorktree)
  const readWaiting = useUiStore((s) => s.readWaiting)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const openCreateWorktree = useUiStore((s) => s.openCreateWorktree)
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
  // Touch has no hover, so the row's actions menu is always shown on mobile
  // and the marquee never runs — a long title simply stays truncated, and the
  // pane header shows it in full.
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
    stopWorktreeOptimistic(worktree, rowIds)
  }

  // A stopping row is a non-interactive, greyed placeholder: no pulse, no
  // unread bubble, no actions menu — just a spinner and a "stopping…" line. It
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
            <span className="ml-auto shrink-0">{agentLabel(worktree.tool, worktreeModel(worktree))}</span>
          </span>
        </div>
      </div>
    )
  }

  // The age/agents/tool line, unchanged whether the title above it is
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
      {/* Tool name moved off the title line so the title can run full-width;
          hidden when the blocked-hosts badge claims the bottom-right. Carries
          the model beside it once the agent has answered as one. */}
      {worktree.blockedHosts.length === 0 && (
        <span className="ml-auto shrink-0">
          {agentLabel(worktree.tool, worktreeModel(worktree))}
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
                actions menu and marquee-scroll when it's too long to fit. On
                mobile the menu never hides, so the inset is permanent. */}
            <span className="flex items-center gap-2 group-hover:pr-8 max-md:pr-10">
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

          {/* Overlaid as a sibling for the same reason as the actions menu:
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

          {/* Overlaid as a sibling (not nested in the row button) and
              pointer-inert until hover, so it can't swallow clicks meant for
              selecting the row. Touch has no hover: below md it is always live
              and visible, with a bigger target. */}
          <RowMenu
            label="Worktree actions"
            items={[
              { label: 'Rename', onSelect: startRename },
              { label: 'Move to group…', onSelect: () => setGrouping(true) },
              {
                label: 'Queue worktree after this…',
                onSelect: () => openCreateWorktree({
                  projectSlug: worktree.projectSlug, parent: worktree.worktreeId, focus: 'prompt',
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
        worktree={worktree}
        shownGroups={shownGroups}
      />
      <StopWorktreeDialog
        worktree={confirmDelete ? worktree : null}
        onOpenChange={setConfirmDelete}
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
  const finalFocus = useOpenerFocus(open)

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
        <Dialog.Popup finalFocus={finalFocus} className="fixed left-1/2 top-1/2 w-[380px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2
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
              maxLength={MAX_TITLE_LENGTH}
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
  const openStoppedOverlay = useUiStore((s) => s.openStoppedOverlay)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const onConfirmRestart = (): void => {
    setConfirmRestart(false)
    removeOptimisticStopped(entry.worktreeId)
    // The group goes with it, so the restarting row replaces this ghost right
    // here instead of jumping to the top of the sidebar.
    provision(entry.projectSlug, entry.tool, 'restart', entry.worktreeId,
      (sid, onProgress) => restartWorktree(sid, onProgress),
      entry.groupId)
  }

  // The stopped list isn't snapshot-pushed, so clear the membership in the
  // cached query (and any optimistic copy) for an instant regroup; the server
  // write makes it durable.
  const ungroup = (): void => {
    patchStopped(queryClient, entry.projectSlug,
      (e) => (e.worktreeId === entry.worktreeId ? { ...e, groupId: undefined } : e))
    removeOptimisticStopped(entry.worktreeId)
    void setWorktreeGroup(entry.projectSlug, entry.worktreeId, null)
      .catch((e: unknown) => console.error('group move failed', e))
  }

  const deletedLine = entry.deathReason
    ? `died${entry.stoppedAt ? ` ${relativeAge(entry.stoppedAt)}` : ''} — ${describeWorktreeDeathReason(entry.deathReason)}`
    : entry.stoppedAt
      ? `stopped ${relativeAge(entry.stoppedAt)}`
      : `last active ${relativeAge(entry.lastActiveAt ?? entry.createdAt)}`

  return (
    <div className="group relative mx-2">
      {/* Opens the stopped-worktrees overlay on this worktree, which is where
          its conversation is readable. There is still nothing to *select* —
          it has no pane until it is restarted — so it stays out of the row
          cycle (`sidebarRowIds`) and reads as dimmed rather than active. */}
      <button
        type="button"
        onClick={() => openStoppedOverlay(entry.worktreeId)}
        title="Read this worktree's conversation"
        className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm opacity-60
          transition hover:bg-surface-2/50 hover:opacity-90 focus-visible:outline-none
          focus-visible:ring-1 focus-visible:ring-border-strong"
      >
        <span className="flex items-center gap-2 group-hover:pr-12 max-md:pr-14">
          <span className="truncate font-medium text-text-dim">
            {entry.title || entry.prompt || 'New worktree'}
          </span>
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="truncate">{deletedLine}</span>
          <span className="ml-auto shrink-0">{agentLabel(entry.tool, worktreeModel(entry))}</span>
        </span>
      </button>

      {/* Same overlay-button pattern as live rows: leave the group on the left
          of the action slot, which here restarts instead of deletes. */}
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
        description={entry.title || entry.prompt || 'New worktree'}
        confirmLabel="Restart"
        onConfirm={onConfirmRestart}
      />
    </div>
  )
}

/** What a queued row's discard confirmation says about the row its children
 *  would move under. */
interface QueueParent {
  name: string
  kind: 'live' | 'held' | 'queued' | 'gone'
}

interface QueueContextValue {
  /** Queued worktrees by the id they wait on. */
  children: Map<string, QueuedWorktreeEntry[]>
  parent: (id: string) => QueueParent
  /** Worktree ids whose queued set is expanded. */
  expanded: ReadonlySet<string>
  setOpen: (id: string, open: boolean) => void
}

/** Handed through the list rather than threaded through every section and
 *  row: any row — live, provisioning, held, or queued — can have entries
 *  nested under it. */
const QueueContext = createContext<QueueContextValue>({
  children: new Map(),
  parent: () => ({ name: '', kind: 'gone' }),
  expanded: new Set(),
  setOpen: () => {},
})

/** Everything queued under a worktree row, behind one expander counting it
 *  at every depth. Only this top-level set collapses; the chains inside it
 *  always show in full. A failed launch is shown only on its own row, so the
 *  expander counts those too, or a collapsed set would hide one. */
function QueuedSet({ parentId }: { parentId: string }): JSX.Element | null {
  const { children, expanded, setOpen } = useContext(QueueContext)
  if (!children.has(parentId)) return null
  const entries: QueuedWorktreeEntry[] = []
  const walk = (id: string): void => {
    for (const e of children.get(id) ?? []) {
      entries.push(e)
      walk(e.id)
    }
  }
  walk(parentId)
  const n = entries.length
  const failed = entries.filter((e) => e.launchError !== undefined).length
  const open = expanded.has(parentId)
  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setOpen(parentId, next)}>
      <Collapsible.Trigger className="mx-2 flex items-center gap-1 pl-5 pr-2 py-1 text-xs
        text-text-faint outline-none transition hover:text-text-dim">
        <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        {n} queued worktree{n === 1 ? '' : 's'}
        {failed > 0 && <span className="text-[#d65858]">· {failed} failed</span>}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <QueuedRows parentId={parentId} depth={1} />
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/** The queued worktrees waiting on `parentId`, each followed by its own
 *  chain, one indent step deeper per link. */
function QueuedRows({ parentId, depth }: { parentId: string; depth: number }): JSX.Element | null {
  const { children } = useContext(QueueContext)
  const entries = children.get(parentId)
  if (entries === undefined) return null
  return (
    <>
      {entries.map((e) => (
        <Fragment key={e.id}>
          <QueuedWorktreeRow entry={e} depth={depth} />
          <QueuedRows parentId={e.id} depth={depth + 1} />
        </Fragment>
      ))}
    </>
  )
}

/** Where a discarded entry's children go, and whether they then run. */
function discardDescription(entry: QueuedWorktreeEntry, context: QueueContextValue): string {
  const lost = `“${clip(queuedTitle(entry))}” will not run.`
  const n = context.children.get(entry.id)?.length ?? 0
  if (n === 0) return lost
  const them = n === 1 ? 'The worktree queued after it' : `The ${n} worktrees queued after it`
  const parent = context.parent(entry.parentWorktreeId ?? entry.parentQueuedId ?? '')
  const name = `“${clip(parent.name, 40)}”`
  switch (parent.kind) {
    case 'live': return `${lost} ${them} will start when ${name} stops instead.`
    case 'queued': return `${lost} ${them} will wait on ${name} instead.`
    case 'held': return `${lost} ${them} will move under ${name}, which is stopped — they wait there until you run them.`
    case 'gone': return `${lost} ${them} will wait at the top of the list until you run them.`
  }
}

/**
 * A queued worktree: a create saved to start when the row above it stops
 * (docs/queued-worktrees.md). Clicking it edits it; its menu runs it now,
 * edits it, queues another after it, or discards it. A launch that failed
 * shows why, in place of its settings, until it is run again.
 *
 * Not selectable — there is nothing to open until it starts — so it stays
 * out of the Alt+J/K cycle (`sidebarRowIds`).
 */
function QueuedWorktreeRow({ entry, depth }: { entry: QueuedWorktreeEntry; depth: number }): JSX.Element {
  const openCreateWorktree = useUiStore((s) => s.openCreateWorktree)
  const context = useContext(QueueContext)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const edit = (): void => openCreateWorktree({ projectSlug: entry.projectSlug, editId: entry.id })
  const report = (e: unknown): void => setError(e instanceof Error ? e.message : String(e))
  const failure = error ?? entry.launchError

  return (
    <div className="group relative mx-2" style={{ paddingLeft: depth * 12 }}>
      <button
        type="button"
        onClick={edit}
        title={entry.prompt}
        className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition
          hover:bg-surface-2/60"
      >
        <span className="flex items-center gap-2 group-hover:pr-8 max-md:pr-10">
          <QueuedIcon size={11} className="shrink-0 text-text-faint" />
          <span className="truncate text-text-dim">{queuedTitle(entry)}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          {failure !== undefined
            ? <span className="truncate text-[#d65858]" title={failure}>{failure}</span>
            : <span className="truncate">{agentLabel(entry.tool, entry)} · queued</span>}
          {entry.orphaned === true && <span className="ml-auto shrink-0">parent gone</span>}
        </span>
      </button>

      <RowMenu
        label="Queued worktree actions"
        items={[
          {
            label: 'Run now',
            onSelect: () => {
              setError(null)
              void runQueuedWorktree(entry.id).catch(report)
            },
          },
          { label: 'Edit…', onSelect: edit },
          {
            label: 'Queue worktree after this…',
            onSelect: () => openCreateWorktree({ projectSlug: entry.projectSlug, parent: entry.id, focus: 'prompt' }),
          },
          'separator',
          { label: 'Discard…', onSelect: () => setConfirmDiscard(true) },
        ]}
      />

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard queued worktree?"
        description={discardDescription(entry, context)}
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmDiscard(false)
          void discardQueuedWorktree(entry.id).catch(report)
        }}
      />
    </div>
  )
}

/**
 * The project's draft worktrees (docs/draft-worktrees.md), collapsible, at
 * the top of the list — above everything that exists, since none of these
 * does yet. Only rendered when there is at least one.
 */
function DraftsSection({ drafts }: { drafts: DraftWorktreeEntry[] }): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div role="group" aria-label="Drafts" className="py-1">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium
          text-text-faint outline-none transition hover:text-text-dim">
          <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
          <span>Drafts</span>
          <span className="text-text-faint/70">{drafts.length}</span>
        </Collapsible.Trigger>
        <Collapsible.Panel>
          {/* Newest first, as everything else in the list is. */}
          {[...drafts].reverse().map((d) => <DraftWorktreeRow key={d.id} draft={d} />)}
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  )
}

/** A saved draft: clicking it reopens the create dialog on it; its menu can
 *  also discard it. Not selectable — there is nothing to open until it is
 *  created — so it stays out of the Alt+J/K cycle. */
function DraftWorktreeRow({ draft }: { draft: DraftWorktreeEntry }): JSX.Element {
  const openCreateWorktree = useUiStore((s) => s.openCreateWorktree)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const name = draft.title ?? queuedTitle(draft)
  const open = (): void => openCreateWorktree({ projectSlug: draft.projectSlug, draftId: draft.id, focus: 'prompt' })

  return (
    <div className="group relative mx-2">
      <button
        type="button"
        onClick={open}
        title={draft.prompt}
        className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition
          hover:bg-surface-2/60"
      >
        <span className="flex items-center gap-2 group-hover:pr-8 max-md:pr-10">
          <DraftIcon size={11} className="shrink-0 text-text-faint" />
          <span className="truncate text-text-dim">{name}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-text-faint">
          <span className="shrink-0">{relativeAge(draft.updatedAt)}</span>
          <span className="ml-auto truncate">{agentLabel(draft.tool, draft)}</span>
        </span>
      </button>

      <RowMenu
        label="Draft actions"
        items={[
          { label: 'Open…', onSelect: open },
          'separator',
          { label: 'Discard…', onSelect: () => setConfirmDiscard(true) },
        ]}
      />

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard draft?"
        description={`“${clip(name)}” will be deleted.`}
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmDiscard(false)
          void discardDraftWorktree(draft.id).catch((e: unknown) => console.error('draft discard failed', e))
        }}
      />
    </div>
  )
}

type RowMenuItem = { label: string; onSelect: () => void } | 'separator'

const MENU_POPUP = 'min-w-[180px] rounded-lg border border-border bg-surface-2 p-1 text-text '
  + 'shadow-[0_12px_32px_var(--shadow-color)] outline-none'
const MENU_ITEM = 'flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs text-text-dim '
  + 'outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-text'

/**
 * A row's `…` actions menu, overlaid at its top right and revealed on hover
 * (always, on touch).
 *
 * A picked item runs once the menu has finished closing, and the menu then
 * leaves focus where the item put it: a rename's input, or a dialog it
 * opened, rather than taking it back to the trigger. What the item sees
 * focused first is where such a dialog returns focus: the trigger after a
 * keyboard pick, so a keyboard user keeps their place, and nothing after a
 * pointer pick, whose `…` would otherwise stay pinned on a row the pointer
 * has left.
 */
function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }): JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null)
  // Kept until the next open: the popup reads it for `finalFocus` as it
  // unmounts, after the item has already run.
  const picked = useRef<(() => void) | null>(null)
  // The input that last acted in the popup. Not the click's `detail`: a
  // press-drag-release pick is a pointer gesture that clicks programmatically.
  const byKey = useRef(false)
  return (
    <Menu.Root
      onOpenChange={(open) => { if (open) picked.current = null }}
      onOpenChangeComplete={(open) => {
        if (open || picked.current === null) return
        if (byKey.current) trigger.current?.focus()
        else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        picked.current()
      }}
    >
      <Menu.Trigger
        ref={trigger}
        title={label}
        aria-label={label}
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100
          focus-visible:pointer-events-auto focus-visible:opacity-100
          data-[popup-open]:pointer-events-auto data-[popup-open]:opacity-100 data-[popup-open]:bg-surface-3
          max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100"
      >
        <MoreIcon size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup
            finalFocus={() => picked.current === null}
            onKeyDown={() => { byKey.current = true }}
            onPointerUp={() => { byKey.current = false }}
            className={MENU_POPUP}
          >
            {items.map((item, i) => item === 'separator'
              ? <Menu.Separator key={`sep-${i}`} className="my-1 h-px bg-border" />
              : (
                <Menu.Item key={item.label} className={MENU_ITEM} onClick={() => { picked.current = item.onSelect }}>
                  {item.label}
                </Menu.Item>
              ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

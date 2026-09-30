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
  RestartIcon,
} from '#lib/icons'
import { agentLabel, workspaceModel } from '#lib/agentLabel'
import { BlockedHostsBadge } from '#components/BlockedHostsBadge'
import { StoppedWorkspacesButton } from '#components/StoppedWorkspacesButton'
import { StopWorkspaceDialog } from '#components/StopWorkspaceDialog'
import { EmptyState } from '#components/ui/EmptyState'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { dismissProvisioning, restartWorkspace } from '#lib/createWorkspace'
import {
  createWorkspaceGroup,
  deleteWorkspaceGroup,
  renameWorkspaceGroup,
  setWorkspaceGroup,
  setWorkspaceGroupPinned,
} from '#lib/groupApi'
import { useInlineEdit, useInlineRename } from '#lib/useInlineRename'
import { useOpenerFocus } from '#lib/useOpenerFocus'
import { discardDraftWorkspace } from '#lib/draftApi'
import { discardQueuedWorkspace, runQueuedWorkspace } from '#lib/queueApi'
import { shownGroups } from '#lib/groups'
import { clip, queuedChildren, queuedParentId, queuedTitle } from '#lib/queued'
import { stopWorkspaceOptimistic } from '#lib/stopWorkspaceFlow'
import { useProvisionWorkspace } from '#lib/useProvisionWorkspace'
import { patchStopped, useStoppedWorkspaces } from '#lib/useStoppedWorkspaces'
import { useIsMobile } from '#lib/viewport'
import { isUnreadWaiting, isUnseenDeath, useUiStore } from '#lib/store'
import { describeWorkspaceDeathReason } from '@yaac/shared/death-reason'
// A group name is stored under this cap, and the routes refuse a longer one
// — so the fields that mint names stop there rather than taking a name the
// server will not keep.
import { MAX_TITLE_LENGTH } from '@yaac/shared/titles'
import type {
  DraftWorkspaceEntry,
  HeldWorkspaceEntry,
  StoppedWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  QueuedWorkspaceEntry,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'
import { relativeAge } from '#lib/time'

/** A workspace is stopping when the server has marked it (its pod has a
 *  deletionTimestamp, or a delete was just issued) or a client-side optimistic
 *  delete is still in flight. Such a row stays exactly where it sits — in the
 *  default list or in its group — but renders as a non-interactive, greyed
 *  placeholder and can't be selected or dragged (see WorkspaceRow). */
function isTerminating(
  workspace: Pick<WorkspaceListEntry, 'workspaceId' | 'stopping'>,
  pendingDeleteIds: string[],
): boolean {
  return Boolean(workspace.stopping) || pendingDeleteIds.includes(workspace.workspaceId)
}

/** Newest first, by the UTC 'YYYY-MM-DD HH:MM:SS' stamp — which compares
 *  lexicographically — with the id as a stable tiebreak for workspaces created
 *  inside the same second. */
function byCreatedAt<T extends { createdAt: string; workspaceId: string }>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt) || b.workspaceId.localeCompare(a.workspaceId)
}

/** One group's section of the list. */
export interface SidebarGroupSection {
  group: WorkspaceGroupSummary
  /** Members still provisioning — a create filed here, or a member being
   *  restarted — rendered above the live rows. */
  provisioning: ProvisioningWorkspaceEntry[]
  /** Live (and terminating) members, newest first. */
  members: WorkspaceListEntry[]
  /** Held members — stopped, with queued workspaces still waiting on them —
   *  newest first, as stopped rows after the live ones. */
  held: StoppedWorkspaceEntry[]
  /** The other stopped members, newest first — ghost rows at the foot of the
   *  section, collapsed behind a count by default. */
  ghosts: StoppedWorkspaceEntry[]
}

export interface SidebarLayout {
  /** Ungrouped provisioning rows, in the order they were started — the top of
   *  the list. A provisioning row that names a group is in that section
   *  instead. */
  provisioning: ProvisioningWorkspaceEntry[]
  /** Ungrouped workspaces, newest first. Terminating rows sit in place. */
  defaultList: WorkspaceListEntry[]
  /** Ungrouped held workspaces — stopped, with queued workspaces still waiting
   *  on them — newest first, as stopped rows after the live ones. */
  defaultHeld: StoppedWorkspaceEntry[]
  /** The groups that are shown, newest group first. */
  groups: SidebarGroupSection[]
  /** Queued workspaces by the id they wait on, each nested under that row. */
  queuedChildren: Map<string, QueuedWorkspaceEntry[]>
  /** Queued workspaces with no row on screen to nest under — a parent whose
   *  own create failed — shown at the top of the list. */
  orphans: QueuedWorkspaceEntry[]
}

/** A held workspace as the stopped row that draws it. */
function heldAsStopped(h: HeldWorkspaceEntry): StoppedWorkspaceEntry {
  return {
    workspaceId: h.workspaceId,
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
 * The sidebar's shape: every ungrouped workspace newest first, then one section
 * per shown group, also newest first — so the workspace or group just created is
 * at the top of whatever it belongs to, and the ungrouped list stays above the
 * sections. Nothing is bucketed by status — a workspace's own markers (the
 * running spinner, the unread dot, the stopping placeholder) say what state it
 * is in, and its position says where the user filed it.
 *
 * A provisioning row is filed the same way: one that names a group leads that
 * group's section rather than the whole list. That is what keeps a restart in
 * place — the workspace is out of the snapshot while its container is recreated,
 * so its restarting row is all there is to hold its section, and a row that
 * jumped to the top would read as somewhere else entirely.
 *
 * A group is shown when it is pinned, holds at least one live workspace, or has
 * one provisioning into it, and a shown group lists ALL its members: live ones
 * as ordinary rows, stopped ones as ghost rows with a restart action, hidden
 * at the foot of the section until asked for so they don't crowd it. So an
 * unpinned group whose workspaces have all stopped simply disappears — its row
 * survives on the server, and restarting a member brings the whole section
 * back — while pinning keeps it on screen as somewhere to restart into.
 *
 * `stopped` is the project's stopped listing, already de-duped against the
 * active and provisioning ids by the caller; only entries belonging to a shown
 * group are rendered, the rest live in the "Stopped workspaces" overlay. A
 * workspace naming a group that no longer exists falls back to the default
 * list, which is what a snapshot arriving mid-delete looks like.
 *
 * A `held` workspace — stopped, with queued workspaces still waiting on it —
 * is the exception: it keeps a stopped row in its normal place, the default
 * list included, and holds its group on screen as a live member would, so
 * what is queued under it stays visible until it has run or been discarded —
 * which is also why it is never hidden with the ghosts.
 * Each queued workspace nests under the row it waits on; one whose parent has
 * no row here goes to the top of the list (`orphans`).
 */
export function sidebarLayout(
  workspaces: WorkspaceListEntry[],
  groups: WorkspaceGroupSummary[],
  stopped: StoppedWorkspaceEntry[] = [],
  provisioning: ProvisioningWorkspaceEntry[] = [],
  queued: QueuedWorkspaceEntry[] = [],
  held: HeldWorkspaceEntry[] = [],
): SidebarLayout {
  const known = new Set(groups.map((g) => g.groupId))
  const filedIn = (entry: { groupId?: string }): string | null =>
    entry.groupId !== undefined && known.has(entry.groupId) ? entry.groupId : null
  const live = [...workspaces].sort(byCreatedAt)
  const liveIds = new Set([...workspaces, ...provisioning].map((w) => w.workspaceId))
  // A parent still stopping is already held but keeps its live row until the
  // snapshot drops it; drawing both would show it, and its queue, twice.
  const shownHeld = held.filter((h) => !liveIds.has(h.workspaceId))
  // The stopped listing's row wins over the snapshot's slimmer held entry.
  const stoppedIds = new Set(stopped.map((d) => d.workspaceId))
  const heldIds = new Set(shownHeld.map((h) => h.workspaceId))
  const heldRows = [
    ...stopped.filter((d) => heldIds.has(d.workspaceId)),
    ...shownHeld.filter((h) => !stoppedIds.has(h.workspaceId)).map(heldAsStopped),
  ].sort(byCreatedAt)
  const ghosts = stopped.filter((d) => !heldIds.has(d.workspaceId)).sort(byCreatedAt)
  // Provisioning rows keep the order they were started in (the caller's merge
  // already sorts them oldest-first): they have no place among the live rows
  // to sort into, and a row moving under the pointer while it provisions is
  // exactly what this ordering is here to avoid.
  const sections = shownGroups(groups, [...workspaces, ...provisioning, ...shownHeld])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.groupId.localeCompare(a.groupId))
    .map((group) => ({
      group,
      provisioning: provisioning.filter((p) => filedIn(p) === group.groupId),
      members: live.filter((w) => filedIn(w) === group.groupId),
      held: heldRows.filter((d) => filedIn(d) === group.groupId),
      ghosts: ghosts.filter((d) => filedIn(d) === group.groupId),
    }))
  const defaultHeld = heldRows.filter((d) => filedIn(d) === null)

  const onScreen = new Set([...liveIds, ...heldIds])
  const queuedIds = new Set(queued.map((e) => e.id))
  return {
    provisioning: provisioning.filter((p) => filedIn(p) === null),
    defaultList: live.filter((w) => filedIn(w) === null),
    defaultHeld,
    groups: sections,
    queuedChildren: queuedChildren(queued),
    orphans: queued.filter((e) => e.parentQueuedId !== undefined
      ? !queuedIds.has(e.parentQueuedId)
      : e.orphaned === true || !onScreen.has(e.parentWorkspaceId ?? '')),
  }
}

/**
 * The list's selectable rows in display order — the ungrouped provisioning
 * rows, then the ungrouped workspaces, then each shown group's own provisioning
 * rows and live members. This is the list the Alt+↑/↓ workspace-switch shortcut
 * steps through (Shell owns the handler). Terminating rows (server-marked,
 * or a mid-flight optimistic delete) still render, greyed, but aren't
 * selectable — nor are ghost rows, which have nothing to open until they're
 * restarted.
 */
export function sidebarRowIds(
  provisioning: ProvisioningWorkspaceEntry[],
  workspaces: WorkspaceListEntry[],
  groups: WorkspaceGroupSummary[],
  pendingDeleteIds: string[],
): string[] {
  // Built on the layout itself, so the cycle can't drift from what is drawn.
  const layout = sidebarLayout(workspaces, groups, [], provisioning)
  const selectable = (list: WorkspaceListEntry[]): string[] =>
    list.filter((w) => !isTerminating(w, pendingDeleteIds)).map((w) => w.workspaceId)
  return [
    ...layout.provisioning.map((p) => p.workspaceId),
    ...selectable(layout.defaultList),
    ...layout.groups.flatMap((s) => [
      ...s.provisioning.map((p) => p.workspaceId),
      ...selectable(s.members),
    ]),
  ]
}

/** Pointer travel that turns a press on a row into a drag rather than a
 *  selection — the same threshold the pane tabs use. */
const DRAG_THRESHOLD = 5

interface DragState {
  workspaceId: string
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
  start: (e: ReactPointerEvent, workspace: WorkspaceListEntry, onSelect: () => void) => void
  /** The row being dragged right now, if any. */
  activeId: string | null
}

/**
 * The scrollable body of the workspace list: the ungrouped provisioning rows,
 * the ungrouped workspaces, the group sections (each leading with its own
 * provisioning rows), and the stopped-workspaces entry point.
 *
 * Chrome-free on purpose — the desktop `Sidebar` wraps it in its fixed-width
 * card and the mobile workspaces screen gives it the whole viewport, and both
 * get the same rows in the same order (which is also the order
 * `sidebarRowIds` promises the Alt+K/J cycle).
 */
export function WorkspaceList({
  projectSlug,
  workspaces,
  groups,
  provisioning,
  queued = [],
  held = [],
  drafts = [],
}: {
  projectSlug: string | null
  workspaces: WorkspaceListEntry[]
  /** The active project's groups, from the snapshot. */
  groups: WorkspaceGroupSummary[]
  provisioning: ProvisioningWorkspaceEntry[]
  /** The active project's queued workspaces, and the stopped workspaces they
   *  still wait on. */
  queued?: QueuedWorkspaceEntry[]
  held?: HeldWorkspaceEntry[]
  /** The active project's draft workspaces. */
  drafts?: DraftWorkspaceEntry[]
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
  const stopped = useStoppedWorkspaces(projectSlug, workspaces, provisioning)

  const layout = sidebarLayout(workspaces, groups, stopped, provisioning, queued, held)
  // Display order of the selectable rows, so a stop from a row's menu can hand
  // the selection to the row below it. Same list the Alt+K/J cycle steps through.
  const rowIds = sidebarRowIds(provisioning, workspaces, groups, pendingDeleteIds)
  const visibleCount = layout.defaultList.length + layout.defaultHeld.length + layout.orphans.length
    + layout.groups.reduce((n, s) => n + s.members.length + s.held.length + s.ghosts.length, 0)
  // What a queued row's discard needs to say about the row its children would
  // move under.
  const names = new Map<string, QueueParent>([
    ...provisioning.map((p) => [p.workspaceId, { name: 'New workspace', kind: 'live' }] as const),
    ...workspaces.map((w) => [w.workspaceId, { name: w.title || w.prompt || 'New workspace', kind: 'live' }] as const),
    ...held.map((h) => [h.workspaceId, { name: h.title || h.prompt || 'New workspace', kind: 'held' }] as const),
    ...queued.map((e) => [e.id, { name: queuedTitle(e), kind: 'queued' }] as const),
  ])
  // Held here rather than in each set, so a set stays open while its
  // workspace moves between sections (stops, restarts, changes group). Sets
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
  // Forget a set once it empties, so the next one queued under that workspace
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

  // --- row drag (move a workspace between the default list and groups) ---
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
  // it moves the workspace. Mouse only — a pointerdown that preventDefaults
  // would fight the scroll on touch, where the group dialog is the way to move
  // a workspace.
  const startDrag = (
    e: ReactPointerEvent,
    workspace: WorkspaceListEntry,
    onSelect: () => void,
  ): void => {
    if (e.pointerType !== 'mouse') return
    // Suppresses the compatibility click, which is why the sub-threshold case
    // below has to call `onSelect` itself.
    e.preventDefault()
    const init: DragState = {
      workspaceId: workspace.workspaceId,
      projectSlug: workspace.projectSlug,
      from: layout.groups.some((s) => s.group.groupId === workspace.groupId)
        ? workspace.groupId ?? null
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
      // NOT_FOUND, and the snapshot already has the workspace where it belongs.
      void setWorkspaceGroup(d.projectSlug, d.workspaceId, d.over)
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

  const rowDrag: SidebarDrag = { start: startDrag, activeId: drag?.active ? drag.workspaceId : null }
  /** Whether a drop here would actually move the dragged workspace. */
  const dropTarget = (groupId: string | null): boolean =>
    Boolean(drag?.active) && drag?.over === groupId && drag.over !== drag.from
  // What a row's dialog can move it into: the sections actually on screen, so
  // it offers exactly the drop targets a drag has. A hidden group is one whose
  // workspaces have all stopped, and moving a live workspace into it would make
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
            title="No workspaces yet"
            description="Start one with the + above."
          />
        )}
        {drafts.length > 0 && <DraftsSection drafts={drafts} />}
        {layout.orphans.map((e) => (
          <Fragment key={e.id}>
            <QueuedWorkspaceRow entry={e} depth={0} />
            <QueuedRows parentId={e.id} depth={1} />
          </Fragment>
        ))}
        {layout.provisioning.map((p) => (
          <Fragment key={p.workspaceId}>
            <ProvisioningRow entry={p} />
            <QueuedSet parentId={p.workspaceId} />
          </Fragment>
        ))}

        {/* The default list is a drop zone in its own right — dragging a row out
            of a group and onto it files the workspace back under no group. It
            keeps a placeholder while a drag is in flight so an empty list is
            still somewhere to drop. */}
        <div
          ref={zoneRef(null)}
          role="group"
          aria-label="Ungrouped workspaces"
          className={clsx('py-1', dropTarget(null) && 'rounded-lg bg-surface-2/40 ring-1 ring-accent/40')}
        >
          {layout.defaultList.map((s) => (
            <Fragment key={s.workspaceId}>
              <WorkspaceRow workspace={s} shownGroups={shownGroups} drag={rowDrag} rowIds={rowIds} />
              <QueuedSet parentId={s.workspaceId} />
            </Fragment>
          ))}
          {layout.defaultHeld.map((d) => (
            <Fragment key={d.workspaceId}>
              <DeletedWorkspaceRow entry={d} />
              <QueuedSet parentId={d.workspaceId} />
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

        {projectSlug && <StoppedWorkspacesButton projectSlug={projectSlug} stopped={stopped} />}
      </div>
    </QueueContext.Provider>
  )
}

/** Selectable row for a workspace that's still provisioning. Clicking it opens
 *  the provisioning status in the main pane; a failed one offers a dismiss ×. */
function ProvisioningRow({ entry }: { entry: ProvisioningWorkspaceEntry }): JSX.Element {
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
        {/* The dismiss × never hides on touch, so the tool label insets clear
            of it there rather than only on hover. */}
        <span className={clsx('flex items-center gap-2', entry.error && 'max-md:pr-9')}>
          <span className="truncate font-medium text-text-dim">
            {entry.kind === 'restart' ? 'Restarting workspace' : 'New workspace'}
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
 * rows, and then its ghost rows, and a whole-section drop zone. The header
 * counts live members against all of them, and its `…` menu renames inline,
 * pins (keep the section when nothing in it is live), shows or hides the
 * ghost rows, and deletes, which needs no confirmation because it only
 * releases the workspaces back to the default list.
 *
 * Ghost rows start hidden and come back hidden whenever the section remounts.
 * A section with nothing but ghosts has nothing else to expand to, so there
 * its caret and the menu item are one toggle.
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
  shownGroups: WorkspaceGroupSummary[]
  drag: SidebarDrag
  /** The whole sidebar's rows in display order, for a member's delete. */
  rowIds: string[]
  /** A drop here would move the dragged workspace into this group. */
  dropTarget: boolean
  zoneRef: (el: HTMLDivElement | null) => void
}): JSX.Element {
  const { group, provisioning, members, held, ghosts } = section
  const [open, setOpen] = useState(true)
  const [showStopped, setShowStopped] = useState(false)
  const onlyGhosts = provisioning.length + members.length + held.length === 0
  const expanded = onlyGhosts ? showStopped : open
  // A failed provisioning row is on screen, but nothing is running behind it.
  const active = provisioning.filter((p) => !p.error).length + members.length
  const total = provisioning.length + members.length + held.length + ghosts.length
  // An unread death is flagged on the header, or hidden ghosts would hide
  // which group it happened in.
  const died = ghosts.filter(isUnseenDeath).length
  const {
    editing,
    seed,
    inputRef,
    start: startRename,
    handleKeyDown,
    handleBlur,
  } = useInlineEdit(group.name, (next) => {
    void renameWorkspaceGroup(group.projectSlug, group.groupId, next)
      .catch((e: unknown) => console.error('group rename failed', e))
  })

  // In the all-stopped case the caret writes both, so the section keeps its
  // state when a live row (a restart, say) hands the caret back to `open`.
  const toggleExpanded = (next: boolean): void => {
    if (onlyGhosts) setShowStopped(next)
    setOpen(next)
  }
  const toggleStopped = (): void => {
    // Showing them opens the section too, or the pick would do nothing visible.
    if (!showStopped) setOpen(true)
    setShowStopped(!showStopped)
  }
  const togglePinned = (): void => {
    void setWorkspaceGroupPinned(group.projectSlug, group.groupId, !group.pinned)
      .catch((e: unknown) => console.error('group pin failed', e))
  }
  const remove = (): void => {
    void deleteWorkspaceGroup(group.projectSlug, group.groupId)
      .catch((e: unknown) => console.error('group delete failed', e))
  }

  return (
    <div
      ref={zoneRef}
      role="group"
      aria-label={group.name}
      className={clsx('py-1', dropTarget && 'rounded-lg bg-surface-2/40 ring-1 ring-accent/40')}
    >
      <Collapsible.Root open={expanded} onOpenChange={toggleExpanded}>
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
                text-text-faint outline-none transition hover:text-text-dim group-hover:pr-9 max-md:pr-11">
                <ChevronIcon size={12} className={clsx('shrink-0 transition-transform', expanded && 'rotate-90')} />
                {/* Pinned is a property of the group, not a hover action's
                    state, so it stays visible next to the name. */}
                {group.pinned && <PinIcon size={10} className="shrink-0 rotate-45" />}
                <span className="truncate">{group.name}</span>
                <span className="text-text-faint/70">({active}/{total})</span>
                {died > 0 && <span className="text-[#d65858]">· {died} died</span>}
              </Collapsible.Trigger>

              {/* A sibling of the trigger, which is itself a button. */}
              <RowMenu
                label="Group actions"
                position="right-2 top-0.5"
                items={[
                  { label: 'Rename', onSelect: startRename },
                  { label: group.pinned ? 'Unpin' : 'Pin', onSelect: togglePinned },
                  ...(ghosts.length > 0
                    ? [{ label: showStopped ? 'Hide stopped workspaces' : 'Show stopped workspaces', onSelect: toggleStopped }]
                    : []),
                  'separator',
                  { label: 'Delete group', onSelect: remove },
                ]}
              />
            </>
          )}
        </div>
        <Collapsible.Panel>
          {/* Leads the section, as provisioning rows lead the whole list: a
              workspace being restarted has no live row to sit next to, and its
              placeholder belongs where the workspace is filed. */}
          {provisioning.map((p) => (
            <Fragment key={p.workspaceId}>
              <ProvisioningRow entry={p} />
              <QueuedSet parentId={p.workspaceId} />
            </Fragment>
          ))}
          {members.map((s) => (
            <Fragment key={s.workspaceId}>
              <WorkspaceRow workspace={s} shownGroups={shownGroups} drag={drag} rowIds={rowIds} />
              <QueuedSet parentId={s.workspaceId} />
            </Fragment>
          ))}
          {held.map((d) => (
            <Fragment key={d.workspaceId}>
              <DeletedWorkspaceRow entry={d} />
              <QueuedSet parentId={d.workspaceId} />
            </Fragment>
          ))}
          {showStopped && ghosts.map((d) => <DeletedWorkspaceRow key={d.workspaceId} entry={d} />)}
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  )
}

/**
 * Workspace title that fills the row's width, truncating with an ellipsis when it
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

/** How many of a workspace's agent workspaces are currently open. A workspace
 *  from an older server (or one whose registry tick hasn't landed) reports
 *  none, which reads as the ordinary single-agent case. */
function openAgentCount(workspace: WorkspaceListEntry): number {
  return workspace.agentSessions.filter((a) => a.active).length
}

function WorkspaceRow({
  workspace,
  shownGroups,
  drag,
  rowIds,
}: {
  workspace: WorkspaceListEntry
  shownGroups: WorkspaceGroupSummary[]
  drag: SidebarDrag
  /** The sidebar's rows in display order — deleting this one moves the
   *  selection to the next of them. */
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
  // Touch has no hover, so the row's actions menu is always shown on mobile
  // and the marquee never runs — a long title simply stays truncated, and the
  // pane header shows it in full.
  const isMobile = useIsMobile()
  const unread = isUnreadWaiting(workspace, readWaiting)
  // The container is being torn down — server-marked, or an optimistic delete
  // not yet reflected in the snapshot. The row stays where it is and renders
  // as a placeholder until the snapshot drops the workspace.
  const stopping = isTerminating(workspace, pendingDeleteIds)

  // Close the dialog immediately; the shared flow marks the row stopping
  // optimistically and restores it if the delete fails.
  const onConfirmDelete = (): void => {
    setConfirmDelete(false)
    stopWorkspaceOptimistic(workspace, rowIds)
  }

  // A stopping row is a non-interactive, greyed placeholder: no pulse, no
  // unread bubble, no actions menu — just a spinner and a "stopping…" line. It
  // vanishes when the snapshot drops the workspace.
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

  // The age/agents/tool line, unchanged whether the title above it is
  // the marquee display or the rename input.
  const metaLine = (
    <span className="flex items-center gap-2 text-xs text-text-faint">
      <span className="shrink-0">{relativeAge(workspace.createdAt)}</span>
      {/* Only when a workspace holds more than one live conversation —
          one is the overwhelmingly common case and a column of "1
          agent" would be pure noise. */}
      {openAgentCount(workspace) > 1 && (
        <span
          className="shrink-0"
          title={`${openAgentCount(workspace)} agent workspaces open in this workspace`}
        >
          {openAgentCount(workspace)} agents
        </span>
      )}
      {/* Tool name moved off the title line so the title can run full-width;
          hidden when the blocked-hosts badge claims the bottom-right. Carries
          the model beside it once the agent has answered as one. */}
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
            // Dragging is tracked from the press so the row can be both a
            // handle and a click target; the list calls this select back when
            // the press turns out not to be a drag. Touch never starts one, so
            // its click still fires here.
            onPointerDown={(e) => drag.start(e, workspace, () => selectWorkspace(workspace.workspaceId))}
            onClick={() => selectWorkspace(workspace.workspaceId)}
            className={clsx(
              'flex w-full flex-col gap-0.5 rounded-lg px-2.5 text-left text-sm transition hover:bg-surface-2/60',
              // A taller row on touch: the whole thing is the tap target.
              'py-2 max-md:py-2.5',
              'cursor-grab active:cursor-grabbing max-md:cursor-pointer',
              drag.activeId === workspace.workspaceId && 'opacity-60',
              selectedWorkspaceId === workspace.workspaceId && 'bg-surface-2 hover:bg-surface-2',
            )}
          >
            {/* Title fills the row; only on hover does it inset to clear the
                actions menu and marquee-scroll when it's too long to fit. On
                mobile the menu never hides, so the inset is permanent. */}
            <span className="flex items-center gap-2 group-hover:pr-8 max-md:pr-10">
              {/* Braille spinner: the workspace's agent is actively running. The
                  cycling glyph reads as "working" and can't be mistaken for the
                  round unread bubble below (which is a solid, still dot). */}
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
              {/* Unread bubble: this workspace started waiting and hasn't been viewed. */}
              {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />}
              <MarqueeTitle
                text={workspace.title || workspace.prompt || 'New workspace'}
                hovered={hovered && !isMobile}
              />
            </span>
            {metaLine}
          </button>

          {/* Overlaid as a sibling for the same reason as the actions menu:
              the badge is a button and can't nest inside the row button. The
              wrapper is pointer-inert so only the badge itself takes clicks. */}
          {workspace.blockedHosts.length > 0 && (
            <span className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1">
              <BlockedHostsBadge
                hosts={workspace.blockedHosts}
                workspaceId={workspace.workspaceId}
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
 * Name-a-group popup: the way a group is created, and — once a project has
 * some — the way a workspace is filed into an existing one without a mouse.
 * Dragging the row is the quicker path, but it is the only one touch and
 * keyboard users don't have.
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
  /** Where this workspace can be moved: the groups the sidebar is showing,
   *  which is exactly the set a drag could drop it on. */
  shownGroups: WorkspaceGroupSummary[]
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
      createWorkspaceGroup(workspace.projectSlug, workspace.workspaceId, name),
      'failed to create group',
    )
  }

  const moveTo = (groupId: string | null): void => {
    void run(
      setWorkspaceGroup(workspace.projectSlug, workspace.workspaceId, groupId),
      'failed to move workspace',
    )
  }

  const others = shownGroups.filter((g) => g.groupId !== workspace.groupId)

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
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * A stopped member of a shown group — the group keeps its row so the workspace
 * can be restarted from where it was filed (they also appear in the full
 * "Stopped workspaces" overlay). Non-selectable: there's nothing to open until
 * it's restarted. Hover offers removal from the group (which drops the row)
 * and a restart, which reuses the deleted-overlay flow: a provisioning row
 * replaces this one while the container is recreated.
 */
function DeletedWorkspaceRow({ entry }: { entry: StoppedWorkspaceEntry }): JSX.Element {
  const provision = useProvisionWorkspace()
  const queryClient = useQueryClient()
  const removeOptimisticStopped = useUiStore((s) => s.removeOptimisticStopped)
  const openStoppedOverlay = useUiStore((s) => s.openStoppedOverlay)
  const [confirmRestart, setConfirmRestart] = useState(false)

  const onConfirmRestart = (): void => {
    setConfirmRestart(false)
    removeOptimisticStopped(entry.workspaceId)
    // The group goes with it, so the restarting row replaces this ghost right
    // here instead of jumping to the top of the sidebar.
    provision(entry.projectSlug, entry.tool, 'restart', entry.workspaceId,
      (sid, onProgress) => restartWorkspace(sid, onProgress),
      entry.groupId)
  }

  // The stopped list isn't snapshot-pushed, so clear the membership in the
  // cached query (and any optimistic copy) for an instant regroup; the server
  // write makes it durable.
  const ungroup = (): void => {
    patchStopped(queryClient, entry.projectSlug,
      (e) => (e.workspaceId === entry.workspaceId ? { ...e, groupId: undefined } : e))
    removeOptimisticStopped(entry.workspaceId)
    void setWorkspaceGroup(entry.projectSlug, entry.workspaceId, null)
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

/** What a queued row's discard confirmation says about the row its children
 *  would move under. */
interface QueueParent {
  name: string
  kind: 'live' | 'held' | 'queued' | 'gone'
}

interface QueueContextValue {
  /** Queued workspaces by the id they wait on. */
  children: Map<string, QueuedWorkspaceEntry[]>
  parent: (id: string) => QueueParent
  /** Workspace ids whose queued set is expanded. */
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

/** Everything queued under a workspace row, behind one expander counting it
 *  at every depth. Only this top-level set collapses; the chains inside it
 *  always show in full. A failed launch is shown only on its own row, so the
 *  expander counts those too, or a collapsed set would hide one. */
function QueuedSet({ parentId }: { parentId: string }): JSX.Element | null {
  const { children, expanded, setOpen } = useContext(QueueContext)
  if (!children.has(parentId)) return null
  const entries: QueuedWorkspaceEntry[] = []
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
        {n} queued workspace{n === 1 ? '' : 's'}
        {failed > 0 && <span className="text-[#d65858]">· {failed} failed</span>}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <QueuedRows parentId={parentId} depth={1} />
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/** The queued workspaces waiting on `parentId`, each followed by its own
 *  chain, one indent step deeper per link. */
function QueuedRows({ parentId, depth }: { parentId: string; depth: number }): JSX.Element | null {
  const { children } = useContext(QueueContext)
  const entries = children.get(parentId)
  if (entries === undefined) return null
  return (
    <>
      {entries.map((e) => (
        <Fragment key={e.id}>
          <QueuedWorkspaceRow entry={e} depth={depth} />
          <QueuedRows parentId={e.id} depth={depth + 1} />
        </Fragment>
      ))}
    </>
  )
}

/** Where a discarded entry's children go, and whether they then run. */
function discardDescription(entry: QueuedWorkspaceEntry, context: QueueContextValue): string {
  const lost = `“${clip(queuedTitle(entry))}” will not run.`
  const n = context.children.get(entry.id)?.length ?? 0
  if (n === 0) return lost
  const them = n === 1 ? 'The workspace queued after it' : `The ${n} workspaces queued after it`
  const parent = context.parent(entry.parentWorkspaceId ?? entry.parentQueuedId ?? '')
  const name = `“${clip(parent.name, 40)}”`
  switch (parent.kind) {
    case 'live': return `${lost} ${them} will start when ${name} stops instead.`
    case 'queued': return `${lost} ${them} will wait on ${name} instead.`
    case 'held': return `${lost} ${them} will move under ${name}, which is stopped — they wait there until you run them.`
    case 'gone': return `${lost} ${them} will wait at the top of the list until you run them.`
  }
}

/**
 * A queued workspace: a create saved to start when the row above it stops
 * (docs/queued-workspaces.md). Clicking it edits it; its menu runs it now,
 * edits it, queues another after it, or discards it. A launch that failed
 * shows why, in place of its settings, until it is run again.
 *
 * Not selectable — there is nothing to open until it starts — so it stays
 * out of the Alt+J/K cycle (`sidebarRowIds`).
 */
function QueuedWorkspaceRow({ entry, depth }: { entry: QueuedWorkspaceEntry; depth: number }): JSX.Element {
  const openCreateWorkspace = useUiStore((s) => s.openCreateWorkspace)
  const context = useContext(QueueContext)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const edit = (): void => openCreateWorkspace({ projectSlug: entry.projectSlug, editId: entry.id })
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
        label="Queued workspace actions"
        items={[
          {
            label: 'Run now',
            onSelect: () => {
              setError(null)
              void runQueuedWorkspace(entry.id).catch(report)
            },
          },
          { label: 'Edit…', onSelect: edit },
          {
            label: 'Queue workspace after this…',
            onSelect: () => openCreateWorkspace({ projectSlug: entry.projectSlug, parent: entry.id, focus: 'prompt' }),
          },
          'separator',
          { label: 'Discard…', onSelect: () => setConfirmDiscard(true) },
        ]}
      />

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard queued workspace?"
        description={discardDescription(entry, context)}
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmDiscard(false)
          void discardQueuedWorkspace(entry.id).catch(report)
        }}
      />
    </div>
  )
}

/**
 * The project's draft workspaces (docs/draft-workspaces.md), collapsible, at
 * the top of the list — above everything that exists, since none of these
 * does yet. Only rendered when there is at least one.
 */
function DraftsSection({ drafts }: { drafts: DraftWorkspaceEntry[] }): JSX.Element {
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
          {[...drafts].reverse().map((d) => <DraftWorkspaceRow key={d.id} draft={d} />)}
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  )
}

/** A saved draft: clicking it reopens the create dialog on it; its menu can
 *  also discard it. Not selectable — there is nothing to open until it is
 *  created — so it stays out of the Alt+J/K cycle. */
function DraftWorkspaceRow({ draft }: { draft: DraftWorkspaceEntry }): JSX.Element {
  const openCreateWorkspace = useUiStore((s) => s.openCreateWorkspace)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const name = queuedTitle(draft)
  const open = (): void => openCreateWorkspace({ projectSlug: draft.projectSlug, draftId: draft.id, focus: 'prompt' })

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
          void discardDraftWorkspace(draft.id).catch((e: unknown) => console.error('draft discard failed', e))
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
function RowMenu({ label, items, position = 'right-2 top-2' }: {
  label: string
  items: RowMenuItem[]
  /** Where the trigger sits in its row — a group header is shorter. */
  position?: string
}): JSX.Element {
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
        className={clsx(position, `absolute flex h-5 w-5 items-center justify-center rounded text-text-faint
          opacity-0 transition hover:bg-surface-3 hover:text-text pointer-events-none
          group-hover:pointer-events-auto group-hover:opacity-100
          focus-visible:pointer-events-auto focus-visible:opacity-100
          data-[popup-open]:pointer-events-auto data-[popup-open]:opacity-100 data-[popup-open]:bg-surface-3
          max-md:h-7 max-md:w-7 max-md:pointer-events-auto max-md:opacity-100`)}
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

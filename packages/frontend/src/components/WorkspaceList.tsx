import { Fragment, useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { StoppedWorkspacesButton } from '#components/StoppedWorkspacesButton'
import { EmptyState } from '#components/ui/EmptyState'
import { api } from '#lib/api'
import { usePressDrag } from '#lib/usePressDrag'
import { shownGroups } from '#lib/groups'
import { queuedChildren, queuedParentId, queuedTitle } from '#lib/queued'
import { useStoppedWorkspaces } from '#lib/useStoppedWorkspaces'
import { useIsMobile } from '#lib/viewport'
import { useUiStore } from '#lib/store'
import type {
  DraftWorkspaceEntry,
  HeldWorkspaceEntry,
  StoppedWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  QueuedWorkspaceEntry,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'
import {
  DraftsSection,
  QueueContext,
  QueuedRows,
  QueuedSet,
  QueuedWorkspaceRow,
  type QueueContextValue,
  type QueueParent,
} from '#components/sidebar/QueuedRows'
import {
  DeletedWorkspaceRow,
  isTerminating,
  ProvisioningRow,
  WorkspaceRow,
  type SidebarDrag,
} from '#components/sidebar/WorkspaceRows'
import { GroupSection } from '#components/sidebar/GroupSection'

/** Newest first (UTC timestamps compare as strings), with the id as a
 *  tiebreak. */
function byCreatedAt<T extends { createdAt: string; workspaceId: string }>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt) || b.workspaceId.localeCompare(a.workspaceId)
}

/** One group's section of the list. */
export interface SidebarGroupSection {
  group: WorkspaceGroupSummary
  /** Members being created or restarted, shown above the live rows. */
  provisioning: ProvisioningWorkspaceEntry[]
  /** Live (and terminating) members, newest first. */
  members: WorkspaceListEntry[]
  /** Held members (stopped, with queued workspaces waiting on them), newest
   *  first, shown as stopped rows after the live ones. */
  held: StoppedWorkspaceEntry[]
  /** Other stopped members, newest first: ghost rows at the end of the
   *  section, collapsed by default. */
  ghosts: StoppedWorkspaceEntry[]
}

export interface SidebarLayout {
  /** Ungrouped provisioning rows at the top of the list, in the order they
   *  were started. */
  provisioning: ProvisioningWorkspaceEntry[]
  /** Ungrouped workspaces, newest first. Terminating rows sit in place. */
  defaultList: WorkspaceListEntry[]
  /** Ungrouped held workspaces, newest first, after the live ones. */
  defaultHeld: StoppedWorkspaceEntry[]
  /** The groups that are shown, newest group first. */
  groups: SidebarGroupSection[]
  /** Queued workspaces by the id they wait on, each nested under that row. */
  queuedChildren: Map<string, QueuedWorkspaceEntry[]>
  /** Queued workspaces whose parent has no row (e.g. its create failed),
   *  shown at the top of the list. */
  orphans: QueuedWorkspaceEntry[]
}

/** A held workspace as a stopped row. */
function heldAsStopped(h: HeldWorkspaceEntry): StoppedWorkspaceEntry {
  return {
    workspaceId: h.workspaceId,
    projectId: h.projectId,
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
 * The sidebar's layout: ungrouped workspaces newest first, then one section
 * per shown group, newest group first. Rows are not grouped by status; each
 * row's markers show its state.
 *
 * A provisioning row that names a group goes at the top of that group, so a
 * restarting workspace (absent from the snapshot meanwhile) stays in place.
 *
 * A group is shown when it is pinned or has a live, provisioning or held
 * member. A shown group lists all its members, with stopped ones as
 * collapsed ghost rows that can be restarted. An unpinned group whose
 * members have all stopped disappears until one is restarted.
 *
 * `stopped` is the project's stopped list, already filtered against live
 * and provisioning ids by the caller; entries outside a shown group appear
 * only in the "Stopped workspaces" overlay. A workspace whose group no
 * longer exists falls back to the default list.
 *
 * A held workspace (stopped, with queued workspaces waiting on it) keeps a
 * stopped row in its usual place and keeps its group shown, so its queue
 * stays visible. Each queued workspace nests under the row it waits on;
 * those without one go in `orphans`.
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
  // A held workspace still stopping keeps its live row; don't draw it twice.
  const shownHeld = held.filter((h) => !liveIds.has(h.workspaceId))
  // Prefer the stopped list's fuller entry over the snapshot's held entry.
  const stoppedIds = new Set(stopped.map((d) => d.workspaceId))
  const heldIds = new Set(shownHeld.map((h) => h.workspaceId))
  const heldRows = [
    ...stopped.filter((d) => heldIds.has(d.workspaceId)),
    ...shownHeld.filter((h) => !stoppedIds.has(h.workspaceId)).map(heldAsStopped),
  ].sort(byCreatedAt)
  const ghosts = stopped.filter((d) => !heldIds.has(d.workspaceId)).sort(byCreatedAt)
  // Provisioning rows keep the order they were started in (the caller sorts
  // them), so they don't move under the pointer.
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
 * The list's selectable rows in display order, for the workspace-cycle
 * shortcut (handled in Shell). Stopping, stopped and ghost rows are not
 * selectable.
 */
export function sidebarRowIds(
  provisioning: ProvisioningWorkspaceEntry[],
  workspaces: WorkspaceListEntry[],
  groups: WorkspaceGroupSummary[],
  pendingDeleteIds: string[],
): string[] {
  // Derived from the layout so it always matches what is drawn.
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

/** A dragged row: the workspace and the group it started in (null for
 *  the default list). */
interface RowDrag {
  workspaceId: string
  projectId: string
  from: string | null
}


/**
 * The scrollable workspace list: drafts, provisioning rows, ungrouped
 * workspaces, group sections and the stopped-workspaces button. It has no
 * outer chrome, so the desktop `Sidebar` and the mobile workspaces screen
 * can each wrap it.
 */
export function WorkspaceList({
  projectId,
  workspaces,
  groups,
  provisioning,
  queued = [],
  held = [],
  drafts = [],
}: {
  projectId: string | null
  workspaces: WorkspaceListEntry[]
  /** The active project's groups, from the snapshot. */
  groups: WorkspaceGroupSummary[]
  provisioning: ProvisioningWorkspaceEntry[]
  /** The active project's queued workspaces, and the stopped workspaces
   *  they wait on. */
  queued?: QueuedWorkspaceEntry[]
  held?: HeldWorkspaceEntry[]
  /** The active project's draft workspaces. */
  drafts?: DraftWorkspaceEntry[]
}): JSX.Element {
  // Keeps stopping rows out of `rowIds`.
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  // For the empty-state text: there's no project rail on a phone.
  const isMobile = useIsMobile()
  const stopped = useStoppedWorkspaces(projectId, workspaces, provisioning)

  const layout = sidebarLayout(workspaces, groups, stopped, provisioning, queued, held)
  // So a stop from a row's menu can select the next row.
  const rowIds = sidebarRowIds(provisioning, workspaces, groups, pendingDeleteIds)
  const visibleCount = layout.defaultList.length + layout.defaultHeld.length + layout.orphans.length
    + layout.groups.reduce((n, s) => n + s.members.length + s.held.length + s.ghosts.length, 0)
  // Names of possible parents, for a queued row's discard dialog.
  const names = new Map<string, QueueParent>([
    ...provisioning.map((p) => [p.workspaceId, { name: p.title ?? 'New workspace', kind: 'live' }] as const),
    ...workspaces.map((w) => [w.workspaceId, { name: w.title || w.prompt || 'New workspace', kind: 'live' }] as const),
    ...held.map((h) => [h.workspaceId, { name: h.title || h.prompt || 'New workspace', kind: 'held' }] as const),
    ...queued.map((e) => [e.id, { name: queuedTitle(e), kind: 'queued' }] as const),
  ])
  // Which queued sets are expanded. Kept here so a set stays open when its
  // workspace moves between sections. Sets start collapsed, except the one
  // the user just queued into.
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
    // Open the set of the chain's top entry.
    let top = revealQueued.id
    for (let e = byId.get(top); e !== undefined; e = byId.get(e.parentQueuedId ?? '')) top = queuedParentId(e)
    setExpandedQueues((prev) => prev.has(top) ? prev : new Set([...prev, top]))
    useUiStore.getState().setRevealQueued(null)
  }, [revealQueued, queued])
  // Forget an emptied set so the next one starts collapsed.
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
  // On-screen drop zones by group id (null = the default list). Rects are
  // read on each move, so they are never stale.
  const zones = useRef(new Map<string | null, HTMLElement>())
  const zoneRef = (groupId: string | null) => (el: HTMLDivElement | null): void => {
    if (el) zones.current.set(groupId, el)
    else zones.current.delete(groupId)
  }
  const { drag, start } = usePressDrag<RowDrag, string | null>({
    over: (x, y) => {
      for (const [groupId, el] of zones.current) {
        const r = el.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return groupId
      }
      return undefined
    },
    onDrop: ({ item, over }) => {
      if (over === undefined || over === item.from) return
      // Not optimistic: the next snapshot moves the row. If the group was
      // deleted mid-drag the server answers NOT_FOUND.
      api.workspace['set-group'].$post({ json: { projectId: item.projectId, workspaceId: item.workspaceId, groupId: over } })
        .catch((e: unknown) => console.error('group move failed', e))
    },
  })
  // Mouse only, so touch can scroll; on touch the group dialog moves
  // workspaces.
  const rowDrag: SidebarDrag = {
    start: (e, workspace, onSelect) => {
      if (e.pointerType !== 'mouse') return
      start(e, {
        workspaceId: workspace.workspaceId,
        projectId: workspace.projectId,
        from: layout.groups.some((s) => s.group.groupId === workspace.groupId) ? workspace.groupId ?? null : null,
      }, onSelect)
    },
    activeId: drag?.item.workspaceId ?? null,
  }
  /** Whether a drop here would actually move the dragged workspace. */
  const dropTarget = (groupId: string | null): boolean =>
    drag !== null && drag.over === groupId && drag.over !== drag.item.from
  // The groups a row's dialog offers: those on screen, the same targets a
  // drag has.
  const shownGroups = layout.groups.map((s) => s.group)

  return (
    <QueueContext.Provider value={queueContext}>
      <div className="flex-1 overflow-y-auto py-1">
        {!projectId && (
          <EmptyState
            compact
            className="py-10"
            title="No project selected"
            description={isMobile
              ? 'Go back and pick a project.'
              : 'Pick a project from the rail on the left.'}
          />
        )}
        {projectId && visibleCount === 0 && provisioning.length === 0 && queued.length === 0
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

        {/* The default list is a drop zone that ungroups a workspace. While
            dragging, an empty list shows a placeholder to drop on. */}
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
          {drag !== null && layout.defaultList.length === 0 && (
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

        {projectId && <StoppedWorkspacesButton projectId={projectId} stopped={stopped} />}
      </div>
    </QueueContext.Provider>
  )
}

import { Fragment, useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { EmptyState } from '#components/ui/EmptyState'
import { agentLabel, workspaceModel } from '#lib/agentLabel'
import { api } from '#lib/api'
import { CloseIcon, LoadingIcon, SearchIcon } from '#lib/icons'
import { usePressDrag } from '#lib/usePressDrag'
import { shownGroups } from '#lib/groups'
import { queuedChildren, queuedParentId, queuedTitle } from '#lib/queued'
import { stoppedSectionCount, useStoppedWorkspaces } from '#lib/useStoppedWorkspaces'
import { useIsMobile } from '#lib/viewport'
import { useReadOnly, useViewedUserId, useWhoami } from '#lib/viewer'
import { useUiStore, type SidebarStatus } from '#lib/store'
import type {
  DraftWorkspaceEntry,
  HeldWorkspaceEntry,
  ProjectSummary,
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
  isTerminating,
  ProvisioningRow,
  StoppedWorkspaceRow,
  WorkspaceRow,
  type SidebarDrag,
} from '#components/sidebar/WorkspaceRows'
import { GroupSection } from '#components/sidebar/GroupSection'
import { StoppedSection } from '#components/sidebar/StoppedRows'
import { StatusFilterMenu } from '#components/sidebar/StatusFilterMenu'

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
   *  first, shown as stopped rows after the live ones. Other stopped members
   *  are the group's ghost rows, fetched by `GroupSection`. */
  held: StoppedWorkspaceEntry[]
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
 * member. A shown group can also list its other stopped members as ghost
 * rows (`GroupSection`). An unpinned group whose members have all stopped
 * disappears until one is restarted. A workspace whose group no longer
 * exists falls back to the default list.
 *
 * A held workspace (stopped, with queued workspaces waiting on it) keeps a
 * stopped row in its usual place and keeps its group shown, so its queue
 * stays visible. Each queued workspace nests under the row it waits on;
 * those without one go in `orphans`.
 */
export function sidebarLayout(
  workspaces: WorkspaceListEntry[],
  groups: WorkspaceGroupSummary[],
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
  const heldIds = new Set(shownHeld.map((h) => h.workspaceId))
  const heldRows = shownHeld.map(heldAsStopped).sort(byCreatedAt)
  // Provisioning rows keep the order they were started in (the caller sorts
  // them), so they don't move under the pointer.
  const sections = shownGroups(groups, [...workspaces, ...provisioning, ...shownHeld])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.groupId.localeCompare(a.groupId))
    .map((group) => ({
      group,
      provisioning: provisioning.filter((p) => filedIn(p) === group.groupId),
      members: live.filter((w) => filedIn(w) === group.groupId),
      held: heldRows.filter((d) => filedIn(d) === group.groupId),
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
  const layout = sidebarLayout(workspaces, groups, provisioning)
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

/**
 * How a group's section shows. `expanded` is what its panel renders with: a
 * search or status filter (`narrowed`) holds it open, a section of only
 * ghosts follows its "Show stopped workspaces" toggle, and any other follows
 * the user's collapse. It owns its ghost rows only while they are actually
 * on screen; the Stopped section lists them otherwise, so each stopped
 * workspace appears in one place.
 */
export function groupDisplay(
  section: Pick<SidebarGroupSection, 'provisioning' | 'members' | 'held'>,
  state: { collapsed: boolean; showStopped: boolean; narrowed: boolean },
): { onlyGhosts: boolean; expanded: boolean; ownsGhosts: boolean } {
  const onlyGhosts = section.provisioning.length + section.members.length + section.held.length === 0
  const expanded = state.narrowed || (onlyGhosts ? state.showStopped : !state.collapsed)
  return { onlyGhosts, expanded, ownsGhosts: !state.narrowed && expanded && state.showStopped }
}

/** The rows the sidebar search and status filter keep. */
export interface SearchableRows {
  workspaces: WorkspaceListEntry[]
  provisioning: ProvisioningWorkspaceEntry[]
  queued: QueuedWorkspaceEntry[]
  held: HeldWorkspaceEntry[]
  drafts: DraftWorkspaceEntry[]
}

/**
 * The rows a sidebar search and status filter keep: those whose title,
 * prompt or agent label holds the query, ignoring case, and whose status is
 * checked. A blank query or no checked status lets every row past that test.
 * A provisioning row counts as running and a held one as stopped. Drafts
 * have no status, so any filter hides them. Queued workspaces skip the
 * status test so they stay nested under a shown parent; while filtering, the
 * caller hides every orphan, since an orphan has no status either. Stopped
 * workspaces are searched by the server, since only their loaded pages are
 * here.
 */
export function narrowRows(
  query: string,
  statuses: readonly SidebarStatus[],
  rows: SearchableRows,
): SearchableRows {
  const q = query.trim().toLowerCase()
  if (!q && statuses.length === 0) return rows
  /** `status` undefined skips the status test; null fails any filter. */
  const keep = (status: SidebarStatus | null | undefined, ...texts: (string | undefined)[]): boolean =>
    (status === undefined || statuses.length === 0 || (status !== null && statuses.includes(status)))
    && (!q || texts.some((t) => t?.toLowerCase().includes(q)))
  return {
    workspaces: rows.workspaces.filter((w) => keep(w.status, w.title, w.prompt, agentLabel(w.tool, workspaceModel(w)))),
    provisioning: rows.provisioning.filter((p) => keep('running', p.title, p.prompt, agentLabel(p.tool, p))),
    queued: rows.queued.filter((e) => keep(undefined, queuedTitle(e), e.prompt, agentLabel(e.tool, undefined))),
    held: rows.held.filter((h) => keep('stopped', h.title, h.prompt, agentLabel(h.tool, undefined))),
    drafts: rows.drafts.filter((d) => keep(null, d.title, d.generatedTitle, d.prompt)),
  }
}

/** How long the search box waits after a keystroke before asking the
 *  server for matching stopped workspaces. */
const SEARCH_DEBOUNCE_MS = 200

/** A dragged row: the workspace and the group it started in (null for
 *  the default list). */
interface RowDrag {
  workspaceId: string
  projectId: string
  from: string | null
}


/**
 * The workspace list: a search box and status filter over the scrolling
 * rows, which are drafts, provisioning rows, ungrouped workspaces, group
 * sections and the Stopped section. It has no outer chrome, so the desktop
 * `Sidebar` and the mobile workspaces screen can each wrap it.
 *
 * A search filters the rows here and the stopped list on the server. A
 * search, or a filter including stopped, holds the Stopped section open; a
 * filter without stopped hides it. Either hides groups with no match,
 * pinned or not, and lists every stopped workspace in the Stopped section.
 * A workspace they hide stays selected.
 */
export function WorkspaceList({
  projectId,
  project,
  workspaces,
  groups,
  provisioning,
  queued = [],
  held = [],
  drafts = [],
}: {
  projectId: string | null
  /** The active project's stopped counts, from the snapshot. */
  project?: Pick<ProjectSummary, 'stoppedCount' | 'unseenDeaths'>
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
  const readOnly = useReadOnly()
  const viewedUserId = useViewedUserId()
  const viewedName = useWhoami()?.users.find((u) => u.id === viewedUserId)?.name ?? 'A teammate'
  const query = useUiStore((s) => s.sidebarQuery)
  const setQuery = useUiStore((s) => s.setSidebarQuery)
  const stoppedExpanded = useUiStore((s) => s.stoppedExpanded)
  const setStoppedExpanded = useUiStore((s) => s.setStoppedExpanded)
  const stoppedShownGroups = useUiStore((s) => s.stoppedShownGroups)
  const collapsedGroups = useUiStore((s) => s.collapsedGroups)
  const statuses = useUiStore((s) => s.sidebarStatuses)

  // The server search waits for a pause in typing.
  const [serverQuery, setServerQuery] = useState(query.trim())
  useEffect(() => {
    const t = setTimeout(() => setServerQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])
  const searching = query.trim() !== ''
  const filtering = statuses.length > 0
  const narrowed = searching || filtering
  const shown = narrowRows(query, statuses, { workspaces, provisioning, queued, held, drafts })
  const layout = sidebarLayout(shown.workspaces, groups, shown.provisioning, shown.queued, shown.held)
  const orphans = filtering ? [] : layout.orphans
  const sections = narrowed
    ? layout.groups.filter((s) => s.provisioning.length + s.members.length + s.held.length > 0)
    : layout.groups

  const owning = new Set(sections.filter((s) => groupDisplay(s, {
    collapsed: collapsedGroups.includes(s.group.groupId),
    showStopped: stoppedShownGroups.includes(s.group.groupId),
    narrowed,
  }).ownsGhosts).map((s) => s.group.groupId))
  // Stopped workspaces with a row elsewhere, held or restarting. The server
  // leaves them out of the stopped lists, so each total counts only what it
  // lists. Live ids are left out on this side too, where a just-stopped
  // workspace's optimistic entry waits for its live row to go.
  const elsewhere = [
    ...held.map((h) => h.workspaceId),
    ...provisioning.filter((p) => p.kind === 'restart').map((p) => p.workspaceId),
  ]
  const hidden = new Set([...workspaces.map((w) => w.workspaceId), ...elsewhere])
  const stoppedShown = !filtering || statuses.includes('stopped')
  const stoppedHeldOpen = searching || (filtering && stoppedShown)
  const stoppedOpen = stoppedShown && (stoppedExpanded || stoppedHeldOpen)
  const stopped = useStoppedWorkspaces(projectId, {
    ...(searching && serverQuery ? { q: serverQuery } : {}),
    excludeGroups: [...owning],
    exclude: elsewhere,
  }, {
    // A search waits for the typing to pause rather than listing everything.
    enabled: stoppedOpen && (!searching || serverQuery === query.trim()),
    version: [project?.stoppedCount ?? 0, ...groups.map((g) => g.stoppedCount)].join(','),
    hidden,
  })
  // The search box spins until the stopped list matches what was typed:
  // through the typing pause, then until the server's first page lands.
  const searchSettling = searching && stoppedOpen
    && (serverQuery !== query.trim() || stopped.settling)
  const stoppedCount = searching
    ? stopped.total ?? 0
    : stoppedSectionCount(project, groups, owning, held, provisioning)
  const ownedDeaths = groups.filter((g) => owning.has(g.groupId)).reduce((n, g) => n + g.unseenDeaths, 0)

  // So a stop from a row's menu can select the next row.
  const rowIds = sidebarRowIds(provisioning, workspaces, groups, pendingDeleteIds)
  // Every queued row nests under a counted row or is an orphan.
  const visibleCount = layout.defaultList.length + layout.defaultHeld.length + orphans.length
    + sections.reduce((n, s) => n + s.members.length + s.held.length, 0)
  const nothingLive = visibleCount === 0 && shown.provisioning.length === 0 && shown.drafts.length === 0
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
      if (e.pointerType !== 'mouse' || readOnly) return
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
      <div className="flex min-h-0 flex-1 flex-col">
        {projectId && (
          <div className="flex shrink-0 gap-1 px-2 pb-1">
            <div className="relative flex-1">
              {searchSettling ? (
                <LoadingIcon
                  size={13}
                  aria-label="Searching"
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 animate-spin text-text-faint"
                />
              ) : (
                <SearchIcon
                  size={13}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                />
              )}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape' || !query) return
                  e.stopPropagation()
                  setQuery('')
                }}
                placeholder="Search workspaces"
                aria-label="Search workspaces"
                className="w-full rounded-md border border-border bg-bg py-1.5 pl-8 pr-7 text-xs text-text
                  outline-none placeholder:text-text-faint focus:border-border-strong max-md:py-2.5 max-md:text-base"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  title="Clear search"
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center
                    rounded text-text-faint transition hover:bg-surface-2 hover:text-text"
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
            <StatusFilterMenu />
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-1">
          {readOnly && (
            <p className="mx-3 mb-1 rounded-md bg-surface-2 px-2.5 py-1.5 text-[11px] text-text-dim">
              {viewedName}&apos;s workspaces, read-only
            </p>
          )}
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
          {projectId && !narrowed && nothingLive && stoppedCount === 0 && (
            <EmptyState
              compact
              className="py-10"
              title="No workspaces yet"
              description={readOnly ? undefined : 'Start one with the + above.'}
            />
          )}
          {narrowed && nothingLive && !searchSettling && (!stoppedShown || stopped.total === 0) && (
            <EmptyState compact className="py-10" title="No matches" />
          )}
          {shown.drafts.length > 0 && <DraftsSection drafts={shown.drafts} />}
          {orphans.map((e) => (
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
                <StoppedWorkspaceRow entry={d} />
                <QueuedSet parentId={d.workspaceId} />
              </Fragment>
            ))}
            {drag !== null && layout.defaultList.length === 0 && (
              <p className="mx-2 rounded-lg border border-dashed border-border px-2.5 py-3 text-center text-xs text-text-faint">
                Ungrouped
              </p>
            )}
          </div>

          {sections.map((section) => (
            <GroupSection
              key={section.group.groupId}
              section={section}
              shownGroups={shownGroups}
              drag={rowDrag}
              rowIds={rowIds}
              dropTarget={dropTarget(section.group.groupId)}
              zoneRef={zoneRef(section.group.groupId)}
              narrowed={narrowed}
              elsewhere={elsewhere}
              hidden={hidden}
            />
          ))}

          {projectId && stoppedShown && (
            <StoppedSection
              projectId={projectId}
              count={stoppedCount}
              unseenDeaths={Math.max(0, (project?.unseenDeaths ?? 0) - ownedDeaths)}
              expanded={stoppedOpen}
              {...(stoppedHeldOpen ? {} : { onExpandedChange: setStoppedExpanded })}
              list={stopped}
            />
          )}
        </div>
      </div>
    </QueueContext.Provider>
  )
}

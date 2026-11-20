import { Fragment, useEffect, useRef, useState, type JSX } from 'react'
import clsx from 'clsx'
import { GitAuthFailureBadge } from '#components/GitAuthFailureBadge'
import { ImageBuildIndicator } from '#components/ImageBuildIndicator'
import { NewWorkspaceButton } from '#components/NewWorkspaceButton'
import { ServerBadge } from '#components/ServerBadge'
import { UsageBadge } from '#components/UsageBadge'
import { api } from '#lib/api'
import { usePressDrag } from '#lib/usePressDrag'
import { shownGroups } from '#lib/groups'
import { queuedChildren, queuedParentId, queuedTitle, roomKey } from '#lib/queued'
import { useStoppedEntry, useStoppedWorkspaces } from '#lib/useStoppedWorkspaces'
import { useIsMobile } from '#lib/viewport'
import { useSnapshot } from '#lib/useSnapshot'
import { useReadOnly, useViewedUserId, useWhoami } from '#lib/viewer'
import { unseenDeaths, useUiStore, type SidebarTab } from '#lib/store'
import type {
  DraftWorkspaceEntry,
  HeldWorkspaceEntry,
  ProjectSummary,
  StoppedWorkspaceEntry,
  ProvisioningWorkspaceEntry,
  QueuedWorkspaceEntry,
  RoutineEntry,
  SiteSummary,
  WorkflowSummary,
  WorkspaceGroupSummary,
  WorkspaceListEntry,
} from '@yaac/shared/types'
import {
  DraftsSection,
  QueueContext,
  QueuedRows,
  QueuedSet,
  QueuedWorkspaceRow,
  ScheduledSection,
  type QueueContextValue,
  type QueueParent,
} from '#components/sidebar/QueuedRows'
import { RoutineItem, SiteItem, WorkflowItem, type OwnedGroupProps } from '#components/sidebar/ObjectRows'
import { useSidebarTab } from '#components/sidebar/SidebarTabs'
import {
  isTerminating,
  ProvisioningRow,
  StoppedWorkspaceRow,
  WorkspaceRow,
  type SidebarDrag,
} from '#components/sidebar/WorkspaceRows'
import { GroupSection } from '#components/sidebar/GroupSection'
import { StoppedSection } from '#components/sidebar/StoppedRows'
import { YButton, YEmptyState } from '#ui'

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
  /** Queued workspaces with no parent, waiting for room in the group. */
  waiting: QueuedWorkspaceEntry[]
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
  /** Queued workspaces that start at a time, soonest first. A routine's
   *  runs are left to its own row. */
  scheduled: QueuedWorkspaceEntry[]
}

/** A held workspace as a stopped row. */
function heldAsStopped(h: HeldWorkspaceEntry): StoppedWorkspaceEntry {
  return {
    workspaceId: h.workspaceId,
    projectId: h.projectId,
    sessions: h.sessions,
    createdAt: h.stoppedAt,
    stoppedAt: h.stoppedAt,
    ...(h.prompt !== undefined ? { prompt: h.prompt } : {}),
    ...(h.title !== undefined ? { title: h.title } : {}),
    conversations: [],
    ...(h.deathReason !== undefined ? { deathReason: h.deathReason } : {}),
    ...(h.deathDetail !== undefined ? { deathDetail: h.deathDetail } : {}),
    ...(h.timedOut ? { timedOut: true } : {}),
    ...(h.endedAtNextRun ? { endedAtNextRun: true } : {}),
    deathSeenBy: h.deathSeenBy,
    ...(h.groupId !== undefined ? { groupId: h.groupId } : {}),
  }
}

/**
 * The active project's slice of the snapshot: what the workspace list and
 * its header show, on the desktop sidebar and the mobile workspaces screen.
 */
export interface ProjectScope {
  projectId: string | null
  project: ProjectSummary | undefined
  workspaces: WorkspaceListEntry[]
  groups: WorkspaceGroupSummary[]
  provisioning: ProvisioningWorkspaceEntry[]
  /** Queued workspaces, and the stopped workspaces they still wait on. */
  queued: QueuedWorkspaceEntry[]
  held: HeldWorkspaceEntry[]
  drafts: DraftWorkspaceEntry[]
  routines: RoutineEntry[]
  workflows: WorkflowSummary[]
  sites: SiteSummary[]
}

/**
 * The groups drawn under their owner's row rather than as sections of
 * their own: those a named workflow, routine or site of the list owns
 * (docs/workspace-groups.md "Owned groups"). One whose owner is gone is an
 * ordinary group again.
 */
export function ownedGroupIds(
  groups: WorkspaceGroupSummary[],
  owners: Pick<ProjectScope, 'workflows' | 'routines' | 'sites'>,
): Set<string> {
  const ids = { workflow: owners.workflows, routine: owners.routines, site: owners.sites }
  return new Set(groups.filter((g) => g.owner !== undefined && ids[g.owner.kind].some((o) => o.id === g.owner?.id))
    .map((g) => g.groupId))
}

/** The list header's title: the project's name, which opens its settings
 *  on the General page, or the app name with no project. Before the first
 *  snapshot frame lists the selected project, it shows nothing rather than
 *  the project's raw id. */
export function ListTitle({ scope }: { scope: ProjectScope }): JSX.Element | null {
  const { project } = scope
  if (!project) return scope.projectId ? null : <span className="font-semibold tracking-tight">yaac</span>
  const openProjectSettings = (): void => {
    const { openSettings, setSettingsProjectId } = useUiStore.getState()
    openSettings('project-general')
    setSettingsProjectId(project.id)
  }
  return (
    <YButton
      variant="bare"
      onClick={openProjectSettings}
      title="Project settings"
      className="-ml-2 min-w-0 truncate rounded-md px-2 py-1 font-semibold tracking-tight text-text transition hover:bg-hover"
    >
      {project.name}
    </YButton>
  )
}

/** The list header's actions: a reconnect notice and new workspace. */
export function ListActions({ projectId, connected }: { projectId: string | null; connected: boolean }): JSX.Element {
  return (
    <>
      {!connected && <span className="text-md text-warning max-md:pr-1">reconnecting…</span>}
      {projectId && <NewWorkspaceButton projectId={projectId} />}
    </>
  )
}

/** The status badges over the list, on one line: each listed project's git
 *  sign-in failures and image builds (on Home, one chit each for every
 *  project), plan usage, and the server. The error chits come first so they
 *  stay in view. When the row runs out of room the server's name truncates
 *  first, then the build and git-auth labels, down to their icons. The row
 *  renders empty when there are none, so `className` decides how an empty
 *  row looks. */
export function ListBadges({ projectIds, className }: { projectIds: string[]; className: string }): JSX.Element {
  const byProject = useSnapshot()?.gitAuthFailures ?? {}
  // One entry per host: two projects can share a rejected host.
  const failures = [...new Map(projectIds.flatMap((id) => byProject[id] ?? []).map((f) => [f.host, f])).values()]
  return (
    <div className={clsx('flex min-w-0 items-center gap-1.5 overflow-hidden', className)}>
      {failures.length > 0 && (
        <GitAuthFailureBadge projectIds={projectIds} failures={failures} iconSize={11} className="min-w-5 shrink hover:bg-danger/25" />
      )}
      <ImageBuildIndicator projectIds={projectIds} />
      <UsageBadge />
      <ServerBadge />
    </div>
  )
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
 * stays visible. Each queued workspace nests under the row it waits on, or
 * with no parent under its group's header, which it keeps shown; one that
 * starts at a time heads its chain in `scheduled`, and those waiting on no
 * row go in `orphans`.
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
  const parentless = queued.filter((e) => e.parentWorkspaceId === undefined && e.parentQueuedId === undefined
    && e.startAt === undefined)
  // Provisioning rows keep the order they were started in (the caller sorts
  // them), so they don't move under the pointer.
  const sections = shownGroups(groups, [...workspaces, ...provisioning, ...shownHeld, ...parentless])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.groupId.localeCompare(a.groupId))
    .map((group) => ({
      group,
      provisioning: provisioning.filter((p) => filedIn(p) === group.groupId),
      members: live.filter((w) => filedIn(w) === group.groupId),
      held: heldRows.filter((d) => filedIn(d) === group.groupId),
      waiting: parentless.filter((e) => filedIn(e) === group.groupId),
    }))
  const defaultHeld = heldRows.filter((d) => filedIn(d) === null)

  const onScreen = new Set([...liveIds, ...heldIds, ...sections.map((s) => roomKey(s.group.groupId))])
  const queuedIds = new Set(queued.map((e) => e.id))
  return {
    provisioning: provisioning.filter((p) => filedIn(p) === null),
    defaultList: live.filter((w) => filedIn(w) === null),
    defaultHeld,
    groups: sections,
    queuedChildren: queuedChildren(queued),
    orphans: queued.filter((e) => e.startAt === undefined && (e.parentQueuedId !== undefined
      ? !queuedIds.has(e.parentQueuedId)
      : e.orphaned === true || !onScreen.has(queuedParentId(e)))),
    scheduled: queued.filter((e) => e.startAt !== undefined && e.routineId === undefined)
      .sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? '')),
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
  owned: ReadonlySet<string> = new Set(),
): string[] {
  // Derived from the layout so it always matches what the Workspace tab
  // draws, where an owned group's runs are ungrouped rows.
  const layout = sidebarLayout(workspaces, groups.filter((g) => !owned.has(g.groupId)), provisioning)
  const selectable = (list: WorkspaceListEntry[]): string[] =>
    list.filter((w) => !isTerminating(w, pendingDeleteIds)).map((w) => w.workspaceId)
  return [
    ...layout.provisioning.map((p) => p.workspaceId),
    ...selectable(layout.defaultList),
    ...layout.groups.flatMap((s) => [...s.provisioning.map((p) => p.workspaceId), ...selectable(s.members)]),
  ]
}

/**
 * The tabs that list the selected workspace, or undefined while that is
 * not known yet. A live, held or provisioning workspace is on the Workspace
 * tab, and a run of a workflow, routine or site also on its owner's tab. A
 * stopped run is only under its owner; any other stopped workspace is in
 * the Workspace tab's Stopped section or its group. A provisioning row with
 * no agent and no group may be an owner's first run, whose group the server
 * is still creating, so it waits until it is listed.
 */
function tabsListing(
  scope: ProjectScope,
  id: string,
  stopped: StoppedWorkspaceEntry | undefined,
): SidebarTab[] | undefined {
  const owned = ownedGroupIds(scope.groups, scope)
  const ownerTab = (groupId: string | undefined): SidebarTab | undefined => {
    const kind = scope.groups.find((g) => g.groupId === groupId && owned.has(g.groupId))?.owner?.kind
    return kind === undefined ? undefined : kind === 'site' ? 'site' : 'workflow'
  }
  const prov = scope.provisioning.find((p) => p.workspaceId === id)
  const row = scope.workspaces.find((w) => w.workspaceId === id) ?? scope.held.find((h) => h.workspaceId === id)
    ?? (prov !== undefined && (prov.groupId !== undefined || prov.tool !== undefined) ? prov : undefined)
  if (row !== undefined) {
    const owner = ownerTab(row.groupId)
    return owner !== undefined ? ['workspace', owner] : ['workspace']
  }
  if (prov !== undefined || stopped === undefined) return undefined
  return [ownerTab(stopped.groupId) ?? 'workspace']
}

/**
 * Keep the sidebar on a tab that lists the selected workspace: whenever
 * the selection changes, or the tabs listing it do (a run stopping leaves
 * only its owner's tab), switch to one of them unless the open tab is one.
 * A tab the user picks is never undone while the selection stays put.
 * App runs this, so it follows selections made while the sidebar is
 * hidden, on Home, or from a link.
 */
export function useSidebarFollow(scope: ProjectScope, stopped: StoppedWorkspaceEntry | undefined): void {
  const selectedId = useUiStore((s) => s.selectedWorkspaceId)
  const listing = selectedId === null ? undefined : tabsListing(scope, selectedId, stopped)?.join(',')
  useEffect(() => {
    if (listing === undefined) return
    const tabs = listing.split(',') as SidebarTab[]
    const { sidebarTab, setSidebarTab } = useUiStore.getState()
    if (!tabs.includes(sidebarTab)) setSidebarTab(tabs[0])
  }, [selectedId, listing])
}

/**
 * How a group's section shows. `expanded` is what its panel renders with: a
 * section of only ghosts follows its "Show stopped workspaces" toggle, and
 * any other follows the user's collapse. It owns its ghost rows only while they are actually
 * on screen; the Stopped section lists them otherwise, so each stopped
 * workspace appears in one place.
 */
export function groupDisplay(
  section: Pick<SidebarGroupSection, 'provisioning' | 'members' | 'held' | 'waiting'>,
  state: { collapsed: boolean; showStopped: boolean },
): { onlyGhosts: boolean; expanded: boolean; ownsGhosts: boolean } {
  const onlyGhosts = section.provisioning.length + section.members.length + section.held.length
    + section.waiting.length === 0
  const expanded = onlyGhosts ? state.showStopped : !state.collapsed
  return { onlyGhosts, expanded, ownsGhosts: expanded && state.showStopped }
}

/** A dragged row: the workspace and the group it started in (null for
 *  the default list). */
interface RowDrag {
  workspaceId: string
  projectId: string
  from: string | null
}


/**
 * The workspace list, a scrolling column showing one of the sidebar's tabs
 * (`SidebarTabs`). The Workspace tab shows drafts, scheduled workspaces,
 * provisioning rows, ungrouped workspaces, group sections and the Stopped
 * section, with a workflow's, routine's or site's live runs among the
 * ungrouped rows. The Workflow tab shows every named workflow and routine,
 * and the Site tab every site, each with all its runs under its row. It has
 * no outer chrome, so the desktop `Sidebar` and the mobile workspaces
 * screen can each wrap it.
 */
export function WorkspaceList({
  projectId,
  project,
  workspaces,
  groups,
  provisioning,
  queued,
  held,
  drafts,
  routines,
  workflows,
  sites,
}: {
  projectId: string | null
  /** The active project's stopped counts, from the snapshot. */
  project?: Pick<ProjectSummary, 'stoppedCount' | 'deaths' | 'deathsSeenBy'>
  workspaces: WorkspaceListEntry[]
  /** The active project's groups, from the snapshot. */
  groups: WorkspaceGroupSummary[]
  provisioning: ProvisioningWorkspaceEntry[]
  /** The active project's queued workspaces, and the stopped workspaces
   *  they wait on. */
  queued: QueuedWorkspaceEntry[]
  held: HeldWorkspaceEntry[]
  /** The active project's draft workspaces. */
  drafts: DraftWorkspaceEntry[]
  routines: RoutineEntry[]
  workflows: WorkflowSummary[]
  sites: SiteSummary[]
}): JSX.Element {
  // Keeps stopping rows out of `rowIds`.
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  // For the empty-state text: there's no project rail on a phone.
  const isMobile = useIsMobile()
  const readOnly = useReadOnly()
  const viewedUserId = useViewedUserId()
  const whoami = useWhoami()
  const me = whoami?.userId
  const viewedName = whoami?.users.find((u) => u.id === viewedUserId)?.name ?? 'A teammate'
  const stoppedExpanded = useUiStore((s) => s.stoppedExpanded)
  const setStoppedExpanded = useUiStore((s) => s.setStoppedExpanded)
  const stoppedShownGroups = useUiStore((s) => s.stoppedShownGroups)
  const collapsedGroups = useUiStore((s) => s.collapsedGroups)
  const setGroupCollapsed = useUiStore((s) => s.setGroupCollapsed)
  const selectedId = useUiStore((s) => s.selectedWorkspaceId)
  const tab = useSidebarTab()

  // An owned group is laid out whatever it holds, since its owner's row is
  // always drawn and its stopped runs are its owner's history.
  const ownedIds = ownedGroupIds(groups, { workflows, routines, sites })
  const layout = sidebarLayout(workspaces, groups.map((g) => (ownedIds.has(g.groupId) ? { ...g, pinned: true } : g)),
    provisioning, queued, held)
  // The Workspace tab draws an owned group's runs as ungrouped rows, so it
  // is laid out without those groups. What waits for room in one is left to
  // its owner's tab.
  const loose = sidebarLayout(workspaces, groups.filter((g) => !ownedIds.has(g.groupId)), provisioning, queued, held)
  const looseOrphans = loose.orphans.filter((e) => e.parentWorkspaceId !== undefined || e.parentQueuedId !== undefined
    || !ownedIds.has(e.groupId ?? ''))
  const ownedSection = (kind: 'workflow' | 'routine' | 'site', id: string): SidebarGroupSection | undefined =>
    layout.groups.find((s) => s.group.owner?.kind === kind && s.group.owner.id === id && ownedIds.has(s.group.groupId))

  // An owned group's stopped runs are its owner's history, kept under its
  // row whether shown or not, so the Stopped section never lists them.
  const owning = new Set([...ownedIds, ...layout.groups.filter((s) => groupDisplay(s, {
    collapsed: collapsedGroups.includes(s.group.groupId),
    showStopped: stoppedShownGroups.includes(s.group.groupId),
  }).ownsGhosts).map((s) => s.group.groupId)])
  // Stopped workspaces with a row elsewhere, held or restarting. The server
  // leaves them out of the stopped lists, so each total counts only what it
  // lists. Live ids are left out on this side too, where a just-stopped
  // workspace's optimistic entry waits for its live row to go.
  const elsewhere = [
    ...held.map((h) => h.workspaceId),
    ...provisioning.filter((p) => p.kind === 'restart').map((p) => p.workspaceId),
  ]
  const hidden = new Set([...workspaces.map((w) => w.workspaceId), ...elsewhere])
  const stopped = useStoppedWorkspaces(projectId, { excludeGroups: [...owning], exclude: elsewhere }, {
    enabled: stoppedExpanded && tab === 'workspace',
    version: [project?.stoppedCount ?? 0, ...groups.map((g) => g.stoppedCount)].join(','),
    hidden,
  })
  // The snapshot's counts already leave out stops drawn as rows elsewhere.
  const owned = groups.filter((g) => owning.has(g.groupId))
  const stoppedCount = (project?.stoppedCount ?? 0) - owned.reduce((n, g) => n + g.stoppedCount, 0)
  const ownedDeaths = owned.reduce((n, g) => n + unseenDeaths(g, me), 0)

  // The open workspace, in whichever form it is listed. A plain stopped one
  // is looked up once the snapshot is in (`project`), under the same key App
  // uses, so this costs no fetch.
  const selectedLive = workspaces.find((w) => w.workspaceId === selectedId)
  const selectedProvisioning = provisioning.find((p) => p.workspaceId === selectedId)
  const selectedHeld = held.find((h) => h.workspaceId === selectedId)
  const selectedStopped = useStoppedEntry(projectId, selectedId, {
    enabled: project !== undefined && !selectedLive && !selectedProvisioning && !selectedHeld,
    version: String(project?.stoppedCount ?? 0),
  }).entry

  // Open the section holding the open workspace's row, its group or the
  // Stopped section, so the pane never shows a workspace whose row is folded
  // away (say one that stopped while another server was in view). This runs
  // when the row lands somewhere new, not on every render, so a section the
  // user collapses afterwards stays collapsed.
  const selectedRow = selectedLive ?? selectedProvisioning ?? selectedHeld
  const revealTarget = selectedRow?.groupId !== undefined ? `group:${selectedRow.groupId}`
    : selectedStopped?.groupId !== undefined && ownedIds.has(selectedStopped.groupId) ? `runs:${selectedStopped.groupId}`
    : selectedStopped && !owning.has(selectedStopped.groupId ?? '') ? 'stopped' : null
  const revealed = useRef<string | null>(null)
  const setGroupShowsStopped = useUiStore((s) => s.setGroupShowsStopped)
  useEffect(() => {
    const key = `${selectedId ?? ''} ${revealTarget ?? ''}`
    if (revealed.current === key) return
    revealed.current = key
    if (revealTarget === 'stopped') setStoppedExpanded(true)
    else if (revealTarget?.startsWith('runs:') === true) {
      // A stopped run of a workflow, routine or site shows among its
      // owner's stopped runs.
      const groupId = revealTarget.slice('runs:'.length)
      setGroupShowsStopped(groupId, true)
      setGroupCollapsed(groupId, false)
    } else if (revealTarget !== null) setGroupCollapsed(revealTarget.slice('group:'.length), false)
  }, [selectedId, revealTarget, setStoppedExpanded, setGroupCollapsed, setGroupShowsStopped])
  // A stopped selection the Stopped section lists, but on a page not loaded
  // yet, is pinned to the section's top until its page loads.
  const pinned = revealTarget === 'stopped' && stoppedExpanded && stopped.total !== undefined
    && !stopped.entries.some((e) => e.workspaceId === selectedId) ? selectedStopped : undefined
  const stoppedList = pinned ? { ...stopped, entries: [pinned, ...stopped.entries] } : stopped

  // So a stop from a row's menu can select the next row.
  const rowIds = sidebarRowIds(provisioning, workspaces, groups, pendingDeleteIds, ownedIds)
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
  const [dropNotice, setDropNotice] = useState<{ groupId: string; message: string } | null>(null)
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
      // Not optimistic: the next snapshot moves the row. A refusal (the
      // group deleted mid-drag, or at its workspace limit) shows under the
      // group's header for a few seconds.
      api.workspace.group.move.$post({ json: { projectId: item.projectId, workspaceId: item.workspaceId, group: over } })
        .catch((e: unknown) => {
          if (over === null) return
          const notice = { groupId: over, message: e instanceof Error ? e.message : String(e) }
          setDropNotice(notice)
          setTimeout(() => setDropNotice((cur) => cur === notice ? null : cur), 6000)
        })
    },
  })
  // Mouse only, so touch can scroll; on touch the group dialog moves
  // workspaces.
  // The groups on screen: drop targets, and what a row's dialog offers.
  const onScreen = (tab === 'workspace' ? loose : layout).groups
  const rowDrag: SidebarDrag = {
    start: (e, workspace, onSelect) => {
      if (e.pointerType !== 'mouse' || readOnly) return
      start(e, {
        workspaceId: workspace.workspaceId,
        projectId: workspace.projectId,
        from: onScreen.some((s) => s.group.groupId === workspace.groupId) ? workspace.groupId ?? null : null,
      }, onSelect)
    },
    activeId: drag?.item.workspaceId ?? null,
  }
  /** Whether a drop here would actually move the dragged workspace. */
  const dropTarget = (groupId: string | null): boolean =>
    drag !== null && drag.over === groupId && drag.over !== drag.item.from
  const shownGroups = onScreen.map((s) => s.group)
  /** The section props of an object's owned group, when it is laid out. */
  const groupProps = (kind: 'workflow' | 'routine' | 'site', id: string): OwnedGroupProps | undefined => {
    const section = ownedSection(kind, id)
    return section === undefined ? undefined : {
      section,
      shownGroups,
      drag: rowDrag,
      rowIds,
      dropTarget: dropTarget(section.group.groupId),
      zoneRef: zoneRef(section.group.groupId),
      elsewhere,
      hidden,
      ...(dropNotice?.groupId === section.group.groupId ? { notice: dropNotice.message } : {}),
    }
  }
  const empty = (title: string, description: string): JSX.Element => (
    <YEmptyState compact className="py-10" title={title} description={readOnly ? undefined : description} />
  )

  return (
    <QueueContext.Provider value={queueContext}>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {readOnly && (
          <p className="mx-3 mb-1 rounded-md bg-selected px-2.5 py-1.5 text-sm text-muted">
            {viewedName}&apos;s workspaces, read-only
          </p>
        )}
        {!projectId && (
          <YEmptyState
            compact
            className="py-10"
            title="No project selected"
            description={isMobile
              ? 'Go back and pick a project.'
              : 'Pick a project from the rail on the left.'}
          />
        )}
        {projectId && tab === 'workflow' && (workflows.length + routines.length === 0
          ? empty('No workflows yet', 'Make one from the Workflow tab of New workspace.')
          : <>
            {workflows.map((w) => <WorkflowItem key={w.id} workflow={w} group={groupProps('workflow', w.id)} />)}
            {routines.map((r) => <RoutineItem key={r.id} routine={r} group={groupProps('routine', r.id)} />)}
          </>)}
        {projectId && tab === 'site' && (sites.length === 0
          ? empty('No sites yet', 'Make one from the Site tab of New workspace.')
          : sites.map((st) => <SiteItem key={st.id} site={st} group={groupProps('site', st.id)} />))}
        {projectId && tab === 'workspace' && <>
          {!project?.stoppedCount && [...workspaces, ...provisioning, ...queued, ...held, ...drafts].length === 0
            && empty('No workspaces yet', 'Start one with New workspace above.')}
          {drafts.length > 0 && <DraftsSection drafts={drafts} />}
          {loose.scheduled.length > 0 && <ScheduledSection entries={loose.scheduled} />}
          {looseOrphans.map((e) => (
            <Fragment key={e.id}>
              <QueuedWorkspaceRow entry={e} depth={0} />
              <QueuedRows parentId={e.id} depth={1} />
            </Fragment>
          ))}
          {loose.provisioning.map((p) => (
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
            className={clsx('pb-1', dropTarget(null) && 'bg-selected/40 ring-1 ring-accent/40')}
          >
            {loose.defaultList.map((s) => (
              <Fragment key={s.workspaceId}>
                <WorkspaceRow workspace={s} shownGroups={shownGroups} drag={rowDrag} rowIds={rowIds} />
                <QueuedSet parentId={s.workspaceId} />
              </Fragment>
            ))}
            {loose.defaultHeld.map((d) => (
              <Fragment key={d.workspaceId}>
                <StoppedWorkspaceRow entry={d} />
                <QueuedSet parentId={d.workspaceId} />
              </Fragment>
            ))}
            {drag !== null && loose.defaultList.length === 0 && (
              <p className="mx-2 rounded-lg border border-dashed border-line-strong px-2.5 py-3 text-center text-md text-subtle">
                Ungrouped
              </p>
            )}
          </div>

          {loose.groups.map((section) => (
            <GroupSection
              key={section.group.groupId}
              section={section}
              shownGroups={shownGroups}
              drag={rowDrag}
              rowIds={rowIds}
              dropTarget={dropTarget(section.group.groupId)}
              zoneRef={zoneRef(section.group.groupId)}
              elsewhere={elsewhere}
              hidden={hidden}
              {...(dropNotice?.groupId === section.group.groupId ? { notice: dropNotice.message } : {})}
            />
          ))}

          <StoppedSection
            projectId={projectId}
            count={stoppedCount}
            unseenDeaths={Math.max(0, (project ? unseenDeaths(project, me) : 0) - ownedDeaths)}
            expanded={stoppedExpanded}
            onExpandedChange={setStoppedExpanded}
            list={stoppedList}
          />
        </>}
      </div>
    </QueueContext.Provider>
  )
}

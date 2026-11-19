import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { api } from './lib/api'
import { stopWorkspaceOptimistic } from './lib/stopWorkspaceFlow'
import { claimChord, cycleDeltaFor, matchShortcut, mergeBindings, resolveCycleTarget } from './lib/shortcuts'
import { deviceTimeZone } from './lib/time'
import { useEvents } from './lib/useEvents'
import { useSnapshot } from './lib/useSnapshot'
import { ownedBy, useReadOnly, useTeammateView, useViewedUserId, useWhoami, whoamiQuery } from './lib/viewer'
import {
  mergeProvisioning, persistSelection, resolveVacantSelection,
  unreadWaitingByProject, useUiStore,
} from './lib/store'
import { ProjectRail } from './components/ProjectRail'
import { ownedGroupIds, Sidebar, sidebarRowIds } from './components/Sidebar'
import type { ProjectScope } from './components/WorkspaceList'
import { useStoppedEntry } from './lib/useStoppedWorkspaces'
import { WorkspaceView } from './components/WorkspaceView'
import { ReadOnlyWorkspace, type ReadOnlySubject } from './components/ReadOnlyWorkspace'
import { MobileScreenLayer } from './components/mobile/MobileScreenLayer'
import { ProjectsScreen } from './components/mobile/ProjectsScreen'
import { WorkspacesScreen } from './components/mobile/WorkspacesScreen'
import { goBackScreen, useMobileHistory } from './lib/mobileHistory'
import { useIsMobile, useVisualViewportHeight } from './lib/viewport'
import { newlyWaiting, waitingKeys } from '@yaac/shared/waiting'
import { playChime } from './lib/sound'
import { hidesTitleBar } from './lib/platform'
import { LeaveNewWorkspaceDialog } from './components/NewWorkspacePane'
import { AddProjectDialog } from './components/NewProjectButton'
import { ProjectOpPane } from './components/ProjectOpPane'
import { mergeProjectOps } from './lib/projectOps'
import { WelcomePane } from './components/WelcomePane'
import { MobileHeader } from './components/mobile/MobileHeader'
import { StopWorkspaceDialog } from './components/StopWorkspaceDialog'
import { SettingsDialog } from './components/SettingsButton'
import { HomePage } from './components/home/HomePage'
import { homeListOrder, homeRows, projectActivity } from './components/home/homeRows'
import { CommandPalette } from './shell/CommandPalette'
import { YTrafficLights } from '#ui'
import { ShowSidebarButton } from '#components/PaneBar'
import type { WorkspaceListEntry } from '@yaac/shared/types'

function App(): JSX.Element {
  // The server identifies the caller from the request (loopback, or
  // tailscale serve's identity headers); a refusal carries its reason.
  const whoami = useQuery(whoamiQuery)
  const authed = whoami.isSuccess
  // Workspaces launch in the zone of the device last used.
  useEffect(() => {
    if (!authed) return
    api.config['time-zone'].$put({ json: { timeZone: deviceTimeZone() } })
      .catch((e: unknown) => console.error('reporting the time zone failed', e))
  }, [authed])

  // Hooks must run unconditionally; the WS only connects once authed.
  const { connected } = useEvents(authed)
  const snapshot = useSnapshot()

  // Chime when a workspace starts waiting for input. The first snapshot only
  // seeds the set, so workspaces already waiting on load stay silent. The
  // workspace the user is looking at (selected, window focused) never chimes,
  // and neither does a teammate's.
  const soundEnabled = useUiStore((s) => s.soundEnabled)
  const selectedWorkspaceId = useUiStore((s) => s.selectedWorkspaceId)
  const me = whoami.data?.userId
  const waitingSpells = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!snapshot || me === undefined) return
    const { workspaces } = ownedBy(snapshot, me)
    const current = waitingKeys(workspaces)
    if (waitingSpells.current === null) { waitingSpells.current = current; return }
    const fresh = newlyWaiting(waitingSpells.current, workspaces)
    waitingSpells.current = current
    const watching = document.hasFocus() ? selectedWorkspaceId : null
    if (soundEnabled && fresh.some((w) => w.workspaceId !== watching)) playChime()
  }, [snapshot, me, soundEnabled, selectedWorkspaceId])

  let content: JSX.Element
  if (whoami.isPending) content = <FullScreen>Loading…</FullScreen>
  else if (whoami.isError) {
    content = (
      <FullScreen>
        <div className="max-w-md px-8">
          <h1 className="text-lg font-semibold text-text">This server will not say who you are</h1>
          <p className="mt-3 text-base text-muted">{whoami.error.message}</p>
        </div>
      </FullScreen>
    )
  } else content = <Shell connected={connected} />

  // In the macOS desktop shell the title bar is hidden and the traffic
  // lights float over the UI. Full-screen states reserve a draggable bar
  // for them; the workspace layout leaves them room in its own bars
  // (YTrafficLights).
  return (
    <div className="flex h-full flex-col bg-shell">
      {hidesTitleBar() && !authed && <div className="titlebar-drag h-bar shrink-0" aria-hidden="true" />}
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  )
}

/*
 * Reads the snapshot from the store itself rather than taking App's as
 * a prop: a component that selects a project the moment the store lists it
 * (NewProjectButton) can re-render Shell before App has, and the fallback
 * below would then miss the project in a stale prop and switch back.
 *
 * Everything below the rail sees `snapshot`, the viewed user's part of the
 * server's (#lib/viewer); bookkeeping over every workspace reads `all`.
 */
function Shell({ connected }: { connected: boolean }): JSX.Element {
  const all = useSnapshot()
  const viewedUserId = useViewedUserId()
  const readOnly = useReadOnly()
  const teammateView = useTeammateView()
  const me = useWhoami()?.userId
  const snapshot = useMemo(
    () => (all && viewedUserId !== undefined ? ownedBy(all, viewedUserId) : all),
    [all, viewedUserId],
  )
  const activeProjectId = useUiStore((s) => s.activeProjectId)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const restoreActiveProject = useUiStore((s) => s.restoreActiveProject)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const optimisticProvisioning = useUiStore((s) => s.optimisticProvisioning)
  const claims = useUiStore((s) => s.claims)
  const inFlightProvisions = useUiStore((s) => s.inFlightProvisions)
  const forgetClaim = useUiStore((s) => s.forgetClaim)
  const selectedWorkspaceId = useUiStore((s) => s.selectedWorkspaceId)
  const autoSelectWorkspace = useUiStore((s) => s.autoSelectWorkspace)
  const lastWorkspaceOf = useUiStore((s) => s.lastWorkspaceOf)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const homeOpen = useUiStore((s) => s.homeOpen)
  const openHome = useUiStore((s) => s.openHome)
  const newWorkspaceForm = useUiStore((s) => s.newWorkspace)
  const selectedObject = useUiStore((s) => s.selectedObject)
  const mobileScreen = useUiStore((s) => s.mobileScreen)
  const syncChatDrafts = useUiStore((s) => s.syncChatDrafts)
  const projectOps = useUiStore((s) => s.projectOps)
  const settleProjectOps = useUiStore((s) => s.settleProjectOps)

  // Phone-sized: the three columns become three screens (docs/mobile-layout.md).
  const isMobile = useIsMobile()
  useVisualViewportHeight(isMobile)
  useMobileHistory(isMobile)

  const projects = snapshot?.projects ?? []
  const workspaces = snapshot?.workspaces ?? []
  // Server-tracked provisioning rows + local optimistic ones (snapshot wins).
  const provisioning = mergeProvisioning(snapshot?.provisioning ?? [], optimisticProvisioning)

  // Write the restored selection into the URL on first paint so a bare
  // reload still yields a shareable link. Later changes go through the store
  // subscription.
  useEffect(() => {
    const s = useUiStore.getState()
    persistSelection(s.activeProjectId, s.selectedWorkspaceId)
  }, [])

  // A layout effect, so a finished add never paints as both its pending chip
  // and the listed project. Settled against every user's projects, since a
  // teammate may be in view. A teammate's view shows no ops, since only
  // their owner can act on them.
  useLayoutEffect(() => {
    if (all) settleProjectOps(all.projects.map((p) => p.id))
  }, [all, projectOps, settleProjectOps])
  const ops = useMemo(
    () => (teammateView ? [] : mergeProjectOps(snapshot?.projectAdds ?? [], projectOps)),
    [teammateView, snapshot, projectOps],
  )
  const projectOp = ops.find((o) => o.id === activeProjectId)

  // An active project of another user's (a link, or a reload) switches to
  // viewing that user. An active project that is no id here may be a link
  // naming the project instead; else the selected workspace says which
  // project it is in. Failing all, fall back to the first project, with
  // restoreActiveProject because the user did not choose it, so on mobile it
  // must not navigate into the project. With no projects at all, the
  // selection is cleared and mobile goes back to the project list, where
  // the welcome pane is. A pending add is selectable before it is listed.
  useEffect(() => {
    const owner = all?.projects.find((p) => p.id === activeProjectId)?.owner
    if (owner !== undefined && owner !== viewedUserId) {
      useUiStore.setState({ viewedUserId: owner })
      return
    }
    if (!snapshot || projectOp) return
    if (projects.length === 0) {
      if (activeProjectId !== null) {
        useUiStore.setState({ activeProjectId: null, selectedWorkspaceId: null, mobileScreen: 'projects' })
      }
      return
    }
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) return
    const { selectedWorkspaceId } = useUiStore.getState()
    const found = projects.find((p) => p.name === activeProjectId)?.id
      ?? workspaces.find((w) => w.workspaceId === selectedWorkspaceId)?.projectId
    if (found !== undefined) useUiStore.setState({ activeProjectId: found })
    else restoreActiveProject(projects[0].id)
  }, [all, snapshot, viewedUserId, activeProjectId, projectOp, projects, workspaces, restoreActiveProject])

  const inProject = <T extends { projectId: string }>(rows: T[] | undefined): T[] =>
    (rows ?? []).filter((r) => r.projectId === activeProjectId)
  const activeProject = projects.find((p) => p.id === activeProjectId)
  const scope: ProjectScope = {
    projectId: activeProjectId,
    project: activeProject,
    workspaces: inProject(workspaces),
    groups: inProject(snapshot?.workspaceGroups),
    provisioning: inProject(provisioning),
    queued: inProject(snapshot?.queuedWorkspaces),
    held: inProject(snapshot?.heldWorkspaces),
    drafts: inProject(snapshot?.draftWorkspaces),
    routines: inProject(snapshot?.routines),
    workflows: inProject(snapshot?.workflows),
    sites: inProject(snapshot?.sites),
  }

  // Project-scoped shortcuts (next/prev workspace, new, stop). They listen
  // on window in the capture phase so xterm never forwards the chord to the
  // PTY, and live here rather than in Sidebar so they work with the sidebar
  // hidden. Terminal-scoped shortcuts belong to WorkspaceView. The ref lets
  // the one listener read the current render's state.
  const owned = ownedGroupIds(scope.groups, scope)
  const rowIds = sidebarRowIds(scope.provisioning, scope.workspaces, scope.groups, pendingDeleteIds, owned)
  const allHomeRows = homeRows(workspaces, provisioning, me, pendingDeleteIds, snapshot?.startedAtMs)
  // On Home the cycle steps through Home's list, across projects.
  const cycleRows = homeOpen ? homeListOrder(allHomeRows) : null
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
  const newWorkspace = (): void => {
    if (activeProjectId && !readOnly) openNewWorkspace({ projectId: activeProjectId })
  }
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceListEntry | null>(null)
  const selectedWorkspace = selectedWorkspaceId && !readOnly && !pendingDeleteIds.includes(selectedWorkspaceId)
    ? workspaces.find((s) => s.workspaceId === selectedWorkspaceId && !s.stopping) ?? null
    : null
  const shortcutCtx = useRef({ rowIds, cycleRows, selectedWorkspaceId, selectedWorkspace, newWorkspace })
  shortcutCtx.current = { rowIds, cycleRows, selectedWorkspaceId, selectedWorkspace, newWorkspace }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const ctx = shortcutCtx.current
      const state = useUiStore.getState()
      if (state.recordingShortcut) return
      const id = matchShortcut(state.bindings, e)
      switch (id) {
        case 'command-palette':
          claimChord(e)
          state.setPaletteOpen(!state.paletteOpen)
          return
        case 'new-workspace':
          claimChord(e)
          ctx.newWorkspace()
          return
        case 'delete-workspace':
          // A site's release is stopped only through its site.
          if (!ctx.selectedWorkspace || ctx.selectedWorkspace.site !== undefined) return
          claimChord(e)
          setConfirmDelete(ctx.selectedWorkspace)
          return
        case 'prev-workspace':
        case 'next-workspace': {
          const delta = cycleDeltaFor(id)
          if (delta === null) return
          const ids = ctx.cycleRows ? ctx.cycleRows.map((r) => r.id) : ctx.rowIds
          const next = resolveCycleTarget(ids, ctx.selectedWorkspaceId ?? undefined, delta)
          if (!next) return
          claimChord(e)
          const homeRow = ctx.cycleRows?.find((r) => r.id === next)
          if (homeRow) useUiStore.getState().selectHomeWorkspace(homeRow.projectId, next)
          else useUiStore.getState().selectWorkspace(next)
          return
        }
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  // Load saved shortcut overrides; the defaults apply until then, or on error.
  useEffect(() => {
    api.shortcuts.get.$get()
      .then(({ overrides }) => useUiStore.getState().setBindings(mergeBindings(overrides)))
      .catch((e: unknown) => console.error('loading shortcut overrides failed', e))
  }, [])

  // A selection that is neither live nor provisioning may be a stopped
  // workspace, which the pane shows read-only. Looked up once the snapshot
  // says it is not live.
  const live = selectedWorkspaceId !== null && (workspaces.some((w) => w.workspaceId === selectedWorkspaceId)
    || provisioning.some((p) => p.workspaceId === selectedWorkspaceId))
  const stoppedSelection = useStoppedEntry(activeProjectId, selectedWorkspaceId, {
    enabled: snapshot !== undefined && !live,
    version: String(activeProject?.stoppedCount ?? 0),
  })
  const stoppedEntry = stoppedSelection.entry

  // Fill the pane when the project changed or the open workspace vanished
  // (see resolveVacantSelection): with the project's last open workspace, or
  // else the top row. `rowIds` is in sidebar order, so "the top row" is the
  // one the user sees first. autoSelectWorkspace, not
  // selectWorkspace, so mobile fills the pane without navigating onto it. A
  // layout effect so the pane never paints empty during a hand-off.
  const lastProjectId = useRef(activeProjectId)
  useLayoutEffect(() => {
    const previousProjectId = lastProjectId.current
    lastProjectId.current = activeProjectId
    // Home's pane is its inbox until the user picks a session.
    if (homeOpen) return
    const pick = resolveVacantSelection({
      previousProjectId,
      activeProjectId,
      selectedWorkspaceId,
      rowIds,
      stopped: stoppedEntry !== undefined || stoppedSelection.pending,
      claims,
      inFlight: inFlightProvisions,
      remembered: activeProjectId ? lastWorkspaceOf[activeProjectId] : undefined,
    })
    if (!pick) return
    if (selectedWorkspaceId !== null && claims[selectedWorkspaceId] === pick) forgetClaim(selectedWorkspaceId)
    autoSelectWorkspace(pick)
  }, [homeOpen, activeProjectId, rowIds, stoppedEntry, stoppedSelection.pending, selectedWorkspaceId, claims, inFlightProvisions, lastWorkspaceOf, forgetClaim, autoSelectWorkspace])
  // Drop chat drafts for workspaces that no longer exist (same first-snapshot
  // guard as above). Provisioning ids count as live because a restarting
  // workspace leaves the workspace list and returns with the same id.
  useEffect(() => {
    if (!all) return
    syncChatDrafts([
      ...all.workspaces.map((s) => s.workspaceId),
      ...mergeProvisioning(all.provisioning, optimisticProvisioning).map((p) => p.workspaceId),
    ])
  }, [all, optimisticProvisioning, syncChatDrafts])

  const attention = unreadWaitingByProject(workspaces, me, pendingDeleteIds)
  const activity = useMemo(() => projectActivity(projects, workspaces, provisioning, me), [projects, workspaces, provisioning, me])
  const home = homeOpen ? { rows: allHomeRows, projects } : undefined
  // Home's pane shows its inbox while nothing else is open in it.
  const homePage = home !== undefined && selectedWorkspaceId === null && newWorkspaceForm === null && selectedObject === null

  // What replaces the sidebar and pane when there is no project to show.
  const placeholder = projectOp
    ? <ProjectOpPane op={projectOp} />
    : snapshot && projects.length === 0 && !readOnly ? <WelcomePane /> : null
  const rail = (
    <ProjectRail
      projects={projects}
      ops={ops}
      activeProjectId={activeProjectId}
      attentionByProject={attention}
      tiles={activity}
      homeActive={homeOpen}
      onHome={openHome}
      onSelect={setActiveProject}
    />
  )

  return (
    // Desktop: rail and sidebar beside an inset workspace card. Mobile: three
    // stacked full-screen layers, one visible at a time. The pane wrapper
    // stays the same <div> in both, so WorkspaceView and its terminals stay
    // mounted when a phone rotates across the breakpoint. On desktop a
    // placeholder (welcome, or a project being added or removed) takes the
    // place of both sidebar and pane.
    <div className={clsx('bg-shell safe-area-inset', isMobile
      ? 'relative h-full overflow-hidden'
      : 'flex h-full')}
    >
      {isMobile ? (
        <MobileScreenLayer active={mobileScreen === 'projects'}>
          <ProjectsScreen
            projects={projects}
            ops={ops}
            activeProjectId={activeProjectId}
            attentionByProject={attention}
            tiles={activity}
            connected={connected}
            onHome={openHome}
            onSelect={setActiveProject}
          />
        </MobileScreenLayer>
      ) : placeholder ? (
        // Room above the rail for the traffic lights.
        <div className="flex shrink-0 flex-col">
          {hidesTitleBar() && <div aria-hidden className="titlebar-drag h-bar shrink-0" />}
          <div className="flex min-h-0 flex-1">{rail}</div>
        </div>
      ) : !sidebarOpen && (
        // The pane's top bar carries on over the rail, holding the button
        // that shows the sidebar, or the traffic lights in the macOS
        // desktop app (PaneBarLeading).
        <div className="flex shrink-0 flex-col">
          <div className="titlebar-drag flex h-bar shrink-0 items-center justify-center border-b border-line bg-surface">
            {!hidesTitleBar() && <span className="no-drag"><ShowSidebarButton /></span>}
          </div>
          <div className="flex min-h-0 flex-1">{rail}</div>
        </div>
      )}

      {isMobile ? (
        <MobileScreenLayer active={mobileScreen === 'workspaces'}>
          {projectOp ? (
            <>
              <MobileHeader onBack={goBackScreen} backLabel="Back to projects" title={projectOp.name} />
              <ProjectOpPane op={projectOp} />
            </>
          ) : (
            <WorkspacesScreen scope={scope} connected={connected} onBack={goBackScreen} {...(home ? { home } : {})} />
          )}
        </MobileScreenLayer>
      ) : placeholder ? (
        <div className="flex min-w-0 flex-1 flex-col bg-surface">
          {/* The bar the hidden sidebar's header would be, for the traffic lights. */}
          <YTrafficLights className="h-bar w-full" />
          {placeholder}
        </div>
      ) : sidebarOpen && (
        <Sidebar scope={scope} connected={connected} rail={rail} {...(home ? { home } : {})} />
      )}

      {(isMobile || !placeholder) && <div
        inert={isMobile && mobileScreen !== 'pane'}
        className={clsx(isMobile
          ? ['absolute inset-0', mobileScreen !== 'pane' && 'invisible pointer-events-none']
          : 'min-w-0 flex-1 bg-surface')}
      >
        {/* A stopped workspace covers the workspace view rather than
            replacing it, so its terminals stay mounted and laid out. */}
        {readOnly && !stoppedEntry ? (
          <ReadOnlyWorkspace subject={liveSubject(workspaces, selectedWorkspaceId)} />
        ) : (
          <div className="relative h-full">
            {!readOnly && (
              <div inert={stoppedEntry !== undefined || homePage} className={clsx('h-full', (stoppedEntry || homePage) && 'invisible')}>
                <WorkspaceView snapshot={snapshot} provisioning={home ? provisioning : scope.provisioning} />
              </div>
            )}
            {homePage && home && (
              <div className="absolute inset-0">
                <HomePage rows={home.rows} projects={projects} activity={activity} waitingByProject={attention} />
              </div>
            )}
            {stoppedEntry && (
              <div className="absolute inset-0">
                <ReadOnlyWorkspace subject={{ kind: 'stopped', entry: stoppedEntry }} />
              </div>
            )}
          </div>
        )}
      </div>}

      {/* Confirm for the delete-workspace shortcut. */}
      <StopWorkspaceDialog
        workspace={confirmDelete}
        onOpenChange={(next) => { if (!next) setConfirmDelete(null) }}
        onConfirm={() => {
          if (confirmDelete) stopWorkspaceOptimistic(confirmDelete, rowIds)
          setConfirmDelete(null)
        }}
      />
      <LeaveNewWorkspaceDialog />
      <AddProjectDialog />
      <SettingsDialog />
      <CommandPalette scope={scope} rows={allHomeRows} projects={projects} />
    </div>
  )
}

/** A teammate's selected running workspace, for the read-only pane. */
function liveSubject(workspaces: WorkspaceListEntry[], selectedId: string | null): ReadOnlySubject | undefined {
  const entry = workspaces.find((w) => w.workspaceId === selectedId)
  return entry && { kind: 'live', entry }
}

function FullScreen({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-sunken text-subtle">
      {children}
    </div>
  )
}

export default App

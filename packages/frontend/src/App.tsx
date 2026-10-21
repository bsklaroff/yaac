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
  isUnreadWaiting, mergeProvisioning, persistSelection, resolveVacantSelection,
  unreadWaitingByProject, useUiStore,
} from './lib/store'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar, sidebarRowIds } from './components/Sidebar'
import { narrowRows, type ProjectScope } from './components/WorkspaceList'
import { useStoppedEntry } from './lib/useStoppedWorkspaces'
import { WorkspaceView } from './components/WorkspaceView'
import { ReadOnlyWorkspace, type ReadOnlySubject } from './components/ReadOnlyWorkspace'
import { MobileScreenLayer } from './components/mobile/MobileScreenLayer'
import { ProjectsScreen } from './components/mobile/ProjectsScreen'
import { WorkspacesScreen } from './components/mobile/WorkspacesScreen'
import { goBackScreen, useMobileHistory } from './lib/mobileHistory'
import { useIsMobile, useVisualViewportHeight } from './lib/viewport'
import { newlyWaiting, waitingKey, waitingKeys } from '@yaac/shared/waiting'
import { playChime } from './lib/sound'
import { isElectron } from './lib/platform'
import { LeaveNewWorkspaceDialog } from './components/NewWorkspacePane'
import { AddProjectDialog } from './components/NewProjectButton'
import { ProjectOpPane } from './components/ProjectOpPane'
import { WelcomePane } from './components/WelcomePane'
import { MobileHeader } from './components/mobile/MobileHeader'
import { StopWorkspaceDialog } from './components/StopWorkspaceDialog'
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
          <p className="mt-3 text-sm text-text-dim">{whoami.error.message}</p>
        </div>
      </FullScreen>
    )
  } else content = <Shell connected={connected} />

  // In Electron the title bar is hidden and the window controls float over
  // the UI. Full-screen states reserve a draggable strip for them; the
  // workspace layout provides its own drag regions and clearance instead.
  return (
    <div className="flex h-full flex-col bg-shell">
      {isElectron() && !authed && <div className="titlebar-drag h-7 shrink-0" aria-hidden="true" />}
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
  const mobileScreen = useUiStore((s) => s.mobileScreen)
  const markWaitingSeen = useUiStore((s) => s.markWaitingSeen)
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
  // teammate may be in view. Ops are the caller's own, so a teammate's view
  // shows none.
  useLayoutEffect(() => {
    if (all) settleProjectOps(all.projects.map((p) => p.id))
  }, [all, projectOps, settleProjectOps])
  const ops = teammateView ? [] : projectOps
  const projectOp = ops.find((o) => o.id === activeProjectId)

  // An active project of another user's (a link, or a reload) switches to
  // viewing that user. An active project that is no id here may be a link
  // naming the project instead; else the selected workspace says which
  // project it is in. Failing all, fall back to the first project, with
  // restoreActiveProject because the user did not choose it, so on mobile it
  // must not navigate into the project. A pending add is selectable before
  // it is listed.
  useEffect(() => {
    const owner = all?.projects.find((p) => p.id === activeProjectId)?.owner
    if (owner !== undefined && owner !== viewedUserId) {
      useUiStore.setState({ viewedUserId: owner })
      return
    }
    if (projects.length === 0 || projectOp) return
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) return
    const { selectedWorkspaceId } = useUiStore.getState()
    const found = projects.find((p) => p.name === activeProjectId)?.id
      ?? workspaces.find((w) => w.workspaceId === selectedWorkspaceId)?.projectId
    if (found !== undefined) useUiStore.setState({ activeProjectId: found })
    else restoreActiveProject(projects[0].id)
  }, [all, viewedUserId, activeProjectId, projectOp, projects, workspaces, restoreActiveProject])

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
    gitAuthFailures: (activeProjectId && snapshot?.gitAuthFailures?.[activeProjectId]) || [],
  }

  // Project-scoped shortcuts (next/prev workspace, new, stop). They listen
  // on window in the capture phase so xterm never forwards the chord to the
  // PTY, and live here rather than in Sidebar so they work with the sidebar
  // hidden. Terminal-scoped shortcuts belong to WorkspaceView. The ref lets
  // the one listener read the current render's state.
  const rowIds = sidebarRowIds(scope.provisioning, scope.workspaces, scope.groups, pendingDeleteIds)
  // The cycle steps through the rows the sidebar search and status filter
  // leave on screen.
  const sidebarQuery = useUiStore((s) => s.sidebarQuery)
  const sidebarStatuses = useUiStore((s) => s.sidebarStatuses)
  const searched = narrowRows(sidebarQuery, sidebarStatuses, {
    workspaces: scope.workspaces, provisioning: scope.provisioning, queued: [], held: [], drafts: [],
  })
  const cycleIds = sidebarRowIds(searched.provisioning, searched.workspaces, scope.groups, pendingDeleteIds)
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
  const newWorkspace = (): void => {
    if (activeProjectId && !readOnly) openNewWorkspace({ projectId: activeProjectId })
  }
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceListEntry | null>(null)
  const selectedWorkspace = selectedWorkspaceId && !readOnly && !pendingDeleteIds.includes(selectedWorkspaceId)
    ? workspaces.find((s) => s.workspaceId === selectedWorkspaceId && !s.stopping) ?? null
    : null
  const shortcutCtx = useRef({ cycleIds, selectedWorkspaceId, selectedWorkspace, newWorkspace })
  shortcutCtx.current = { cycleIds, selectedWorkspaceId, selectedWorkspace, newWorkspace }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const ctx = shortcutCtx.current
      const state = useUiStore.getState()
      if (state.recordingShortcut) return
      const id = matchShortcut(state.bindings, e)
      switch (id) {
        case 'new-workspace':
          claimChord(e)
          ctx.newWorkspace()
          return
        case 'delete-workspace':
          if (!ctx.selectedWorkspace) return
          claimChord(e)
          setConfirmDelete(ctx.selectedWorkspace)
          return
        case 'prev-workspace':
        case 'next-workspace': {
          const delta = cycleDeltaFor(id)
          if (delta === null) return
          const next = resolveCycleTarget(ctx.cycleIds, ctx.selectedWorkspaceId ?? undefined, delta)
          if (!next) return
          claimChord(e)
          useUiStore.getState().selectWorkspace(next)
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
  }, [activeProjectId, rowIds, stoppedEntry, stoppedSelection.pending, selectedWorkspaceId, claims, inFlightProvisions, lastWorkspaceOf, forgetClaim, autoSelectWorkspace])
  // Viewing a waiting workspace marks its spell read by the caller on the
  // server, whether it was selected while waiting or started waiting while
  // open. A teammate's workspace is marked too, since each user has their
  // own dot. A spell whose mark failed or was refused (it had already
  // ended) is not sent again this page load, so a write whose next snapshot
  // shows it unread cannot loop; one the server accepted may be re-marked.
  const markingSpells = useRef(new Set<string>())
  useEffect(() => {
    if (!selectedWorkspaceId || me === undefined) return
    const open = workspaces.find((s) => s.workspaceId === selectedWorkspaceId)
    if (!open || !isUnreadWaiting(open, me)) return
    const spell = waitingKey(open)
    if (markingSpells.current.has(spell)) return
    markingSpells.current.add(spell)
    markWaitingSeen(open.workspaceId, me)
    void api.workspace['mark-waiting-seen'].$post({
      json: { projectId: open.projectId, workspaceId: open.workspaceId, waitingSinceMs: open.waitingSinceMs ?? 0 },
    }).then(({ marked }) => {
      if (marked) markingSpells.current.delete(spell)
    }).catch(() => {})
  }, [selectedWorkspaceId, me, workspaces, markWaitingSeen])

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

  // What replaces the sidebar and pane when there is no project to show.
  const placeholder = projectOp
    ? <ProjectOpPane op={projectOp} />
    : snapshot && projects.length === 0 && !readOnly ? <WelcomePane /> : null

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
            connected={connected}
            onSelect={setActiveProject}
          />
        </MobileScreenLayer>
      ) : (
        <ProjectRail
          projects={projects}
          ops={ops}
          activeProjectId={activeProjectId}
          attentionByProject={attention}
          onSelect={setActiveProject}
        />
      )}

      {isMobile ? (
        <MobileScreenLayer active={mobileScreen === 'workspaces'}>
          {projectOp ? (
            <>
              <MobileHeader onBack={goBackScreen} backLabel="Back to projects" title={projectOp.name} />
              <ProjectOpPane op={projectOp} />
            </>
          ) : (
            <WorkspacesScreen scope={scope} connected={connected} onBack={goBackScreen} />
          )}
        </MobileScreenLayer>
      ) : placeholder ? (
        <div className="m-2 flex min-w-0 flex-1 flex-col rounded-lg border border-hairline bg-surface">
          {placeholder}
        </div>
      ) : sidebarOpen && (
        <Sidebar scope={scope} connected={connected} />
      )}

      {(isMobile || !placeholder) && <div
        inert={isMobile && mobileScreen !== 'pane'}
        className={clsx(isMobile
          ? ['absolute inset-0', mobileScreen !== 'pane' && 'invisible pointer-events-none']
          : 'min-w-0 flex-1 p-2')}
      >
        {/* A stopped workspace covers the workspace view rather than
            replacing it, so its terminals stay mounted and laid out. */}
        {readOnly && !stoppedEntry ? (
          <ReadOnlyWorkspace subject={liveSubject(workspaces, selectedWorkspaceId)} />
        ) : (
          <div className="relative h-full">
            {!readOnly && (
              <div inert={stoppedEntry !== undefined} className={clsx('h-full', stoppedEntry && 'invisible')}>
                <WorkspaceView snapshot={snapshot} provisioning={scope.provisioning} />
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
    <div className="flex h-full items-center justify-center bg-bg text-text-faint">
      {children}
    </div>
  )
}

export default App

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { api } from './lib/api'
import { stopWorkspaceOptimistic } from './lib/stopWorkspaceFlow'
import { claimChord, cycleDeltaFor, matchShortcut, mergeBindings, resolveCycleTarget } from './lib/shortcuts'
import { deviceTimeZone } from './lib/time'
import { useEvents } from './lib/useEvents'
import { useSnapshot } from './lib/useSnapshot'
import { ownedBy, useReadOnly, useViewedUserId, whoamiQuery } from './lib/viewer'
import {
  mergeProvisioning, persistSelection, resolveVacantSelection,
  shortcutsSuspended, unreadWaitingByProject, useUiStore,
} from './lib/store'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar, sidebarRowIds } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { ReadOnlyWorkspace } from './components/ReadOnlyWorkspace'
import { MobileScreenLayer } from './components/mobile/MobileScreenLayer'
import { ProjectsScreen } from './components/mobile/ProjectsScreen'
import { WorkspacesScreen } from './components/mobile/WorkspacesScreen'
import { goBackScreen, useMobileHistory } from './lib/mobileHistory'
import { useIsMobile, useVisualViewportHeight } from './lib/viewport'
import { newlyWaiting, waitingKeys } from '@yaac/shared/waiting'
import { playChime } from './lib/sound'
import { isElectron } from './lib/platform'
import { CreateWorkspaceDialog } from './components/CreateWorkspaceDialog'
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
    const watching = typeof document !== 'undefined' && document.hasFocus() ? selectedWorkspaceId : null
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
 * Reads the snapshot from the query cache itself rather than taking App's as
 * a prop: a component that selects a project the moment the cache lists it
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
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const mobileScreen = useUiStore((s) => s.mobileScreen)
  const readWaiting = useUiStore((s) => s.readWaiting)
  const markWaitingRead = useUiStore((s) => s.markWaitingRead)
  const syncWaitingRead = useUiStore((s) => s.syncWaitingRead)
  const syncChatDrafts = useUiStore((s) => s.syncChatDrafts)

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

  // An active project of another user's (a link, or a reload) switches to
  // viewing that user. An active project that is no id here may be a link
  // naming the project instead; else the selected workspace says which
  // project it is in. Failing all, fall back to the first project, with
  // restoreActiveProject because the user did not choose it, so on mobile it
  // must not navigate into the project.
  useEffect(() => {
    const owner = all?.projects.find((p) => p.id === activeProjectId)?.owner
    if (owner !== undefined && owner !== viewedUserId) {
      useUiStore.setState({ viewedUserId: owner })
      return
    }
    if (projects.length === 0) return
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) return
    const { selectedWorkspaceId } = useUiStore.getState()
    const found = projects.find((p) => p.name === activeProjectId)?.id
      ?? workspaces.find((w) => w.workspaceId === selectedWorkspaceId)?.projectId
    if (found !== undefined) useUiStore.setState({ activeProjectId: found })
    else restoreActiveProject(projects[0].id)
  }, [all, viewedUserId, activeProjectId, projects, workspaces, restoreActiveProject])

  const scoped = workspaces.filter((s) => s.projectId === activeProjectId)
  const scopedProvisioning = provisioning.filter((p) => p.projectId === activeProjectId)
  const scopedGroups = (snapshot?.workspaceGroups ?? [])
    .filter((g) => g.projectId === activeProjectId)
  const scopedQueued = (snapshot?.queuedWorkspaces ?? []).filter((e) => e.projectId === activeProjectId)
  const scopedHeld = (snapshot?.heldWorkspaces ?? []).filter((h) => h.projectId === activeProjectId)
  const scopedDrafts = (snapshot?.draftWorkspaces ?? []).filter((d) => d.projectId === activeProjectId)

  // Project-scoped shortcuts (next/prev workspace, new, stop). They listen
  // on window in the capture phase so xterm never forwards the chord to the
  // PTY, and live here rather than in Sidebar so they work with the sidebar
  // hidden. Terminal-scoped shortcuts belong to WorkspaceView. The ref lets
  // the one listener read the current render's state.
  const rowIds = sidebarRowIds(scopedProvisioning, scoped, scopedGroups, pendingDeleteIds)
  const openCreateWorkspace = useUiStore((s) => s.openCreateWorkspace)
  const newWorkspace = (): void => {
    if (activeProjectId && !readOnly) openCreateWorkspace({ projectId: activeProjectId, focus: 'prompt' })
  }
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceListEntry | null>(null)
  const selectedWorkspace = selectedWorkspaceId && !readOnly && !pendingDeleteIds.includes(selectedWorkspaceId)
    ? workspaces.find((s) => s.workspaceId === selectedWorkspaceId && !s.stopping) ?? null
    : null
  const shortcutCtx = useRef({ rowIds, selectedWorkspaceId, selectedWorkspace, newWorkspace })
  shortcutCtx.current = { rowIds, selectedWorkspaceId, selectedWorkspace, newWorkspace }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const ctx = shortcutCtx.current
      const state = useUiStore.getState()
      if (shortcutsSuspended(state)) return
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
          const next = resolveCycleTarget(ctx.rowIds, ctx.selectedWorkspaceId ?? undefined, delta)
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

  // Fill the pane when the project changed or the open workspace vanished
  // (see resolveVacantSelection). `rowIds` is in sidebar order, so "the top
  // row" is the one the user sees first. autoSelectWorkspace, not
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
      claims,
      inFlight: inFlightProvisions,
    })
    if (!pick) return
    if (selectedWorkspaceId !== null && claims[selectedWorkspaceId] === pick) forgetClaim(selectedWorkspaceId)
    autoSelectWorkspace(pick)
  }, [activeProjectId, rowIds, selectedWorkspaceId, claims, inFlightProvisions, forgetClaim, autoSelectWorkspace])
  // Viewing a waiting workspace marks its current waiting spell as read,
  // whether it was selected while waiting or started waiting while open.
  useEffect(() => {
    if (!selectedWorkspaceId) return
    const open = workspaces.find((s) => s.workspaceId === selectedWorkspaceId)
    if (open?.status === 'waiting') markWaitingRead(selectedWorkspaceId, open.waitingSinceMs ?? 0)
  }, [selectedWorkspaceId, workspaces, markWaitingRead])

  // Drop read marks whose waiting spell has ended. Skipped until the first
  // snapshot, since syncing against the empty fallback would wipe every
  // restored mark on reload.
  useEffect(() => {
    if (!all) return
    syncWaitingRead(all.workspaces
      .filter((s) => s.status === 'waiting')
      .map((s) => ({ workspaceId: s.workspaceId, waitingSinceMs: s.waitingSinceMs ?? 0 })))
  }, [all, syncWaitingRead])

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

  const attention = unreadWaitingByProject(workspaces, readWaiting, pendingDeleteIds)

  const projectRemoteUrl = projects.find((p) => p.id === activeProjectId)?.remoteUrl ?? ''
  const scopedGitAuthFailures = (activeProjectId && snapshot?.gitAuthFailures?.[activeProjectId]) || []

  return (
    // Desktop: rail and sidebar beside an inset workspace card. Mobile: three
    // stacked full-screen layers, one visible at a time. The pane wrapper
    // stays the same <div> in both, so WorkspaceView and its terminals stay
    // mounted when a phone rotates across the breakpoint.
    <div className={clsx('bg-shell', isMobile
      ? 'safe-area-inset relative h-full overflow-hidden'
      : 'flex h-full')}
    >
      {isMobile ? (
        <MobileScreenLayer active={mobileScreen === 'projects'}>
          <ProjectsScreen
            projects={projects}
            activeProjectId={activeProjectId}
            attentionByProject={attention}
            connected={connected}
            onSelect={setActiveProject}
          />
        </MobileScreenLayer>
      ) : (
        <ProjectRail
          projects={projects}
          activeProjectId={activeProjectId}
          attentionByProject={attention}
          onSelect={setActiveProject}
        />
      )}

      {isMobile ? (
        <MobileScreenLayer active={mobileScreen === 'workspaces'}>
          <WorkspacesScreen
            projectId={activeProjectId}
            projectRemoteUrl={projectRemoteUrl}
            workspaces={scoped}
            groups={scopedGroups}
            provisioning={scopedProvisioning}
            queued={scopedQueued}
            held={scopedHeld}
            drafts={scopedDrafts}
            connected={connected}
            gitAuthFailures={scopedGitAuthFailures}
            onBack={goBackScreen}
          />
        </MobileScreenLayer>
      ) : sidebarOpen && (
        <Sidebar
          projectId={activeProjectId}
          projectRemoteUrl={projectRemoteUrl}
          workspaces={scoped}
          groups={scopedGroups}
          provisioning={scopedProvisioning}
          queued={scopedQueued}
          held={scopedHeld}
          drafts={scopedDrafts}
          connected={connected}
          gitAuthFailures={scopedGitAuthFailures}
        />
      )}

      <div
        inert={isMobile && mobileScreen !== 'pane'}
        className={clsx(isMobile
          ? ['absolute inset-0', mobileScreen !== 'pane' && 'invisible pointer-events-none']
          : 'min-w-0 flex-1 p-2')}
      >
        {readOnly
          ? <ReadOnlyWorkspace workspace={workspaces.find((w) => w.workspaceId === selectedWorkspaceId)} />
          : <WorkspaceView snapshot={snapshot} provisioning={scopedProvisioning} />}
      </div>

      {/* Confirm for the delete-workspace shortcut. */}
      <StopWorkspaceDialog
        workspace={confirmDelete}
        onOpenChange={(next) => { if (!next) setConfirmDelete(null) }}
        onConfirm={() => {
          if (confirmDelete) stopWorkspaceOptimistic(confirmDelete, rowIds)
          setConfirmDelete(null)
        }}
      />
      <CreateWorkspaceDialog />
    </div>
  )
}

function FullScreen({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-text-faint">
      {children}
    </div>
  )
}

export default App

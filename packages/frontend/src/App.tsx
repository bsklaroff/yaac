import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { api } from './lib/api'
import { stopWorkspaceOptimistic } from './lib/stopWorkspaceFlow'
import { claimChord, cycleDeltaFor, matchShortcut, mergeBindings, resolveCycleTarget } from './lib/shortcuts'
import { getShortcutOverrides } from './lib/settingsApi'
import { useEvents } from './lib/useEvents'
import { useSnapshot } from './lib/useSnapshot'
import {
  mergeProvisioning, persistSelection, resolveVacantSelection,
  shortcutsSuspended, unreadWaitingBySlug, useUiStore,
} from './lib/store'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar, sidebarRowIds } from './components/Sidebar'
import { WorkspaceView } from './components/WorkspaceView'
import { MobileScreenLayer } from './components/mobile/MobileScreenLayer'
import { ProjectsScreen } from './components/mobile/ProjectsScreen'
import { WorkspacesScreen } from './components/mobile/WorkspacesScreen'
import { goBackScreen, useMobileHistory } from './lib/mobileHistory'
import { useIsMobile, useVisualViewportHeight } from './lib/viewport'
import { newlyWaitingWorkspaces, shouldChime, waitingSpellKeys } from './lib/attentionChime'
import { playChime } from './lib/sound'
import { isElectron } from './lib/platform'
import { CreateWorkspaceDialog } from './components/CreateWorkspaceDialog'
import { StopWorkspaceDialog } from './components/StopWorkspaceDialog'
import type { ServerSnapshot, WorkspaceListEntry } from '@yaac/shared/types'

/** `unidentified` carries the server's explanation of why it could not
 *  identify this device, or the error from asking. */
type AuthState = { kind: 'checking' } | { kind: 'ok' } | { kind: 'unidentified'; message: string }

function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ kind: 'checking' })

  useEffect(() => {
    let cancelled = false
    api.whoami.$get().then(
      () => { if (!cancelled) setAuth({ kind: 'ok' }) },
      (err: unknown) => {
        if (!cancelled) setAuth({ kind: 'unidentified', message: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => { cancelled = true }
  }, [])

  // Hooks must run unconditionally; the WS only connects once authed.
  const { connected } = useEvents(auth.kind === 'ok')
  const snapshot = useSnapshot()

  // Chime when a workspace starts waiting for input. The first snapshot only
  // seeds the set, so workspaces already waiting on load stay silent. The
  // workspace the user is looking at (selected, window focused) never chimes.
  const soundEnabled = useUiStore((s) => s.soundEnabled)
  const selectedWorkspaceId = useUiStore((s) => s.selectedWorkspaceId)
  const waitingSpells = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!snapshot) return
    const current = waitingSpellKeys(snapshot.workspaces)
    if (waitingSpells.current === null) { waitingSpells.current = current; return }
    const fresh = newlyWaitingWorkspaces(waitingSpells.current, snapshot.workspaces)
    waitingSpells.current = current
    const watching = typeof document !== 'undefined' && document.hasFocus() ? selectedWorkspaceId : null
    if (soundEnabled && shouldChime(fresh, watching)) playChime()
  }, [snapshot, soundEnabled, selectedWorkspaceId])

  let content: JSX.Element
  if (auth.kind === 'checking') content = <FullScreen>Loading…</FullScreen>
  else if (auth.kind === 'unidentified') {
    content = (
      <FullScreen>
        <div className="max-w-md px-8">
          <h1 className="text-lg font-semibold text-text">This server will not say who you are</h1>
          <p className="mt-3 text-sm text-text-dim">{auth.message}</p>
        </div>
      </FullScreen>
    )
  } else content = <Shell snapshot={snapshot} connected={connected} />

  // In Electron the title bar is hidden and the window controls float over
  // the UI. Full-screen states reserve a draggable strip for them; the
  // workspace layout provides its own drag regions and clearance instead.
  const inShell = auth.kind === 'ok'
  return (
    <div className="flex h-full flex-col bg-shell">
      {isElectron() && !inShell && <div className="titlebar-drag h-7 shrink-0" aria-hidden="true" />}
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  )
}

function Shell({ snapshot, connected }: { snapshot: ServerSnapshot | undefined; connected: boolean }): JSX.Element {
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const restoreActiveProject = useUiStore((s) => s.restoreActiveProject)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const endDelete = useUiStore((s) => s.endDelete)
  const optimisticProvisioning = useUiStore((s) => s.optimisticProvisioning)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const claims = useUiStore((s) => s.claims)
  const inFlightProvisions = useUiStore((s) => s.inFlightProvisions)
  const recordClaim = useUiStore((s) => s.recordClaim)
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
    persistSelection(s.activeProjectSlug, s.selectedWorkspaceId)
  }, [])

  // Fall back to the first project when none is active or the active one no
  // longer exists. Uses restoreActiveProject because the user did not choose
  // it, so on mobile it must not navigate into the project.
  useEffect(() => {
    if (projects.length === 0) return
    if (activeProjectSlug && projects.some((p) => p.slug === activeProjectSlug)) return
    restoreActiveProject(projects[0].slug)
  }, [activeProjectSlug, projects, restoreActiveProject])

  // Stop tracking an optimistic delete once the snapshot drops the workspace,
  // so the set can't grow forever or hide a later workspace with the same id.
  useEffect(() => {
    const live = new Set(workspaces.map((s) => s.workspaceId))
    for (const id of pendingDeleteIds) if (!live.has(id)) endDelete(id)
  }, [workspaces, pendingDeleteIds, endDelete])

  // Drop the local optimistic provisioning row once the server reports the
  // id, as a workspace or its own provisioning row.
  useEffect(() => {
    const known = new Set<string>([
      ...workspaces.map((s) => s.workspaceId),
      ...(snapshot?.provisioning ?? []).map((p) => p.workspaceId),
    ])
    for (const e of optimisticProvisioning) if (known.has(e.workspaceId)) removeOptimisticProvisioning(e.workspaceId)
  }, [workspaces, snapshot, optimisticProvisioning, removeOptimisticProvisioning])

  // A create that claims a prewarmed spare ends up under the spare's id.
  // Remember that mapping so the selection can follow it, and forget it if
  // the create fails or lists under its own id.
  useEffect(() => {
    for (const p of snapshot?.provisioning ?? []) {
      if (p.error !== undefined) forgetClaim(p.workspaceId)
      else if (p.claimedId) recordClaim(p.workspaceId, p.claimedId)
    }
    for (const w of workspaces) forgetClaim(w.workspaceId)
  }, [snapshot, workspaces, recordClaim, forgetClaim])

  const scoped = workspaces.filter((s) => s.projectSlug === activeProjectSlug)
  const scopedProvisioning = provisioning.filter((p) => p.projectSlug === activeProjectSlug)
  const scopedGroups = (snapshot?.workspaceGroups ?? [])
    .filter((g) => g.projectSlug === activeProjectSlug)
  const scopedQueued = (snapshot?.queuedWorkspaces ?? []).filter((e) => e.projectSlug === activeProjectSlug)
  const scopedHeld = (snapshot?.heldWorkspaces ?? []).filter((h) => h.projectSlug === activeProjectSlug)
  const scopedDrafts = (snapshot?.draftWorkspaces ?? []).filter((d) => d.projectSlug === activeProjectSlug)

  // Project-scoped shortcuts (next/prev workspace, new, stop). They listen
  // on window in the capture phase so xterm never forwards the chord to the
  // PTY, and live here rather than in Sidebar so they work with the sidebar
  // hidden. Terminal-scoped shortcuts belong to WorkspaceView. The ref lets
  // the one listener read the current render's state.
  const rowIds = sidebarRowIds(scopedProvisioning, scoped, scopedGroups, pendingDeleteIds)
  const openCreateWorkspace = useUiStore((s) => s.openCreateWorkspace)
  const newWorkspace = (): void => {
    if (activeProjectSlug) openCreateWorkspace({ projectSlug: activeProjectSlug, focus: 'prompt' })
  }
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceListEntry | null>(null)
  const selectedWorkspace = selectedWorkspaceId && !pendingDeleteIds.includes(selectedWorkspaceId)
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
    void getShortcutOverrides()
      .then((overrides) => useUiStore.getState().setBindings(mergeBindings(overrides)))
      .catch((e: unknown) => console.error(e))
  }, [])

  // Fill the pane when the project changed or the open workspace vanished
  // (see resolveVacantSelection). `rowIds` is in sidebar order, so "the top
  // row" is the one the user sees first. autoSelectWorkspace, not
  // selectWorkspace, so mobile fills the pane without navigating onto it. A
  // layout effect so the pane never paints empty during a hand-off.
  const lastProjectSlug = useRef(activeProjectSlug)
  useLayoutEffect(() => {
    const previousProjectSlug = lastProjectSlug.current
    lastProjectSlug.current = activeProjectSlug
    const pick = resolveVacantSelection({
      previousProjectSlug,
      activeProjectSlug,
      selectedWorkspaceId,
      rowIds,
      claims,
      inFlight: inFlightProvisions,
    })
    if (!pick) return
    if (selectedWorkspaceId !== null && claims[selectedWorkspaceId] === pick) forgetClaim(selectedWorkspaceId)
    autoSelectWorkspace(pick)
  }, [activeProjectSlug, rowIds, selectedWorkspaceId, claims, inFlightProvisions, forgetClaim, autoSelectWorkspace])
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
    if (!snapshot) return
    syncWaitingRead(workspaces
      .filter((s) => s.status === 'waiting')
      .map((s) => ({ workspaceId: s.workspaceId, waitingSinceMs: s.waitingSinceMs ?? 0 })))
  }, [snapshot, workspaces, syncWaitingRead])

  // Drop chat drafts for workspaces that no longer exist (same first-snapshot
  // guard as above). Provisioning ids count as live because a restarting
  // workspace leaves the workspace list and returns with the same id.
  useEffect(() => {
    if (!snapshot) return
    syncChatDrafts([
      ...workspaces.map((s) => s.workspaceId),
      ...provisioning.map((p) => p.workspaceId),
    ])
  }, [snapshot, workspaces, provisioning, syncChatDrafts])

  const attention = unreadWaitingBySlug(workspaces, readWaiting, pendingDeleteIds)

  const projectRemoteUrl = projects.find((p) => p.slug === activeProjectSlug)?.remoteUrl ?? ''
  const scopedGitAuthFailures = (activeProjectSlug && snapshot?.gitAuthFailures?.[activeProjectSlug]) || []

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
            activeProjectSlug={activeProjectSlug}
            attentionBySlug={attention}
            connected={connected}
            onSelect={setActiveProject}
          />
        </MobileScreenLayer>
      ) : (
        <ProjectRail
          projects={projects}
          activeProjectSlug={activeProjectSlug}
          attentionBySlug={attention}
          onSelect={setActiveProject}
        />
      )}

      {isMobile ? (
        <MobileScreenLayer active={mobileScreen === 'workspaces'}>
          <WorkspacesScreen
            projectSlug={activeProjectSlug}
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
          projectSlug={activeProjectSlug}
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
        <WorkspaceView snapshot={snapshot} provisioning={scopedProvisioning} />
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

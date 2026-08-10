import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import clsx from 'clsx'
import { readExchangeToken, postWebSession, stripTokenFromUrl } from './lib/webSession'
import { createWorktree } from './lib/createWorktree'
import { stopWorktreeOptimistic } from './lib/stopWorktreeFlow'
import { cycleDeltaFor, matchShortcut, mergeBindings, resolveCycleTarget } from './lib/shortcuts'
import { getShortcutOverrides } from './lib/settingsApi'
import { configuredTools, useAuthList } from './lib/useAuthList'
import { useEvents } from './lib/useEvents'
import { useProvisionWorktree } from './lib/useProvisionWorktree'
import { randomUUID } from './lib/uuid'
import { useSnapshot } from './lib/useSnapshot'
import {
  mergeProvisioning, persistSelection, resolveAttentionTarget, resolveNewWorktreeTool, unreadWaitingBySlug,
  useUiStore,
} from './store'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar, sidebarRowIds } from './components/Sidebar'
import { WorktreeView } from './components/WorktreeView'
import { ConnectSplash } from './components/ConnectSplash'
import { MobileScreenLayer } from './components/mobile/MobileScreenLayer'
import { ProjectsScreen } from './components/mobile/ProjectsScreen'
import { WorktreesScreen } from './components/mobile/WorktreesScreen'
import { goBackScreen, useMobileHistory } from './lib/mobileHistory'
import { useIsMobile, useVisualViewportHeight } from './lib/viewport'
import { newlyWaitingWorktrees, shouldChime, waitingSpellKeys } from './lib/attentionChime'
import { playChime } from './lib/sound'
import { isElectron } from './lib/platform'
import { ConfirmDialog } from './components/ui/ConfirmDialog'
import type { ServerSnapshot, WorktreeListEntry } from '@yaac/shared/types'

type AuthState = 'checking' | 'authed' | 'needs-token'

/** Hit a protected endpoint to see if the worktree cookie is still good. This
 *  bootstrap probe stays on a raw fetch: the route is unauthenticated-adjacent
 *  and not part of the typed RPC surface, and any failure (401 or server down)
 *  should show the splash rather than a blank screen. */
async function probeAuth(): Promise<boolean> {
  try {
    const res = await fetch('/auth/web-session', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    return res.ok
  } catch {
    return false
  }
}

function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>('checking')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const token = readExchangeToken()
      if (token) {
        const ok = await postWebSession(token)
        stripTokenFromUrl()
        if (ok) {
          if (!cancelled) setAuth('authed')
          return
        }
      }
      const authed = await probeAuth()
      if (!cancelled) setAuth(authed ? 'authed' : 'needs-token')
    })()
    return () => { cancelled = true }
  }, [])

  // Hooks must run unconditionally; the WS only connects once authed.
  const { connected } = useEvents(auth === 'authed')
  const snapshot = useSnapshot()

  // Chime the moment a worktree flips to waiting (it needs input) — the audible
  // sibling of the tray badge + notification. Seed silently on the first
  // snapshot so worktrees already waiting on load don't all fire; skip the
  // worktree the user is actively watching (selected + window focused — they can
  // see it flip); gate on the sound preference.
  const soundEnabled = useUiStore((s) => s.soundEnabled)
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId)
  const waitingSpells = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!snapshot) return
    const current = waitingSpellKeys(snapshot.worktrees)
    if (waitingSpells.current === null) { waitingSpells.current = current; return }
    const fresh = newlyWaitingWorktrees(waitingSpells.current, snapshot.worktrees)
    waitingSpells.current = current
    const watching = typeof document !== 'undefined' && document.hasFocus() ? selectedWorktreeId : null
    if (soundEnabled && shouldChime(fresh, watching)) playChime()
  }, [snapshot, soundEnabled, selectedWorktreeId])

  let content: JSX.Element
  if (auth === 'checking') content = <FullScreen>Loading…</FullScreen>
  else if (auth === 'needs-token') content = <ConnectSplash onAuthed={() => setAuth('authed')} />
  else content = <Workspace snapshot={snapshot} connected={connected} />

  // In Electron the title bar is hidden and the traffic lights float over the
  // UI. The full-screen states (loading/connect) reserve a thin draggable
  // strip for the lights; the workspace instead pulls its own top row (rail /
  // sidebar header / worktree bar) up level with them, so that band isn't dead
  // space — it carries its own drag regions and light clearance.
  // A browser tab gets neither, so it always renders content flush.
  const isWorkspace = auth === 'authed'
  return (
    <div className="flex h-full flex-col bg-base">
      {isElectron() && !isWorkspace && <div className="titlebar-drag h-7 shrink-0" aria-hidden="true" />}
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  )
}

/** A worktree's display name for dialog copy — title, else prompt (which can
 *  be a whole first message, so clipped), else the placeholder. */
function worktreeName(worktree: WorktreeListEntry | null): string {
  const name = worktree ? worktree.title || worktree.prompt || 'New worktree' : ''
  return name.length > 60 ? `${name.slice(0, 60)}…` : name
}

function Workspace({ snapshot, connected }: { snapshot: ServerSnapshot | undefined; connected: boolean }): JSX.Element {
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const restoreActiveProject = useUiStore((s) => s.restoreActiveProject)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const endDelete = useUiStore((s) => s.endDelete)
  const optimisticProvisioning = useUiStore((s) => s.optimisticProvisioning)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const selectedWorktreeId = useUiStore((s) => s.selectedWorktreeId)
  const autoSelectWorktree = useUiStore((s) => s.autoSelectWorktree)
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
  const worktrees = snapshot?.worktrees ?? []
  // Server-tracked provisioning rows + local optimistic ones (snapshot wins).
  const provisioning = mergeProvisioning(snapshot?.provisioning ?? [], optimisticProvisioning)

  // Mirror the restored selection (which may have come from localStorage) into
  // the URL on first paint, so even a bare reload yields a shareable link.
  // Ongoing changes are mirrored by the store subscription.
  useEffect(() => {
    const s = useUiStore.getState()
    persistSelection(s.activeProjectSlug, s.selectedWorktreeId)
  }, [])

  // Default the rail selection to the first project once projects arrive, and
  // recover from a persisted/active project that no longer exists (deleted, or
  // a stale link) by falling back to the first. Switching here clears the
  // worktree — correct, since the restored worktree belonged to that project.
  // Through restoreActiveProject, not setActiveProject: nobody chose this
  // project, so on mobile it must not also count as walking into it.
  useEffect(() => {
    if (projects.length === 0) return
    if (activeProjectSlug && projects.some((p) => p.slug === activeProjectSlug)) return
    restoreActiveProject(projects[0].slug)
  }, [activeProjectSlug, projects, restoreActiveProject])

  // Once the snapshot no longer lists an optimistically-deleted worktree, the
  // server's cleanup landed — stop tracking it so the set can't leak (or
  // wrongly hide a future worktree that reuses the id).
  useEffect(() => {
    const live = new Set(worktrees.map((s) => s.worktreeId))
    for (const id of pendingDeleteIds) if (!live.has(id)) endDelete(id)
  }, [worktrees, pendingDeleteIds, endDelete])

  // Once the server knows a provisioning id (as a real worktree or its own
  // provisioning row), drop the local optimistic copy — the snapshot is the
  // source of truth from here, carrying live progress and reload-survival.
  useEffect(() => {
    const known = new Set<string>([
      ...worktrees.map((s) => s.worktreeId),
      ...(snapshot?.provisioning ?? []).map((p) => p.worktreeId),
    ])
    for (const e of optimisticProvisioning) if (known.has(e.worktreeId)) removeOptimisticProvisioning(e.worktreeId)
  }, [worktrees, snapshot, optimisticProvisioning, removeOptimisticProvisioning])

  const scoped = worktrees.filter((s) => s.projectSlug === activeProjectSlug)
  const scopedProvisioning = provisioning.filter((p) => p.projectSlug === activeProjectSlug)

  // Worktree shortcuts, window-captured so the chord is swallowed before
  // xterm's textarea handler could forward it to the PTY, and registered
  // here, not in Sidebar, so they work with the sidebar hidden too:
  //  - Alt+K/Alt+J step through the sidebar rows top-to-bottom (wrapping)
  //    — the vertical sibling of WorktreeView's Alt+H/Alt+L terminal cycler.
  //  - Alt+N starts a new worktree in the active project, with the selected
  //    worktree's tool (or claude) — ignored while that tool has no stored
  //    credential (sign in via settings → credentials).
  //  - Alt+D deletes the selected worktree, through the same confirm dialog
  //    as the sidebar row's × (Enter confirms — the button holds focus).
  //  - Alt+B jumps to the worktree that most needs attention: the topmost
  //    unread-waiting one, else the topmost waiting, else the topmost running.
  // The ref keeps the single listener reading the current render's state.
  const provision = useProvisionWorktree()
  const rowIds = sidebarRowIds(scopedProvisioning, scoped, pendingDeleteIds)
  const attentionTarget = resolveAttentionTarget(
    scoped.filter((s) => !s.stopping && !pendingDeleteIds.includes(s.worktreeId)),
    readWaiting,
  )
  const authList = useAuthList()
  const configured = configuredTools(authList)
  const newWorktree = (): void => {
    if (!activeProjectSlug) return
    const slug = activeProjectSlug
    const tool = resolveNewWorktreeTool(worktrees, selectedWorktreeId, configured)
    if (!tool) return
    const worktreeId = randomUUID()
    provision(slug, tool, 'create', worktreeId,
      (sid, onProgress) => createWorktree(slug, tool, onProgress, sid))
  }
  const [confirmDelete, setConfirmDelete] = useState<WorktreeListEntry | null>(null)
  const selectedWorktree = selectedWorktreeId && !pendingDeleteIds.includes(selectedWorktreeId)
    ? worktrees.find((s) => s.worktreeId === selectedWorktreeId && !s.stopping) ?? null
    : null
  const shortcutCtx = useRef({ rowIds, selectedWorktreeId, selectedWorktree, newWorktree, attentionTarget })
  shortcutCtx.current = { rowIds, selectedWorktreeId, selectedWorktree, newWorktree, attentionTarget }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const ctx = shortcutCtx.current
      const state = useUiStore.getState()
      // The settings pane is capturing a rebind — don't act on the keypress
      // it's recording.
      if (state.recordingShortcut) return
      // Only the project-scoped commands are handled here; terminal-scoped
      // ones (new-shell, kill-terminal, terminal cycles) belong to WorktreeView,
      // so its ids fall through the switch untouched.
      const id = matchShortcut(state.bindings, e)
      switch (id) {
        case 'new-worktree':
          e.preventDefault()
          e.stopPropagation()
          ctx.newWorktree()
          return
        case 'delete-worktree':
          if (!ctx.selectedWorktree) return
          e.preventDefault()
          e.stopPropagation()
          setConfirmDelete(ctx.selectedWorktree)
          return
        case 'jump-attention':
          if (!ctx.attentionTarget) return
          e.preventDefault()
          e.stopPropagation()
          useUiStore.getState().selectWorktree(ctx.attentionTarget)
          return
        case 'prev-worktree':
        case 'next-worktree': {
          const delta = cycleDeltaFor(id)
          if (delta === null) return
          const next = resolveCycleTarget(ctx.rowIds, ctx.selectedWorktreeId ?? undefined, delta)
          if (!next) return
          e.preventDefault()
          e.stopPropagation()
          useUiStore.getState().selectWorktree(next)
          return
        }
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  // Load saved shortcut overrides once at startup; until they arrive the
  // factory defaults apply. Failures are non-fatal — the defaults just stand.
  useEffect(() => {
    void getShortcutOverrides()
      .then((overrides) => useUiStore.getState().setBindings(mergeBindings(overrides)))
      .catch((e: unknown) => console.error(e))
  }, [])

  // Auto-select: never show an empty pane when the project has worktrees — pick
  // the first waiting one (else the first visible). But never override a
  // selected provisioning row (it's not in `scoped`, so it would otherwise be
  // stolen) — auto-open on create relies on the selection sticking.
  // Goes through autoSelectWorktree, not selectWorktree: this is the app
  // choosing, so on mobile it must fill the pane *behind* the worktree list
  // rather than navigating the user onto it.
  useEffect(() => {
    if (!activeProjectSlug) return
    if (selectedWorktreeId && scopedProvisioning.some((p) => p.worktreeId === selectedWorktreeId)) return
    // Terminating rows are excluded so a worktree deleted out from under the
    // user (CLI/reaper) auto-navigates to a live one instead of showing a
    // dying container.
    const visible = scoped.filter((s) => !s.stopping && !pendingDeleteIds.includes(s.worktreeId))
    if (visible.length === 0) return
    if (selectedWorktreeId && visible.some((s) => s.worktreeId === selectedWorktreeId)) return
    const pick = visible.find((s) => s.status === 'waiting') ?? visible[0]
    autoSelectWorktree(pick.worktreeId)
  }, [activeProjectSlug, scopedProvisioning, scoped, selectedWorktreeId, pendingDeleteIds, autoSelectWorktree])
  // Viewing a waiting worktree marks its current spell read — the pane shows
  // it, so it no longer needs attention. Covers both selecting a waiting
  // worktree and the open worktree flipping running → waiting under the
  // user's eyes.
  useEffect(() => {
    if (!selectedWorktreeId) return
    const open = worktrees.find((s) => s.worktreeId === selectedWorktreeId)
    if (open?.status === 'waiting') markWaitingRead(selectedWorktreeId, open.waitingSinceMs ?? 0)
  }, [selectedWorktreeId, worktrees, markWaitingRead])

  // GC read marks whose waiting spell is over (worktree running, gone, or
  // waiting anew with a fresh waitingSinceMs). Only against hydrated frames:
  // before the first snapshot lands, `worktrees` is the empty fallback, and
  // syncing against it would wipe every restored mark — re-flagging all
  // waiting worktrees as unread on every reload.
  useEffect(() => {
    if (!snapshot) return
    syncWaitingRead(worktrees
      .filter((s) => s.status === 'waiting')
      .map((s) => ({ worktreeId: s.worktreeId, waitingSinceMs: s.waitingSinceMs ?? 0 })))
  }, [snapshot, worktrees, syncWaitingRead])

  // GC chat drafts for worktrees that no longer exist. Same hydration guard as
  // the read marks, and for the same reason: syncing against the pre-snapshot
  // empty fallback would wipe every restored draft on reload.
  //
  // Provisioning ids count as live: a worktree being restarted is filtered out
  // of the snapshot's worktree list for the whole restart, and it comes back
  // with the same id and the same conversations — GCing there would delete a
  // draft the user is about to return to.
  useEffect(() => {
    if (!snapshot) return
    syncChatDrafts([
      ...worktrees.map((s) => s.worktreeId),
      ...provisioning.map((p) => p.worktreeId),
    ])
  }, [snapshot, worktrees, provisioning, syncChatDrafts])

  // Per-project count of unread waiting worktrees → the rail attention badge.
  const attention = unreadWaitingBySlug(worktrees, readWaiting, pendingDeleteIds)

  const projectRemoteUrl = projects.find((p) => p.slug === activeProjectSlug)?.remoteUrl ?? ''
  const scopedGitAuthFailures = (activeProjectSlug && snapshot?.gitAuthFailures?.[activeProjectSlug]) || []

  return (
    // Desktop: rail + sidebar sit flush on the base layer and the worktree
    // pane floats as an inset, rounded, bordered card. Mobile: the same three
    // regions become stacked full-screen layers, one visible at a time.
    //
    // The three children keep their slots across the switch, which is what
    // keeps the pane's WorktreeView — and every kept-alive terminal under it —
    // mounted when a phone is rotated across the breakpoint. Only the two
    // navigation regions swap component (they're cheap); the pane's wrapper
    // stays the same <div> and merely changes class.
    <div className={clsx('bg-base', isMobile
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
        <MobileScreenLayer active={mobileScreen === 'worktrees'}>
          <WorktreesScreen
            projectSlug={activeProjectSlug}
            projectRemoteUrl={projectRemoteUrl}
            worktrees={scoped}
            provisioning={scopedProvisioning}
            connected={connected}
            gitAuthFailures={scopedGitAuthFailures}
            onBack={goBackScreen}
          />
        </MobileScreenLayer>
      ) : sidebarOpen && (
        <Sidebar
          projectSlug={activeProjectSlug}
          projectRemoteUrl={projectRemoteUrl}
          worktrees={scoped}
          provisioning={scopedProvisioning}
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
        <WorktreeView snapshot={snapshot} provisioning={scopedProvisioning} />
      </div>

      {/* Alt+D's confirm. Unlike the sidebar row's × (whose dialog needs no
          name — you clicked the row), this names its invisible target. */}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(next) => { if (!next) setConfirmDelete(null) }}
        title={`Delete “${worktreeName(confirmDelete)}”?`}
        description="Stops and removes the worktree's container. The worktree history and worktree will be saved, and can be restarted."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmDelete) stopWorktreeOptimistic(confirmDelete)
          setConfirmDelete(null)
        }}
      />
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

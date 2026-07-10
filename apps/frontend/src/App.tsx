import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { api, ApiError } from './lib/apiClient'
import { readBootstrapCode, postBootstrap, stripBootstrapFromUrl } from './lib/bootstrap'
import { createSession } from './lib/createSession'
import { deleteSessionOptimistic } from './lib/deleteSessionFlow'
import { cycleDeltaFor, matchShortcut, mergeBindings, resolveCycleTarget } from './lib/shortcuts'
import { getShortcutOverrides } from './lib/settingsApi'
import { configuredTools, useAuthList } from './lib/useAuthList'
import { useEvents } from './lib/useEvents'
import { useProvisionSession } from './lib/useProvisionSession'
import { useSnapshot } from './lib/useSnapshot'
import {
  mergeProvisioning, persistSelection, resolveAttentionTarget, resolveNewSessionTool, unreadWaitingBySlug,
  useUiStore,
} from './store'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar, sidebarRowIds } from './components/Sidebar'
import { SessionView } from './components/SessionView'
import { BootstrapSplash } from './components/BootstrapSplash'
import { ConfirmDialog } from './components/ui/ConfirmDialog'
import type { ServerSnapshot, SessionListEntry } from '@yaac/shared/types'

type AuthState = 'checking' | 'authed' | 'needs-bootstrap'

/** Hit a protected endpoint to see if the session cookie is still good. */
async function probeAuth(): Promise<boolean> {
  try {
    await api.get('/auth/bootstrap-code')
    return true
  } catch (err) {
    // 401 → not authed; anything else (server down) → show the splash too
    // rather than a blank screen.
    if (err instanceof ApiError && err.status === 401) return false
    return false
  }
}

function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>('checking')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const code = readBootstrapCode()
      if (code) {
        const ok = await postBootstrap(code)
        stripBootstrapFromUrl()
        if (ok) {
          if (!cancelled) setAuth('authed')
          return
        }
      }
      const authed = await probeAuth()
      if (!cancelled) setAuth(authed ? 'authed' : 'needs-bootstrap')
    })()
    return () => { cancelled = true }
  }, [])

  // Hooks must run unconditionally; the WS only connects once authed.
  const { connected } = useEvents(auth === 'authed')
  const snapshot = useSnapshot()

  if (auth === 'checking') return <FullScreen>Loading…</FullScreen>
  if (auth === 'needs-bootstrap') return <BootstrapSplash onAuthed={() => setAuth('authed')} />

  return <Workspace snapshot={snapshot} connected={connected} />
}

/** A session's display name for dialog copy — title, else prompt (which can
 *  be a whole first message, so clipped), else the placeholder. */
function sessionName(session: SessionListEntry | null): string {
  const name = session ? session.title || session.prompt || 'New session' : ''
  return name.length > 60 ? `${name.slice(0, 60)}…` : name
}

function Workspace({ snapshot, connected }: { snapshot: ServerSnapshot | undefined; connected: boolean }): JSX.Element {
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const endDelete = useUiStore((s) => s.endDelete)
  const optimisticProvisioning = useUiStore((s) => s.optimisticProvisioning)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const readWaiting = useUiStore((s) => s.readWaiting)
  const markWaitingRead = useUiStore((s) => s.markWaitingRead)
  const syncWaitingRead = useUiStore((s) => s.syncWaitingRead)

  const projects = snapshot?.projects ?? []
  const sessions = snapshot?.sessions ?? []
  // Server-tracked provisioning rows + local optimistic ones (snapshot wins).
  const provisioning = mergeProvisioning(snapshot?.provisioning ?? [], optimisticProvisioning)

  // Mirror the restored selection (which may have come from localStorage) into
  // the URL on first paint, so even a bare reload yields a shareable link.
  // Ongoing changes are mirrored by the store subscription.
  useEffect(() => {
    const s = useUiStore.getState()
    persistSelection(s.activeProjectSlug, s.selectedSessionId)
  }, [])

  // Default the rail selection to the first project once projects arrive, and
  // recover from a persisted/active project that no longer exists (deleted, or
  // a stale link) by falling back to the first. Switching here clears the
  // session — correct, since the restored session belonged to that project.
  useEffect(() => {
    if (projects.length === 0) return
    if (activeProjectSlug && projects.some((p) => p.slug === activeProjectSlug)) return
    setActiveProject(projects[0].slug)
  }, [activeProjectSlug, projects, setActiveProject])

  // Once the snapshot no longer lists an optimistically-deleted session, the
  // server's cleanup landed — stop tracking it so the set can't leak (or
  // wrongly hide a future session that reuses the id).
  useEffect(() => {
    const live = new Set(sessions.map((s) => s.sessionId))
    for (const id of pendingDeleteIds) if (!live.has(id)) endDelete(id)
  }, [sessions, pendingDeleteIds, endDelete])

  // Once the server knows a provisioning id (as a real session or its own
  // provisioning row), drop the local optimistic copy — the snapshot is the
  // source of truth from here, carrying live progress and reload-survival.
  useEffect(() => {
    const known = new Set<string>([
      ...sessions.map((s) => s.sessionId),
      ...(snapshot?.provisioning ?? []).map((p) => p.sessionId),
    ])
    for (const e of optimisticProvisioning) if (known.has(e.sessionId)) removeOptimisticProvisioning(e.sessionId)
  }, [sessions, snapshot, optimisticProvisioning, removeOptimisticProvisioning])

  const scoped = sessions.filter((s) => s.projectSlug === activeProjectSlug)
  const scopedProvisioning = provisioning.filter((p) => p.projectSlug === activeProjectSlug)

  // Session shortcuts, window-captured so the chord is swallowed before
  // xterm's textarea handler could forward it to the PTY, and registered
  // here, not in Sidebar, so they work with the sidebar hidden too:
  //  - Alt+↑/Alt+↓ step through the sidebar rows top-to-bottom (wrapping)
  //    — the vertical sibling of SessionView's Alt+←/→ terminal cycler.
  //  - Alt+N starts a new session in the active project, with the selected
  //    session's tool (or claude) — ignored while that tool has no stored
  //    credential (sign in via settings → credentials).
  //  - Alt+D deletes the selected session, through the same confirm dialog
  //    as the sidebar row's × (Enter confirms — the button holds focus).
  //  - Alt+B jumps to the session that most needs attention: the topmost
  //    unread-waiting one, else the topmost waiting, else the topmost running.
  // The ref keeps the single listener reading the current render's state.
  const provision = useProvisionSession()
  const rowIds = sidebarRowIds(scopedProvisioning, scoped, pendingDeleteIds)
  const attentionTarget = resolveAttentionTarget(
    scoped.filter((s) => !pendingDeleteIds.includes(s.sessionId)),
    readWaiting,
  )
  const authList = useAuthList()
  const configured = configuredTools(authList)
  const newSession = (): void => {
    if (!activeProjectSlug) return
    const slug = activeProjectSlug
    const tool = resolveNewSessionTool(sessions, selectedSessionId, configured)
    if (!tool) return
    const sessionId = crypto.randomUUID()
    provision(slug, tool, 'create', sessionId,
      (sid, onProgress) => createSession(slug, tool, onProgress, sid))
  }
  const [confirmDelete, setConfirmDelete] = useState<SessionListEntry | null>(null)
  const selectedSession = selectedSessionId && !pendingDeleteIds.includes(selectedSessionId)
    ? sessions.find((s) => s.sessionId === selectedSessionId) ?? null
    : null
  const shortcutCtx = useRef({ rowIds, selectedSessionId, selectedSession, newSession, attentionTarget })
  shortcutCtx.current = { rowIds, selectedSessionId, selectedSession, newSession, attentionTarget }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const ctx = shortcutCtx.current
      const state = useUiStore.getState()
      // The settings pane is capturing a rebind — don't act on the keypress
      // it's recording.
      if (state.recordingShortcut) return
      // Only the project-scoped commands are handled here; terminal-scoped
      // ones (new-shell, kill-terminal, terminal cycles) belong to SessionView,
      // so its ids fall through the switch untouched.
      const id = matchShortcut(state.bindings, e)
      switch (id) {
        case 'new-session':
          e.preventDefault()
          e.stopPropagation()
          ctx.newSession()
          return
        case 'delete-session':
          if (!ctx.selectedSession) return
          e.preventDefault()
          e.stopPropagation()
          setConfirmDelete(ctx.selectedSession)
          return
        case 'jump-attention':
          if (!ctx.attentionTarget) return
          e.preventDefault()
          e.stopPropagation()
          useUiStore.getState().selectSession(ctx.attentionTarget)
          return
        case 'prev-session':
        case 'next-session': {
          const delta = cycleDeltaFor(id)
          if (delta === null) return
          const next = resolveCycleTarget(ctx.rowIds, ctx.selectedSessionId ?? undefined, delta)
          if (!next) return
          e.preventDefault()
          e.stopPropagation()
          useUiStore.getState().selectSession(next)
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

  // Auto-select: never show an empty pane when the project has sessions — pick
  // the first waiting one (else the first visible). But never override a
  // selected provisioning row (it's not in `scoped`, so it would otherwise be
  // stolen) — auto-open on create relies on the selection sticking.
  useEffect(() => {
    if (!activeProjectSlug) return
    if (selectedSessionId && scopedProvisioning.some((p) => p.sessionId === selectedSessionId)) return
    const visible = scoped.filter((s) => !pendingDeleteIds.includes(s.sessionId))
    if (visible.length === 0) return
    if (selectedSessionId && visible.some((s) => s.sessionId === selectedSessionId)) return
    const pick = visible.find((s) => s.status === 'waiting') ?? visible[0]
    selectSession(pick.sessionId)
  }, [activeProjectSlug, scopedProvisioning, scoped, selectedSessionId, pendingDeleteIds, selectSession])
  // Viewing a waiting session marks its current spell read — the pane shows
  // it, so it no longer needs attention. Covers both selecting a waiting
  // session and the open session flipping running → waiting under the
  // user's eyes.
  useEffect(() => {
    if (!selectedSessionId) return
    const open = sessions.find((s) => s.sessionId === selectedSessionId)
    if (open?.status === 'waiting') markWaitingRead(selectedSessionId, open.waitingSinceMs ?? 0)
  }, [selectedSessionId, sessions, markWaitingRead])

  // GC read marks whose waiting spell is over (session running, gone, or
  // waiting anew with a fresh waitingSinceMs). Only against hydrated frames:
  // before the first snapshot lands, `sessions` is the empty fallback, and
  // syncing against it would wipe every restored mark — re-flagging all
  // waiting sessions as unread on every reload.
  useEffect(() => {
    if (!snapshot) return
    syncWaitingRead(sessions
      .filter((s) => s.status === 'waiting')
      .map((s) => ({ sessionId: s.sessionId, waitingSinceMs: s.waitingSinceMs ?? 0 })))
  }, [snapshot, sessions, syncWaitingRead])

  // Per-project count of unread waiting sessions → the rail attention badge.
  const attention = unreadWaitingBySlug(sessions, readWaiting, pendingDeleteIds)

  return (
    // Rail + sidebar sit flush on the base layer; the session pane floats
    // as an inset, rounded, bordered card.
    <div className="flex h-full bg-base">
      <ProjectRail
        projects={projects}
        activeProjectSlug={activeProjectSlug}
        attentionBySlug={attention}
        onSelect={setActiveProject}
      />
      {sidebarOpen && (
        <Sidebar
          projectSlug={activeProjectSlug}
          projectRemoteUrl={projects.find((p) => p.slug === activeProjectSlug)?.remoteUrl ?? ''}
          sessions={scoped}
          provisioning={scopedProvisioning}
          connected={connected}
          gitAuthFailures={(activeProjectSlug && snapshot?.gitAuthFailures[activeProjectSlug]) || []}
        />
      )}
      <div className="min-w-0 flex-1 p-2">
        <SessionView snapshot={snapshot} provisioning={scopedProvisioning} />
      </div>

      {/* Alt+D's confirm. Unlike the sidebar row's × (whose dialog needs no
          name — you clicked the row), this names its invisible target. */}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(next) => { if (!next) setConfirmDelete(null) }}
        title={`Delete “${sessionName(confirmDelete)}”?`}
        description="Stops and removes the session's container. The session history and worktree will be saved, and can be restarted."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmDelete) deleteSessionOptimistic(confirmDelete)
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

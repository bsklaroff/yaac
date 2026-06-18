import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { api, ApiError } from './lib/apiClient'
import { readBootstrapCode, postBootstrap, stripBootstrapFromUrl } from './lib/bootstrap'
import { useEvents } from './lib/useEvents'
import { useSnapshot } from './lib/useSnapshot'
import { mergeProvisioning, useUiStore } from './store'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar } from './components/Sidebar'
import { SessionView } from './components/SessionView'
import { BootstrapSplash } from './components/BootstrapSplash'
import type { DaemonSnapshot } from '@/shared/types'

type AuthState = 'checking' | 'authed' | 'needs-bootstrap'

/** Hit a protected endpoint to see if the session cookie is still good. */
async function probeAuth(): Promise<boolean> {
  try {
    await api.get('/auth/bootstrap-code')
    return true
  } catch (err) {
    // 401 → not authed; anything else (daemon down) → show the splash too
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

function Workspace({ snapshot, connected }: { snapshot: DaemonSnapshot | undefined; connected: boolean }): JSX.Element {
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const endDelete = useUiStore((s) => s.endDelete)
  const optimisticProvisioning = useUiStore((s) => s.optimisticProvisioning)
  const removeOptimisticProvisioning = useUiStore((s) => s.removeOptimisticProvisioning)
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)

  const projects = snapshot?.projects ?? []
  const sessions = snapshot?.sessions ?? []
  // Daemon-tracked provisioning rows + local optimistic ones (snapshot wins).
  const provisioning = mergeProvisioning(snapshot?.provisioning ?? [], optimisticProvisioning)

  // Default the rail selection to the first project once projects arrive.
  useEffect(() => {
    if (!activeProjectSlug && projects.length > 0) setActiveProject(projects[0].slug)
  }, [activeProjectSlug, projects, setActiveProject])

  // Once the snapshot no longer lists an optimistically-deleted session, the
  // daemon's cleanup landed — stop tracking it so the set can't leak (or
  // wrongly hide a future session that reuses the id).
  useEffect(() => {
    const live = new Set(sessions.map((s) => s.sessionId))
    for (const id of pendingDeleteIds) if (!live.has(id)) endDelete(id)
  }, [sessions, pendingDeleteIds, endDelete])

  // Once the daemon knows a provisioning id (as a real session or its own
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
  // Per-project count of sessions awaiting input → the rail attention badge.
  const attention: Record<string, number> = {}
  for (const s of sessions) {
    if (s.status === 'waiting') attention[s.projectSlug] = (attention[s.projectSlug] ?? 0) + 1
  }

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
          sessions={scoped}
          provisioning={scopedProvisioning}
          connected={connected}
        />
      )}
      <div className="min-w-0 flex-1 p-2">
        <SessionView snapshot={snapshot} provisioning={scopedProvisioning} />
      </div>
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

import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { api, ApiError } from './lib/apiClient'
import { readBootstrapCode, postBootstrap, stripBootstrapFromUrl } from './lib/bootstrap'
import { useEvents } from './lib/useEvents'
import { useSnapshot } from './lib/useSnapshot'
import { useUiStore } from './store'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar } from './components/Sidebar'
import { SessionView } from './components/SessionView'
import { BootstrapSplash } from './components/BootstrapSplash'
import type { DaemonSnapshot } from '@/shared/types'

type AuthState = 'checking' | 'authed' | 'needs-bootstrap'

/** Hit a protected endpoint to see if the session cookie is still good. */
async function probeAuth(): Promise<boolean> {
  try {
    await api.get('/prewarm')
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
  const creating = useUiStore((s) => s.creating)
  const setCreating = useUiStore((s) => s.setCreating)

  const projects = snapshot?.projects ?? []
  const sessions = snapshot?.sessions ?? []

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

  // Once the provisioned session shows up in the snapshot, hand off from the
  // optimistic "starting" placeholder to the real, snapshot-driven row.
  useEffect(() => {
    if (creating?.sessionId && sessions.some((s) => s.sessionId === creating.sessionId)) {
      setCreating(null)
    }
  }, [creating, sessions, setCreating])

  const scoped = sessions.filter((s) => s.projectSlug === activeProjectSlug)
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
      <Sidebar projectSlug={activeProjectSlug} sessions={scoped} connected={connected} />
      <div className="min-w-0 flex-1 p-2">
        <SessionView snapshot={snapshot} />
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

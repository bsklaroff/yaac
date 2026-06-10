import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { readBootstrapCode, postBootstrap, stripBootstrapFromUrl } from './lib/bootstrap'
import { useEvents } from './lib/useEvents'
import { useSnapshot } from './lib/useSnapshot'
import { useUiStore } from './store'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar } from './components/Sidebar'
import { SessionView } from './components/SessionView'
import { BootstrapSplash } from './components/BootstrapSplash'
import { GuestView } from './components/GuestView'
import { getAuthMe, type AuthMe } from './lib/invitesApi'
import type { DaemonSnapshot } from '@/shared/types'

type AuthState =
  | { kind: 'checking' }
  | { kind: 'authed'; me: AuthMe }
  | { kind: 'needs-bootstrap' }

function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ kind: 'checking' })

  useEffect(() => {
    let cancelled = false
    const finish = async (): Promise<void> => {
      const me = await getAuthMe().catch((): AuthMe | null => null)
      if (cancelled) return
      setAuth(me && (me.owner || me.guest) ? { kind: 'authed', me } : { kind: 'needs-bootstrap' })
    }
    void (async () => {
      const code = readBootstrapCode()
      if (code) {
        await postBootstrap(code)
        stripBootstrapFromUrl()
      }
      // /auth/me reports owner and/or guest (share-link cookie) standing —
      // it's the single source of truth for which experience to render.
      await finish()
    })()
    return () => { cancelled = true }
  }, [])

  // Guest experience: scoped cookie only, or an owner previewing via
  // /join's ?guest=1 redirect.
  const me = auth.kind === 'authed' ? auth.me : null
  const guestParam = new URLSearchParams(window.location.search).has('guest')
  const asGuest = !!me?.guest && (!me.owner || guestParam)

  // Hooks must run unconditionally; the WS only connects for owners.
  const { connected } = useEvents(auth.kind === 'authed' && !!me?.owner && !asGuest)
  const snapshot = useSnapshot()

  if (auth.kind === 'checking') return <FullScreen>Loading…</FullScreen>
  if (auth.kind === 'needs-bootstrap') {
    return <BootstrapSplash onAuthed={() => { window.location.reload() }} />
  }
  if (asGuest && me?.guest) {
    return <GuestView sessionId={me.guest.sessionId} mode={me.guest.mode} />
  }

  return <Workspace snapshot={snapshot} connected={connected} />
}

function Workspace({ snapshot, connected }: { snapshot: DaemonSnapshot | undefined; connected: boolean }): JSX.Element {
  const activeProjectSlug = useUiStore((s) => s.activeProjectSlug)
  const setActiveProject = useUiStore((s) => s.setActiveProject)
  const pendingDeleteIds = useUiStore((s) => s.pendingDeleteIds)
  const endDelete = useUiStore((s) => s.endDelete)
  const creating = useUiStore((s) => s.creating)
  const setCreating = useUiStore((s) => s.setCreating)
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)

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

  // Auto-select: never show an empty pane when the project has sessions —
  // pick the first waiting one (else the first visible). Skipped while a
  // create is provisioning (its placeholder owns the pane and the new id
  // isn't in the snapshot yet).
  useEffect(() => {
    if (!activeProjectSlug || creating) return
    const visible = scoped.filter((s) => s.status !== 'prewarm' && !pendingDeleteIds.includes(s.sessionId))
    if (visible.length === 0) return
    if (selectedSessionId && visible.some((s) => s.sessionId === selectedSessionId)) return
    const pick = visible.find((s) => s.status === 'waiting') ?? visible[0]
    selectSession(pick.sessionId)
  }, [activeProjectSlug, creating, scoped, selectedSessionId, pendingDeleteIds, selectSession])
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
      {sidebarOpen && <Sidebar projectSlug={activeProjectSlug} sessions={scoped} connected={connected} />}
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

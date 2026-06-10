import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { api, ApiError } from './lib/apiClient'
import { readBootstrapCode, postBootstrap, stripBootstrapFromUrl } from './lib/bootstrap'
import { useEvents } from './lib/useEvents'
import { useSnapshot } from './lib/useSnapshot'
import { useUiStore, type PhaseTab } from './store'
import { ProjectRail } from './components/ProjectRail'
import { Sidebar } from './components/Sidebar'
import { SessionView } from './components/SessionView'
import { PlanView } from './components/PlanView'
import { BootstrapSplash } from './components/BootstrapSplash'
import clsx from 'clsx'
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
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const phaseTab = useUiStore((s) => s.phaseTab)
  const setPhaseTab = useUiStore((s) => s.setPhaseTab)

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
  // Grill sessions live in the Plan tab (embedded next to their doc); the
  // Build tab's list only shows regular + build-role sessions.
  const buildScoped = scoped.filter((s) => s.planRole !== 'plan')

  // Auto-select: never show an empty pane when the project has sessions —
  // pick the first waiting one (else the first visible). Skipped while a
  // create is provisioning (its placeholder owns the pane and the new id
  // isn't in the snapshot yet).
  useEffect(() => {
    if (!activeProjectSlug || creating) return
    const visible = buildScoped.filter((s) => s.status !== 'prewarm' && !pendingDeleteIds.includes(s.sessionId))
    if (visible.length === 0) return
    if (selectedSessionId && visible.some((s) => s.sessionId === selectedSessionId)) return
    const pick = visible.find((s) => s.status === 'waiting') ?? visible[0]
    selectSession(pick.sessionId)
    // (buildScoped derives from scoped, which the deps cover.)
  }, [activeProjectSlug, creating, scoped, selectedSessionId, pendingDeleteIds, selectSession])
  // Per-project count of sessions awaiting input → the rail attention badge.
  const attention: Record<string, number> = {}
  for (const s of sessions) {
    if (s.status === 'waiting') attention[s.projectSlug] = (attention[s.projectSlug] ?? 0) + 1
  }

  return (
    // Rail + sidebar sit flush on the base layer; the session pane floats
    // as an inset, rounded, bordered card. The Plan | Build tabs sit above
    // everything right of the rail: Build is the regular workspace, Plan is
    // the wiki-doc view.
    <div className="flex h-full bg-base">
      <ProjectRail
        projects={projects}
        activeProjectSlug={activeProjectSlug}
        attentionBySlug={attention}
        onSelect={setActiveProject}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PhaseTabs tab={phaseTab} onChange={setPhaseTab} />
        {phaseTab === 'plan' ? (
          <PlanView projectSlug={activeProjectSlug} sessions={scoped} snapshot={snapshot} />
        ) : (
          <div className="flex min-h-0 flex-1">
            {sidebarOpen && <Sidebar projectSlug={activeProjectSlug} sessions={buildScoped} connected={connected} />}
            <div className="min-w-0 flex-1 p-2 pt-0">
              <SessionView snapshot={snapshot} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PhaseTabs({ tab, onChange }: { tab: PhaseTab; onChange: (t: PhaseTab) => void }): JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-center justify-center gap-1">
      {(['plan', 'build'] as const).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={clsx(
            'rounded-md px-3 py-1 text-xs font-medium capitalize transition',
            tab === t ? 'bg-surface-2 text-text' : 'text-text-faint hover:text-text-dim',
          )}
        >
          {t}
        </button>
      ))}
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

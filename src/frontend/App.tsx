import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { api, ApiError } from './lib/apiClient'
import { readBootstrapCode, postBootstrap, stripBootstrapFromUrl } from './lib/bootstrap'
import { useEvents } from './lib/useEvents'
import { useSnapshot } from './lib/useSnapshot'
import { Sidebar } from './components/Sidebar'
import { SessionView } from './components/SessionView'
import { BootstrapSplash } from './components/BootstrapSplash'

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

  return (
    <div className="flex h-full">
      <Sidebar snapshot={snapshot} connected={connected} />
      <SessionView snapshot={snapshot} />
    </div>
  )
}

function FullScreen({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-neutral-950 text-neutral-500">
      {children}
    </div>
  )
}

export default App

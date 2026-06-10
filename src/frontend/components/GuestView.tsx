import { type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SessionTerminal } from '@/frontend/components/SessionTerminal'
import { ViewIcon } from '@/frontend/lib/icons'
import { api } from '@/frontend/lib/apiClient'

interface GuestSessionDetail {
  sessionId?: string
  prompt?: string
  title?: string
}

/**
 * What a share-link guest sees: that one session's agent terminal,
 * full-bleed, with a slim bar — no rail, sidebar, or lifecycle actions.
 * Guests poll the session detail (they don't ride the events socket).
 * View-mode input is dropped client-side here and enforced server-side
 * at the PTY bridge.
 */
export function GuestView({
  sessionId,
  mode,
}: {
  sessionId: string
  mode: 'view' | 'drive'
}): JSX.Element {
  const { data } = useQuery({
    queryKey: ['guest-session', sessionId],
    queryFn: () => api.get<GuestSessionDetail>(`/session/${encodeURIComponent(sessionId)}`),
    refetchInterval: 10_000,
  })

  return (
    <div className="flex h-full flex-col bg-base p-2">
      <header className="flex h-8 shrink-0 items-center gap-2.5 px-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-text">
          {data?.title || data?.prompt || 'Shared session'}
        </span>
        <span className="flex shrink-0 items-center gap-1 rounded bg-surface px-2 py-0.5 text-[11px] text-text-dim">
          <ViewIcon size={11} />
          {mode === 'view' ? 'shared · view only' : 'shared · can drive'}
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-white/[0.06]
        bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
        <div className="m-0.5 min-h-0 flex-1 overflow-hidden rounded-md bg-bg px-2.5 py-1.5">
          <SessionTerminal sessionId={sessionId} target="agent-view" readOnly={mode === 'view'} />
        </div>
      </main>
    </div>
  )
}

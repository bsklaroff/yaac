import type { JSX } from 'react'
import { useUiStore } from '@/frontend/store'
import { SessionTerminal } from '@/frontend/components/SessionTerminal'
import type { DaemonSnapshot, SessionListEntry } from '@/shared/types'

const STATUS_DOT: Record<SessionListEntry['status'], string> = {
  running: 'bg-green-500',
  waiting: 'bg-amber-500',
  prewarm: 'bg-sky-500',
}

export function SessionView({ snapshot }: { snapshot: DaemonSnapshot | undefined }): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const session = snapshot?.sessions.find((s) => s.sessionId === selectedSessionId)

  if (!session) {
    return (
      <main className="flex h-full flex-1 items-center justify-center text-neutral-600">
        Select a session
      </main>
    )
  }

  return (
    <main className="flex h-full flex-1 flex-col bg-neutral-900">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-4 py-2.5 text-sm">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[session.status]}`} />
        <span className="font-semibold text-neutral-100">{session.projectSlug}</span>
        <span className="text-neutral-500">{session.tool}</span>
        <span className="text-neutral-600">{session.status}</span>
        <span className="ml-auto font-mono text-xs text-neutral-600">{session.sessionId.slice(0, 12)}</span>
      </header>
      {/* key forces a fresh terminal + socket when switching sessions */}
      <div className="min-h-0 flex-1 p-2">
        <SessionTerminal key={session.sessionId} sessionId={session.sessionId} />
      </div>
    </main>
  )
}

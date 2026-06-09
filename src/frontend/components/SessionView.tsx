import type { JSX } from 'react'
import { useUiStore } from '@/frontend/store'
import { SessionTerminal } from '@/frontend/components/SessionTerminal'
import { SessionActionsMenu } from '@/frontend/components/SessionActionsMenu'
import type { DaemonSnapshot, SessionListEntry } from '@/shared/types'

const STATUS_DOT: Record<SessionListEntry['status'], string> = {
  running: 'bg-green-500',
  waiting: 'bg-amber-500',
  prewarm: 'bg-sky-500',
}

export function SessionView({ snapshot }: { snapshot: DaemonSnapshot | undefined }): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const terminalNonce = useUiStore((s) => s.terminalNonce)
  const session = snapshot?.sessions.find((s) => s.sessionId === selectedSessionId)

  if (!session) {
    return (
      <main className="flex h-full flex-1 items-center justify-center bg-bg text-text-faint">
        Select a session
      </main>
    )
  }

  return (
    <main className="flex h-full flex-1 flex-col bg-bg">
      <header className="flex h-11 items-center gap-3 border-b border-border bg-surface px-4 text-sm">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[session.status]}`} />
        <span className="font-semibold text-text">{session.projectSlug}</span>
        <span className="text-text-dim">{session.tool}</span>
        <span className="text-text-faint">{session.status}</span>
        <span className="ml-auto font-mono text-xs text-text-faint">{session.sessionId.slice(0, 12)}</span>
        <SessionActionsMenu sessionId={session.sessionId} />
      </header>
      {/* key forces a fresh terminal + socket when switching sessions or on
          restart (terminalNonce bumps), so it reattaches to the new container */}
      <div className="min-h-0 flex-1 p-2">
        <SessionTerminal key={`${session.sessionId}:${terminalNonce}`} sessionId={session.sessionId} />
      </div>
    </main>
  )
}

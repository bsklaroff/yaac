import type { JSX } from 'react'
import clsx from 'clsx'
import { TerminalIcon } from '@/frontend/lib/icons'
import { useUiStore } from '@/frontend/store'
import type { SessionListEntry } from '@/shared/types'

const STATUS_DOT: Record<SessionListEntry['status'], string> = {
  running: 'bg-green-500',
  waiting: 'bg-amber-500',
  prewarm: 'bg-sky-500',
}

/**
 * Session list for the active project (the rail picks the project). Project
 * navigation lives in the rail, so this is session-only now.
 */
export function Sidebar({
  projectSlug,
  sessions,
  connected,
}: {
  projectSlug: string | null
  sessions: SessionListEntry[]
  connected: boolean
}): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-surface text-text">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="truncate font-semibold tracking-tight">{projectSlug ?? 'yaac'}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-dim">
          <span className={clsx('h-2 w-2 rounded-full', connected ? 'bg-green-500' : 'bg-text-faint')} />
          {connected ? 'live' : 'offline'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        <div className="flex items-center gap-1.5 px-4 py-1 text-xs font-semibold uppercase tracking-wide text-text-faint">
          <TerminalIcon size={13} />
          Sessions ({sessions.length})
        </div>
        {!projectSlug && <Empty label="No project selected" />}
        {projectSlug && sessions.length === 0 && <Empty label="No active sessions" />}
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            onClick={() => selectSession(s.sessionId)}
            className={clsx(
              'flex w-full flex-col gap-0.5 px-4 py-2 text-left text-sm transition hover:bg-surface-2',
              selectedSessionId === s.sessionId && 'bg-surface-2',
            )}
          >
            <span className="flex items-center gap-2">
              <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[s.status])} />
              <span className="truncate font-medium">{s.prompt || 'new session'}</span>
              <span className="ml-auto shrink-0 text-xs text-text-faint">{s.tool}</span>
            </span>
            <span className="truncate pl-4 font-mono text-xs text-text-faint">
              {s.sessionId.slice(0, 12)}
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}

function Empty({ label }: { label: string }): JSX.Element {
  return <div className="px-4 py-2 text-sm text-text-faint">{label}</div>
}

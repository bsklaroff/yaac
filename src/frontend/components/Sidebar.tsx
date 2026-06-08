import type { JSX, ReactNode } from 'react'
import { useUiStore } from '@/frontend/store'
import type { DaemonSnapshot, SessionListEntry } from '@/shared/types'

const STATUS_DOT: Record<SessionListEntry['status'], string> = {
  running: 'bg-green-500',
  waiting: 'bg-amber-500',
  prewarm: 'bg-sky-500',
}

export function Sidebar({
  snapshot,
  connected,
}: {
  snapshot: DaemonSnapshot | undefined
  connected: boolean
}): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)

  const sessions = snapshot?.sessions ?? []
  const projects = snapshot?.projects ?? []

  return (
    <aside className="flex h-full w-72 flex-col border-r border-neutral-800 bg-neutral-950 text-neutral-200">
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <span className="font-semibold tracking-tight">yaac</span>
        <span className="flex items-center gap-1.5 text-xs text-neutral-400">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-neutral-600'}`} />
          {connected ? 'live' : 'offline'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section title={`Sessions (${sessions.length})`}>
          {sessions.length === 0 && <Empty label="No active sessions" />}
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => selectSession(s.sessionId)}
              className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left text-sm hover:bg-neutral-900 ${
                selectedSessionId === s.sessionId ? 'bg-neutral-900' : ''
              }`}
            >
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[s.status]}`} />
                <span className="truncate font-medium">{s.projectSlug}</span>
                <span className="ml-auto shrink-0 text-xs text-neutral-500">{s.tool}</span>
              </span>
              <span className="truncate pl-4 text-xs text-neutral-400">
                {s.prompt || s.sessionId.slice(0, 12)}
              </span>
            </button>
          ))}
        </Section>

        <Section title={`Projects (${projects.length})`}>
          {projects.length === 0 && <Empty label="No projects" />}
          {projects.map((p) => (
            <div key={p.slug} className="flex items-center gap-2 px-4 py-1.5 text-sm">
              <span className="truncate">{p.slug}</span>
              <span className="ml-auto text-xs text-neutral-500">{p.sessionCount}</span>
            </div>
          ))}
        </Section>
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="py-2">
      <div className="px-4 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </div>
      {children}
    </div>
  )
}

function Empty({ label }: { label: string }): React.JSX.Element {
  return <div className="px-4 py-2 text-sm text-neutral-600">{label}</div>
}

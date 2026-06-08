import type { JSX, ReactNode } from 'react'
import clsx from 'clsx'
import { FolderGit2, SquareTerminal } from 'lucide-react'
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
    <aside className="flex h-full w-72 flex-col border-r border-border bg-surface text-text">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="font-semibold tracking-tight">yaac</span>
        <span className="flex items-center gap-1.5 text-xs text-text-dim">
          <span className={clsx('h-2 w-2 rounded-full', connected ? 'bg-green-500' : 'bg-text-faint')} />
          {connected ? 'live' : 'offline'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section icon={<SquareTerminal size={13} />} title={`Sessions (${sessions.length})`}>
          {sessions.length === 0 && <Empty label="No active sessions" />}
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
                <span className="truncate font-medium">{s.projectSlug}</span>
                <span className="ml-auto shrink-0 text-xs text-text-faint">{s.tool}</span>
              </span>
              <span className="truncate pl-4 text-xs text-text-dim">
                {s.prompt || s.sessionId.slice(0, 12)}
              </span>
            </button>
          ))}
        </Section>

        <Section icon={<FolderGit2 size={13} />} title={`Projects (${projects.length})`}>
          {projects.length === 0 && <Empty label="No projects" />}
          {projects.map((p) => (
            <div key={p.slug} className="flex items-center gap-2 px-4 py-1.5 text-sm">
              <span className="truncate">{p.slug}</span>
              <span className="ml-auto text-xs text-text-faint">{p.sessionCount}</span>
            </div>
          ))}
        </Section>
      </div>
    </aside>
  )
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="py-2">
      <div className="flex items-center gap-1.5 px-4 py-1 text-xs font-semibold uppercase tracking-wide text-text-faint">
        {icon}
        {title}
      </div>
      {children}
    </div>
  )
}

function Empty({ label }: { label: string }): JSX.Element {
  return <div className="px-4 py-2 text-sm text-text-faint">{label}</div>
}

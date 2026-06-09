import type { JSX } from 'react'
import clsx from 'clsx'
import { BlockedIcon, TerminalIcon, TOOL_ICON } from '@/frontend/lib/icons'
import { NewSessionButton } from '@/frontend/components/NewSessionButton'
import { NextWaitingButton } from '@/frontend/components/NextWaitingButton'
import { ProjectActionsMenu } from '@/frontend/components/ProjectActionsMenu'
import { useUiStore } from '@/frontend/store'
import type { SessionListEntry } from '@/shared/types'

/** Human relative age from the session's UTC 'YYYY-MM-DD HH:MM:SS' time. */
function relativeAge(createdAt: string): string {
  const t = Date.parse(createdAt.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * Session list for the active project (the rail picks the project). Project
 * navigation lives in the rail, so this is session-only now.
 */
export function Sidebar({
  projectSlug,
  sessions,
  waiting,
  connected,
}: {
  projectSlug: string | null
  sessions: SessionListEntry[]
  waiting: SessionListEntry[]
  connected: boolean
}): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const selectSession = useUiStore((s) => s.selectSession)

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-surface text-text">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="truncate font-semibold tracking-tight">{projectSlug ?? 'yaac'}</span>
        {projectSlug && <ProjectActionsMenu slug={projectSlug} />}
        {/* Only surfaced when disconnected — no permanent "live" dot. */}
        {!connected && <span className="ml-auto shrink-0 text-xs text-amber-400/80">reconnecting…</span>}
      </div>

      {waiting.length > 0 && (
        <div className="border-b border-border p-2">
          <NextWaitingButton waiting={waiting} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-2">
        <div className="flex items-center gap-1.5 px-4 py-1 text-xs font-semibold uppercase tracking-wide text-text-faint">
          <TerminalIcon size={13} />
          <span>Sessions ({sessions.length})</span>
          {projectSlug && (
            <span className="ml-auto">
              <NewSessionButton projectSlug={projectSlug} />
            </span>
          )}
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
              <span className="truncate font-medium">{s.prompt || 'New session'}</span>
              {(() => { const Icon = TOOL_ICON[s.tool]; return <Icon size={14} className="ml-auto shrink-0 text-text-dim" /> })()}
            </span>
            <span className="flex items-center gap-2 text-xs text-text-faint">
              <span className="truncate">{relativeAge(s.createdAt)}</span>
              {s.blockedHosts.length > 0 && (
                <span
                  className="ml-auto flex shrink-0 items-center gap-0.5 text-[#d65858]"
                  title={`${s.blockedHosts.length} blocked host(s)`}
                >
                  <BlockedIcon size={11} />
                  {s.blockedHosts.length}
                </span>
              )}
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

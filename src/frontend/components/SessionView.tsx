import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useUiStore } from '@/frontend/store'
import { SessionTerminal } from '@/frontend/components/SessionTerminal'
import { SessionActionsMenu } from '@/frontend/components/SessionActionsMenu'
import { CreatingPlaceholder } from '@/frontend/components/CreatingPlaceholder'
import { BlockedIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import type { DaemonSnapshot } from '@/shared/types'

export function SessionView({ snapshot }: { snapshot: DaemonSnapshot | undefined }): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const terminalNonces = useUiStore((s) => s.terminalNonces)
  const creating = useUiStore((s) => s.creating)
  const sessions = snapshot?.sessions ?? []
  const session = sessions.find((s) => s.sessionId === selectedSessionId)

  // Keep-alive: remember every session that's been opened and keep its
  // terminal mounted (just hidden) so switching back is instant — no
  // remount, reconnect, or resize-reflow jump.
  const [opened, setOpened] = useState<string[]>([])
  useEffect(() => {
    if (selectedSessionId) {
      setOpened((prev) => (prev.includes(selectedSessionId) ? prev : [...prev, selectedSessionId]))
    }
  }, [selectedSessionId])

  const liveIds = new Set(sessions.map((s) => s.sessionId))
  const mounted = opened.filter((id) => liveIds.has(id))

  return (
    <main className="flex h-full flex-1 flex-col bg-bg">
      {creating ? (
        <header className="flex h-11 items-center gap-2.5 border-b border-border bg-surface px-4 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium text-text-dim">New session</span>
          <span className="shrink-0 text-xs text-text-faint">{TOOL_LABEL[creating.tool]}</span>
        </header>
      ) : session ? (
        <header className="flex h-11 items-center gap-2.5 border-b border-border bg-surface px-4 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium text-text">
            {session.prompt || 'New session'}
          </span>
          <span className="shrink-0 text-xs text-text-faint">{TOOL_LABEL[session.tool]}</span>
          {session.blockedHosts.length > 0 && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-xs text-[#d65858]"
              title={session.blockedHosts.join('\n')}
            >
              <BlockedIcon size={12} />
              {session.blockedHosts.length}
            </span>
          )}
          <SessionActionsMenu sessionId={session.sessionId} />
        </header>
      ) : (
        <div className="flex h-11 shrink-0 items-center border-b border-border bg-surface" />
      )}

      <div className="relative min-h-0 flex-1">
        {!session && !creating && (
          <div className="flex h-full items-center justify-center text-text-faint">Select a session</div>
        )}
        {/* All opened terminals stay mounted; only the active one is visible.
            Keyed with a per-session nonce so a restart remounts just that one. */}
        {mounted.map((id) => (
          <div key={id} className={clsx('absolute inset-0 p-2', id !== selectedSessionId && 'invisible')}>
            <SessionTerminal key={`${id}:${terminalNonces[id] ?? 0}`} sessionId={id} />
          </div>
        ))}
        {/* Provisioning overlay — covers the (kept-alive) terminals until ready. */}
        {creating && (
          <div className="absolute inset-0 z-20 bg-bg">
            <CreatingPlaceholder creating={creating} />
          </div>
        )}
      </div>
    </main>
  )
}

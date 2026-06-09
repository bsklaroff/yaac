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
    // The floating pane, Claude Code-style: surface fill + hairline white/10
    // border + drop shadow over the (lighter) base, compact title bar inside.
    <main className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-surface
      shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
      {creating ? (
        <header className="flex h-9 shrink-0 items-center gap-2.5 px-4 text-xs">
          <span className="min-w-0 flex-1 truncate font-medium text-text-dim">New session</span>
          <span className="shrink-0 text-[11px] text-text-faint">{TOOL_LABEL[creating.tool]}</span>
        </header>
      ) : session ? (
        <header className="flex h-9 shrink-0 items-center gap-2.5 px-4 text-xs">
          <span className="min-w-0 flex-1 truncate font-medium text-text">
            {session.prompt || 'New session'}
          </span>
          <span className="shrink-0 text-[11px] text-text-faint">{TOOL_LABEL[session.tool]}</span>
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
        <div className="h-9 shrink-0" />
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
          <div className="absolute inset-0 z-20 bg-surface">
            <CreatingPlaceholder creating={creating} />
          </div>
        )}
      </div>
    </main>
  )
}

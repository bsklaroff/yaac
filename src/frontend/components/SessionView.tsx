import { useEffect, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useUiStore, type TerminalTab } from '@/frontend/store'
import { SessionTerminal } from '@/frontend/components/SessionTerminal'
import { SessionActionsMenu } from '@/frontend/components/SessionActionsMenu'
import { CreatingPlaceholder } from '@/frontend/components/CreatingPlaceholder'
import { AddIcon, BlockedIcon, CloseIcon, TOOL_LABEL } from '@/frontend/lib/icons'
import { getSessionTerminals, closeSessionTerminal, nextShellName } from '@/frontend/lib/terminalsApi'
import type { DaemonSnapshot } from '@/shared/types'

export function SessionView({ snapshot }: { snapshot: DaemonSnapshot | undefined }): JSX.Element {
  const selectedSessionId = useUiStore((s) => s.selectedSessionId)
  const terminalNonces = useUiStore((s) => s.terminalNonces)
  const terminalTabs = useUiStore((s) => s.terminalTabs)
  const setTerminalTab = useUiStore((s) => s.setTerminalTab)
  const creating = useUiStore((s) => s.creating)
  const queryClient = useQueryClient()
  const sessions = snapshot?.sessions ?? []
  const session = sessions.find((s) => s.sessionId === selectedSessionId)
  const activeTab: TerminalTab = selectedSessionId ? (terminalTabs[selectedSessionId] ?? 'agent') : 'agent'

  // The container's terminals beyond the agent: initCommands windows and
  // scratch shells. Light polling keeps the strip in sync with windows that
  // appear/disappear (e.g. an init dev server starting up).
  const { data: terminals } = useQuery({
    queryKey: ['terminals', selectedSessionId],
    queryFn: () => getSessionTerminals(selectedSessionId ?? ''),
    enabled: !!session,
    refetchInterval: 10_000,
    staleTime: 5_000,
  })

  // Keep-alive: remember every session|target that's been opened and keep
  // its terminal mounted (just hidden) so switching back is instant — no
  // remount, reconnect, or resize-reflow jump. Tabs open lazily, so e.g. a
  // shell only exists once its tab is first visited. ('|' separator —
  // targets themselves contain ':'.)
  const [opened, setOpened] = useState<string[]>([])
  useEffect(() => {
    if (!selectedSessionId) return
    const key = `${selectedSessionId}|${activeTab}`
    setOpened((prev) => (prev.includes(key) ? prev : [...prev, key]))
  }, [selectedSessionId, activeTab])

  const liveIds = new Set(sessions.map((s) => s.sessionId))
  const mounted = opened.filter((key) => liveIds.has(key.slice(0, key.indexOf('|'))))

  const refetchTerminals = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['terminals', selectedSessionId] })
  }

  const addShell = (): void => {
    if (!session) return
    // Attaching creates the tmux session lazily; the list refetch turns the
    // provisional tab into a real one.
    const name = nextShellName(terminals ?? [])
    setTerminalTab(session.sessionId, `shell:${name}`)
    setTimeout(refetchTerminals, 1000)
  }

  const closeShell = (target: string): void => {
    if (!session) return
    const id = session.sessionId
    setOpened((prev) => prev.filter((k) => k !== `${id}|${target}`))
    if (activeTab === target) setTerminalTab(id, 'agent')
    void closeSessionTerminal(id, target)
      .catch((e: unknown) => console.error('close shell failed', e))
      .finally(refetchTerminals)
  }

  // Strip = Agent + listed terminals, plus the active target if its shell
  // was *just* created and the list hasn't caught up yet.
  const tabs: { target: TerminalTab; label: string; closable: boolean }[] = [
    { target: 'agent', label: 'Agent', closable: false },
    ...(terminals ?? []).map((t) => ({
      target: t.target,
      label: t.name,
      closable: t.kind === 'shell',
    })),
  ]
  if (session && activeTab !== 'agent' && !tabs.some((t) => t.target === activeTab)) {
    tabs.push({
      target: activeTab,
      label: activeTab.startsWith('shell:') ? activeTab.slice('shell:'.length) : activeTab,
      closable: activeTab.startsWith('shell:'),
    })
  }

  return (
    // The floating pane, Claude Code-style: surface fill + hairline white/10
    // border + drop shadow over the (lighter) base, compact title bar inside.
    <main className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-white/[0.06] bg-surface
      shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
      {creating ? (
        <header className="flex h-8 shrink-0 items-center gap-2.5 px-4 text-xs">
          <span className="min-w-0 flex-1 truncate font-medium text-text-dim">New session</span>
          <span className="shrink-0 text-[11px] text-text-faint">{TOOL_LABEL[creating.tool]}</span>
        </header>
      ) : session ? (
        <header className="flex h-8 shrink-0 items-center gap-2.5 px-4 text-xs">
          <span className="min-w-0 flex-1 truncate font-medium text-text">
            {session.prompt || 'New session'}
          </span>
          {/* Terminal tabs: the agent, the container's extra tmux windows
              (initCommands dev servers, …), and scratch shells. */}
          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-bg/60 p-0.5">
            {tabs.map((t) => (
              <span key={t.target} className="group/tab relative flex items-center">
                <button
                  onClick={() => setTerminalTab(session.sessionId, t.target)}
                  className={clsx(
                    'rounded px-2 py-0.5 text-[11px] transition',
                    activeTab === t.target
                      ? 'bg-surface-3 font-medium text-text'
                      : 'text-text-faint hover:text-text-dim',
                    t.closable && 'pr-5',
                  )}
                >
                  {t.label}
                </button>
                {t.closable && (
                  <button
                    onClick={() => closeShell(t.target)}
                    title={`Close ${t.label}`}
                    aria-label={`Close ${t.label}`}
                    className="absolute right-0.5 flex h-4 w-4 items-center justify-center rounded text-text-faint
                      opacity-0 transition hover:text-text group-hover/tab:opacity-100"
                  >
                    <CloseIcon size={10} />
                  </button>
                )}
              </span>
            ))}
            <button
              onClick={addShell}
              title="New shell"
              aria-label="New shell"
              className="flex h-5 w-5 items-center justify-center rounded text-text-faint transition
                hover:bg-surface-3 hover:text-text"
            >
              <AddIcon size={12} />
            </button>
          </div>
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
        <div className="h-8 shrink-0" />
      )}

      <div className="relative min-h-0 flex-1">
        {!session && !creating && (
          <div className="flex h-full items-center justify-center text-text-faint">Select a session</div>
        )}
        {/* All opened terminals stay mounted; only the active one is visible.
            Keyed with a per-session nonce so a restart remounts just that
            session's terminals. */}
        {mounted.map((key) => {
          const sep = key.indexOf('|')
          const id = key.slice(0, sep)
          const target = key.slice(sep + 1)
          const visible = id === selectedSessionId && target === activeTab
          return (
            <div key={key} className={clsx('absolute inset-0 px-0.5 pb-0.5', !visible && 'invisible')}>
              {/* The terminal is its own dark rounded block inset in the surface
                  card, with side padding so text isn't flush to the edge. */}
              <div className="h-full w-full overflow-hidden rounded-lg bg-bg px-3 py-2">
                <SessionTerminal key={`${key}:${terminalNonces[id] ?? 0}`} sessionId={id} target={target} />
              </div>
            </div>
          )
        })}
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

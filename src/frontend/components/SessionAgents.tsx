import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { getSessionAgents, formatAgentDuration } from '@/frontend/lib/agentsApi'
import { LoadingIcon, WarningIcon, ChevronIcon, AgentsIcon } from '@/frontend/lib/icons'
import type { SubAgent } from '@/shared/types'

/**
 * The sub-agent pane: what the session's coding agent fanned out into. A live
 * list of spawned sub-agents — type · task · running/done · duration — each an
 * accordion you can expand to read its final result. Polls the daemon (which
 * reads the transcript) so new sub-agents and completions appear as they land.
 */
export function SessionAgents({ sessionId }: { sessionId: string }): JSX.Element {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agents', sessionId],
    queryFn: () => getSessionAgents(sessionId),
    refetchInterval: 3000,
    staleTime: 1500,
  })

  const agents = data?.agents ?? []
  const running = agents.filter((a) => a.status === 'running').length

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string): void => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-text-dim">
        <LoadingIcon size={18} className="animate-spin" />
      </div>
    )
  }
  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface text-xs text-text-dim">
        <WarningIcon size={18} className="text-text-faint" />
        <span>Couldn’t load sub-agents.</span>
        <button
          onClick={() => void refetch()}
          className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-dim transition hover:text-text"
        >
          Retry
        </button>
      </div>
    )
  }
  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 bg-surface px-4 text-center">
        <AgentsIcon size={22} className="text-text-faint" />
        <p className="text-xs text-text-dim">No sub-agents yet</p>
        <p className="text-[11px] text-text-faint">When the agent fans out work to sub-agents, they show up here.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-7 shrink-0 items-center gap-3 border-b border-hairline px-3 text-[11px] text-text-dim">
        <span>{agents.length} sub-agent{agents.length === 1 ? '' : 's'}</span>
        {running > 0 && <span className="text-[#d29922]">{running} running</span>}
        <span className="text-text-faint">{agents.length - running} done</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            open={expanded.has(agent.id)}
            onToggle={() => toggle(agent.id)}
          />
        ))}
      </div>
    </div>
  )
}

function AgentRow({ agent, open, onToggle }: { agent: SubAgent; open: boolean; onToggle: () => void }): JSX.Element {
  const done = agent.status === 'done'
  const duration = done && agent.spawnedAt && agent.completedAt
    ? formatAgentDuration(agent.completedAt - agent.spawnedAt)
    : ''
  return (
    <div className="border-b border-hairline">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition hover:bg-surface-2"
      >
        <ChevronIcon size={12} className={clsx('shrink-0 text-text-faint transition-transform', open && 'rotate-90')} />
        {done ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#3fb950]" />
        ) : (
          <LoadingIcon size={12} className="shrink-0 animate-spin text-[#d29922]" />
        )}
        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-dim">
          {agent.type}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-text">{agent.task || '(no description)'}</span>
        <span className="shrink-0 font-mono text-[10px] text-text-faint">{done ? duration : 'running…'}</span>
      </button>
      {open && (
        <div className="border-t border-hairline bg-bg px-3 py-2">
          {agent.result ? (
            <div className="whitespace-pre-wrap break-words text-[12px] leading-[1.55] text-text-dim">
              {agent.result}
            </div>
          ) : (
            <p className="text-[11px] text-text-faint">{done ? 'No result text.' : 'Still working…'}</p>
          )}
        </div>
      )}
    </div>
  )
}

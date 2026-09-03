import { useMemo, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { AcpTranscript, groupEvents } from '#components/AcpTranscript'
import { TOOL_LABEL } from '#lib/icons'
import { ServerError } from '@yaac/shared/errors'
import {
  getSessionTranscript, transcriptViewable, TRANSCRIPT_UNAVAILABLE,
} from '#lib/transcriptApi'
import type { AgentSessionEntry, AgentTool } from '@yaac/shared/types'

/**
 * What a stopped worktree actually said, in the pane that used to show only
 * the question that started it.
 *
 * A stopped worktree's conversation outlives its container — an `acp` one as
 * the record acpd wrote, a `tui` claude one as the transcript claude wrote —
 * so there is no reason for the view of a stopped worktree to be poorer than
 * the view of a running one. It renders through the same `AcpTranscript` the
 * live chat pane does, because it is the same conversation.
 *
 * A worktree can hold several: `/clear` starts a new conversation in the same
 * worktree, and a worktree can be launched with more than one agent. They are
 * offered as tabs in restore order, which is the order the sidebar's own
 * history list uses.
 *
 * Fetched rather than pushed, and cached forever: a stopped conversation is
 * finished, so there is nothing to poll for.
 */
export function StoppedTranscript({
  worktreeId,
  sessions,
  tool,
  prompt,
}: {
  worktreeId: string
  sessions: AgentSessionEntry[]
  /** The worktree's tool, for the note shown when nothing is readable. */
  tool: AgentTool
  /** The founding ask — what this pane showed before, and still shows when
   *  there is no transcript to show instead. */
  prompt?: string
}): JSX.Element | null {
  const viewable = useMemo(
    () => sessions.filter(transcriptViewable).sort((a, b) => a.ordinal - b.ordinal),
    [sessions],
  )
  const [picked, setPicked] = useState<string | null>(null)
  // The one the user chose, else the conversation the worktree was last in,
  // else its first — never a stale pick from a worktree that is no longer
  // selected, which is why this is derived rather than seeded into state.
  const selected = viewable.find((s) => s.agentSessionId === picked)
    ?? viewable.find((s) => s.active)
    ?? viewable[0]

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['transcript', worktreeId, selected?.agentSessionId],
    queryFn: () => getSessionTranscript(worktreeId, selected?.agentSessionId ?? ''),
    enabled: selected !== undefined,
    staleTime: Infinity,
  })

  const groups = useMemo(
    () => (Array.isArray(data) ? groupEvents(data) : []),
    [data],
  )

  // Nothing readable, which now means one thing: a `tui` conversation of a
  // tool whose own history the server cannot read once the pod is gone —
  // opencode's is a sqlite database inside the container, and codex names its
  // rollouts by a thread id yaac never sees. Every `acp` conversation is
  // readable whatever ran it, because acpd's record is yaac's own. The
  // founding ask is still worth showing — it is what this pane showed before
  // there were transcripts at all.
  if (selected === undefined || data === TRANSCRIPT_UNAVAILABLE) {
    if (!prompt) return null
    // Only say *why* when this tool is the reason — the worktree's
    // conversations are known and not one of them is readable. Two other ways
    // to land here must not claim that: a row listing no conversations yet is
    // the optimistic entry of a worktree stopped a moment ago, and a viewable
    // conversation that came back unavailable is a server too old to serve the
    // route. Blaming the tool would be wrong in both, and permanent-sounding
    // in two cases that resolve on their own.
    const explain = sessions.length > 0 && viewable.length === 0
    return (
      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-1.5">
        <p className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded bg-bg/80 p-2.5
          text-xs leading-relaxed text-text-dim">
          {prompt}
        </p>
        {explain && (
          <p className="shrink-0 text-[11px] text-text-faint">
            {TOOL_LABEL[tool]} keeps its history inside the worktree, so only the
            opening message is readable once it has stopped.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col">
      {/* Only when there is a choice to make: one conversation needs no tab. */}
      {viewable.length > 1 && (
        <div className="mb-2 flex shrink-0 flex-wrap gap-1">
          {viewable.map((s, i) => (
            <button
              key={s.agentSessionId}
              type="button"
              onClick={() => setPicked(s.agentSessionId)}
              title={s.prompt ?? undefined}
              className={clsx(
                'max-w-52 truncate rounded-md px-2 py-1 text-[11px] transition max-md:py-2',
                s.agentSessionId === selected.agentSessionId
                  ? 'bg-surface-3 text-text'
                  : 'text-text-faint hover:bg-surface-2 hover:text-text-dim',
              )}
            >
              {s.prompt ?? `Conversation ${String(i + 1)}`}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto rounded bg-bg/80 p-2.5">
        {isPending && <p className="text-xs text-text-faint">Loading the conversation…</p>}
        {/* The server's own words when it has any — a conversation refused for
            its size says so, which a generic failure would hide. */}
        {isError && (
          <p className="text-xs text-text-faint">
            {error instanceof ServerError
              ? `This conversation could not be shown: ${error.message}.`
              : 'The conversation could not be read.'}
          </p>
        )}
        {!isPending && !isError && groups.length === 0 && (
          <p className="text-xs text-text-faint">This conversation has no messages.</p>
        )}
        <AcpTranscript groups={groups} className="text-xs" />
      </div>
    </div>
  )
}

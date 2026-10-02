import { useMemo, useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { AcpTranscript, groupEvents } from '#components/AcpTranscript'
import { ActivityHeader, latestActivity } from '#components/AcpActivity'
import { SubagentIcon, TOOL_LABEL } from '#lib/icons'
import { ServerError } from '@yaac/shared/errors'
import {
  getSessionTranscript, transcriptViewable, TRANSCRIPT_UNAVAILABLE,
} from '#lib/transcriptApi'
import type { AgentSessionEntry, AgentTool } from '@yaac/shared/types'

/**
 * A stopped workspace's conversations, rendered with the same `AcpTranscript`
 * as the live chat pane. They survive the container: an `acp` one as acpd's
 * record, a `tui` claude one as claude's own transcript.
 *
 * A workspace can have several (`/clear`, or more than one agent); they show
 * as tabs in restore order. Fetched once and cached forever, since a stopped
 * conversation cannot change. A subagent's card opens its own transcript, as
 * in the live pane.
 */
export function StoppedTranscript({
  workspaceId,
  sessions,
  tool,
  prompt,
}: {
  workspaceId: string
  sessions: AgentSessionEntry[]
  /** The workspace's tool, for the note shown when nothing is readable. */
  tool: AgentTool
  /** The starting prompt, shown when there is no readable transcript. */
  prompt?: string
}): JSX.Element | null {
  const viewable = useMemo(
    () => sessions.filter(transcriptViewable).sort((a, b) => a.ordinal - b.ordinal),
    [sessions],
  )
  const [picked, setPicked] = useState<string | null>(null)
  // The user's pick, else the last conversation, else the first. Derived
  // rather than stored so a pick from another workspace never sticks.
  const selected = viewable.find((s) => s.agentSessionId === picked)
    ?? viewable.find((s) => s.active)
    ?? viewable[0]

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['transcript', workspaceId, selected?.agentSessionId],
    queryFn: () => getSessionTranscript(workspaceId, selected?.agentSessionId ?? ''),
    enabled: selected !== undefined,
    staleTime: Infinity,
  })

  /** The subagent being read instead of the conversation, if any. */
  const [opened, setOpened] = useState<string | null>(null)
  const subagent = opened === null || !Array.isArray(data)
    ? undefined
    : latestActivity(data).subagents.get(opened)
  const groups = useMemo(
    () => (Array.isArray(data) ? groupEvents(data, subagent?.id) : []),
    [data, subagent?.id],
  )

  // Nothing readable: a `tui` conversation of a tool whose history the server
  // cannot read after the pod is gone (opencode keeps it in an in-container
  // sqlite db; codex names rollouts by a thread id yaac never sees). Show the
  // starting prompt instead.
  if (selected === undefined || data === TRANSCRIPT_UNAVAILABLE) {
    if (!prompt) return null
    // Blame the tool only when conversations are known and none is readable.
    // An empty list is a just-stopped workspace, and an unavailable viewable
    // one is an older server; both resolve on their own.
    const explain = sessions.length > 0 && viewable.length === 0
    return (
      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-1.5">
        <p className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded bg-bg/80 p-2.5
          text-xs leading-relaxed text-text-dim">
          {prompt}
        </p>
        {explain && (
          <p className="shrink-0 text-[11px] text-text-faint">
            {TOOL_LABEL[tool]} keeps its history inside the workspace, so only the
            opening message is readable once it has stopped.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col">
      {viewable.length > 1 && (
        <div className="mb-2 flex shrink-0 flex-wrap gap-1">
          {viewable.map((s, i) => (
            <button
              key={s.agentSessionId}
              type="button"
              onClick={() => {
                setPicked(s.agentSessionId)
                setOpened(null)
              }}
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
      {subagent !== undefined && (
        <ActivityHeader
          icon={SubagentIcon}
          label="Agent"
          title={subagent.name}
          state={subagent.state}
          live={false}
          onBack={() => setOpened(null)}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto rounded bg-bg/80 p-2.5">
        {isPending && <p className="text-xs text-text-faint">Loading the conversation…</p>}
        {/* Prefer the server's message, e.g. a conversation too large to send. */}
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
        <AcpTranscript groups={groups} className="text-xs" onOpenSubagent={setOpened} />
      </div>
    </div>
  )
}

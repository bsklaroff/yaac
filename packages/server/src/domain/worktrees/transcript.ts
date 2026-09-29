import { ServerError } from '@yaac/shared/errors'
import { ConfinedPathError } from '#lib/confined-fs'
import {
  acpRecord,
  claudeTranscriptAsAcp,
  readSandboxFile,
  replayAcpLog,
  sessionTranscriptPath,
  type SandboxFile,
} from '#runtime/agents'
import { listWorktreeAgentSessions } from '#db'
import { recordedTranscript } from './agent-session-paths'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * One conversation's history, as the events a chat pane renders.
 *
 * This is what makes a stopped worktree readable: the pod is gone, but the
 * conversation is not, and until now the only thing a stopped worktree could
 * show of itself was its founding ask. Nothing here requires a running
 * workspace — it is a resolve and a file read — so the same route answers for
 * a live worktree, which is what a "read this conversation" view of a
 * *running* tui session would want too.
 *
 * Which file to read is the decision this mediator exists to make, and it
 * turns on the conversation's mode rather than on the driver:
 *
 *  - `acp` — acpd recorded the conversation as it relayed it, on a host path
 *    outside anything teardown prunes. Replaying that record is what a live
 *    pane does on every attach, so a stopped one costs the same read.
 *  - `tui` claude — no record exists, so claude's own transcript is replayed
 *    through the ACP adapter's translation (see `claude-acp-replay`).
 *  - anything else — refused. opencode keeps its history in a sqlite database
 *    inside the container and leaves nothing on the host, so there is no file
 *    to read once the worktree is gone; codex and pi leave transcripts in
 *    formats nothing here translates yet.
 *
 * A conversation whose file is missing answers with an empty history rather
 * than an error: an agent that never spoke has nothing to show, which is not
 * a failure. So does one whose file is not a plain file under its tool's
 * home — both are written from inside the sandbox, which can put a link or a
 * FIFO there, and neither is read through.
 */
export async function getAgentSessionTranscript(
  projectSlug: string,
  worktreeId: string,
  agentSessionId: string,
): Promise<AcpEvent[]> {
  const links = await listWorktreeAgentSessions(projectSlug, worktreeId)
  const session = links.find((l) => l.agentSessionId === agentSessionId)
  if (session === undefined) {
    throw new ServerError('NOT_FOUND', `conversation ${agentSessionId} not found`)
  }

  if (session.mode === 'acp') {
    const raw = await readTranscript(acpRecord({ slug: projectSlug, worktreeId, agentSessionId }))
    return raw === null ? [] : replayAcpLog(raw)
  }

  if (session.tool !== 'claude') {
    throw new ServerError(
      'NOT_SUPPORTED',
      `${session.tool} conversations have no readable transcript`,
    )
  }

  // The recorded path first, then the conventional one. The second attempt is
  // not redundant: the registry only stamps a transcript path for a *running*
  // pod, so a worktree whose pod died before that tick has a link with no
  // path, and deriving it from the layout is the only way its conversation is
  // ever read. `stoppedPrompt` falls back for the same reason.
  const file = recordedTranscript(session)
    ?? await sessionTranscriptPath(projectSlug, agentSessionId, session.tool)
  const raw = await readTranscript(file)
  return raw === null ? [] : claudeTranscriptAsAcp(raw, agentSessionId)
}

/**
 * The largest conversation this will answer with.
 *
 * Reading one is a whole-file read, a projection into events, and a single
 * JSON response, so the peak cost is a few multiples of the file — fine for
 * the conversations people actually read, and a way to stall the server for
 * one that has grown to hundreds of megabytes of tool output. The ceiling is
 * far above any conversation a person would scroll and far below the point
 * where reading it hurts.
 *
 * Refusing beats truncating: a conversation silently missing its first half
 * looks exactly like a conversation that started there. The cap is applied by
 * the read itself, so a file that grows between a size check and the read
 * cannot get past it.
 */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

async function readTranscript(file: SandboxFile | undefined): Promise<string | null> {
  if (file === undefined) return null
  try {
    return (await readSandboxFile(file, MAX_TRANSCRIPT_BYTES))?.toString('utf8') ?? null
  } catch (err) {
    if (!(err instanceof ConfinedPathError) || err.reason !== 'too-large') throw err
    const mb = (n: number): string => `${String(Math.round(n / (1024 * 1024)))} MB`
    throw new ServerError(
      'TOO_LARGE',
      `this conversation is ${mb(err.size ?? 0)}, past the ${mb(MAX_TRANSCRIPT_BYTES)} a transcript can be shown at`,
    )
  }
}

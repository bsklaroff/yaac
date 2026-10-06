import { ServerError } from '@yaac/shared/errors'
import { ConfinedPathError } from '#lib/confined-fs'
import {
  acpRecord,
  claudeTranscriptAsAcp,
  codexTranscriptAsAcp,
  conversationFiles,
  opencodeTranscriptAsAcp,
  piTranscriptAsAcp,
  readSandboxFile,
  replayAcpLog,
  sessionTranscriptPath,
  type SandboxFile,
} from '#runtime/agents'
import { listWorkspaceAgentSessions } from '#db'
import { recordedTranscript } from './agent-session-paths'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * One conversation's history as chat-pane events, for running or stopped
 * workspaces (it only reads files). An `acp` conversation replays acpd's
 * record, on a host path teardown keeps. A `tui` one has no record, so the
 * tool's own history is translated into the updates its ACP adapter would
 * have sent: claude's transcript, codex's rollout and the rollouts of the
 * subagents it spawned, pi's session log, or opencode's history (its
 * database, or the checkpoint's export of a sandboxed one).
 *
 * A missing file, or one that is not a plain file (the sandbox can plant a
 * link), gives an empty history.
 */
export async function getAgentSessionTranscript(
  projectSlug: string,
  workspaceId: string,
  agentSessionId: string,
): Promise<AcpEvent[]> {
  const links = await listWorkspaceAgentSessions(projectSlug, workspaceId)
  const session = links.find((l) => l.agentSessionId === agentSessionId)
  if (session === undefined) {
    throw new ServerError('NOT_FOUND', `conversation ${agentSessionId} not found`)
  }

  if (session.mode === 'acp') {
    const raw = await readTranscript(acpRecord({ slug: projectSlug, workspaceId, agentSessionId }))
    return raw === null ? [] : replayAcpLog(raw)
  }

  switch (session.tool) {
    case 'claude': {
      // Fall back to the conventional path, as `stoppedPrompt` does.
      const file = recordedTranscript(session)
        ?? await sessionTranscriptPath(projectSlug, workspaceId, session.tool, agentSessionId)
      const raw = await readTranscript(file)
      return raw === null ? [] : claudeTranscriptAsAcp(raw, agentSessionId)
    }
    case 'codex': {
      const files = (await conversationFiles(projectSlug, workspaceId, [session])).get(agentSessionId) ?? []
      const raws = await readTranscripts(files.map((f) => f.file))
      return raws.length === 0 ? [] : codexTranscriptAsAcp(raws)
    }
    case 'pi': {
      const raw = await readTranscript(await sessionTranscriptPath(projectSlug, workspaceId, session.tool, agentSessionId))
      return raw === null ? [] : piTranscriptAsAcp(raw)
    }
    case 'opencode':
      return opencodeTranscriptAsAcp(projectSlug, workspaceId, agentSessionId)
  }
}

/**
 * Largest transcript served. Reading costs a few times the file size, so a
 * huge one could stall the server. Larger files are refused rather than
 * truncated, which would look like a complete conversation. The read itself
 * enforces the cap.
 */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

async function readTranscript(file: SandboxFile | undefined, maxBytes = MAX_TRANSCRIPT_BYTES): Promise<string | null> {
  if (file === undefined) return null
  try {
    return (await readSandboxFile(file, maxBytes))?.toString('utf8') ?? null
  } catch (err) {
    if (!(err instanceof ConfinedPathError) || err.reason !== 'too-large') throw err
    const mb = (n: number): string => `${String(Math.round(n / (1024 * 1024)))} MB`
    throw new ServerError(
      'TOO_LARGE',
      `this conversation is ${mb(err.size ?? 0)}, past the ${mb(MAX_TRANSCRIPT_BYTES)} a transcript can be shown at`,
    )
  }
}

/** Several files read under one shared cap, in order; missing ones are
 *  skipped. */
async function readTranscripts(files: SandboxFile[]): Promise<string[]> {
  const out: string[] = []
  let left = MAX_TRANSCRIPT_BYTES
  for (const file of files) {
    const raw = await readTranscript(file, left)
    if (raw === null) continue
    out.push(raw)
    left -= Buffer.byteLength(raw)
  }
  return out
}

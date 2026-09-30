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
import { listWorkspaceAgentSessions } from '#db'
import { recordedTranscript } from './agent-session-paths'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * One conversation's history as chat-pane events, for running or stopped
 * workspaces (it only reads files). The source depends on the mode:
 *
 *  - `acp`: acpd's record, on a host path teardown keeps.
 *  - `tui` claude: claude's transcript, translated (`claudeTranscriptAsAcp`).
 *  - anything else: refused. opencode keeps history inside the container;
 *    codex and pi formats are not translated.
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

  if (session.tool !== 'claude') {
    throw new ServerError(
      'NOT_SUPPORTED',
      `${session.tool} conversations have no readable transcript`,
    )
  }

  // Fall back to the conventional path, as `stoppedPrompt` does.
  const file = recordedTranscript(session)
    ?? await sessionTranscriptPath(projectSlug, workspaceId, session.tool, agentSessionId)
  const raw = await readTranscript(file)
  return raw === null ? [] : claudeTranscriptAsAcp(raw, agentSessionId)
}

/**
 * Largest transcript served. Reading costs a few times the file size, so a
 * huge one could stall the server. Larger files are refused rather than
 * truncated, which would look like a complete conversation. The read itself
 * enforces the cap.
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

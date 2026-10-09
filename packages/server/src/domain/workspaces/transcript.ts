import { ServerError } from '@yaac/shared/errors'
import { ConfinedPathError } from '#lib/confined-fs'
import { sniffImage } from '@yaac/shared/attachments'
import {
  acpRecord,
  acpStoredImage,
  claudeSubagentThreads,
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
import { serverLog } from '#log'
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
  projectId: string,
  workspaceId: string,
  agentSessionId: string,
): Promise<AcpEvent[]> {
  const links = await listWorkspaceAgentSessions(projectId, workspaceId)
  const session = links.find((l) => l.agentSessionId === agentSessionId)
  if (session === undefined) {
    throw new ServerError('NOT_FOUND', `conversation ${agentSessionId} not found`)
  }

  // Fall back to the conventional path when none was recorded.
  const claudeFile = session.tool !== 'claude' ? undefined
    : recordedTranscript(session) ?? await sessionTranscriptPath(projectId, workspaceId, session.tool, agentSessionId)

  if (session.mode === 'acp') {
    const raw = await readTranscript(acpRecord({ projectId, workspaceId, agentSessionId }))
    return raw === null ? [] : withSubagentThreads(replayAcpLog(raw), claudeFile, raw)
  }

  switch (session.tool) {
    case 'claude': {
      const raw = await readTranscript(claudeFile)
      return raw === null ? [] : withSubagentThreads(await claudeTranscriptAsAcp(raw, agentSessionId), claudeFile, raw)
    }
    case 'codex': {
      const files = (await conversationFiles(projectId, workspaceId, [session])).get(agentSessionId) ?? []
      const raws = await readTranscripts(files.map((f) => f.file))
      return raws.length === 0 ? [] : codexTranscriptAsAcp(raws)
    }
    case 'pi': {
      const raw = await readTranscript(await sessionTranscriptPath(projectId, workspaceId, session.tool, agentSessionId))
      return raw === null ? [] : piTranscriptAsAcp(raw)
    }
    case 'opencode':
      return opencodeTranscriptAsAcp(projectId, workspaceId, agentSessionId)
  }
}

/** Largest stored image served: well past a full-screen screenshot. */
const MAX_STORED_IMAGE_BYTES = 32 * 1024 * 1024

/**
 * An image acpd stored apart from a workspace's records (`AcpStoredImage`),
 * with its type sniffed from the bytes. The workspace can write the file, so
 * anything that is not a PNG, JPEG, GIF or WebP is not served, and neither
 * is a file over the cap.
 */
export async function getAcpStoredImage(
  projectId: string,
  workspaceId: string,
  hash: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const file = acpStoredImage({ projectId, workspaceId }, hash)
  const bytes = file === undefined ? null : await readSandboxFile(file, MAX_STORED_IMAGE_BYTES).catch((err: unknown) => {
    if (err instanceof ConfinedPathError && err.reason === 'too-large') throw new ServerError('TOO_LARGE', 'the image is too large to show')
    throw err
  })
  const kind = bytes === null ? undefined : sniffImage(bytes)
  if (bytes === null || kind === undefined) throw new ServerError('NOT_FOUND', `image ${hash} not found`)
  return { bytes, mimeType: kind.mimeType }
}

/**
 * Fill in each subagent the events show without its thread (a `session/load`
 * replay and a tui transcript both leave it out) from claude's own
 * transcript of it, beside the conversation's `session`. They are read in
 * order under what is left of the transcript cap after `main`, the
 * conversation already read; one that cannot be read, or does not fit,
 * keeps the view it has.
 */
async function withSubagentThreads(events: AcpEvent[], session: SandboxFile | undefined, main: string): Promise<AcpEvent[]> {
  if (session === undefined) return events
  const threaded = new Set(events.flatMap((e) => ('thread' in e && e.thread !== undefined ? [e.thread] : [])))
  const missing = new Set(events.flatMap((e) => (e.type === 'subagent' && !threaded.has(e.subagent.id) ? [e.subagent.id] : [])))
  if (missing.size === 0) return events
  const read = await claudeSubagentThreads(session, [...missing], MAX_TRANSCRIPT_BYTES - Buffer.byteLength(main))
    .catch((err: unknown) => {
      serverLog(`[server] subagent transcripts unreadable: ${String(err)}`)
      return []
    })
  let seq = (events[events.length - 1]?.seq ?? -1) + 1
  return [...events, ...read.map((e) => ({ ...e, seq: seq++ }))]
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

import { StringDecoder } from 'node:string_decoder'
import { ServerError } from '@yaac/shared/errors'
import { ConfinedPathError } from '#lib/confined-fs'
import { sniffImage } from '@yaac/shared/attachments'
import { ACP_RECORD_NAME, acpPage, acpStoredImage, openSandboxFile, readAcpLife, readAcpPage, claudeSubagentThreads, claudeTranscriptAsAcp, codexTranscriptAsAcp, conversationFiles, opencodeTranscriptAsAcp, piTranscriptAsAcp, sessionTranscriptPath, readSandboxFile, type AcpLife, type RecordOrigin, type SandboxFile } from '#runtime/agents'
import { listWorkspaceAgentSessions, type AgentSessionLinkRow } from '#db'
import { serverLog } from '#lib/log'
import { recordedTranscript } from './agent-session-paths'
import { ACP_PAGE_SPAN, acpPageOf, type AcpEvent, type AcpTranscriptPage } from '@yaac/shared/acp'

/**
 * One page of a conversation's history as chat-pane events (`page`, or the
 * last one), for running or stopped workspaces (it only reads files). A
 * conversation's pages split at each compaction and at a size cap, so the
 * last one is where a pane starts and the ones before load as it scrolls.
 *
 * The history is the tool's own (`ownHistory`). An `acp` conversation's
 * current agent life comes from acpd's record instead, on a host path
 * teardown keeps, since that is what its live pane shows: the tool's history
 * fills the pages before the life began, and the record's pages follow
 * (`recordOrigin`). Its pages carry the life's id, since a restart numbers
 * them afresh.
 *
 * A missing file, or one that is not a plain file (the sandbox can plant a
 * link), gives an empty history.
 */
export async function getAgentSessionTranscript(
  projectId: string,
  workspaceId: string,
  agentSessionId: string,
  page?: number,
): Promise<AcpTranscriptPage> {
  const session = await conversation(projectId, workspaceId, agentSessionId)
  if (session === undefined) {
    throw new ServerError('NOT_FOUND', `conversation ${agentSessionId} not found`)
  }
  const claudeFile = await claudeTranscript(projectId, workspaceId, session)
  if (session.mode === 'tui') {
    const own = await ownHistory(projectId, workspaceId, session, claudeFile)
    return withSubagentThreads(acpPage(own.events, page), claudeFile, own.budget)
  }
  const ref = { projectId, workspaceId, agentSessionId }
  const life = await readAcpLife(ref)
  if (life === undefined) return withSubagentThreads(await readAcpPage(ref, page), claudeFile, MAX_TRANSCRIPT_BYTES)
  const origin = await recordOrigin(projectId, workspaceId, agentSessionId, life)
  const own = page !== undefined && page < origin.firstPage
    ? await historyBefore(projectId, workspaceId, session, claudeFile, life)
    : undefined
  const read = own !== undefined
    ? await withSubagentThreads(acpPage(own.events, page), claudeFile, own.budget)
    : await withSubagentThreads(await readAcpPage(ref, page, origin), claudeFile, MAX_TRANSCRIPT_BYTES)
  return { ...read, life: life.id }
}

/**
 * Where an `acp` conversation's record goes in its conversation: after the
 * tool's own history of what came before the life it holds. The live pane
 * numbers the record's pages from it (`attachAcp`), and the transcript route
 * from the same answer, cached per life since that history no longer
 * changes.
 */
export function recordOrigin(
  projectId: string,
  workspaceId: string,
  agentSessionId: string,
  life: AcpLife | undefined,
): Promise<RecordOrigin> {
  if (life === undefined) return Promise.resolve(NO_HISTORY)
  return cached(origins, MAX_ORIGINS, lifeKey(projectId, workspaceId, agentSessionId, life), async () => {
    const session = await conversation(projectId, workspaceId, agentSessionId)
    if (session === undefined) return NO_HISTORY
    const own = await historyBefore(projectId, workspaceId, session, await claudeTranscript(projectId, workspaceId, session), life)
    const last = own?.events.at(-1)
    return last === undefined ? NO_HISTORY : { firstPage: acpPageOf(last.seq) + 1, skipReplay: true }
  })
}

const NO_HISTORY: RecordOrigin = { firstPage: 0, skipReplay: false }

/** Each life's `RecordOrigin`, and the history before it, which is larger
 *  and so kept for fewer lives; one is read again when evicted. */
const origins = new Map<string, Promise<RecordOrigin>>()
const MAX_ORIGINS = 256
const histories = new Map<string, Promise<OwnHistory | undefined>>()
const MAX_HISTORIES = 4

function lifeKey(projectId: string, workspaceId: string, agentSessionId: string, life: AcpLife): string {
  return JSON.stringify([projectId, workspaceId, agentSessionId, life.id])
}

/** `key`'s value in `map`, made once; a failure is made again next time.
 *  Past `max` entries the oldest goes. */
function cached<T>(map: Map<string, Promise<T>>, max: number, key: string, make: () => Promise<T>): Promise<T> {
  let value = map.get(key)
  if (value === undefined) {
    value = make()
    value.catch(() => map.delete(key))
    map.set(key, value)
    if (map.size > max) map.delete(map.keys().next().value as string)
  }
  return value
}

async function conversation(projectId: string, workspaceId: string, agentSessionId: string): Promise<AgentSessionLinkRow | undefined> {
  return (await listWorkspaceAgentSessions(projectId, workspaceId)).find((l) => l.agentSessionId === agentSessionId)
}

/** claude's own transcript of a conversation, at its recorded path or else
 *  the conventional one. */
async function claudeTranscript(projectId: string, workspaceId: string, session: AgentSessionLinkRow): Promise<SandboxFile | undefined> {
  return session.tool !== 'claude' ? undefined
    : recordedTranscript(session) ?? await sessionTranscriptPath(projectId, workspaceId, session.tool, session.agentSessionId)
}

/**
 * The tool's own history of an `acp` conversation before `life` began, or
 * undefined when the record's replay is to stand for it: none was found,
 * it is past the transcript cap, or the tool is opencode. opencode's
 * `session/load` replays the whole conversation, and a sandboxed
 * workspace's export of its database lags its last minutes, so the replay
 * is the more complete of the two.
 */
function historyBefore(
  projectId: string,
  workspaceId: string,
  session: AgentSessionLinkRow,
  claudeFile: SandboxFile | undefined,
  life: AcpLife,
): Promise<OwnHistory | undefined> {
  return cached(histories, MAX_HISTORIES, lifeKey(projectId, workspaceId, session.agentSessionId, life), async () => {
    const before = Date.parse(life.startedAt)
    if (session.tool === 'opencode' || Number.isNaN(before)) return undefined
    const own = await ownHistory(projectId, workspaceId, session, claudeFile, before).catch((err: unknown) => {
      if (err instanceof ServerError && err.code === 'TOO_LARGE') return undefined
      throw err
    })
    return own?.events.length === 0 ? undefined : own
  })
}

/** A tool's own history of a conversation as events, and what is left of
 *  the transcript cap for its subagents' threads. */
interface OwnHistory {
  events: AcpEvent[]
  budget: number
}

/**
 * A conversation's history as the tool keeps it, translated into the
 * updates its ACP adapter would have sent: claude's transcript, codex's
 * rollout and the rollouts of the subagents it spawned, pi's session log,
 * or opencode's history (its database, or the checkpoint's export of a
 * sandboxed one). Only what the tool wrote before `before` (epoch ms), when
 * given (`readTranscript`): the agent lives before the one running, whose
 * subagents and tasks died with them. What this loses against the live pane
 * is listed in docs/acp-history-differences.md.
 */
async function ownHistory(
  projectId: string,
  workspaceId: string,
  session: AgentSessionLinkRow,
  claudeFile: SandboxFile | undefined,
  before = Infinity,
): Promise<OwnHistory> {
  const id = session.agentSessionId
  const ended = before !== Infinity
  switch (session.tool) {
    case 'claude': {
      const raw = await readTranscript(claudeFile, before)
      return raw === null
        ? { events: [], budget: MAX_TRANSCRIPT_BYTES }
        : { events: await claudeTranscriptAsAcp(raw, id, ended), budget: MAX_TRANSCRIPT_BYTES - Buffer.byteLength(raw) }
    }
    case 'codex': {
      const files = (await conversationFiles(projectId, workspaceId, [session])).get(id) ?? []
      const raws = await readTranscripts(files.filter((f) => f.name !== ACP_RECORD_NAME).map((f) => f.file), before)
      return { events: raws.length === 0 ? [] : codexTranscriptAsAcp(raws, ended), budget: 0 }
    }
    case 'pi': {
      const raw = await readTranscript(await sessionTranscriptPath(projectId, workspaceId, session.tool, id), before)
      return { events: raw === null ? [] : piTranscriptAsAcp(raw), budget: 0 }
    }
    case 'opencode':
      return { events: await opencodeTranscriptAsAcp(projectId, workspaceId, id), budget: 0 }
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
 * Fill in each subagent the page shows without its thread (a `session/load`
 * replay and a tui transcript both leave it out) from claude's own
 * transcript of it, beside the conversation's `session`. They are read in
 * order under `budget` bytes; one that cannot be read, or does not fit,
 * keeps the view it has. The threads join the page they are shown on.
 */
async function withSubagentThreads(
  { page, events }: AcpTranscriptPage,
  session: SandboxFile | undefined,
  budget: number,
): Promise<AcpTranscriptPage> {
  if (session === undefined) return { page, events }
  const threaded = new Set(events.flatMap((e) => ('thread' in e && e.thread !== undefined ? [e.thread] : [])))
  const missing = new Set(events.flatMap((e) => (e.type === 'subagent' && !threaded.has(e.subagent.id) ? [e.subagent.id] : [])))
  if (missing.size === 0) return { page, events }
  const read = await claudeSubagentThreads(session, [...missing], budget)
    .catch((err: unknown) => {
      serverLog(`[server] subagent transcripts unreadable: ${String(err)}`)
      return []
    })
  let seq = (events[events.length - 1]?.seq ?? page * ACP_PAGE_SPAN - 1) + 1
  return { page, events: [...events, ...read.map((e) => ({ ...e, seq: seq++ }))] }
}

/**
 * Largest transcript served. Reading costs a few times the file size, so a
 * huge one could stall the server. Larger files are refused rather than
 * truncated, which would look like a complete conversation. The read itself
 * enforces the cap.
 */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

/**
 * A JSONL history file's text, or null when there is none. With `before`
 * (epoch ms), only its lines up to the first one stamped at or after it,
 * which every tool writes in time order: reading stops there, so a running
 * life neither costs a read nor counts toward the cap, and what is read
 * stays the same for as long as that life runs. Lines with no `timestamp`
 * are kept.
 */
async function readTranscript(
  file: SandboxFile | undefined,
  before = Infinity,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): Promise<string | null> {
  if (file === undefined) return null
  if (before === Infinity) {
    try {
      return (await readSandboxFile(file, maxBytes))?.toString('utf8') ?? null
    } catch (err) {
      if (!(err instanceof ConfinedPathError) || err.reason !== 'too-large') throw err
      throw tooLarge(err.size ?? 0)
    }
  }
  const handle = await openSandboxFile(file)
  if (handle === null) return null
  try {
    const decoder = new StringDecoder('utf8')
    const buf = Buffer.allocUnsafe(1024 * 1024)
    let text = ''
    /** Where the first line not yet checked starts. */
    let at = 0
    for (let pos = 0; ;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
      pos += bytesRead
      text += bytesRead === 0 ? decoder.end() : decoder.write(buf.subarray(0, bytesRead))
      for (let nl = text.indexOf('\n', at); nl !== -1; nl = text.indexOf('\n', at)) {
        if (stampedFrom(text.slice(at, nl), before)) return text.slice(0, at)
        at = nl + 1
      }
      // The last line, which no newline ended.
      if (bytesRead === 0) return stampedFrom(text.slice(at), before) ? text.slice(0, at) : text
      if (pos > maxBytes) throw tooLarge()
    }
  } finally {
    await handle.close()
  }
}

/** Whether a history line is stamped at or after `before`. */
function stampedFrom(line: string, before: number): boolean {
  try {
    const stamp = (JSON.parse(line) as { timestamp?: unknown }).timestamp
    return typeof stamp === 'string' && Date.parse(stamp) >= before
  } catch {
    return false
  }
}

function tooLarge(size?: number): ServerError {
  const mb = (n: number): string => `${String(Math.round(n / (1024 * 1024)))} MB`
  return new ServerError(
    'TOO_LARGE',
    `this conversation is ${size !== undefined ? `${mb(size)}, ` : ''}past the ${mb(MAX_TRANSCRIPT_BYTES)} a transcript can be shown at`,
  )
}

/** Several files read under one shared cap, in order; missing ones are
 *  skipped. */
async function readTranscripts(files: SandboxFile[], before = Infinity): Promise<string[]> {
  const out: string[] = []
  let left = MAX_TRANSCRIPT_BYTES
  for (const file of files) {
    const raw = await readTranscript(file, before, left)
    if (raw === null) continue
    out.push(raw)
    left -= Buffer.byteLength(raw)
  }
  return out
}

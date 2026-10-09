/**
 * Reader for the conversation record acpd writes as it relays
 * (`dockerfiles/acpd/acpd.js`).
 *
 * The record is the verbatim JSON-RPC stream in both directions, so replay
 * uses the same `acp-protocol` projection as live traffic. acpd writes it
 * whether or not a client is attached, onto a host-visible path, so the
 * server keeps nothing itself and a stopped workspace's conversation stays
 * readable.
 *
 * It is the only path by which conversation content reaches a pane (see
 * `tailAcpLog`), and because it holds both directions it also tells a
 * reconnecting client whether a turn is running (see `readAcpInFlight`).
 */

import type { FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { acpLogDir } from '@yaac/shared/project-paths'
import { agentSessionIdSchema } from '@yaac/shared/types'
import {
  ACP, ACPD, AcpProjection, CLAUDE_SDK_MESSAGE, agentRunningReport, asRecord, asString, backgroundWorkReport,
  sessionEffort, sessionModeId, sessionModels, sessionStateModeId, toContentList, type AcpEffort,
} from './acp-protocol'
import { openSandboxFile, readSandboxFile, type SandboxFile } from './sandbox-fs'
import { serverLog } from '#log'
import type { AcpEvent, AcpEventInit } from '@yaac/shared/acp'

/** Which conversation's record; acpd names each `<agentSessionId>.jsonl`
 *  in its workspace's record dir. */
export interface AcpRecordRef {
  projectId: string
  workspaceId: string
  agentSessionId: string
}

/**
 * A conversation's record as a file confined to its record dir, which the
 * workspace can write (`SandboxFile`). Undefined for an invalid id: the id
 * comes from the agent and is joined into the path, so it must pass
 * `agentSessionIdSchema`.
 */
export function acpRecord(ref: AcpRecordRef): SandboxFile | undefined {
  if (!agentSessionIdSchema.safeParse(ref.agentSessionId).success) return undefined
  return { projectId: ref.projectId, dir: acpLogDir(ref.projectId, ref.workspaceId), rel: `${ref.agentSessionId}.jsonl` }
}

/** Size cap for the whole-file readers below. */
export const MAX_ACP_RECORD_BYTES = 64 * 1024 * 1024

/**
 * A whole record as text, or undefined if there is none. A missing record
 * just means no history yet; one over the cap is logged and treated as
 * absent.
 */
async function readRecord(ref: AcpRecordRef): Promise<string | undefined> {
  const file = acpRecord(ref)
  if (file === undefined) return undefined
  try {
    return (await readSandboxFile(file, MAX_ACP_RECORD_BYTES))?.toString('utf8')
  } catch (err) {
    serverLog(`[server] acp log ${file.dir}/${file.rel}: ${String(err)}`)
    return undefined
  }
}

async function openRecord(ref: AcpRecordRef): Promise<FileHandle | null> {
  const file = acpRecord(ref)
  return file === undefined ? null : openSandboxFile(file)
}

/**
 * Project recorded lines into the events a pane renders. Bad lines are
 * skipped: the record may end mid-write, and adapters may print non-JSON.
 */
export function replayAcpLog(raw: string): AcpEvent[] {
  const projection = new AcpProjection()
  return raw
    .split('\n')
    .flatMap((line) => projectLine(line, projection))
    .map((event, seq) => ({ ...event, seq }))
}

/**
 * A record built from a tool's own history (the `*-acp-replay` modules), as
 * acpd would have written it. A translation can repeat what it read, such
 * as one large file write in every result naming its call, so its output is
 * capped near a record read from disk: past `MAX_ACP_RECORD_BYTES`
 * characters the record ends and every later message is dropped unread, so
 * the conversation shows up to that point. A message too deeply nested to
 * serialize is skipped.
 */
export class AcpRecordWriter {
  private readonly lines: string[] = []
  private left = MAX_ACP_RECORD_BYTES
  private full = false

  write(msg: Record<string, unknown>): void {
    if (this.full) return
    let line: string
    try {
      line = JSON.stringify({ jsonrpc: '2.0', ...msg })
    } catch {
      return
    }
    this.left -= line.length + 1
    if (this.left < 0) this.full = true
    else this.lines.push(line)
  }

  replay(): AcpEvent[] {
    return replayAcpLog(this.lines.join('\n'))
  }
}

/** Tail poll interval: short enough for streaming to look live, cheap when
 *  idle (one open and two small reads). */
const TAIL_INTERVAL_MS = 150

/** The most a tail reads into memory at once. */
const TAIL_READ_BYTES = 1024 * 1024

/**
 * Bytes of the record's head to read to identify the agent life that wrote
 * it. acpd's `_acpd/life` line is always first and small.
 */
const LIFE_HEADER_BYTES = 512

export interface AcpLogTail {
  /** Read anything appended since the last pass, now. Used before emitting
   *  something that must come after the record's contents. */
  flush(): Promise<void>
  close(): void
}

/**
 * Follow a record as it grows, projecting each appended line.
 *
 * This is the only path by which conversation content reaches a pane. The
 * live socket carries the same `session/update` notifications, but ACP gives
 * them no ids, so merging two sources would duplicate or drop the overlap.
 *
 * A new agent life resets the reader and flags the batch so the caller
 * replaces rather than appends. Lives are told apart by the `_acpd/life`
 * header id, not by the file shrinking: a restart whose `session/load`
 * replay regrows the file within one tick would not look like a shrink.
 *
 * `onEvents` is always called at least once, even when no record exists
 * yet (an empty history).
 */
export function tailAcpLog(
  record: AcpRecordRef,
  onEvents: (events: AcpEventInit[], reset: boolean) => void,
  opts: { intervalMs?: number } = {},
): AcpLogTail {
  let pos = 0
  let residual = ''
  let projection = new AcpProjection()
  // One decoder across passes: acpd's writes can split characters, and
  // decoding each pass alone would produce U+FFFDs inside valid JSON.
  let decoder = new StringDecoder('utf8')
  let lifeId: string | undefined
  let closed = false
  let first = true
  let tooLarge = false
  // A restart seen but not yet reported. acpd empties the file first, so a
  // pass may see size 0 and must still tell the caller to start over.
  let pendingReset = false

  const startOver = (): void => {
    pendingReset = true
    pos = 0
    residual = ''
    decoder = new StringDecoder('utf8')
    projection = new AcpProjection()
    tooLarge = false
  }

  const runPass = async (): Promise<void> => {
    if (closed) return
    const handle = await openRecord(record)
    // A close during the open means nothing read now may be reported.
    if (closed) {
      await handle?.close()
      return
    }
    if (handle === null) {
      // No record yet; the first pass still reports an empty history.
      if (first) {
        first = false
        onEvents([], true)
      }
      return
    }

    try {
      const size = (await handle.stat()).size
      const life = await readLifeId(handle)
      if (life !== lifeId) {
        // No header on either side (a partial first write, or an unstamped
        // log): only a change counts as a restart, with the size check as a
        // fallback.
        if (lifeId !== undefined || life !== undefined) startOver()
        lifeId = life
      }
      if (size < pos) startOver()

      const reset = pendingReset || first
      if (size === pos && !reset) return

      const events: AcpEventInit[] = []
      // Stop at the cap: the file size is the workspace's to choose, but
      // memory is the server's.
      if (size > MAX_ACP_RECORD_BYTES) {
        if (!tooLarge) serverLog(`[server] acp log for ${record.agentSessionId}: past ${String(MAX_ACP_RECORD_BYTES)} bytes, no longer followed`)
        tooLarge = true
      }
      // Read in windows, each split once, so an endless line costs linear
      // memory and time.
      while (!tooLarge && pos < size) {
        const buf = Buffer.allocUnsafe(Math.min(TAIL_READ_BYTES, size - pos))
        const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
        if (bytesRead === 0) break
        pos += bytesRead
        const raw = decoder.write(buf.subarray(0, bytesRead))
        // Hold an incomplete last line for the next pass.
        const nl = raw.lastIndexOf('\n')
        if (nl === -1) {
          residual += raw
          continue
        }
        for (const line of (residual + raw.slice(0, nl)).split('\n')) events.push(...projectLine(line, projection))
        residual = raw.slice(nl + 1)
      }
      first = false
      if (events.length > 0 || reset) {
        pendingReset = false
        onEvents(events, reset)
      }
    } finally {
      await handle.close()
    }
  }

  // Serialize passes rather than skipping: `flush()` must actually read the
  // bytes it was called for, even if a timer pass is already running.
  let chain: Promise<void> = Promise.resolve()
  const pass = (): Promise<void> => {
    chain = chain.then(runPass, runPass)
    return chain
  }

  const timer = setInterval(() => void pass(), opts.intervalMs ?? TAIL_INTERVAL_MS)
  // Run the first pass immediately.
  void pass()

  return {
    // An in-flight pass may have `stat`ed before the bytes we need were
    // appended, so queue a fresh pass after it.
    flush: async () => {
      await chain
      await pass()
    },
    close: () => {
      closed = true
      clearInterval(timer)
    },
  }
}

/** The id acpd stamped as the record's first line, if it has one. */
async function readLifeId(handle: FileHandle): Promise<string | undefined> {
  const buf = Buffer.alloc(LIFE_HEADER_BYTES)
  const { bytesRead } = await handle.read(buf, 0, LIFE_HEADER_BYTES, 0)
  const head = buf.subarray(0, bytesRead).toString('utf8')
  const nl = head.indexOf('\n')
  if (nl === -1) return undefined
  try {
    const parsed: unknown = JSON.parse(head.slice(0, nl))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const msg = parsed as { method?: unknown; params?: unknown }
    if (msg.method !== ACPD.life) return undefined
    const id = (msg.params as { id?: unknown } | undefined)?.id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * One recorded line as an object, or undefined. Bad lines are tolerated
 * (mid-write reads, non-JSON adapter output).
 */
function parseLine(line: string): Record<string, unknown> | undefined {
  if (line.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** A line's JSON-RPC id as the string the events key permission asks by. */
function lineId(msg: Record<string, unknown>): string | undefined {
  return typeof msg.id === 'string' || typeof msg.id === 'number' ? String(msg.id) : undefined
}

/** One recorded line's contribution to the rendered conversation. */
function projectLine(line: string, projection: AcpProjection): AcpEventInit[] {
  const msg = parseLine(line)
  if (msg === undefined) return []
  // An adapter's own state report, the only boundary a run the agent
  // started itself has. A new agent life starts idle.
  if (msg.method === ACPD.exit) {
    projection.agentState(false)
    projection.forgetWakes()
  }
  const running = agentRunningReport(msg.method, msg.params)
  if (running !== undefined) return projection.agentState(running)
  // The client's own prompts. The agent echoes user messages only when
  // replaying under `session/load`, so live prompts appear only here.
  if (msg.method === ACP.sessionPrompt) {
    projection.forgetWakes()
    const content = toContentList(asRecord(msg.params)?.prompt)
    return content.length === 0 ? [] : [{ type: 'user', content }]
  }
  // A message steered into a running turn shows once its reply says the
  // agent took it, so one that fell back to `session/prompt` shows once.
  if (msg.method === ACP.sessionSteer) {
    const id = lineId(msg)
    if (id !== undefined) projection.openSteer(id, msg.params)
    return []
  }
  if (msg.method === ACP.sessionLoad) {
    const id = lineId(msg)
    if (id !== undefined) projection.openLoad(id)
    return []
  }
  if (msg.method === ACP.sessionUpdate) return projection.apply(msg.params)
  if (msg.method === ACP.opencodeChildUpdate) return projection.applyChildUpdate(msg.params)
  if (msg.method === CLAUDE_SDK_MESSAGE) return projection.applyClaudeSdk(msg.params)
  // Permission asks and their answers come from the record because an ask
  // that arrived while the relay was down exists only here, and a
  // reattaching pane must see what the agent is blocked on.
  if (msg.method === ACP.requestPermission) {
    const id = lineId(msg)
    return id === undefined ? [] : [projection.openPermission(id, msg.params)]
  }
  // A reply settles a permission ask or a steer, or carries the session's
  // models: the handshake's `session/new` or `session/load`, or a model
  // switch.
  if (msg.method === undefined) {
    const id = lineId(msg)
    if (id === undefined) return []
    const event = projection.closePermission(id, msg.result) ?? projection.closeSteer(id, msg.result)
    if (event !== undefined) return [event]
    const models = sessionModels(msg.result)
    const settled = projection.closeLoad(id) ?? []
    return models === undefined ? settled : [...settled, { type: 'models', ...models }]
  }
  // Requests and acpd's control lines carry no conversation content.
  return []
}

/** What a record says was running when it was last written; see
 *  `readAcpInFlight`. */
export interface AcpInFlight {
  /** Our last `session/prompt` has no reply. */
  prompt: boolean
  /** The agent's last own report of its state (`agentRunningReport`), if
   *  its adapter sends one. */
  agentRunning?: boolean
  /** The agent's last report of live background work
   *  (`backgroundWorkReport`), if it sent one. */
  backgroundWork?: boolean
}

/**
 * What was in flight when the record was last written.
 *
 * ACP gives a reconnecting client no way to ask whether the agent is working
 * (turn state is tied to your own unanswered `session/prompt`). The record
 * has both directions, so a prompt is in flight if the last recorded one has
 * no recorded reply. Turns never overlap (`AcpConversation` queues them, and
 * a steered message joins the running turn rather than starting one), so
 * only the last can be open. An adapter that reports its own state also
 * covers turns the agent started itself, including one codex starts from a
 * steer it answers `startedNewTurn`. No record means nothing running.
 */
export async function readAcpInFlight(record: AcpRecordRef): Promise<AcpInFlight> {
  const raw = await readRecord(record)
  if (raw === undefined) return { prompt: false }
  let pending: string | number | undefined
  const steers = new Set<string | number>()
  let agentRunning: boolean | undefined
  let backgroundWork: boolean | undefined
  for (const line of raw.split('\n')) {
    const msg = parseLine(line)
    if (msg === undefined) continue
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : undefined
    if (msg.method === ACP.sessionPrompt) {
      // Without an id it is a notification, which is never answered.
      if (id !== undefined) pending = id
      continue
    }
    if (msg.method === ACP.sessionSteer) {
      if (id !== undefined) steers.add(id)
      continue
    }
    // As live (`AcpConversation.cancel`): Stop with no prompt running drops
    // the adapter's report.
    if (msg.method === ACP.sessionCancel) {
      if (pending === undefined) agentRunning = undefined
      continue
    }
    if (msg.method === ACPD.exit) {
      // The agent exited; acpd starts a fresh record for the next life.
      pending = undefined
      agentRunning = undefined
      backgroundWork = undefined
      continue
    }
    agentRunning = agentRunningReport(msg.method, msg.params) ?? agentRunning
    backgroundWork = backgroundWorkReport(msg.method, msg.params) ?? backgroundWork
    // Only a reply (no method) can close a turn.
    if (msg.method !== undefined || id === undefined) continue
    if (id === pending) {
      pending = undefined
      // As live (`AcpConversation.runTurn`): a refused prompt drops the
      // adapter's report.
      if (msg.error !== undefined) agentRunning = undefined
    }
    if (steers.delete(id) && asRecord(msg.result)?.outcome === 'startedNewTurn') agentRunning = true
  }
  return {
    prompt: pending !== undefined,
    ...(agentRunning !== undefined ? { agentRunning } : {}),
    ...(backgroundWork !== undefined ? { backgroundWork } : {}),
  }
}

/**
 * Permission asks the agent was still blocked on when the record was last
 * written: asks with no recorded answer, paired as in `readAcpInFlight`.
 * Several can be open at once.
 *
 * Ids are returned verbatim, not as strings: JSON-RPC matches ids by value
 * and type, so answering `42` with `"42"` would never pair.
 */
export async function readAcpPendingPermissions(
  record: AcpRecordRef,
): Promise<Array<string | number>> {
  const raw = await readRecord(record)
  if (raw === undefined) return []
  // Keyed by string form for pairing, valued by the original id.
  const open = new Map<string, string | number>()
  for (const line of raw.split('\n')) {
    const msg = parseLine(line)
    if (msg === undefined) continue
    const raw = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : undefined
    if (msg.method === ACP.requestPermission) {
      if (raw !== undefined) open.set(String(raw), raw)
      continue
    }
    if (msg.method === ACPD.exit) {
      // The agent exited, and its asks with it.
      open.clear()
      continue
    }
    if (msg.method !== undefined) continue
    if (raw !== undefined) open.delete(String(raw))
  }
  return [...open.values()]
}

/**
 * How much of a record to scan for the opening message. The first prompt
 * follows the small life header and handshake, so a bounded read suffices
 * even for a large conversation.
 */
const FIRST_PROMPT_SCAN_BYTES = 64 * 1024

/** The text block at the start of a `session/prompt` line, used only for a
 *  line too long to parse. */
const TRUNCATED_PROMPT_TEXT =
  /"method":"session\/prompt".*?"prompt":\[\{"type":"text","text":("(?:[^"\\]|\\.)*")/

/**
 * The conversation's opening user message, used as the workspace's sidebar
 * label. Read from the record so the registry, which runs on a reconcile
 * tick, needs no live connection.
 */
export async function readAcpFirstPrompt(record: AcpRecordRef): Promise<string | undefined> {
  const handle = await openRecord(record)
  if (handle === null) return undefined
  try {
    const buf = Buffer.alloc(FIRST_PROMPT_SCAN_BYTES)
    const { bytesRead } = await handle.read(buf, 0, FIRST_PROMPT_SCAN_BYTES, 0)
    // Decode so a character split at the scan boundary is held back rather
    // than shown as U+FFFD; an incomplete trailing line is discarded.
    const head = new StringDecoder('utf8').write(buf.subarray(0, bytesRead))
    for (const line of head.split('\n')) {
      const msg = parseLine(line)
      if (msg?.method === ACP.sessionPrompt) return promptText(msg.params)
      // The scan may end mid-line, typically in an opening message with an
      // image; its text is still reachable because `AcpConversation.prompt`
      // writes the text block before the images.
      const cut = TRUNCATED_PROMPT_TEXT.exec(line)
      if (cut) return JSON.parse(cut[1]) as string
    }
    return undefined
  } finally {
    await handle.close()
  }
}

/** The text of a `session/prompt` request, if it carries any. */
function promptText(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const prompt = (params as { prompt?: unknown }).prompt
  if (!Array.isArray(prompt)) return undefined
  const text = prompt
    .flatMap((block) => {
      if (typeof block !== 'object' || block === null) return []
      const b = block as { type?: unknown; text?: unknown }
      return b.type === 'text' && typeof b.text === 'string' ? [b.text] : []
    })
    .join('')
  return text === '' ? undefined : text
}


/**
 * The session mode the record last shows: the handshake reply's, then each
 * successful `session/set_mode` and adapter mode update, last one winning.
 * A reattach seeds its posture from this (`AcpConversation.recoverMode`).
 */
export async function readAcpModeId(record: AcpRecordRef): Promise<string | undefined> {
  const raw = await readRecord(record)
  if (raw === undefined) return undefined
  let modeId: string | undefined
  // Requests whose reply moves the mode: a `set_mode` naming it, or a
  // handshake whose reply reports it (undefined here).
  const asked = new Map<string, string | undefined>()
  for (const line of raw.split('\n')) {
    const msg = parseLine(line)
    if (msg === undefined) continue
    const id = lineId(msg)
    if (msg.method === ACP.sessionNew || msg.method === ACP.sessionLoad || msg.method === ACP.sessionSetMode) {
      if (id !== undefined) asked.set(id, asString(asRecord(msg.params)?.modeId))
      continue
    }
    if (msg.method === ACP.sessionUpdate) {
      const update = asRecord(asRecord(msg.params)?.update)
      modeId = (update === undefined ? undefined : sessionModeId(update)) ?? modeId
      continue
    }
    if (msg.method !== undefined || id === undefined || !asked.has(id)) continue
    const set = asked.get(id)
    asked.delete(id)
    // An `error` means the request did nothing.
    if (msg.error === undefined) modeId = set ?? sessionStateModeId(msg.result) ?? modeId
  }
  return modeId
}

/**
 * The effort option the record last shows (`sessionEffort`): from the
 * handshake reply, each `session/set_config_option` reply, and each
 * `config_option_update`, last one winning. A reattach runs no handshake,
 * so this is where it learns the levels a pane may pick.
 */
export async function readAcpEffort(record: AcpRecordRef): Promise<AcpEffort | undefined> {
  const raw = await readRecord(record)
  if (raw === undefined) return undefined
  let effort: AcpEffort | undefined
  for (const line of raw.split('\n')) {
    const msg = parseLine(line)
    if (msg === undefined) continue
    const state = msg.method === ACP.sessionUpdate
      ? asRecord(asRecord(msg.params)?.update)
      : msg.method === undefined && msg.error === undefined ? msg.result : undefined
    effort = sessionEffort(state) ?? effort
  }
  return effort
}

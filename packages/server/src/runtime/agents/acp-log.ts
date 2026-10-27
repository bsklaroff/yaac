/**
 * Reader for the conversation record acpd writes as it relays
 * (`dockerfiles/acpd/acpd.js`).
 *
 * The record is the verbatim JSON-RPC stream in both directions, so replay
 * uses the same `acp-protocol` projection as live traffic. acpd writes it
 * whether or not a client is attached, onto a host-visible path, so the
 * server keeps nothing itself and a stopped workspace's conversation stays
 * readable. A record holds one agent life of a conversation, since acpd
 * starts it afresh; what came before is the tool's own history, which the
 * record's pages follow (`RecordOrigin`).
 *
 * It is the only path by which conversation content reaches a pane (see
 * `tailAcpLog`), and because it holds both directions it also tells a
 * reconnecting client whether a turn is running (see `readAcpRecovery`).
 */

import type { FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { acpLogDir } from '@yaac/shared/project-paths'
import { agentSessionIdSchema } from '@yaac/shared/types'
import {
  ACP, ACPD, AcpProjection, CLAUDE_SDK_MESSAGE, agentRunningReport, backgroundWorkReport, fromOtherSession,
  sessionEffort, sessionModeId, sessionModel, sessionModels, sessionStateModeId, toContentList,
  type AcpConfigOption, type AcpEffort, type AcpSessionModes,
} from './acp-protocol'
import { asRecord, asString } from '#lib/narrow'
import { openSandboxFile, type SandboxFile } from './sandbox-fs'
import { serverLog } from '#lib/log'
import { ACP_PAGE_SPAN, acpPageOf, type AcpEvent, type AcpEventInit, type AcpTranscriptPage } from '@yaac/shared/acp'

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

/**
 * An image acpd stored beside its workspace's records (`AcpStoredImage`), as
 * a file confined to the record dir. Undefined for anything but a SHA-256
 * hex digest, since the hash is joined into the path.
 */
export function acpStoredImage(ref: Omit<AcpRecordRef, 'agentSessionId'>, hash: string): SandboxFile | undefined {
  if (!/^[0-9a-f]{64}$/.test(hash)) return undefined
  return { projectId: ref.projectId, dir: acpLogDir(ref.projectId, ref.workspaceId), rel: `images/${hash}` }
}

/**
 * The largest record the readers that follow a whole conversation read: the
 * tail, a page, and recovery. They hold one page at a time, so memory stays
 * bounded by `PAGE_BYTES`, but reading costs time in the record's size,
 * which is the workspace's to choose. A larger record is not read at all.
 */
export const MAX_ACP_SCAN_BYTES = 1024 * 1024 * 1024

/** Size cap for the readers of a record's head (`readAcpFirstPrompt`) and
 *  for a record built from a tool's own history (`AcpRecordWriter`). */
export const MAX_ACP_RECORD_BYTES = 64 * 1024 * 1024

/** A record line longer than this is skipped: it holds no message worth
 *  showing (images are kept apart), and a string this long is costly. */
const MAX_LINE_CHARS = 64 * 1024 * 1024

/** How much of a record is read at once. */
const READ_BYTES = 1024 * 1024

async function openRecord(ref: AcpRecordRef): Promise<FileHandle | null> {
  const file = acpRecord(ref)
  return file === undefined ? null : openSandboxFile(file)
}

/**
 * Splits bytes read in order into whole lines. One decoder spans the reads,
 * so a character split between two is not shown as U+FFFD, and each read is
 * split once, so an endless line costs linear time until it is dropped.
 */
class LineReader {
  private decoder = new StringDecoder('utf8')
  /** The unfinished last line; undefined while skipping an overlong one. */
  private residual: string | undefined = ''

  /** The lines `buf` completes. */
  push(buf: Buffer): string[] {
    const text = this.decoder.write(buf)
    const nl = text.lastIndexOf('\n')
    if (nl === -1) {
      if (this.residual !== undefined) this.residual += text
      if (this.residual !== undefined && this.residual.length > MAX_LINE_CHARS) this.residual = undefined
      return []
    }
    const lines = ((this.residual ?? '') + text.slice(0, nl)).split('\n')
    if (this.residual === undefined) lines[0] = ''
    this.residual = text.slice(nl + 1)
    return lines
  }

  /** The last line, which no newline ended. */
  end(): string {
    return (this.residual ?? '') + this.decoder.end()
  }
}

/** A record's lines, none for one past `MAX_ACP_SCAN_BYTES`. */
async function* recordLines(handle: FileHandle): AsyncGenerator<string> {
  if ((await handle.stat()).size > MAX_ACP_SCAN_BYTES) return
  const reader = new LineReader()
  const buf = Buffer.allocUnsafe(READ_BYTES)
  for (let pos = 0; pos < MAX_ACP_SCAN_BYTES;) {
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, MAX_ACP_SCAN_BYTES - pos), pos)
    if (bytesRead === 0) break
    pos += bytesRead
    yield* reader.push(buf.subarray(0, bytesRead))
  }
  yield reader.end()
}

/**
 * Project recorded lines into the events a pane renders, numbered by page
 * (`Pager`). Bad lines are skipped: the record may end mid-write, and
 * adapters may print non-JSON.
 */
export function replayAcpLog(raw: string): AcpEvent[] {
  const projection = new RecordProjection()
  return raw.split('\n').flatMap((line) => projection.line(line))
}

/** One page of events already projected in full: `page`, or the last one,
 *  which a page past the end also is. */
export function acpPage(events: AcpEvent[], page?: number): AcpTranscriptPage {
  const last = events.length === 0 ? 0 : acpPageOf(events[events.length - 1].seq)
  const at = Math.min(page ?? last, last)
  return { page: at, events: events.filter((e) => acpPageOf(e.seq) === at) }
}

/**
 * Where a record's pages go in its conversation: the history before the
 * life it holds (the tool's own) fills the pages before `firstPage`. With that
 * history found, the record's `session/load` replay of it is not shown
 * (`skipReplay`); without it, the replay is all there is of it.
 */
export interface RecordOrigin {
  firstPage: number
  skipReplay: boolean
}

/** A record with no history before it. */
const NO_HISTORY: RecordOrigin = { firstPage: 0, skipReplay: false }

/**
 * One page of a conversation's record: `page`, or the last one, which a page
 * outside the record's also is. Reading stops at the end of the page asked
 * for, so an early page costs less than a late one. No record is an empty
 * page, and one past the cap is only the notice saying so.
 */
export async function readAcpPage(ref: AcpRecordRef, page?: number, origin = NO_HISTORY): Promise<AcpTranscriptPage> {
  const handle = await openRecord(ref)
  if (handle === null) return { page: origin.firstPage, events: [] }
  try {
    const projection = new RecordProjection(origin)
    if ((await handle.stat()).size > MAX_ACP_SCAN_BYTES) {
      return { page: origin.firstPage, events: [projection.number({ type: 'error', message: RECORD_TOO_LARGE })] }
    }
    const wanted = page !== undefined && page >= origin.firstPage ? page : undefined
    let at = origin.firstPage
    let events: AcpEvent[] = []
    for await (const line of recordLines(handle)) {
      for (const event of projection.line(line)) {
        const p = acpPageOf(event.seq)
        if (wanted !== undefined && p > wanted) return { page: wanted, events }
        if (p !== at) {
          at = p
          events = []
        }
        events.push(event)
      }
    }
    return { page: at, events }
  } finally {
    await handle.close()
  }
}

/**
 * A record built from a tool's own history (the `*-acp-replay` modules), as
 * acpd would have written it. A translation can repeat what it read, such
 * as one large file write in every result naming its call, so its output is
 * capped near a record read from disk: past `MAX_ACP_RECORD_BYTES`
 * characters the record ends and every later message is dropped unread, so
 * the conversation shows up to that point. A message too deeply nested to
 * serialize is skipped.
 *
 * The history of agent lives that have ended replays `ended`: closed by
 * acpd's exit line, past the cap too, so what it left running shows as
 * stopped rather than still going.
 *
 * Lines are projected as they are written, so a translation that follows a
 * growing history keeps writing to one writer, and `events` is always the
 * whole conversation so far.
 */
export class AcpRecordWriter {
  private readonly projection = new RecordProjection()
  readonly events: AcpEvent[] = []
  private left = MAX_ACP_RECORD_BYTES
  private full = false
  private marked: number | undefined

  /** Note when what follows happened, as acpd's time marks do. A time
   *  within a second of the last one noted is left out, as acpd leaves it. */
  time(at: unknown): void {
    if (typeof at !== 'number' || !Number.isFinite(at)) return
    if (this.marked !== undefined && Math.abs(at - this.marked) < TIME_MARK_MS) return
    this.marked = at
    this.write({ method: ACPD.time, params: { at } })
  }

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
    else this.events.push(...this.projection.line(line))
  }

  /** The conversation's events, closed by acpd's exit line when `ended`.
   *  Ending is final: nothing is written after it. */
  replay(ended = false): AcpEvent[] {
    if (ended) this.events.push(...this.projection.line(JSON.stringify({ jsonrpc: '2.0', method: ACPD.exit })))
    return this.events
  }
}

/** The least time between two of acpd's time marks (`ACPD.time`). */
const TIME_MARK_MS = 1000

/** Tail poll interval: short enough for streaming to look live, cheap when
 *  idle (one open and a stat). */
const TAIL_INTERVAL_MS = 150

/** What a pane shows once its record is past the cap. */
const RECORD_TOO_LARGE = `This conversation's record is past the ${String(MAX_ACP_SCAN_BYTES / (1024 * 1024 * 1024))} GB `
  + 'a chat pane can show, so nothing more of it is shown here. The agent is unaffected.'

export interface AcpLogTail {
  /** Read anything appended since the last pass, now. Used before emitting
   *  something that must come after the record's contents. */
  flush(): Promise<void>
  /** Number an event the record does not hold (a turn boundary from the
   *  live connection) after what the tail has delivered. */
  number(event: AcpEventInit): AcpEvent
  close(): void
}

/** The agent life a record holds, as acpd stamps its first line. */
export interface AcpLife {
  id: string
  /** When acpd started; everything before it is the tool's own history. */
  startedAt: string
}

/** Bytes of a record's head to read for its life line, which is small. */
const LIFE_HEADER_BYTES = 512

/** The life a record holds, if it has a record and acpd stamped it. */
export async function readAcpLife(ref: AcpRecordRef): Promise<AcpLife | undefined> {
  const handle = await openRecord(ref)
  if (handle === null) return undefined
  try {
    return await lifeOf(handle)
  } finally {
    await handle.close()
  }
}

async function lifeOf(handle: FileHandle): Promise<AcpLife | undefined> {
  const buf = Buffer.alloc(LIFE_HEADER_BYTES)
  const { bytesRead } = await handle.read(buf, 0, LIFE_HEADER_BYTES, 0)
  const head = buf.subarray(0, bytesRead).toString('utf8')
  const nl = head.indexOf('\n')
  const msg = nl === -1 ? undefined : parseLine(head.slice(0, nl))
  const params = asRecord(msg?.params)
  const id = asString(params?.id)
  const startedAt = asString(params?.startedAt)
  return msg?.method === ACPD.life && id !== undefined && startedAt !== undefined ? { id, startedAt } : undefined
}

/**
 * Follow a record as it grows, projecting each appended line.
 *
 * This is the only path by which conversation content reaches a pane. The
 * live socket carries the same `session/update` notifications, but ACP gives
 * them no ids, so merging two sources would duplicate or drop the overlap.
 *
 * The first delivery is the record's last page (`Pager`), flagged so the
 * caller replaces what it holds, with `page` its number and `life` the
 * life it is numbered for; the pages before it
 * are read separately (`readAcpPage`, and the tool's own history before
 * that). Each later delivery is what was appended since. acpd starts a new
 * life with a fresh record, which the tail tells by its life line rather
 * than by the file shrinking (a `session/load` replay can regrow it within
 * one pass); it asks `origin` where that life's pages go and starts over
 * with a first delivery.
 *
 * `onEvents` is always called at least once, even when no record exists
 * yet (an empty history).
 */
export function tailAcpLog(
  record: AcpRecordRef,
  origin: (life: AcpLife | undefined) => Promise<RecordOrigin>,
  onEvents: (events: AcpEvent[], reset: boolean, page: number, life: string | undefined) => void,
  opts: { intervalMs?: number } = {},
): AcpLogTail {
  let pos = 0
  let lines = new LineReader()
  let projection = new RecordProjection(NO_HISTORY)
  let life: string | undefined
  let closed = false
  let reset = true
  let tooLarge = false

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
      if (reset) {
        reset = false
        onEvents([], true, projection.page, life)
      }
      return
    }

    try {
      const size = (await handle.stat()).size
      const current = await lifeOf(handle)
      if (current?.id !== life || size < pos) {
        life = current?.id
        pos = 0
        lines = new LineReader()
        projection = new RecordProjection(await origin(current))
        reset = true
        tooLarge = false
        if (closed) return
      }
      if ((size === pos && !reset) || tooLarge) return
      // Stop at the cap: the pane says so rather than going quiet.
      if (size > MAX_ACP_SCAN_BYTES) {
        serverLog(`[server] acp log for ${record.agentSessionId}: past ${String(MAX_ACP_SCAN_BYTES)} bytes, no longer followed`)
        tooLarge = true
        const first = reset
        reset = false
        onEvents([projection.number({ type: 'error', message: RECORD_TOO_LARGE })], first, projection.page, life)
        return
      }

      // A first delivery keeps only the last page; a later one, everything.
      let events: AcpEvent[] = []
      const take = (line: string): void => {
        for (const event of projection.line(line)) {
          if (reset && events.length > 0 && acpPageOf(events[0].seq) !== acpPageOf(event.seq)) events = []
          events.push(event)
        }
      }
      const buf = Buffer.allocUnsafe(READ_BYTES)
      while (pos < size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - pos), pos)
        if (bytesRead === 0) break
        pos += bytesRead
        for (const line of lines.push(buf.subarray(0, bytesRead))) take(line)
        if (closed) return
      }
      if (events.length > 0 || reset) {
        const first = reset
        reset = false
        onEvents(events, first, events.length > 0 ? acpPageOf(events[0].seq) : projection.page, life)
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
    number: (event) => projection.number(event),
    close: () => {
      closed = true
      clearInterval(timer)
    },
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

/** Events that are session state rather than conversation, which a skipped
 *  replay still contributes (`RecordOrigin.skipReplay`). */
const STATE_EVENTS: ReadonlySet<AcpEvent['type']> = new Set(['commands', 'models', 'usage'])

/** The user asking the agent to compact (`AcpProjection.unreportedCompaction`). */
const COMPACT_COMMAND = /^\/compact(?:\s|$)/

/** Events a pane dates (`AcpEvent`'s `at`). */
const DATED_EVENTS: ReadonlySet<AcpEvent['type']> = new Set(['user', 'woken'])

/**
 * Projects a record's lines, in order, into the events a pane renders,
 * numbered by page (`Pager`) from the origin's first page. A `session/load`
 * replays the history before this life; with that history read from the
 * tool's own (`skipReplay`), the replay contributes only session state
 * (commands, models, usage).
 *
 * The dated events get their time from the record's last time mark
 * (`ACPD.time`), so a record with none shows them undated. A replay's lines are
 * dated only by marks older than the `session/load` that asked for it: a
 * history built from the tool's own (`AcpRecordWriter`) carries marks from
 * when it happened, while acpd's marks during a live replay say only when
 * it was replayed.
 */
export class RecordProjection {
  private readonly projection = new AcpProjection()
  private readonly pager: Pager
  private readonly skipReplay: boolean
  /** The id of the `session/load` whose replay is being skipped. */
  private skipping: string | undefined
  /** The user's `/compact` awaiting its reply, and how many compactions had
   *  been shown when it was sent. */
  private compact: { id: string; seen: number } | undefined
  private compacts = 0
  /** The last time mark. */
  private mark: number | undefined
  /** The open `session/load`, and the time mark it was sent under. */
  private load: { id: string; sentAt: number } | undefined

  constructor(origin: RecordOrigin = NO_HISTORY) {
    this.pager = new Pager(origin.firstPage)
    this.skipReplay = origin.skipReplay
  }

  /** The page events are being numbered into. */
  get page(): number {
    return this.pager.page
  }

  line(line: string): AcpEvent[] {
    const msg = parseLine(line)
    if (msg === undefined) return []
    let events = this.project(msg)
    if (this.skipping !== undefined) {
      events = events.filter((e) => STATE_EVENTS.has(e.type))
      if (msg.method === undefined && lineId(msg) === this.skipping) this.skipping = undefined
    }
    if (msg.method === undefined && lineId(msg) === this.load?.id) this.load = undefined
    const at = this.time()
    if (at !== undefined) events = events.map((e) => (DATED_EVENTS.has(e.type) ? { ...e, at } : e))
    return this.pager.number(events, line.length + 1)
  }

  /** When the line being projected was recorded, if the record says. */
  private time(): number | undefined {
    if (this.load === undefined) return this.mark
    return this.mark !== undefined && this.mark < this.load.sentAt ? this.mark : undefined
  }

  /** Number an event the record does not hold, after the last one. */
  number(event: AcpEventInit): AcpEvent {
    return this.pager.add(event)
  }

  /** One recorded line's contribution to the rendered conversation. */
  private project(msg: Record<string, unknown>): AcpEventInit[] {
    const projection = this.projection
    const id = lineId(msg)
    if (msg.method === ACPD.time) {
      const at = asRecord(msg.params)?.at
      if (typeof at === 'number' && Number.isFinite(at)) this.mark = at
      return []
    }
    // The agent exited: what it was doing died with it.
    if (msg.method === ACPD.exit) {
      this.skipping = undefined
      projection.agentState(false)
      projection.forgetWakes()
      return projection.endLife()
    }
    // An adapter's own state report, the only boundary a run the agent
    // started itself has.
    const running = agentRunningReport(msg.method, msg.params)
    if (running !== undefined) return projection.agentState(running, msg.params)
    // The client's own prompts. The agent echoes user messages only when
    // replaying under `session/load`, so live prompts appear only here.
    if (msg.method === ACP.sessionPrompt) {
      projection.forgetWakes()
      const content = toContentList(asRecord(msg.params)?.prompt)
      const text = promptText(msg.params)
      if (id !== undefined && text !== undefined && COMPACT_COMMAND.test(text)) {
        this.compact = { id, seen: projection.compactionsSeen }
      }
      return content.length === 0 ? [] : [{ type: 'user', content }]
    }
    // A message steered into a running turn shows once its reply says the
    // agent took it, so one that fell back to `session/prompt` shows once.
    if (msg.method === ACP.sessionSteer) {
      if (id !== undefined) projection.openSteer(id, msg.params)
      return []
    }
    if (msg.method === ACP.sessionLoad) {
      if (id !== undefined) {
        this.load = { id, sentAt: this.mark ?? Infinity }
        projection.openLoad(id)
        if (this.skipReplay) this.skipping = id
      }
      return []
    }
    if (msg.method === ACP.sessionUpdate) return projection.apply(msg.params)
    if (msg.method === ACP.opencodeChildUpdate) return projection.applyChildUpdate(msg.params)
    if (msg.method === CLAUDE_SDK_MESSAGE) return projection.applyClaudeSdk(msg.params)
    // Permission asks and their answers come from the record because an ask
    // that arrived while the relay was down exists only here, and a
    // reattaching pane must see what the agent is blocked on.
    if (msg.method === ACP.requestPermission) {
      return id === undefined ? [] : [projection.openPermission(id, msg.params)]
    }
    // A reply settles a permission ask or a steer, carries the session's
    // models (the handshake's `session/new` or `session/load`, or a model
    // switch), or answers a `/compact`.
    if (msg.method === undefined) {
      if (id === undefined) return []
      const event = projection.closePermission(id, msg.result) ?? projection.closeSteer(id, msg.result)
      if (event !== undefined) return [event]
      const models = sessionModels(msg.result)
      const settled = projection.closeLoad(id) ?? []
      const compact = this.compact?.id === id ? this.compact : undefined
      if (compact !== undefined) this.compact = undefined
      const compacted = compact !== undefined && msg.error === undefined
        ? projection.unreportedCompaction(`compact-${String(this.compacts++)}`, compact.seen)
        : undefined
      return [
        ...settled,
        ...(models !== undefined ? [{ type: 'models' as const, ...models }] : []),
        ...(compacted !== undefined ? [compacted] : []),
      ]
    }
    // Requests and acpd's control lines carry no conversation content.
    return []
  }
}

/**
 * A page's size cap, in record bytes. Past it the page ends at the next user
 * message, or at once past twice the cap, so a conversation that never
 * compacts still loads a page at a time.
 */
export const PAGE_BYTES = 16 * 1024 * 1024

/**
 * Numbers a projected stream's events, starting a new page at each
 * compaction and at the size cap (`PAGE_BYTES`). A new page opens with the
 * session state the pages before it left standing, so a page read alone
 * still offers the composer its commands and models, the strip what is
 * running, and the pane what the agent is waiting on: the latest commands,
 * models and context usage, the subagents and tasks still running, and the
 * permission asks not yet answered. A compaction stays first on its page.
 */
class Pager {
  page: number
  private count = 0
  private bytes = 0
  private readonly compactions = new Set<string>()
  /** What a new page opens with, by what it is the state of. */
  private readonly standing = new Map<string, AcpEventInit>()

  constructor(firstPage = 0) {
    this.page = firstPage
  }

  number(events: AcpEventInit[], bytes: number): AcpEvent[] {
    this.bytes += bytes
    const out: AcpEvent[] = []
    for (const event of events) {
      const compaction = event.type === 'compaction' && !this.compactions.has(event.compaction.id)
      if (event.type === 'compaction') this.compactions.add(event.compaction.id)
      const full = this.bytes > PAGE_BYTES && (event.type === 'user' || this.bytes > 2 * PAGE_BYTES)
      if ((compaction || full) && this.count > 0) {
        this.page++
        this.count = 0
        this.bytes = bytes
        const standing = [...this.standing.values()]
        if (compaction) out.push(this.add(event))
        for (const e of standing) out.push(this.seq(e))
        if (compaction) continue
      }
      out.push(this.add(event))
    }
    return out
  }

  add(event: AcpEventInit): AcpEvent {
    this.track(event)
    return this.seq(event)
  }

  private seq(event: AcpEventInit): AcpEvent {
    return { ...event, seq: this.page * ACP_PAGE_SPAN + this.count++ }
  }

  private track(e: AcpEventInit): void {
    switch (e.type) {
      case 'commands':
      case 'models':
        this.standing.set(e.type, e)
        return
      case 'usage':
        if (e.thread === undefined) this.standing.set(e.type, e)
        return
      case 'subagent':
        if (e.subagent.state === 'running') this.standing.set(`s:${e.subagent.id}`, e)
        else this.standing.delete(`s:${e.subagent.id}`)
        return
      case 'task':
        if (e.task.state === 'running' || e.task.state === 'paused') this.standing.set(`t:${e.task.id}`, e)
        else this.standing.delete(`t:${e.task.id}`)
        return
      case 'permission-request':
        this.standing.set(`p:${e.requestId}`, e)
        return
      case 'permission-resolved':
        this.standing.delete(`p:${e.requestId}`)
        return
      default:
    }
  }
}

/** What a record says was running when it was last written; see
 *  `readAcpRecovery`. */
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

/** What a reattach learns from a conversation's record; see
 *  `readAcpRecovery`. */
export interface AcpRecovery {
  inFlight: AcpInFlight
  /**
   * Permission asks the agent was still blocked on: asks with no recorded
   * answer. Several can be open at once. Ids are verbatim, not strings:
   * JSON-RPC matches ids by value and type, so answering `42` with `"42"`
   * would never pair.
   */
  pendingPermissions: Array<string | number>
  /** The session mode the record last shows: the handshake reply's, then
   *  each successful `session/set_mode` and adapter mode update. */
  modeId?: string
  /** The effort option the record last shows (`sessionEffort`): from the
   *  handshake reply, each config-option reply, and each
   *  `config_option_update`. */
  effort?: AcpEffort
  /** The model the record last shows (`sessionModel`), from the same
   *  messages, or the one a successful model switch asked for when its
   *  reply names none. */
  model?: { id: string; name?: string }
  /** The modes the session offers, from the handshake reply in either
   *  shape. Only the offer is kept; the mode the reply names is `modeId`'s. */
  offered?: { modes?: AcpSessionModes; configOptions?: AcpConfigOption[] }
  /**
   * The handshake was answered, but no mode change has been answered since
   * and no prompt sent. A connection that went down before its posture call
   * landed leaves this, and the next one makes the launch's effort and
   * posture calls (`AcpConversation`). An answered effort change does not
   * settle it: acpd records a reply that arrives after the connection that
   * asked has gone. Adapters whose posture is no mode (pi, most of
   * opencode's) stay unsettled until the first prompt, which costs a reattach
   * only an effort call when the session's differs from the row's.
   */
  launchUnsettled?: true
}

/**
 * Everything a reattaching connection reads back from the record, in one
 * pass over it. A reattach runs no handshake, and ACP gives a reconnecting
 * client no way to ask what the agent is doing, but the record holds both
 * directions:
 *
 * - A prompt is in flight if the last recorded one has no recorded reply.
 *   Turns never overlap (`AcpConversation` queues them, and a steered
 *   message joins the running turn), so only the last can be open. An
 *   adapter that reports its own state also covers turns the agent started
 *   itself, including one codex starts from a steer it answers
 *   `startedNewTurn`.
 * - An ask is pending if it has no recorded answer; the ask went to a
 *   connection that is gone and nothing replays it.
 * - The mode, effort and model are the last ones recorded, since the
 *   session may have changed any of them while disconnected; the modes it
 *   offers are the handshake's.
 *
 * acpd's exit line ends a life: what was running and asked dies with it.
 * No record means nothing running and nothing recorded.
 */
export async function readAcpRecovery(record: AcpRecordRef): Promise<AcpRecovery> {
  const handle = await openRecord(record)
  if (handle === null) return { inFlight: { prompt: false }, pendingPermissions: [] }
  try {
    return await recover(recordLines(handle))
  } finally {
    await handle.close()
  }
}

/**
 * The `session/new` acpd recorded its agent being sent last: the reply's
 * result once that is recorded, `pending` while it is not, and undefined if
 * none was sent, it was refused, or there is no record. A server that went
 * down mid-handshake leaves one behind for the next connection to adopt
 * (`AcpConversationDeps.recordedSessionNew`).
 */
export async function readRecordedSessionNew(record: AcpRecordRef): Promise<{ result: unknown } | 'pending' | undefined> {
  const handle = await openRecord(record)
  if (handle === null) return undefined
  try {
    let sent: string | undefined
    let reply: Record<string, unknown> | undefined
    for await (const line of recordLines(handle)) {
      const msg = parseLine(line)
      const id = msg === undefined ? undefined : lineId(msg)
      if (msg === undefined || id === undefined) continue
      if (msg.method === ACP.sessionNew) {
        sent = id
        reply = undefined
      } else if (id === sent && msg.method === undefined) {
        reply = msg
      }
    }
    if (sent === undefined) return undefined
    if (reply === undefined) return 'pending'
    return 'result' in reply ? { result: reply.result } : undefined
  } finally {
    await handle.close()
  }
}

async function recover(lines: AsyncIterable<string>): Promise<AcpRecovery> {
  let pending: string | number | undefined
  const steers = new Set<string | number>()
  let agentRunning: boolean | undefined
  let backgroundWork: boolean | undefined
  // Keyed by string form for pairing, valued by the original id.
  const asks = new Map<string, string | number>()
  let modeId: string | undefined
  // Requests whose reply moves the state, by id: a handshake (whose reply
  // reports it), a mode switch, or a model switch.
  const asked = new Map<string, { handshake?: true; mode?: true; modeId?: string; model?: string }>()
  let effort: AcpEffort | undefined
  let model: { id: string; name?: string } | undefined
  let offered: AcpRecovery['offered']
  let launchUnsettled = false
  // The conversation's own session, as the handshake names it.
  let sessionId: string | undefined
  for await (const line of lines) {
    const msg = parseLine(line)
    if (msg === undefined) continue
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : undefined
    switch (msg.method) {
      case ACP.sessionPrompt:
        launchUnsettled = false
        // Without an id it is a notification, which is never answered.
        if (id !== undefined) pending = id
        continue
      case ACP.sessionSteer:
        if (id !== undefined) steers.add(id)
        continue
      case ACP.sessionCancel:
        // As live (`AcpConversation.cancel`): Stop with no prompt running
        // drops the adapter's report.
        if (pending === undefined) agentRunning = undefined
        continue
      case ACP.requestPermission:
        if (id !== undefined) asks.set(String(id), id)
        continue
      case ACPD.exit:
        // The agent exited, and its turn and asks with it; acpd starts a
        // fresh record for the next life.
        pending = undefined
        agentRunning = undefined
        backgroundWork = undefined
        asks.clear()
        continue
      case ACP.sessionNew:
      case ACP.sessionLoad:
        sessionId = asString(asRecord(msg.params)?.sessionId)
        if (id !== undefined) asked.set(String(id), { handshake: true })
        continue
      case ACP.sessionSetMode: {
        const set = asString(asRecord(msg.params)?.modeId)
        if (id !== undefined) asked.set(String(id), { mode: true, ...(set !== undefined ? { modeId: set } : {}) })
        continue
      }
      case ACP.sessionSetConfigOption: {
        const params = asRecord(msg.params)
        const set = params?.configId === 'model' ? asString(params.value) : undefined
        if (id !== undefined) asked.set(String(id), set !== undefined ? { model: set } : {})
        continue
      }
      case ACP.sessionUpdate: {
        if (fromOtherSession(msg.params, sessionId)) continue
        const update = asRecord(asRecord(msg.params)?.update)
        if (update !== undefined) {
          modeId = sessionModeId(update) ?? modeId
          effort = sessionEffort(update) ?? effort
          if (update.sessionUpdate === 'config_option_update') model = sessionModel(update) ?? model
        }
        break
      }
    }
    agentRunning = agentRunningReport(msg.method, msg.params) ?? agentRunning
    backgroundWork = backgroundWorkReport(msg.method, msg.params) ?? backgroundWork
    // Only a reply (no method) closes a turn, settles an ask or moves state;
    // an `error` means the request did nothing.
    if (msg.method !== undefined) continue
    const ask = id !== undefined ? asked.get(String(id)) : undefined
    if (id !== undefined) asked.delete(String(id))
    // A refused mode change settles the launch too: asking again would be
    // refused.
    if (ask?.handshake === true) launchUnsettled = msg.error === undefined
    else if (ask?.mode === true) launchUnsettled = false
    if (msg.error === undefined) {
      const result = asRecord(msg.result)
      effort = sessionEffort(result) ?? effort
      model = sessionModel(result) ?? (ask?.model !== undefined ? { id: ask.model } : model)
      if (ask !== undefined) modeId = ask.modeId ?? sessionStateModeId(result) ?? modeId
      if (ask?.handshake === true) {
        sessionId = asString(result?.sessionId) ?? sessionId
        const available = asRecord(result?.modes)?.availableModes
        offered = {
          ...(Array.isArray(available) ? { modes: { availableModes: available as AcpSessionModes['availableModes'] } } : {}),
          ...(Array.isArray(result?.configOptions) ? { configOptions: result.configOptions as AcpConfigOption[] } : {}),
        }
      }
    }
    if (id === undefined) continue
    if (id === pending) {
      pending = undefined
      // As live (`AcpConversation.runTurn`): a refused prompt drops the
      // adapter's report.
      if (msg.error !== undefined) agentRunning = undefined
    }
    if (steers.delete(id) && asRecord(msg.result)?.outcome === 'startedNewTurn') agentRunning = true
    asks.delete(String(id))
  }
  return {
    inFlight: {
      prompt: pending !== undefined,
      ...(agentRunning !== undefined ? { agentRunning } : {}),
      ...(backgroundWork !== undefined ? { backgroundWork } : {}),
    },
    pendingPermissions: [...asks.values()],
    ...(modeId !== undefined ? { modeId } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(offered !== undefined ? { offered } : {}),
    ...(launchUnsettled ? { launchUnsettled: true as const } : {}),
  }
}

/**
 * How much of each record line `readAcpFirstPrompt` keeps, and how much it
 * reads at once. Adapters may write long lines before the opening message
 * (opencode's model lists), so the record is read up to that message, but
 * memory stays bounded however large the record or its lines grow. The read
 * stops at `MAX_ACP_RECORD_BYTES`, because a conversation nobody has
 * prompted is rescanned on every reconcile pass.
 */
const LINE_HEAD_CHARS = 64 * 1024

/**
 * A `session/prompt` line too long to parse, and the text block at its
 * start if that fits in the line's head.
 */
const TRUNCATED_PROMPT =
  /"method":"session\/prompt"(?:.*?"prompt":\[\{"type":"text","text":("(?:[^"\\]|\\.)*"))?/

/**
 * The conversation's opening user message, used as the workspace's sidebar
 * label. Read from the record so the registry, which runs on a reconcile
 * tick, needs no live connection. A line cut to its head is typically an
 * opening message with an image; its text is still reachable because
 * `AcpConversation.prompt` writes the text block before the images.
 */
export async function readAcpFirstPrompt(record: AcpRecordRef): Promise<string | undefined> {
  const handle = await openRecord(record)
  if (handle === null) return undefined
  try {
    for await (const line of lineHeads(handle)) {
      const msg = parseLine(line)
      if (msg?.method === ACP.sessionPrompt) return promptText(msg.params)
      const cut = TRUNCATED_PROMPT.exec(line)
      if (cut) return cut[1] === undefined ? undefined : JSON.parse(cut[1]) as string
    }
    return undefined
  } finally {
    await handle.close()
  }
}

/**
 * Each line of a record's first `MAX_ACP_RECORD_BYTES`, cut to its first
 * `LINE_HEAD_CHARS`. One decoder spans the reads so a character split
 * between two is not shown as U+FFFD.
 */
async function* lineHeads(handle: FileHandle): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  const buf = Buffer.alloc(LINE_HEAD_CHARS)
  let head = ''
  for (let pos = 0; pos < MAX_ACP_RECORD_BYTES;) {
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, MAX_ACP_RECORD_BYTES - pos), pos)
    if (bytesRead === 0) break
    pos += bytesRead
    const parts = decoder.write(buf.subarray(0, bytesRead)).split('\n')
    for (const [i, part] of parts.entries()) {
      if (i > 0) {
        yield head
        head = ''
      }
      if (head.length < LINE_HEAD_CHARS) head = (head + part).slice(0, LINE_HEAD_CHARS)
    }
  }
  if (head !== '') yield head
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

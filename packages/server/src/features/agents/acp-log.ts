/**
 * Reader for the conversation record acpd tees as it relays
 * (`dockerfiles/acpd/acpd.js`). This is where a pane's history comes from.
 *
 * The record is the verbatim JSON-RPC stream, both directions, in arrival
 * order — so replaying it is the same translation the live path does, through
 * the same `acp-protocol` projection. That is the whole reason the log is in
 * ACP's vocabulary rather than the agent's own transcript format: one
 * translator, not two that can disagree about what a conversation looked like.
 *
 * Because acpd writes it whether or not anyone is attached, and onto a
 * host-mounted path, the server needs to retain nothing itself: a pane
 * attaching reads the file, and a pod that is long gone still has a readable
 * conversation.
 *
 * The record is not merely where history comes from — it is the ONLY path by
 * which conversation content reaches a pane, live content included. See
 * `tailAcpLog` for why that is forced rather than chosen.
 */

import fs from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { ACP, ACPD, AcpProjection } from './acp-protocol'
import { serverLog } from '#log'
import type { AcpEvent, AcpEventInit } from '@yaac/shared/acp'

/**
 * Read a conversation's record. A missing file is not an error — a
 * conversation whose agent has not spoken yet simply has no history — so it
 * answers with an empty replay.
 */
export async function readAcpLog(logPath: string): Promise<AcpEvent[]> {
  let raw: string
  try {
    raw = await fs.readFile(logPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      serverLog(`[server] acp log ${logPath}: ${String(err)}`)
    }
    return []
  }
  return replayAcpLog(raw)
}

/**
 * Project a recorded stream into the events a pane renders. Exported
 * separately from the file read so the projection can be exercised without a
 * filesystem.
 *
 * Every line is tolerated: the record can end mid-write while the agent is
 * streaming, and an adapter that printed something that is not JSON-RPC put it
 * in here too. Neither is a reason to lose the conversation.
 */
export function replayAcpLog(raw: string): AcpEvent[] {
  const projection = new AcpProjection()
  return raw
    .split('\n')
    .flatMap((line) => projectLine(line, projection))
    .map((event, seq) => ({ ...event, seq }) as AcpEvent)
}

/** How often a tail looks for newly appended bytes. Short enough that a
 *  streaming reply reads as streaming, long enough that an idle conversation
 *  costs one open + two small reads a tick. */
const TAIL_INTERVAL_MS = 150

/**
 * How much of the record's head to read to identify the life that wrote it.
 * acpd's `_acpd/life` line is byte 0 of every life and carries only a uuid and
 * a timestamp, so this is generous.
 */
const LIFE_HEADER_BYTES = 512

export interface AcpLogTail {
  /** Read whatever has been appended since the last pass, now. Used before
   *  emitting anything that must order *after* the record's contents. */
  flush(): Promise<void>
  close(): void
}

/**
 * Follow a record as it grows, projecting each newly appended line.
 *
 * This is the ONLY path by which conversation content reaches a pane. The
 * socket carries the RPC half — our requests and their replies, and the
 * agent's questions — but not a single rendered message, because two copies of
 * one stream cannot be spliced: the record and the socket carry the same
 * `session/update` notifications, ACP gives notifications no identity, and
 * joining them at an unknown point either duplicates the overlap or drops it.
 * One source has no join.
 *
 * A new agent life resets the reader — position, partial line, decoder and
 * projection all start again, and the batch is flagged so the caller replaces
 * rather than appends. Lives are told apart by the id in acpd's `_acpd/life`
 * header rather than by the record getting shorter: a restart whose
 * `session/load` replay regrows the file past where we were reading, inside
 * one tick, is not visible as a shrink but is still a different conversation.
 *
 * `onEvents` is always called at least once, even for a record that does not
 * exist yet — a conversation whose agent has not spoken has an empty history,
 * not a missing one.
 */
export function tailAcpLog(
  logPath: string,
  onEvents: (events: AcpEventInit[], reset: boolean) => void,
  opts: { intervalMs?: number } = {},
): AcpLogTail {
  let pos = 0
  let residual = ''
  let projection = new AcpProjection()
  // Bytes are decoded through a decoder that spans passes, because a pass
  // boundary lands wherever the writer happened to be: acpd appends one
  // `writeSync` per agent stdout chunk and those chunks split characters, so
  // decoding `[pos, size)` on its own would turn a straddling character into
  // a pair of U+FFFDs inside otherwise valid JSON.
  let decoder = new StringDecoder('utf8')
  let lifeId: string | undefined
  let closed = false
  let first = true
  // A restart seen but not yet reported. acpd empties the file before writing
  // a byte, so a pass can land on a record of size 0 — nothing to project, but
  // the caller must still be told to start over, or the next pass's events
  // would be appended to the previous life's.
  let pendingReset = false

  const startOver = (): void => {
    pendingReset = true
    pos = 0
    residual = ''
    decoder = new StringDecoder('utf8')
    projection = new AcpProjection()
  }

  const runPass = async (): Promise<void> => {
    if (closed) return
    let handle
    try {
      handle = await fs.open(logPath, 'r')
    } catch {
      // No record yet. The first pass still reports, so a pane learns it has
      // an empty history rather than waiting for one.
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
        // Undefined on both sides means a record with no header — a partial
        // first write, or a log acpd could not stamp. Treat only a *change*
        // as a restart, and keep the size heuristic as the fallback for a
        // record that never identifies itself.
        if (lifeId !== undefined || life !== undefined) startOver()
        lifeId = life
      }
      if (size < pos) startOver()

      const reset = pendingReset || first
      if (size === pos && !reset) return

      let raw = ''
      if (size > pos) {
        const buf = Buffer.alloc(size - pos)
        const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
        raw = decoder.write(buf.subarray(0, bytesRead))
        pos += bytesRead
      }

      const lines = (residual + raw).split('\n')
      // A record being appended to always ends mid-line; hold it for next pass.
      residual = lines.pop() ?? ''
      const events = lines.flatMap((line) => projectLine(line, projection))
      first = false
      if (events.length > 0 || reset) {
        pendingReset = false
        onEvents(events, reset)
      }
    } finally {
      await handle.close()
    }
  }

  // Passes are serialized on a chain rather than skipped while one is running.
  // `flush()` exists to order the caller's next message *after* the record's
  // contents, and a flush that returned early because the interval had just
  // fired would resolve without having read the bytes it was called to read.
  let chain: Promise<void> = Promise.resolve()
  const pass = (): Promise<void> => {
    chain = chain.then(runPass, runPass)
    return chain
  }

  const timer = setInterval(() => void pass(), opts.intervalMs ?? TAIL_INTERVAL_MS)
  // Kick the first pass immediately so an attach does not wait out a tick.
  void pass()

  return {
    // Await the chain first: an in-flight pass may have `stat`ed before the
    // bytes we need were appended, so ordering after it is not enough on its
    // own — we need one that starts now.
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
async function readLifeId(handle: fs.FileHandle): Promise<string | undefined> {
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

/** One recorded line's contribution to the rendered conversation. */
function projectLine(line: string, projection: AcpProjection): AcpEventInit[] {
  if (line.trim() === '') return []
  let msg: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return []
    msg = parsed as Record<string, unknown>
  } catch {
    // Adapter noise, or a line the writer had not finished when we read.
    return []
  }
  // The client's own prompts. The agent echoes a user message only when
  // replaying under `session/load`, so for anything said live these lines are
  // the only record that a user spoke at all.
  if (msg.method === ACP.sessionPrompt) {
    const text = promptText(msg.params)
    return text === undefined ? [] : [{ type: 'user', content: [{ type: 'text', text }] }]
  }
  if (msg.method === ACP.sessionUpdate) {
    const event = projection.apply(msg.params)
    return event === undefined ? [] : [event]
  }
  // Responses, `initialize`, `session/new` and acpd's control lines carry no
  // conversation content.
  return []
}

/**
 * How much of a record to scan for the opening message. The first prompt sits
 * near the top by construction — after the life header and the handshake, all
 * of which are small — so a bounded read answers the question without paying
 * for a conversation that has since grown to megabytes. Not finding one in
 * this much means there isn't one.
 */
const FIRST_PROMPT_SCAN_BYTES = 64 * 1024

/**
 * The conversation's opening user message — what labels a worktree in the
 * sidebar.
 *
 * Taken from the record rather than watched on the live stream, so a worktree
 * can be labelled without a conversation being attached: the registry runs on
 * a reconciler tick, and coupling it to a live connection is the dependency the
 * record exists to break.
 */
export async function readAcpFirstPrompt(logPath: string): Promise<string | undefined> {
  let handle
  try {
    handle = await fs.open(logPath, 'r')
  } catch {
    return undefined
  }
  try {
    const buf = Buffer.alloc(FIRST_PROMPT_SCAN_BYTES)
    const { bytesRead } = await handle.read(buf, 0, FIRST_PROMPT_SCAN_BYTES, 0)
    // Through a decoder, so a character straddling the scan boundary is held
    // back rather than becoming a U+FFFD in a sidebar label. Whatever it holds
    // is discarded with it: an incomplete trailing line is not an answer.
    const head = new StringDecoder('utf8').write(buf.subarray(0, bytesRead))
    for (const line of head.split('\n')) {
      if (line.trim() === '') continue
      let msg: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed !== 'object' || parsed === null) continue
        msg = parsed as Record<string, unknown>
      } catch {
        // The scan can end mid-line; a truncated tail is not an answer.
        continue
      }
      if (msg.method === ACP.sessionPrompt) return promptText(msg.params)
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

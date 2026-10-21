import { acpPage, attachAcp, claudeSubagentThreads, type AcpSocket, type SandboxFile } from '#runtime/agents'
import type { AgentSessionLinkRow } from '#db'
import { errorText, serverLog } from '#lib/log'
import {
  claudeTranscript, conversation, followHistory, historyFiles, historyStamp, recordOrigin, type FollowedHistory,
} from './transcript'
import type { AcpClientMessage, AcpEvent, AcpServerMessage } from '@yaac/shared/acp'

/**
 * Readers following a running workspace's conversation (`/acp/observe`,
 * docs/multi-user.md "Following a teammate's conversation"), who see it as
 * it happens but cannot drive it.
 *
 * An `acp` conversation is attached like a chat pane with every control
 * frame dropped (`attachAcp`). A `tui` one has no record, only its tool's
 * own history, so one `HistoryTail` per conversation follows that for all
 * of its readers: it stats the history's files a few times a second,
 * translates them when they change (`followHistory`, which for claude reads
 * only what was appended), and sends each reader the events added since.
 * Readers past the first cost only the frames sent to them.
 */
export async function observeConversation(
  projectId: string,
  workspaceId: string,
  agentSessionId: string,
  sock: AcpSocket,
): Promise<void> {
  // A socket that closes during the lookup is never put on a tail.
  let closed = false
  sock.onClose(() => {
    closed = true
  })
  const session = await conversation(projectId, workspaceId, agentSessionId)
  if (closed) return
  if (session === undefined) {
    send(sock, { type: 'health', connected: false })
    sock.close(1011, 'no such conversation')
    return
  }
  if (session.mode === 'acp') {
    attachAcp(projectId, workspaceId, agentSessionId, sock,
      (life) => recordOrigin(projectId, workspaceId, agentSessionId, life), { control: false })
    return
  }
  const key = JSON.stringify([projectId, workspaceId, agentSessionId])
  let tail = tails.get(key)
  if (tail === undefined) {
    const created: HistoryTail = new HistoryTail(projectId, workspaceId, session, () => {
      if (tails.get(key) === created) tails.delete(key)
    })
    tail = created
    tails.set(key, tail)
  }
  sock.onClose(tail.add(sock))
}

const tails = new Map<string, HistoryTail>()

/** End every tail, for tests. */
export function stopHistoryTails(): void {
  for (const tail of [...tails.values()]) tail.stop()
}

/** How often a tail stats its files. */
const TAIL_INTERVAL_MS = 250
/** How often it lists them again, to find a subagent's or rollout's new
 *  file; a conversation with no file yet is listed every pass. */
const RELIST_MS = 5000
/** How long a tail outlives its last reader, so a reconnect or a tab switch
 *  finds it warm. */
const IDLE_MS = 30_000

interface Reader {
  sock: AcpSocket
  greeted: boolean
  /** The subagent whose transcript this reader last asked for, sent again
   *  whenever it grows. */
  thread?: string
}

/** A subagent transcript as last translated, and the stamp of the
 *  subagents' files it was translated at. */
interface Thread {
  stamp: string
  frame: AcpServerMessage
}

/**
 * One `tui` conversation followed for its readers. Its history and the
 * subagent transcripts its readers follow are each translated once per
 * change to their files, however many readers there are, and the result is
 * sent to all of them. A pass runs at most one at a time, and the next
 * starts no sooner than four times the last one took, so a slow
 * translation runs less often rather than taking more of the server.
 *
 * Each reader is greeted with the conversation's last page, then sent what
 * each translation added. A translation that changed what was already sent
 * (a claude `/rewind`, a new codex rollout) greets every reader again, as a
 * new agent life does an attached pane.
 */
class HistoryTail {
  private readonly readers = new Set<Reader>()
  private files: Array<{ file: SandboxFile; thread: boolean }> = []
  private claudeFile: SandboxFile | undefined
  private listedAt = -Infinity
  private stamp: string | undefined
  private history: FollowedHistory | undefined
  private readonly threads = new Map<string, Thread>()
  private notBefore = 0
  private running = false
  private stopped = false
  private readonly timer: NodeJS.Timeout
  private idle: NodeJS.Timeout | undefined

  constructor(
    private readonly projectId: string,
    private readonly workspaceId: string,
    private readonly session: AgentSessionLinkRow,
    private readonly onStop: () => void,
  ) {
    this.timer = setInterval(() => void this.pass(), TAIL_INTERVAL_MS)
    this.timer.unref()
    void this.pass()
  }

  add(sock: AcpSocket): () => void {
    clearTimeout(this.idle)
    const reader: Reader = { sock, greeted: false }
    this.readers.add(reader)
    sock.onMessage((data, isBinary) => {
      if (isBinary) return
      let msg: AcpClientMessage
      try {
        msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')) as AcpClientMessage
      } catch {
        return
      }
      if (msg.type === 'subagent-transcript' && typeof msg.subagentId === 'string') this.follow(reader, msg.subagentId)
    })
    if (this.history !== undefined) this.greet(reader)
    return () => this.remove(reader)
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    clearTimeout(this.idle)
    this.onStop()
  }

  private remove(reader: Reader): void {
    this.readers.delete(reader)
    if (this.readers.size > 0 || this.stopped) return
    this.idle = setTimeout(() => this.stop(), IDLE_MS)
    this.idle.unref()
  }

  private async pass(): Promise<void> {
    if (this.running || this.stopped || Date.now() < this.notBefore) return
    this.running = true
    // The first read also loads the translator and reads the whole
    // history, so it says little about what the next will cost.
    const first = this.history === undefined
    const started = Date.now()
    try {
      if (started - this.listedAt >= RELIST_MS || !this.files.some((f) => !f.thread)) {
        this.files = await historyFiles(this.projectId, this.workspaceId, this.session)
        this.claudeFile = await claudeTranscript(this.projectId, this.workspaceId, this.session)
        this.listedAt = started
      }
      const stamp = await historyStamp(this.files.flatMap((f) => (f.thread ? [] : [f.file])))
      if (stamp !== this.stamp) await this.translate(stamp)
      await this.translateThreads()
      this.notBefore = Date.now() + Math.max(TAIL_INTERVAL_MS, first ? 0 : 4 * (Date.now() - started))
    } catch (err) {
      serverLog(`[server] history tail ${this.workspaceId}/${this.session.agentSessionId}: ${errorText(err)}`)
      this.notBefore = Date.now() + RELIST_MS
    } finally {
      this.running = false
    }
  }

  private async translate(stamp: string): Promise<void> {
    let history: FollowedHistory
    try {
      history = await followHistory(this.projectId, this.workspaceId, this.session, this.claudeFile, this.history)
    } catch (err) {
      // With nothing shown yet, readers are told why (a conversation past
      // the size cap), and it is read again once its files next change.
      if (this.history !== undefined) throw err
      const message = err instanceof Error ? err.message : String(err)
      history = { stamp: '', events: [{ type: 'error', message, seq: 0 }], lineage: {} }
    }
    this.stamp = stamp
    this.publish(history)
  }

  private publish(history: FollowedHistory): void {
    const prev = this.history
    this.history = history
    if (prev === history) return
    const grew = prev !== undefined
      && (history.lineage === prev.lineage || extendsEvents(prev.events, history.events))
    if (!grew) {
      for (const reader of this.readers) this.greet(reader)
      return
    }
    const added = history.events.slice(prev.events.length)
    for (const reader of this.readers) {
      if (!reader.greeted) this.greet(reader)
      else for (const event of added) send(reader.sock, { type: 'event', event })
    }
  }

  private greet(reader: Reader): void {
    reader.greeted = true
    const { page, events } = acpPage(this.history?.events ?? [])
    send(reader.sock, {
      type: 'hello', agentSessionId: this.session.agentSessionId, busy: false, queued: [], history: true, page, events,
    })
  }

  /** Follow a subagent's transcript for `reader`, in place of the one it
   *  followed before. Only one the conversation announced may be read. */
  private follow(reader: Reader, subagentId: string): void {
    const announced = this.history?.events.some((e) => e.type === 'subagent' && e.subagent.id === subagentId) === true
    if (!announced) {
      send(reader.sock, { type: 'subagent-transcript', subagentId, error: 'no such subagent' })
      return
    }
    reader.thread = subagentId
    const known = this.threads.get(subagentId)
    if (known !== undefined) send(reader.sock, known.frame)
    // Its file may be new since the last listing.
    else this.listedAt = -Infinity
  }

  /**
   * Translate each subagent transcript a reader follows that changed since
   * it was last translated, once, and send it to every reader following
   * it. One nobody follows any more is forgotten.
   */
  private async translateThreads(): Promise<void> {
    const followed = new Set([...this.readers].flatMap((r) => (r.thread !== undefined ? [r.thread] : [])))
    for (const id of this.threads.keys()) if (!followed.has(id)) this.threads.delete(id)
    if (followed.size === 0) return
    const stamp = await historyStamp(this.files.flatMap((f) => (f.thread ? [f.file] : [])))
    for (const subagentId of followed) {
      if (this.threads.get(subagentId)?.stamp === stamp) continue
      // Only claude keeps a subagent's transcript apart; for another tool
      // there is nothing to read and the thread stays as the history has it.
      const file = this.claudeFile
      const frame = await (file === undefined ? Promise.resolve([]) : claudeSubagentThreads(file, [subagentId])).then(
        (events): AcpServerMessage => ({ type: 'subagent-transcript', subagentId, events }),
        (err: unknown): AcpServerMessage => ({ type: 'subagent-transcript', subagentId, error: errorText(err) }),
      )
      this.threads.set(subagentId, { stamp, frame })
      for (const reader of this.readers) if (reader.thread === subagentId) send(reader.sock, frame)
    }
  }
}

/** Whether `next` is `prev` with events added at its end. */
function extendsEvents(prev: AcpEvent[], next: AcpEvent[]): boolean {
  return next.length >= prev.length && prev.every((e, i) => JSON.stringify(e) === JSON.stringify(next[i]))
}

/** Send a frame to a socket that may already be gone. */
function send(sock: AcpSocket, msg: AcpServerMessage): void {
  try {
    sock.send(JSON.stringify(msg))
  } catch {
    // The reader left mid-write; its close handler removes it.
  }
}

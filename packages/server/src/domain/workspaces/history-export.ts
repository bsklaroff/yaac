/**
 * A workspace's conversation history as `yaac-mama history` hands it out:
 * each conversation's files as the tool left them (see `conversationFiles`),
 * running or stopped, read through confined reads since the workspace wrote
 * them.
 *
 * Files are streamed, never held whole, and each is cut at the length it had
 * when opened, so a running agent's last line can be partial. A file over
 * `MAX_HISTORY_FILE_BYTES` is never sent: a workspace can make one as large
 * as it likes (a sparse file costs it nothing), and the caller would write
 * every byte.
 */
import { Readable } from 'node:stream'
import { ServerError } from '@yaac/shared/errors'
import {
  ACP_RECORD_NAME,
  conversationFiles,
  openConversationFile,
  type ConversationFile,
} from '#runtime/agents'
import type { AgentSessionLinkRow } from '#db'

export const MAX_HISTORY_FILE_BYTES = 256 * 1024 * 1024

export interface HistoryConversation {
  row: AgentSessionLinkRow
  files: ConversationFile[]
}

/** Names the script's one-per-line file listing could not carry intact; a
 *  workspace could plant one. */
const UNLISTABLE = /[\x00-\x1f\x7f\\"]/

/** Each conversation with the files it left (none for one with none on the
 *  host). */
export async function withFiles(
  projectId: string,
  workspaceId: string,
  rows: AgentSessionLinkRow[],
): Promise<HistoryConversation[]> {
  const files = await conversationFiles(projectId, workspaceId, rows)
  return rows.map((row) => ({
    row,
    files: (files.get(row.agentSessionId) ?? []).filter((f) => !UNLISTABLE.test(f.name)),
  }))
}

/** Whether a file is too large to hand out. */
export const oversized = (f: ConversationFile): boolean => f.size > MAX_HISTORY_FILE_BYTES

/**
 * One conversation's JSONL transcripts concatenated, the main one first, each
 * ending in a newline. acpd's record is left out when the tool wrote
 * transcripts of its own, which it would only repeat in another format.
 */
export function historyTranscripts(files: ConversationFile[]): ReadableStream<Uint8Array> {
  const jsonl = files.filter((f) => f.name.endsWith('.jsonl'))
  const own = jsonl.filter((f) => f.name !== ACP_RECORD_NAME)
  return historyFiles(own.length > 0 ? own : jsonl, { newlines: true })
}

/**
 * Files streamed back to back, optionally each ending in a newline. A file
 * gone since it was listed is skipped. One listed over the cap is refused up
 * front, rather than leaving a gap; one that grew past it since is cut off
 * mid-stream, which the caller sees as a broken download.
 */
export function historyFiles(files: ConversationFile[], opts: { newlines?: boolean } = {}): ReadableStream<Uint8Array> {
  const big = files.find(oversized)
  if (big !== undefined) {
    throw new ServerError('TOO_LARGE', `${big.name} is ${formatSize(big.size)}, past the `
      + `${formatSize(MAX_HISTORY_FILE_BYTES)} a file is handed out at`)
  }
  async function* concat(): AsyncGenerator<Buffer> {
    for (const f of files) {
      const fh = await openConversationFile(f)
      if (fh === null) continue
      try {
        const { size } = await fh.stat()
        if (size > MAX_HISTORY_FILE_BYTES) throw new Error(`${f.name} grew past ${formatSize(MAX_HISTORY_FILE_BYTES)}`)
        if (size === 0) continue
        let last: number | undefined
        for await (const chunk of fh.createReadStream({ start: 0, end: size - 1, autoClose: false }) as AsyncIterable<Buffer>) {
          last = chunk.at(-1)
          yield chunk
        }
        if (opts.newlines === true && last !== 0x0a) yield Buffer.from('\n')
      } finally {
        await fh.close()
      }
    }
  }
  return Readable.toWeb(Readable.from(concat())) as ReadableStream<Uint8Array>
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

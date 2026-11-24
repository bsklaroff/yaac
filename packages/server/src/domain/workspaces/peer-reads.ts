/**
 * What one workspace's agent reads of another's (`yaac-mama history` and
 * `fetch`), running or stopped: its conversations, each with its files as
 * the tool left them (see `conversationFiles`), read through confined reads
 * since the workspace wrote them, and a git bundle of a checkout's
 * branches.
 *
 * Files are streamed, never held whole, and each is cut at the length it had
 * when opened, so a running agent's last line can be partial. A file over
 * `MAX_HISTORY_FILE_BYTES` is never sent: a workspace can make one as large
 * as it likes (a sparse file costs it nothing), and the caller would write
 * every byte.
 */
import path from 'node:path'
import { Readable } from 'node:stream'
import { ServerError } from '@yaac/shared/errors'
import { formatSize } from '@yaac/shared/sizes'
import { repoDir, workspaceDir } from '@yaac/shared/project-paths'
import { ACP_RECORD_NAME, conversationFiles, openConversationFile, type ConversationFile } from '#runtime/agents'
import { listWorkspaceConversations, listWorkspaceRepos, type ConversationLinkRow } from '#db'
import { bundleCheckout } from '#domain/git'
import { withCwds } from './conversation-paths'
import { resolveWorkspaceRecord } from './resolve'

const MAX_HISTORY_FILE_BYTES = 256 * 1024 * 1024

interface HistoryConversation {
  row: ConversationLinkRow
  files: ConversationFile[]
}

/**
 * A workspace's conversations, first held first, each with its files and
 * when it was last active (its row's time or its newest file's), or just
 * the one `conversation` names by id or unique prefix. A file over the cap
 * is listed with `oversized`, since it is never handed out.
 */
export async function workspaceHistory(idOrPrefix: string, conversation?: string) {
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  const short = workspaceId.slice(0, 8)
  // The conversation is picked before files are gathered, which reads
  // every one's.
  let rows = await listWorkspaceConversations(projectId, workspaceId)
  if (conversation !== undefined) {
    const exact = rows.find((r) => r.conversationId === conversation)
    rows = exact !== undefined ? [exact] : rows.filter((r) => r.conversationId.startsWith(conversation))
    if (rows.length !== 1) {
      throw new ServerError(rows.length === 0 ? 'NOT_FOUND' : 'VALIDATION', rows.length === 0
        ? `no conversation '${conversation}' in ${short}`
        : `'${conversation}' matches more than one conversation in ${short} — use a longer prefix`)
    }
  }
  return {
    workspaceId,
    /** The largest file handed out. */
    maxFileBytes: MAX_HISTORY_FILE_BYTES,
    conversations: (await withFiles(projectId, workspaceId, rows)).map(({ row, files }) => {
      const last = Math.max(0, row.lastActiveAt?.getTime() ?? 0, ...files.map((f) => f.mtimeMs))
      return {
        conversationId: row.conversationId,
        tool: row.tool,
        mode: row.mode,
        active: row.active,
        ...(row.model !== undefined ? { model: row.model } : {}),
        ...(last > 0 ? { lastActiveAt: new Date(last).toISOString() } : {}),
        ...(row.firstPrompt !== undefined ? { firstPrompt: row.firstPrompt } : {}),
        files: files.map((f) => ({ name: f.name, size: f.size, ...(oversized(f) ? { oversized: true } : {}) })),
      }
    }),
  }
}

/**
 * One conversation's history to save: its file named `file`, or its JSONL
 * transcripts (opencode's database, which keeps its history, for a
 * conversation of opencode's), with the content type each is and the
 * workspace's full id.
 */
export async function workspaceHistoryContent(
  idOrPrefix: string,
  conversationId: string,
  file?: string,
): Promise<{ workspaceId: string; body: ReadableStream<Uint8Array>; contentType: string }> {
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  const row = (await listWorkspaceConversations(projectId, workspaceId)).find((r) => r.conversationId === conversationId)
  if (row === undefined) throw new ServerError('NOT_FOUND', `no conversation '${conversationId}' in ${workspaceId.slice(0, 8)}`)
  const [{ files }] = await withFiles(projectId, workspaceId, [row])
  if (file !== undefined) {
    const found = files.find((f) => f.name === file)
    if (found === undefined) throw new ServerError('NOT_FOUND', `${conversationId} has no file '${file}'`)
    return { workspaceId, body: historyFiles([found]), contentType: 'application/octet-stream' }
  }
  const database = files.find((f) => f.sqlite === true)
  if (database !== undefined) return { workspaceId, body: historyFiles([database]), contentType: 'application/vnd.sqlite3' }
  if (!files.some((f) => f.name.endsWith('.jsonl'))) {
    throw new ServerError('NOT_FOUND', `${conversationId} has no transcript on the host yet`)
  }
  return { workspaceId, body: historyTranscripts(files), contentType: 'application/x-ndjson' }
}

/**
 * A git bundle of a workspace's branches and HEAD in its checkout of
 * repo `repoId`, running or stopped, for another workspace to fetch into its
 * own. Its git dir is read as data, never run (`bundleCheckout`), and
 * nothing is written to it.
 */
export async function workspaceBundle(idOrPrefix: string, repoId: string): Promise<{ workspaceId: string; bundle: Buffer<ArrayBuffer> }> {
  const { projectId, workspaceId } = await resolveWorkspaceRecord(idOrPrefix)
  const short = workspaceId.slice(0, 8)
  const theirs = (await listWorkspaceRepos(workspaceId)).find((r) => r.repoId === repoId)
  if (!theirs) throw new ServerError('NOT_FOUND', `${short} has no checkout of this repo`)
  try {
    return { workspaceId, bundle: await bundleCheckout(path.join(workspaceDir(projectId, workspaceId), theirs.path), repoDir(repoId)) }
  } catch (err) {
    throw new ServerError('CONFLICT', `cannot read ${short}'s git: ${(err as Error).message}`)
  }
}

/** Names the script's one-per-line file listing could not carry intact; a
 *  workspace could plant one. */
const UNLISTABLE = /[\x00-\x1f\x7f\\"]/

/** Each conversation with the files it left (none for one with none on the
 *  host). */
async function withFiles(
  projectId: string,
  workspaceId: string,
  rows: ConversationLinkRow[],
): Promise<HistoryConversation[]> {
  const files = await conversationFiles(projectId, workspaceId, await withCwds(rows))
  return rows.map((row) => ({
    row,
    files: (files.get(row.conversationId) ?? []).filter((f) => !UNLISTABLE.test(f.name)),
  }))
}

/** Whether a file is too large to hand out. */
const oversized = (f: ConversationFile): boolean => f.size > MAX_HISTORY_FILE_BYTES

/**
 * One conversation's JSONL transcripts concatenated, the main one first, each
 * ending in a newline. acpd's record is left out when the tool wrote
 * transcripts of its own, which it would only repeat in another format.
 */
function historyTranscripts(files: ConversationFile[]): ReadableStream<Uint8Array> {
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
function historyFiles(files: ConversationFile[], opts: { newlines?: boolean } = {}): ReadableStream<Uint8Array> {
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

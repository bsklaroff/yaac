/**
 * Renders a `tui` opencode conversation as the same `AcpEvent[]` an `acp` one
 * produces. A tui conversation has no acpd record, only opencode's own
 * history: the `session_message` rows of its session and of the subagent
 * sessions under it. This module turns those rows into the record
 * `opencode acp` would have streamed to yaac live, and replays that through
 * `replayAcpLog`.
 *
 * The mapping follows @opencode/cli 2.0.21 (the version
 * dockerfiles/Dockerfile.tools installs): its `session/load` replay for each
 * message part, and its live stream where the two differ, since that is what
 * an `acp` conversation shows. So the user's prompts become `session/prompt`
 * lines (text, then images), as yaac sends them. A subagent's updates become
 * `opencode/session/child_update` notifications, as opencode sends them to a
 * client declaring `OPENCODE_CAPABILITIES_META`: placed inside the call that
 * spawned the subagent, with its tool call ids and titles prefixed as live,
 * and without its prompt, which live never shows.
 *
 * Two kinds of row only the TUI writes are rendered as the closest thing a
 * client could have sent: a `!command` the user ran (a `shell` row) is the
 * prompt they typed plus the shell call with its output, and a manual
 * compaction is the `/compact` prompt that starts one over ACP.
 *
 * Dropped, because neither the live stream nor yaac's projection renders
 * them: the text a slash command expands into is shown in place of the
 * `/command` typed (opencode stores only the expansion, and live renders no
 * reply to a command at all), and these are not shown:
 *  - a failed step's error and a turn's stop reason, which live arrive as the
 *    prompt's reply, and replay never reads;
 *  - synthetic and system messages, skills, compaction summaries, and agent,
 *    model and directory switches, which the model sees but the stream skips;
 *  - token usage, retries and models, which need the model catalog or are
 *    session state rather than conversation;
 *  - permission asks, which opencode does not persist.
 *
 * Where the rows are read depends on who wrote the database. Under
 * containerless the workspace is the user's own process, so its database is
 * queried read-only in place. A sandboxed workspace wrote its database, so the
 * server never opens that with SQLite: the pod's checkpoint script exports the
 * rows as JSONL beside it (`OPENCODE_EXPORT_DIR`), and that file is read like
 * any other agent-written transcript. Both give the same rows. See
 * docs/workspace-storage.md, "opencode".
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ServerError } from '@yaac/shared/errors'
import { opencodeCheckpointDir } from '@yaac/shared/project-paths'
import { ConfinedPathError } from '#lib/confined-fs'
import { serverLog } from '#log'
import { AcpRecordWriter, MAX_ACP_RECORD_BYTES } from './acp-log'
import { ACP, asRecord, asString } from './acp-protocol'
import { jsonObjects, parseJson } from './jsonl'
import { readSandboxFile, sandboxLinkPolicy } from './sandbox-fs'
import { conversationFiles } from './transcripts'
import type { AcpEvent } from '@yaac/shared/acp'

/**
 * The directory in a workspace's opencode checkpoint holding the export, one
 * `<root session id>.jsonl` per conversation. Keep in sync with
 * workspace-bin/yaac-opencode-checkpoint.
 */
const OPENCODE_EXPORT_DIR = 'yaac-transcripts'

/** An opencode session id, as the export names its files. */
const SESSION_ID = /^ses_[A-Za-z0-9]+$/

/**
 * One history row: a session (`type: 'session'`, with its parent, title and
 * directory) or one of its messages (`data` is the message). The export's
 * lines have this shape; so do the rows read from a database here.
 */
type Row = Record<string, unknown>

/** A conversation's history, as read by `getAgentSessionTranscript`. */
export async function opencodeTranscriptAsAcp(
  projectId: string,
  workspaceId: string,
  agentSessionId: string,
): Promise<AcpEvent[]> {
  if (!SESSION_ID.test(agentSessionId)) return []
  const rows = sandboxLinkPolicy() === 'inside'
    ? await databaseRows(projectId, workspaceId, agentSessionId)
    : await exportRows(projectId, workspaceId, agentSessionId)
  return synthesizeAcpRecord(rows, agentSessionId).replay()
}

/** The export's rows, or none before the checkpoint has written one. */
async function exportRows(projectId: string, workspaceId: string, root: string): Promise<Row[]> {
  const file = { projectId, dir: opencodeCheckpointDir(projectId, workspaceId), rel: `${OPENCODE_EXPORT_DIR}/${root}.jsonl` }
  let raw: Buffer | null
  try {
    raw = await readSandboxFile(file, MAX_ACP_RECORD_BYTES)
  } catch (err) {
    if (err instanceof ConfinedPathError && err.reason === 'too-large') throw tooLarge()
    throw err
  }
  return jsonObjects(raw?.toString('utf8') ?? '')
}

/**
 * The rows of a host workspace's live database, the conversation's session
 * and every session below it. A `-wal` beside the database means opencode may
 * be writing, so a read-only connection reads through it; without one the
 * file is the whole database, and is opened immutable so that nothing (not
 * even a lock file) is written beside it.
 */
async function databaseRows(projectId: string, workspaceId: string, root: string): Promise<Row[]> {
  const [listed] = (await conversationFiles(projectId, workspaceId, [{ tool: 'opencode', mode: 'tui', agentSessionId: root }]))
    .get(root) ?? []
  if (listed === undefined) return []
  const file = path.join(listed.file.dir, listed.file.rel)
  const writing = await fs.lstat(`${file}-wal`).then(() => true, () => false)
  const url = pathToFileURL(file)
  url.searchParams.set('immutable', '1')
  // Loaded only here (an ExperimentalWarning on Node 22).
  /* eslint-disable-next-line no-restricted-syntax -- deferring it is the point; see above */
  const { DatabaseSync } = await import('node:sqlite')
  const rows: Row[] = []
  let bytes = 0
  try {
    const db = new DatabaseSync(writing ? file : url, { readOnly: true })
    try {
      const session = db.prepare('select parent_id, title, directory from session_v2 where id = ?')
      const children = db.prepare('select id from session_v2 where parent_id = ? order by time_created')
      const messages = db.prepare('select type, seq, data from session_message where session_id = ? order by seq')
      const queue = [root]
      const queued = new Set(queue)
      for (const id of queue) {
        const s = session.get(id)
        if (s === undefined) continue
        rows.push({ session: id, type: 'session', parent: s.parent_id, title: s.title, directory: s.directory })
        for (const c of children.all(id)) {
          const child = String(c.id)
          if (queued.has(child)) continue
          queued.add(child)
          queue.push(child)
        }
        for (const m of messages.iterate(id)) {
          bytes += String(m.data).length
          if (bytes > MAX_ACP_RECORD_BYTES) throw tooLarge()
          rows.push({ session: id, type: m.type, seq: m.seq, data: parseJson(String(m.data)) })
        }
      }
    } finally {
      db.close()
    }
  } catch (err) {
    if (err instanceof ServerError) throw err
    // A database opencode is migrating, or a torn read, shows no history.
    serverLog(`[server] opencode history of ${workspaceId}: ${String(err)}`)
    return []
  }
  return rows
}

function tooLarge(): ServerError {
  return new ServerError(
    'TOO_LARGE',
    `this conversation is past the ${String(MAX_ACP_RECORD_BYTES / (1024 * 1024))} MB a transcript can be shown at`,
  )
}

interface Session {
  id: string
  parent?: string
  title?: string
  directory?: string
  messages: Array<{ type: unknown; data: Row }>
}

/** Who a child update is from, as opencode names a subagent. */
interface Child {
  rootSessionId: string
  childSessionId: string
  parentSessionId: string
  depth: number
  title?: string
}

/** The deepest subagent nesting played. */
const MAX_SUBAGENT_DEPTH = 16

/** A subagent's final state, by the outcome its session went idle with. */
const IDLE_STATUS: Record<string, string> = {
  succeeded: 'completed',
  interrupted: 'interrupted',
  failed: 'failed',
}

/** The JSON-RPC lines `opencode acp` would have sent for a conversation. */
function synthesizeAcpRecord(rows: Row[], rootId: string): AcpRecordWriter {
  const sessions = new Map<string, Session>()
  for (const row of rows) {
    const id = asString(row.session)
    if (id === undefined) continue
    const s = sessions.get(id) ?? { id, messages: [] }
    sessions.set(id, s)
    if (row.type === 'session') {
      s.parent = asString(row.parent)
      s.title = asString(row.title)
      s.directory = asString(row.directory)
    } else {
      s.messages.push({ type: row.type, data: asRecord(row.data) ?? {} })
    }
  }
  const record = new AcpRecordWriter()
  const root = sessions.get(rootId)
  if (root === undefined) return record
  // Tools run in the conversation's directory, the cwd opencode reports for
  // a subagent's calls too.
  const cwd = root.directory ?? '/'
  const send = (method: string, params: unknown): void => {
    record.write({ method, params })
  }
  const prompt = (blocks: Row[]): void => {
    if (blocks.length > 0) send(ACP.sessionPrompt, { sessionId: rootId, prompt: blocks })
  }
  const spawned = new Set<string>([rootId])
  // Each session's subagents in order, and how many of them are placed, so
  // finding the next unplaced one does not rescan every session.
  const children = new Map<string, { list: Session[]; next: number }>()
  for (const c of sessions.values()) {
    if (c.parent === undefined) continue
    const of = children.get(c.parent) ?? { list: [], next: 0 }
    of.list.push(c)
    children.set(c.parent, of)
  }

  const play = (s: Session, child?: Child): void => {
    const update = (u: Row): void => {
      if (child === undefined) send(ACP.sessionUpdate, { sessionId: rootId, update: u })
      else send(ACP.opencodeChildUpdate, { ...child, type: 'update', update: inChild(u, child) })
    }
    const status = (value: string): void => {
      if (child !== undefined) send(ACP.opencodeChildUpdate, { ...child, type: 'status', status: value })
    }
    // A subagent's session, played where the call that spawned it ran: the
    // one its result names, or failing that (a call still running) the next
    // not yet placed.
    const subagent = (state: Row = {}): Session | undefined => {
      const named = sessions.get(asString(asRecord(state.metadata)?.sessionID) ?? '')
      if (named?.parent === s.id && !spawned.has(named.id)) {
        spawned.add(named.id)
        return named
      }
      const of = children.get(s.id)
      while (of !== undefined && of.next < of.list.length) {
        const c = of.list[of.next++]
        if (!spawned.has(c.id)) {
          spawned.add(c.id)
          return c
        }
      }
      return undefined
    }
    const spawn = (c: Session): void => {
      // opencode does not nest subagents by default; a deeper chain is a
      // crafted one, and playing it would recurse without bound.
      if ((child?.depth ?? 0) >= MAX_SUBAGENT_DEPTH) return
      play(c, {
        rootSessionId: rootId,
        childSessionId: c.id,
        parentSessionId: s.id,
        depth: (child?.depth ?? 0) + 1,
        ...(c.title !== undefined && c.title !== '' ? { title: c.title } : {}),
      })
    }

    status('created')
    let running = false
    for (const { type, data } of s.messages) {
      if (type === 'user' && child === undefined) {
        const text = asString(data.text) ?? ''
        prompt([...(text === '' ? [] : [{ type: 'text', text }]), ...userImages(data.files)])
      } else if (type === 'shell' && child === undefined) {
        const command = asString(data.command) ?? ''
        prompt([{ type: 'text', text: `!${command}` }])
        const output = asString(asRecord(data.output)?.output) ?? ''
        const part = {
          id: asString(data.shellID),
          name: 'shell',
          state: data.status === 'running'
            ? { status: 'running', input: { command } }
            : { status: 'completed', input: { command }, content: [{ type: 'text', text: output }] },
        }
        for (const u of toolUpdates(part, cwd)) update(u)
      } else if (type === 'compaction' && child === undefined && data.reason === 'manual') {
        prompt([{ type: 'text', text: '/compact' }])
      } else if (type === 'assistant') {
        if (!running) status('running')
        running = true
        for (const raw of Array.isArray(data.content) ? data.content : []) {
          const part = asRecord(raw) ?? {}
          const text = asString(part.text)
          if (part.type === 'text' || part.type === 'reasoning') {
            if (text === undefined || text === '') continue
            update({
              sessionUpdate: part.type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
              content: { type: 'text', text },
            })
            continue
          }
          const [first, ...rest] = toolUpdates(part, cwd)
          if (first === undefined) continue
          update(first)
          const c = toolKind(asString(part.name) ?? '') === 'think' ? subagent(asRecord(part.state)) : undefined
          if (c !== undefined) spawn(c)
          for (const u of rest) update(u)
        }
      } else if (type === 'idle' && running) {
        const outcome = IDLE_STATUS[asString(data.outcome) ?? '']
        if (outcome !== undefined) status(outcome)
        running = false
      }
    }
    // A subagent no call claimed still ran under this session.
    for (let c = subagent(); c !== undefined; c = subagent()) spawn(c)
  }

  play(root)
  return record
}

/** A subagent's update as opencode forwards it: its tool calls are keyed and
 *  titled under the subagent's own. */
function inChild(u: Row, c: Child): Row {
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return u
  const title = asString(u.title)
  return {
    ...u,
    toolCallId: `${c.childSessionId}:${String(u.toolCallId)}`,
    ...(title !== undefined && title !== '' && c.title !== undefined ? { title: `${c.title}: ${title}` } : {}),
  }
}

/** The images a user message attached, as the blocks yaac prompts with. A
 *  file the TUI attached by path is a link ACP has no block for here. */
function userImages(files: unknown): Row[] {
  return (Array.isArray(files) ? files : []).flatMap((raw) => {
    const f = asRecord(raw) ?? {}
    const source = asRecord(f.source)
    const inline = source?.type === 'uri' ? /^data:([^;]+);base64,(.*)$/.exec(asString(source.uri) ?? '') : undefined
    const mimeType = inline === undefined ? asString(f.mime) : inline?.[1]
    const data = inline === undefined ? asString(f.data) : inline?.[2]
    return mimeType?.startsWith('image/') === true && data !== undefined ? [{ type: 'image', mimeType, data }] : []
  })
}

/**
 * The updates opencode sends for one tool part, by the state it was left in:
 * the call, then its result (or, still running, its input). The call is
 * pending with no input while the model was still writing it.
 */
function toolUpdates(part: Row, cwd: string): Row[] {
  const id = asString(part.id)
  if (id === undefined) return []
  const name = asString(part.name) ?? 'tool'
  const state = asRecord(part.state) ?? {}
  const input = state.status === 'streaming' ? {} : asRecord(state.input) ?? {}
  const call = {
    toolCallId: id,
    title: toolTitle(name, input),
    kind: toolKind(name),
    locations: toolLocations(name, input, cwd),
    rawInput: input,
  }
  const first = { sessionUpdate: 'tool_call', ...call, status: 'pending' }
  switch (state.status) {
    case 'running':
      return [first, { sessionUpdate: 'tool_call_update', ...call, status: 'in_progress' }]
    case 'completed':
      return [first, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: completedContent(name, input, state.content) }]
    case 'error': {
      const error = asString(asRecord(state.error)?.message) ?? ''
      return [first, {
        sessionUpdate: 'tool_call_update',
        ...call,
        status: 'failed',
        content: [...toolContent(state.content), { type: 'content', content: { type: 'text', text: error } }],
      }]
    }
    default:
      return [first]
  }
}

/** A finished call's content. A read's result is the file text opencode
 *  extracts from its JSON form, an edit's old and new strings become a diff,
 *  and images go last. */
function completedContent(name: string, input: Row, raw: unknown): Row[] {
  const content = toolContent(raw)
  const images = content.filter((c) => asRecord(c.content)?.type === 'image')
  const firstText = (Array.isArray(raw) ? raw : []).map(asRecord).find((c) => c?.type === 'text')
  const read = name.toLowerCase() === 'read' && firstText !== undefined ? readText(asString(firstText.text) ?? '') : undefined
  const oldText = asString(input.oldString)
  const newText = asString(input.newString)
  return [
    ...(read === undefined ? content.filter((c) => !images.includes(c)) : [{ type: 'content', content: { type: 'text', text: read } }]),
    ...(oldText !== undefined && newText !== undefined
      ? [{ type: 'diff', path: asString(input.path) ?? asString(input.filePath) ?? '', oldText, newText }]
      : []),
    ...images,
  ]
}

/** A read result given as JSON (a text page, or a directory's entries), as
 *  the text opencode shows; undefined for a plain-text result. */
function readText(text: string): string | undefined {
  if (!text.startsWith('{')) return undefined
  const parsed = asRecord(parseJson(text)) ?? {}
  if (typeof parsed.content === 'string' && (parsed.type === 'text-page' || parsed.encoding === 'utf8')) return parsed.content
  if (!Array.isArray(parsed.entries)) return undefined
  return parsed.entries.flatMap((e) => {
    const entry = typeof e === 'string' ? e : asString(asRecord(e)?.path)
    return entry === undefined ? [] : [entry]
  }).join('\n')
}

/** A tool result's text and inline images as ACP tool content. */
function toolContent(raw: unknown): Row[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item): Row[] => {
    const c = asRecord(item) ?? {}
    if (c.type === 'text') {
      const text = asString(c.text)
      return text === undefined ? [] : [{ type: 'content', content: { type: 'text', text } }]
    }
    const image = /^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/.exec(asString(c.uri) ?? '')
    return image?.[1].startsWith('image/') === true
      ? [{ type: 'content', content: { type: 'image', mimeType: image[1], data: image[2] } }]
      : []
  })
}

const isShell = (name: string): boolean => ['bash', 'shell'].includes(name.toLowerCase())

function toolTitle(name: string, input: Row): string {
  return isShell(name) ? asString(input.command) ?? asString(input.cmd) ?? name : name
}

const TOOL_KINDS: Record<string, string> = {
  bash: 'execute',
  shell: 'execute',
  webfetch: 'fetch',
  edit: 'edit',
  apply_patch: 'edit',
  patch: 'edit',
  write: 'edit',
  grep: 'search',
  glob: 'search',
  context: 'search',
  context7_resolve_library_id: 'search',
  context7_get_library_docs: 'search',
  read: 'read',
  task: 'think',
  subagent: 'think',
}

function toolKind(name: string): string {
  return TOOL_KINDS[name.toLowerCase()] ?? 'other'
}

/** The paths a call is about: a shell call's working directory, or the file
 *  or directory a read, search or edit names. */
function toolLocations(name: string, input: Row, cwd: string): Array<{ path: string }> {
  const kind = toolKind(name)
  const target = kind === 'execute'
    ? shellCwd(input, cwd)
    : kind === 'edit' ? asString(input.filePath) ?? asString(input.filepath)
    : kind === 'read' || kind === 'search' ? asString(input.path)
    : undefined
  return target === undefined || target === '' ? [] : [{ path: target }]
}

function shellCwd(input: Row, cwd: string): string {
  const dir = asString(input.workdir) ?? asString(input.cwd)
  return dir === undefined || dir === '' ? cwd : path.posix.resolve(cwd, dir)
}

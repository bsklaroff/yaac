/**
 * Renders a `tui` codex conversation as the same `AcpEvent[]` an `acp` one
 * produces. A tui conversation has no acpd record, only codex's rollouts, so
 * this synthesizes the `session/update` lines the pinned codex-acp adapter
 * (dockerfiles/Dockerfile.tools) sends live to a client declaring
 * `CODEX_CAPABILITIES_META`, and feeds them to `replayAcpLog`. Live rather
 * than the adapter's `session/load` replay is the target where they differ.
 *
 * codex persists each item (`event_msg` `item_completed`) only once it ends,
 * with its start and end times. Every rollout's entries are merged into one
 * timeline by those times, so a tool call opens where it started, a command
 * left running at a turn's end becomes a background task there, and a
 * subagent's updates interleave with its parent's as they did live.
 *
 * Items and their updates:
 *  - UserMessage: the main thread's become the prompt yaac would have sent
 *    (a steer when the turn is already under way); a subagent's are its
 *    parent's words, which the adapter does not show.
 *  - AgentMessage, Reasoning: message and thought chunks. Plan (plan mode's
 *    proposed plan): message text after the message it ends.
 *  - CommandExecution: a tool call titled as the adapter titles it, its output
 *    as `terminal_output_delta`; one still running at its turn's end is an
 *    async task until it exits.
 *  - FileChange (diffs), McpToolCall, WebSearch, ImageView, ImageGeneration,
 *    ContextCompaction, CollabAgentToolCall: tool calls.
 *  - SubAgentActivity: a started agent is a subagent whose rollout is
 *    replayed under its own session id until its first turn ends, it is
 *    interrupted, or its parent's turn stops; like the adapter, nothing
 *    after that is shown (a follow-up turn included) but its background
 *    commands' ends.
 *  - `update_plan` calls: plans. `token_count`: usage. Turn starts and ends:
 *    the thread status reports; a failed turn's error as message text.
 *
 * Dropped on purpose:
 *  - DynamicToolCall: only an app-server client registers dynamic tools, and
 *    the TUI registers none.
 *  - EnteredReviewMode, ExitedReviewMode: the review's text is also the
 *    AgentMessage after it, which is shown. HookPrompt, FunctionCallOutput,
 *    Sleep: the adapter shows none of them.
 *  - What codex never persists: an item that has not ended (a running
 *    command, or a wait cut short by a stop), a plan set from code mode's
 *    `exec` cell, warnings and notices, a TUI slash command (`/review`,
 *    `/compact`) as a user message, and session state (models, commands,
 *    modes).
 *  - Exchanges only an ACP client has: permission asks, plan approval.
 *  - Rollouts from before codex persisted `item_completed` show nothing but
 *    their usage and turn reports.
 *
 * Small differences from live remain: a command's output is one chunk sent
 * with its end, a steer shows where codex took it rather than when it was
 * sent, and a proposed plan follows the message it ended instead of
 * splitting it.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpRecordWriter } from './acp-log'
import { ACP, asRecord, asString, unifiedDiffHunks } from './acp-protocol'
import { jsonObjects, parseJson } from './jsonl'
import type { AcpEvent } from '@yaac/shared/acp'

type Json = Record<string, unknown>

/**
 * A conversation's history from its rollouts: the conversation's own first,
 * then every descendant's (see `conversationFiles`).
 */
export function codexTranscriptAsAcp(rollouts: string[]): AcpEvent[] {
  return synthesizeAcpRecord(rollouts).replay()
}

/** One point on the merged timeline. `seq` keeps file order among ties. */
interface Entry {
  ms: number
  seq: number
  thread: string
  /** The turn the line or item belongs to, when codex names one. */
  turn?: string
  /** An item's start or end, or any other rollout line. */
  item?: { at: 'start' | 'end'; value: Json }
  line?: Json
}

/** Every rollout's entries in time order, and the conversation's own
 *  thread. */
function timeline(rollouts: string[]): { entries: Entry[]; main?: string } {
  const entries: Entry[] = []
  let main: string | undefined
  rollouts.forEach((raw, file) => {
    let thread: string | undefined
    let ms = 0
    jsonObjects(raw).forEach((line, i) => {
      const payload = asRecord(line.payload) ?? {}
      if (line.type === 'session_meta') thread ??= asString(payload.id)
      if (thread === undefined) return
      if (file === 0) main ??= thread
      ms = Date.parse(asString(line.timestamp) ?? '') || ms
      const seq = (file * 2 ** 24 + i) * 2
      const item = asRecord(payload.item)
      const turn = asString(payload.turn_id)
      if (payload.type !== 'item_completed' || item === undefined) {
        entries.push({ ms, seq, thread, turn, line })
        return
      }
      const time = (key: string): number => typeof payload[key] === 'number' ? payload[key] : ms
      // A rollout can hold another thread's items: a review's.
      const owner = asString(payload.thread_id) ?? thread
      entries.push({ ms: time('started_at_ms'), seq, thread: owner, turn, item: { at: 'start', value: item } })
      entries.push({ ms: time('completed_at_ms'), seq: seq + 1, thread: owner, turn, item: { at: 'end', value: item } })
    })
  })
  return { entries: entries.sort((a, b) => a.ms - b.ms || a.seq - b.seq), main }
}

/** The rollouts as the record acpd would have written over ACP. */
function synthesizeAcpRecord(rollouts: string[]): AcpRecordWriter {
  const { entries, main } = timeline(rollouts)
  const record = new AcpRecordWriter()
  /** The message that began each main-thread turn, which yaac's prompt
   *  line precedes everything the turn does, such as a compaction codex
   *  runs before it. */
  const prompts = new Map<string, Json>()
  /** The images each user message sent, as data URLs. A message keeps an
   *  attached file only as its path; the data is in the model input
   *  recorded just before it. */
  const images = new Map<Json, string[]>()
  let sent: string[] = []
  for (const { thread, turn, item, line } of entries) {
    if (thread !== main) continue
    const payload = asRecord(line?.payload)
    if (line?.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
      sent = (Array.isArray(payload.content) ? payload.content : []).map(asRecord)
        .flatMap((c) => (c?.type === 'input_image' ? [asString(c.image_url) ?? ''] : []))
    }
    if (item?.at !== 'end' || item.value.type !== 'UserMessage') continue
    images.set(item.value, sent)
    if (turn !== undefined && !prompts.has(turn)) prompts.set(turn, item.value)
  }
  /** Each subagent's parent thread and last reported state. Once it leaves
   *  `running` its updates are dropped, as the adapter drops them. */
  const subagents = new Map<string, { parent: string; state: string }>()
  const runningSubagents = new Set<string>()
  /** Threads in a turn, those whose turn start is not yet reported, and
   *  the proposed plan each holds back. */
  const inTurn = new Set<string>()
  const pendingStart = new Set<string>()
  const plans = new Map<string, string>()
  /** Each thread's commands started and neither ended nor announced as
   *  background tasks, and the announced ones, by the adapter's task id.
   *  Announcing moves a command from one to the other, so a turn's end
   *  looks only at what is still unannounced. */
  const foreground = new Map<string, Map<string, Json>>()
  const tasks = new Set<string>()
  /** Opening messages already sent as their turn's prompt. */
  const begun = new Set<Json>()
  let steers = 0

  const write = (msg: Json): void => {
    record.write(msg)
  }
  const send = (thread: string, update: Json): void => {
    write({ method: ACP.sessionUpdate, params: { sessionId: thread, update } })
  }
  const status = (type: string): Json => ({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type } } } })
  // A turn's start is reported after the prompt that began it. A proposed
  // plan streams after the message it ends, which codex persists later, so
  // it waits for the next update that is not message text.
  const emit = (thread: string, update: Json): void => {
    if (pendingStart.delete(thread)) send(thread, status('active'))
    const plan = plans.get(thread)
    if (plan !== undefined && update.sessionUpdate !== 'agent_message_chunk') {
      plans.delete(thread)
      send(thread, chunk('agent_message_chunk', plan))
    }
    send(thread, update)
  }
  const prompt = (thread: string, item: Json): void => {
    const content = userContent(item.content, images.get(item) ?? [])
    if (content.length === 0) return
    // A message sent into a running turn is a steer the agent took.
    if (inTurn.has(thread)) {
      const steer = `steer-${String(++steers)}`
      write({ id: steer, method: ACP.sessionSteer, params: { sessionId: thread, prompt: content } })
      write({ id: steer, result: { outcome: 'injected' } })
    } else {
      write({ method: ACP.sessionPrompt, params: { sessionId: thread, prompt: content } })
    }
  }
  /** A thread's commands still running when its turn or its life as a
   *  subagent ends go on as background tasks. */
  const background = (thread: string): void => {
    for (const [taskId, item] of foreground.get(thread) ?? []) {
      tasks.add(taskId)
      emit(thread, {
        sessionUpdate: 'async_task_spawned',
        asyncTaskId: taskId,
        name: commandStart(item).title,
        taskType: 'shell',
        canStop: true,
        toolCallId: item.id,
      })
    }
    foreground.delete(thread)
  }
  const endSubagent = (id: string, state: string): void => {
    const s = subagents.get(id)
    if (s?.state !== 'running') return
    s.state = state
    runningSubagents.delete(id)
    send(s.parent, { sessionUpdate: 'subagent_state_update', subagentSessionId: id, state })
    background(id)
  }
  const endTurn = (thread: string, state: string, error?: string): void => {
    inTurn.delete(thread)
    background(thread)
    emit(thread, status('idle'))
    if (error !== undefined) send(thread, chunk('agent_message_chunk', `${error}\n\n`))
    endSubagent(thread, state)
    // The main turn failing or stopping ends the subagents still running.
    if (thread === main && state !== 'completed') for (const id of runningSubagents) endSubagent(id, state)
  }
  /** A command's end: its task's, then its call's. */
  const endCommand = (thread: string, taskId: string, item: Json, shown: boolean): void => {
    foreground.get(thread)?.delete(taskId)
    const end = toolEnd(item)
    if (tasks.delete(taskId)) {
      emit(thread, { sessionUpdate: 'async_task_state_update', asyncTaskId: taskId, state: end.status, toolCallId: item.id })
    }
    if (!shown) return
    // Only a shell command's output is shown; a read's or search's is not.
    const output = asString(item.aggregated_output) ?? ''
    emit(thread, commandStart(item).kind === 'execute' && output !== '' ? { ...end, _meta: { terminal_output_delta: { data: output } } } : end)
  }
  const onItem = (thread: string, at: 'start' | 'end', item: Json): void => {
    const id = asString(item.id) ?? ''
    switch (item.type) {
      case 'UserMessage':
        if (at === 'end' && thread === main && !begun.has(item)) prompt(thread, item)
        return
      case 'SubAgentActivity': {
        const child = asString(item.agent_thread_id)
        if (at === 'start' || child === undefined) return
        if (item.kind === 'started' && !subagents.has(child)) {
          subagents.set(child, { parent: thread, state: 'running' })
          runningSubagents.add(child)
          const name = agentName(asString(item.agent_path) ?? '', child)
          emit(thread, { sessionUpdate: 'subagent_spawned', subagentSessionId: child, name, task: `Delegated task for ${name}` })
          send(child, status('idle'))
        }
        if (item.kind === 'interrupted') endSubagent(child, 'cancelled')
        return
      }
      case 'Plan':
        if (at === 'end') plans.set(thread, (plans.get(thread) ?? '') + (asString(item.text) ?? ''))
        return
      case 'CommandExecution': {
        const taskId = thread === main ? id : `${thread}:${id}`
        if (at === 'end') return endCommand(thread, taskId, item, true)
        foreground.set(thread, (foreground.get(thread) ?? new Map<string, Json>()).set(taskId, item))
        emit(thread, { sessionUpdate: 'tool_call', toolCallId: id, status: 'in_progress', ...commandStart(item) })
        return
      }
      default:
        for (const update of itemUpdates(item, at)) emit(thread, update)
    }
  }

  for (const { thread, turn, item, line } of entries) {
    if (thread !== main && subagents.get(thread)?.state !== 'running') {
      // An ended subagent's background command still ends its task.
      const id = asString(item?.value.id) ?? ''
      if (item?.at === 'end' && item.value.type === 'CommandExecution') endCommand(thread, `${thread}:${id}`, item.value, false)
      continue
    }
    if (item !== undefined) {
      onItem(thread, item.at, item.value)
      continue
    }
    const payload = asRecord(line?.payload) ?? {}
    switch (line?.type === 'event_msg' ? payload.type : line?.type) {
      case 'task_started': {
        const opening = turn === undefined ? undefined : prompts.get(turn)
        if (opening !== undefined && !begun.has(opening)) {
          begun.add(opening)
          prompt(thread, opening)
        }
        pendingStart.add(thread)
        inTurn.add(thread)
        break
      }
      case 'task_complete': {
        const error = asString(asRecord(payload.error)?.message)
        endTurn(thread, error === undefined ? 'completed' : 'failed', error)
        break
      }
      case 'turn_aborted':
        endTurn(thread, 'cancelled')
        break
      case 'token_count': {
        const info = asRecord(payload.info)
        const used = asRecord(info?.last_token_usage)?.total_tokens
        const size = info?.model_context_window
        if (typeof used === 'number' && typeof size === 'number') emit(thread, { sessionUpdate: 'usage_update', used, size })
        break
      }
      case 'response_item':
        // Direct calls only: code mode's `exec` cell keeps its calls in
        // script source.
        if (payload.type === 'function_call' && payload.name === 'update_plan' && payload.namespace === undefined) {
          emit(thread, { sessionUpdate: 'plan', entries: planEntries(payload.arguments) })
        }
    }
  }
  return record
}

/** A tool call's or text item's updates at its start or end. Commands,
 *  user messages, proposed plans and subagents are the caller's. */
function itemUpdates(item: Json, at: 'start' | 'end'): Json[] {
  const toolCallId = asString(item.id) ?? ''
  const start = (fields: Json): Json[] => at === 'start'
    ? [{ sessionUpdate: 'tool_call', toolCallId, status: 'in_progress', ...fields }]
    : [toolEnd(item)]
  switch (item.type) {
    case 'AgentMessage': {
      const text = (Array.isArray(item.content) ? item.content : [])
        .map((c) => asString(asRecord(c)?.text) ?? '').join('')
      return at === 'end' && text !== '' ? [chunk('agent_message_chunk', text)] : []
    }
    case 'Reasoning': {
      const summary = strings(item.summary_text)
      const text = summary.length > 0 ? summary.map((s) => `\n\n${s}`).join('') : strings(item.raw_content).join('')
      return at === 'end' && text !== '' ? [chunk('agent_thought_chunk', text)] : []
    }
    case 'FileChange':
      return start({ kind: 'edit', title: 'Editing files', content: fileDiffs(item.changes) })
    case 'McpToolCall':
      return start({
        kind: 'execute',
        title: `mcp.${asString(item.server) ?? ''}.${asString(item.tool) ?? ''}`,
        rawInput: { server: item.server, tool: item.tool, arguments: item.arguments },
      })
    case 'WebSearch':
      return start({ kind: 'search', title: webSearchTitle(item) })
    case 'ContextCompaction':
      return start({ kind: 'think', title: 'Compact conversation' })
    case 'CollabAgentToolCall': {
      const prompt = asString(item.prompt)
      return start({
        kind: 'other',
        title: (asString(item.tool) ?? '').replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
        ...(prompt ? { content: [textContent(prompt)] } : {}),
      })
    }
    case 'ImageView': {
      const file = localPath(asString(item.path) ?? '')
      return at === 'start'
        ? [{ sessionUpdate: 'tool_call', toolCallId, kind: 'read', title: `View Image ${file}`, status: 'completed', locations: [{ path: file }] }]
        : []
    }
    case 'ImageGeneration': {
      if (at === 'start') return start({ kind: 'other', title: 'Image generation' })
      const revised = asString(item.revised_prompt)?.trim()
      const image = asString(item.result)?.trim()
      // The item has ended, so a provider status such as `generating`
      // counts as completed, as the adapter counts it.
      return [{
        ...toolEnd({ ...item, status: item.status === 'failed' ? 'failed' : 'completed' }),
        content: [
          ...(revised ? [textContent(`Revised prompt: ${asString(item.revised_prompt) ?? ''}`)] : []),
          ...(image ? [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: item.result } }] : []),
        ],
      }]
    }
    default:
      return []
  }
}

/** The update closing a tool call with codex's final status, as the
 *  adapter reports it; an item with no status (a web search, a compaction)
 *  always completes. */
function toolEnd(item: Json): Json {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: asString(item.id) ?? '',
    status: item.status === undefined || item.status === 'completed' ? 'completed' : 'failed',
  }
}

/**
 * A command's title, kind and locations as the adapter derives them from
 * codex's reading of it: a lone read, search or listing is shown as that,
 * anything else as the shell command it ran.
 */
function commandStart(item: Json): Json {
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map(asRecord) : []
  const argv = strings(item.command)
  const action = parsed.length === 1 && parsed[0] !== undefined ? parsed[0] : { type: 'unknown', cmd: shellJoin(argv) }
  const target = asString(action.path)
  switch (action.type) {
    case 'read': {
      const file = path.posix.resolve(localPath(asString(item.cwd) ?? '/'), target ?? '')
      return { kind: 'read', title: `Read file '${file}'`, locations: [{ path: file }] }
    }
    case 'search': {
      const query = asString(action.query)
      const title = query && target ? `Search for '${query}' in ${target}`
        : query ? `Search for '${query}'` : target ? `Search in '${target}'` : 'Search'
      return { kind: 'search', title }
    }
    case 'list_files':
      return { kind: 'read', title: target ? `List files in '${target}'` : 'List files' }
    default: {
      const command = asString(action.cmd) ?? ''
      return { kind: 'execute', title: stripShellPrefix(command), rawInput: { command } }
    }
  }
}

/** The adapter's `stripShellPrefix`: a `bash -lc '…'` wrapper off a title. */
function stripShellPrefix(command: string): string {
  const bare = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, '')
  return bare.startsWith("'") && bare.endsWith("'") ? bare.slice(1, -1) : bare
}

/** An argv as one shell line, quoting as codex does for a command line. */
function shellJoin(argv: string[]): string {
  return argv.map((a) => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'"'"'`)}'`).join(' ')
}

/** The diffs of a FileChange's changes, ordered by path as the adapter
 *  gets them; an update shows one diff per hunk. */
function fileDiffs(changes: unknown): Json[] {
  return Object.entries(asRecord(changes) ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([file, raw]): Json[] => {
    const change = asRecord(raw) ?? {}
    const text = asString(change.type === 'update' ? change.unified_diff : change.content) ?? ''
    // The adapter leaves out a diff past this size.
    if (Buffer.byteLength(text) > 1024 * 1024) return []
    if (change.type === 'add') return [{ type: 'diff', path: file, oldText: null, newText: text }]
    if (change.type === 'delete') return [{ type: 'diff', path: file, oldText: text, newText: '' }]
    const target = asString(change.move_path) ?? file
    const hunks = unifiedDiffHunks(text)
    if (hunks.length === 0 && target !== file) return [{ type: 'diff', path: target, oldText: '', newText: '' }]
    return hunks.map((h) => ({ type: 'diff', path: target, ...h }))
  })
}

/** The adapter's title for a web search. */
function webSearchTitle(item: Json): string {
  const action = asRecord(item.action)
  const query = asString(item.query)
  switch (action?.type) {
    case 'search': {
      const joined = strings(action.queries).filter(Boolean).join(', ')
      const q = asString(action.query) ?? (joined || undefined) ?? query
      return q ? `Web search: ${q}` : 'Web search'
    }
    case 'open_page': {
      const url = asString(action.url)
      return url ? `Open page: ${url}` : 'Open page'
    }
    case 'find_in_page': {
      const pattern = asString(action.pattern)
      const url = asString(action.url)
      return `Find in page${pattern ? ` for '${pattern}'` : ''}${url ? ` in ${url}` : ''}`
    }
    case 'other':
      return 'Web search'
    default:
      return query ? `Web search: ${query}` : 'Web search'
  }
}

/**
 * A user message's parts as the prompt blocks yaac sends: text, and an
 * attached image as its data, the message's images being `sent` in order.
 * An image with no data to show, or a skill, is named the way the adapter
 * names it.
 */
function userContent(content: unknown, sent: string[]): Json[] {
  let image = 0
  return (Array.isArray(content) ? content : []).map(asRecord).flatMap((c): Json[] => {
    switch (c?.type) {
      case 'text':
        return c.text ? [{ type: 'text', text: c.text }] : []
      case 'image':
      case 'local_image': {
        const url = (c.type === 'image' ? asString(c.image_url) : undefined) ?? sent[image] ?? ''
        image++
        const data = /^data:([^;,]+);base64,(.*)$/s.exec(url)
        if (data !== null) return [{ type: 'image', mimeType: data[1], data: data[2] }]
        const file = asString(c.path) ?? ''
        return [{ type: 'text', text: c.type === 'image' ? `[@image](${url})` : `[@${path.basename(file)}](file://${file})` }]
      }
      case 'skill':
        return [{ type: 'text', text: `skill:${asString(c.name) ?? ''} (${asString(c.path) ?? ''})` }]
      default:
        return []
    }
  })
}

/** The steps of an `update_plan` call, as the adapter lists them. */
function planEntries(args: unknown): Json[] {
  const plan = asRecord(parseJson(asString(args) ?? ''))?.plan
  return (Array.isArray(plan) ? plan : []).map(asRecord).map((step) => ({
    content: step?.step, status: step?.status, priority: 'medium',
  }))
}

/** A subagent's name from its agent path (`/root/code_reviewer` is "Code
 *  reviewer"), as the adapter names it. */
function agentName(agentPath: string, thread: string): string {
  const name = agentPath.trim().replace(/\/+$/, '').split('/').at(-1)?.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : `Agent ${thread.slice(-8)}`
}

/** A path codex may record as a `file://` URL. */
function localPath(value: string): string {
  return value.startsWith('file://') ? fileURLToPath(value) : value
}

function chunk(sessionUpdate: string, text: string): Json {
  return { sessionUpdate, content: { type: 'text', text } }
}

function textContent(text: string): Json {
  return { type: 'content', content: { type: 'text', text } }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

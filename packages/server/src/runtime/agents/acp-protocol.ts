/**
 * The part of the Agent Client Protocol yaac speaks, and the translation of
 * `session/update` notifications into the `AcpEvent` union the webapp
 * renders (`@yaac/shared/acp`).
 *
 * This is the only server module that knows ACP's shapes, so spec changes
 * land here. Parsing is defensive: unknown update variants are dropped, so a
 * newer adapter degrades to rendering less rather than breaking.
 *
 * Unlike an editor, yaac runs the agent inside the workspace on the real
 * checkout with its own tools, so it declines the `fs/*` and `terminal/*`
 * capabilities rather than proxying them.
 */

import type {
  AcpContent,
  AcpEventInit,
  AcpModel,
  AcpPermissionOption,
  AcpPlanEntry,
  AcpStopReason,
  AcpSubagent,
  AcpSubagentState,
  AcpTask,
  AcpTaskState,
  AcpToolCall,
  AcpToolContent,
  AcpToolKind,
  AcpToolStatus,
  AcpWake,
} from '@yaac/shared/acp'

/** The ACP revision this client negotiates. */
export const ACP_PROTOCOL_VERSION = 1

/** Method names from the spec, as constants so a rename breaks the build. */
export const ACP = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  sessionSetMode: 'session/set_mode',
  sessionSetConfigOption: 'session/set_config_option',
  requestPermission: 'session/request_permission',
  /** Not in the spec: the steering extension claude's and codex's adapters
   *  implement, which adds a message to the running turn. */
  sessionSteer: '_session/steering',
  /** Stop one background task (see `AcpTask`); claude's and codex's
   *  adapters serve it. */
  asyncTaskStop: '_session/async_task/stop',
  /** opencode's report of a subagent's life and updates (see
   *  `AcpProjection.applyChildUpdate`). */
  opencodeChildUpdate: 'opencode/session/child_update',
} as const

/** acpd's own control notifications (see dockerfiles/acpd/acpd.js). */
export const ACPD = {
  hello: '_acpd/hello',
  exit: '_acpd/exit',
  life: '_acpd/life',
} as const

export interface AcpInitializeResult {
  protocolVersion?: number
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: Record<string, boolean>
  }
  authMethods?: Array<{ id: string; name?: string; description?: string }>
}

/** The session modes an adapter advertises, as `session/new` reports them. */
export interface AcpSessionModes {
  currentModeId?: string
  availableModes?: Array<{ id: string; name?: string }>
}

/**
 * The model a session is running, in either shape adapters report: a
 * `models` block, and/or a `configOptions` entry with `id: 'model'` (the one
 * `session/set_config_option` changes). Both are read; neither is required.
 */
export interface AcpSessionModels {
  currentModelId?: string
  availableModels?: Array<{ modelId?: string; name?: string }>
}

/** A config option; a `select` option's choices may be grouped
 *  (`{ group, name, options }` entries), which `selectChoices` flattens. */
export interface AcpConfigOption {
  id?: string
  currentValue?: unknown
  options?: Array<{ value?: unknown; name?: string; options?: unknown[] }>
}

export interface AcpNewSessionResult {
  sessionId: string
  modes?: AcpSessionModes
  models?: AcpSessionModels
  configOptions?: AcpConfigOption[]
}

/** `session/load`'s reply: the same session facts, without the id. */
export interface AcpLoadSessionResult {
  modes?: AcpSessionModes
  models?: AcpSessionModels
  configOptions?: AcpConfigOption[]
}

export interface AcpPromptResult {
  stopReason?: string
}

/**
 * The capabilities yaac declares. `fs` and `terminal` are off (see the
 * module comment); `readTextFile`/`writeTextFile` are set explicitly so an
 * adapter cannot default them to true. `meta` is the adapter's own opt-ins
 * (`AcpAdapterProfile.capabilitiesMeta`).
 */
export function clientCapabilities(meta?: Record<string, unknown>): Record<string, unknown> {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    ...(meta !== undefined ? { _meta: meta } : {}),
  }
}

/**
 * codex's opt-ins. codex reports subagents and background shells only to
 * JetBrains AIR, so yaac declares itself that client. The declaration is the
 * client's identity, not a feature list: it also changes how codex renders
 * every tool call (it drops the fields it sends plain ACP clients, and sends
 * a command's output only as chunks). `terminal_output_delta` asks for those
 * chunks as `tool_call_update._meta.terminal_output_delta`; without it an AIR
 * client gets a command's output only once it ends.
 *
 * claude's adapter changes even more for AIR (a read's text is dropped), so
 * claude is not told this; see `CLAUDE_SESSION_META`.
 */
export const CODEX_CAPABILITIES_META = {
  jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] } },
  terminal_output_delta: true,
}

/** opencode's opt-in to its subagents' updates
 *  (`AcpProjection.applyChildUpdate`). */
export const OPENCODE_CAPABILITIES_META = { 'opencode/child-session-updates': true }

const TOOL_KINDS: readonly AcpToolKind[] = [
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]
const TOOL_STATUSES: readonly AcpToolStatus[] = ['pending', 'in_progress', 'completed', 'failed']
const STOP_REASONS: readonly AcpStopReason[] = [
  'end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled',
]
const SUBAGENT_STATES: readonly AcpSubagentState[] = [
  'running', 'completed', 'failed', 'cancelled', 'disconnected',
]
const TASK_STATES: readonly AcpTaskState[] = ['running', 'paused', 'completed', 'failed', 'stopped']
/** claude's task types, as the kinds a pane names. Its Monitor tool's
 *  command watch is a `local_bash` task, told apart by the call that started
 *  it (`AcpProjection.monitorCalls`). */
const CLAUDE_TASK_KINDS: Record<string, string> = {
  local_bash: 'shell',
  local_workflow: 'workflow',
  monitor_mcp: 'monitor',
  monitor_ws: 'monitor',
}
/** claude's task statuses, as task and subagent states. */
const CLAUDE_TASK_STATES: Record<string, AcpTaskState> = {
  pending: 'running',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  killed: 'stopped',
  cancelled: 'stopped',
  stopped: 'stopped',
}
const CLAUDE_SUBAGENT_STATES: Record<string, AcpSubagentState> = {
  pending: 'running',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'cancelled',
  cancelled: 'cancelled',
  stopped: 'cancelled',
}

/** The output file a claude background command's result names
 *  (`…Output is being written to: <path>. You will be notified…`), if it
 *  is that task's. */
function outputFileOf(call: AcpToolCall, taskId: string): string | undefined {
  const text = (call.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('')
  const path = /Output is being written to: (\S+)\. You will be notified/.exec(text)?.[1]
  return path?.endsWith(`/tasks/${taskId}.output`) === true ? path : undefined
}

/** opencode's child session statuses, as subagent states. */
const OPENCODE_CHILD_STATES: Record<string, AcpSubagentState> = {
  created: 'running',
  running: 'running',
  completed: 'completed',
  interrupted: 'cancelled',
  failed: 'failed',
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Unknown stop reasons are reported as `end_turn`; the turn is over
 *  either way. */
export function toStopReason(value: unknown): AcpStopReason {
  const s = asString(value)
  return s !== undefined && (STOP_REASONS as readonly string[]).includes(s)
    ? s as AcpStopReason
    : 'end_turn'
}

/**
 * One ACP content block, or undefined for variants an in-workspace agent
 * never sends (`audio`, `resource`, `resource_link`).
 */
function toContent(value: unknown): AcpContent | undefined {
  const block = asRecord(value)
  if (!block) return undefined
  if (block.type === 'text') {
    const text = asString(block.text)
    return text === undefined ? undefined : { type: 'text', text }
  }
  if (block.type === 'image') {
    const mimeType = asString(block.mimeType)
    const data = asString(block.data)
    return mimeType !== undefined && data !== undefined
      ? { type: 'image', mimeType, data }
      : undefined
  }
  return undefined
}

/** A chunk update carries one block; a tool call or prompt carries a list. */
export function toContentList(value: unknown): AcpContent[] {
  const list = Array.isArray(value) ? value : [value]
  return list.map(toContent).filter((c): c is AcpContent => c !== undefined)
}

/**
 * A tool call's content entries: `content` wraps a block, `diff` a
 * before/after pair, `terminal` names a terminal yaac never created.
 *
 * Diffs pass through as diffs so a pane can render them properly. An
 * `oldText: null` (a new file) becomes absent, not the string "null".
 */
function toToolContent(value: unknown): AcpToolContent[] {
  if (!Array.isArray(value)) return []
  const out: AcpToolContent[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    if (!entry) continue
    if (entry.type === 'content') {
      const block = toContent(entry.content)
      if (block) out.push(block)
      continue
    }
    if (entry.type === 'diff') {
      const oldText = asString(entry.oldText)
      out.push({
        type: 'diff',
        path: asString(entry.path) ?? '(file)',
        ...(oldText !== undefined ? { oldText } : {}),
        newText: asString(entry.newText) ?? '',
      })
    }
    // yaac declines terminals, so there is nothing to show.
  }
  return out
}

function toLocations(value: unknown): Array<{ path: string; line?: number }> | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.flatMap((raw) => {
    const loc = asRecord(raw)
    const p = asString(loc?.path)
    if (p === undefined) return []
    const line = typeof loc?.line === 'number' ? loc.line : undefined
    return [{ path: p, ...(line !== undefined ? { line } : {}) }]
  })
  return out.length > 0 ? out : undefined
}

function toPlanEntries(value: unknown): AcpPlanEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const e = asRecord(raw)
    const content = asString(e?.content)
    if (content === undefined) return []
    const priority = asString(e?.priority)
    const status = asString(e?.status)
    return [{
      content,
      priority: priority === 'high' || priority === 'low' ? priority : 'medium',
      status: status === 'in_progress' || status === 'completed' ? status : 'pending',
    }]
  })
}

/**
 * A partial tool call: `tool_call` is complete, `tool_call_update` names
 * only what changed. The caller merges patches, so status and title are
 * optional.
 */
export interface AcpToolCallPatch {
  toolCallId: string
  title?: string
  shell?: boolean
  description?: string
  kind?: AcpToolKind
  status?: AcpToolStatus
  content?: AcpToolContent[]
  locations?: Array<{ path: string; line?: number }>
  /** Terminal output to append, projected as a `tool-output` event: codex
   *  streams a command's output this way, including a background shell's
   *  after its turn has ended. */
  output?: string
}

/**
 * Whether an update marks its call as a shell command, or `undefined` when it
 * does not say. A shell call's `rawInput` has a string `command` (claude,
 * codex, opencode); pi sends no `rawInput` for its bash calls at all, while
 * codex's MCP and dynamic calls always send one without a command. An MCP
 * tool can take a `command` argument too, so `mergeToolCall` keeps the mark
 * only on an `execute` call.
 */
function isShellCall(update: Record<string, unknown>, kind: string | undefined): boolean | undefined {
  const rawInput = asRecord(update.rawInput)
  if (rawInput !== undefined) return typeof rawInput.command === 'string'
  return update.sessionUpdate === 'tool_call' && kind === 'execute' ? true : undefined
}

/**
 * Project one tool call update. claude's Monitor tool runs a command and
 * watches its output, but the adapter titles the call just "Monitor" and
 * files it under `other` on every update, so the update that brings the
 * command makes it the shell call it is: titled by its command, with the
 * description the model gave it. A Monitor of a WebSocket has no command
 * and stays an `other` call titled "Monitor".
 */
function toToolCallPatch(update: Record<string, unknown>): AcpToolCallPatch | undefined {
  const toolCallId = asString(update.toolCallId)
  if (toolCallId === undefined) return undefined
  const rawInput = asRecord(update.rawInput)
  const monitor = asRecord(asRecord(update._meta)?.claudeCode)?.toolName === 'Monitor'
  const monitorCommand = monitor ? asString(rawInput?.command) : undefined
  const kind = !monitor ? asString(update.kind) : monitorCommand !== undefined ? 'execute' : undefined
  const status = asString(update.status)
  const content = 'content' in update ? toToolContent(update.content) : undefined
  const locations = toLocations(update.locations)
  const shell = isShellCall(update, kind)
  const description = asString(rawInput?.description)
  const title = monitorCommand ?? asString(update.title)
  const output = asString(asRecord(asRecord(update._meta)?.terminal_output_delta)?.data)
  return {
    toolCallId,
    ...(title !== undefined ? { title } : {}),
    ...(shell !== undefined ? { shell } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(kind !== undefined && (TOOL_KINDS as readonly string[]).includes(kind)
      ? { kind: kind as AcpToolKind }
      : {}),
    ...(status !== undefined && (TOOL_STATUSES as readonly string[]).includes(status)
      ? { status: status as AcpToolStatus }
      : {}),
    ...(content !== undefined ? { content } : {}),
    ...(locations !== undefined ? { locations } : {}),
    ...(output !== undefined ? { output } : {}),
  }
}

/** Merge a patch onto the last known state of the same call. */
export function mergeToolCall(
  previous: AcpToolCall | undefined,
  patch: AcpToolCallPatch,
): AcpToolCall {
  const kind = patch.kind ?? previous?.kind ?? 'other'
  const shell = kind === 'execute' && (patch.shell ?? previous?.shell) === true
  const description = patch.description ?? previous?.description
  return {
    toolCallId: patch.toolCallId,
    title: patch.title ?? previous?.title ?? patch.toolCallId,
    kind,
    ...(shell ? { shell: true as const } : {}),
    ...(shell && description !== undefined ? { description } : {}),
    status: patch.status ?? previous?.status ?? 'pending',
    // Content is cumulative; an update without it is a status change.
    ...(patch.content !== undefined && patch.content.length > 0
      ? { content: patch.content }
      : previous?.content !== undefined ? { content: previous.content } : {}),
    ...(patch.locations ?? previous?.locations
      ? { locations: patch.locations ?? previous?.locations }
      : {}),
  }
}

/** Updates only a run's own output starts with: claude's first sign of a
 *  run it begins while still reporting `running` (`AcpProjection.runEnded`). */
const RUN_STARTS = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'plan'])

/**
 * State for projecting one `session/update` stream into complete events.
 * Tool calls arrive as incremental patches and must be merged. The live
 * path and record replay share this class so they cannot disagree; each
 * stream gets its own instance.
 */
export class AcpProjection {
  private readonly toolCalls = new Map<string, AcpToolCall>()
  /** Subagents by session id; an update under one of these ids is that
   *  subagent's, so its event gets a `thread`. */
  private readonly subagents = new Map<string, AcpSubagent>()
  /** Tasks shown to the pane, by id. */
  private readonly tasks = new Map<string, AcpTask>()
  /** The thread each tool call ran in, when not the main one. */
  private readonly toolThreads = new Map<string, string>()
  /** Every claude task, shown or not, at its latest state. */
  private readonly claudeTasks = new Map<string, AcpTask>()
  /** claude's task ids for subagents, mapped to the subagent's id. */
  private readonly subagentTasks = new Map<string, string>()
  /** Task ids of the subagents claude runs in the background. Only these
   *  appear in its live set, so only these may be ended for leaving it. */
  private readonly backgroundSubagents = new Set<string>()
  /** claude's Monitor calls. The task one starts reports itself only as a
   *  shell, and its call always arrives first. */
  private readonly monitorCalls = new Set<string>()
  /**
   * Permission asks not yet answered. A reply line is just `{id, result}`,
   * so only a seen request identifies it as settling a permission ask.
   */
  private readonly openPermissions = new Set<string>()
  /** Steered messages awaiting their reply, which says whether the agent
   *  took them (see `closeSteer`). */
  private readonly openSteers = new Map<string, AcpContent[]>()

  /** The adapter's last state report (`agentRunningReport`). */
  private agentRunning = false
  /**
   * claude finished a run and has not begun another. It can stay `running`
   * meanwhile, holding our prompt open while a background subagent works,
   * so a run woken then is found by its first output instead (`apply`).
   */
  private runEnded = false
  /** claude's task notifications since its last run ended: what may wake it
   *  into the next one. */
  private wakes: AcpWake[] = []
  /** Any notification came since the last run ended, named in `wakes` or
   *  not (an ambient watch's, a subagent's own task's). */
  private notified = false
  /** What may have woken the current run, taken when it started: the
   *  notifications before it, and failing those the monitors running. */
  private runCauses: AcpWake[] = []
  /** claude tasks a subagent started. Their notifications go to it. */
  private readonly subagentOwned = new Set<string>()

  /** Follow a state report; a run starting is an `agent-turn` boundary. */
  agentState(running: boolean): AcpEventInit[] {
    const started = running && !this.agentRunning
    this.agentRunning = running
    return started ? this.startRun() : []
  }

  /** Drop notifications no run has claimed: a prompt or a new agent life
   *  starts a run they did not wake. */
  forgetWakes(): void {
    this.wakes = []
    this.notified = false
  }

  private startRun(): AcpEventInit[] {
    this.runEnded = false
    this.runCauses = this.wakes.length > 0 ? this.wakes : this.notified ? [] : this.monitorCauses()
    this.forgetWakes()
    return [{ type: 'agent-turn' }]
  }

  /**
   * A monitor's event wakes claude with nothing before the run, so a run
   * with no notification at all before it is credited to the running
   * monitor, or monitors in general when several run. An ambient watch is
   * not one the agent asked for, so it is not counted.
   */
  private monitorCauses(): AcpWake[] {
    const monitors = [...this.tasks.values()].filter((t) => t.kind === 'monitor' && t.state === 'running' && t.ambient === undefined)
    if (monitors.length === 0) return []
    const [only] = monitors
    return [monitors.length === 1 ? { kind: 'monitor', id: only.id, name: only.name } : { kind: 'monitor' }]
  }

  /** Hold a `_session/steering` request line until its reply. */
  openSteer(requestId: string, params: unknown): void {
    const content = toContentList(asRecord(params)?.prompt)
    if (content.length > 0) this.openSteers.set(requestId, content)
  }

  /**
   * Project a steering reply as the user message it delivered, or undefined
   * when it settles no steer this projection holds or the agent did not take
   * it. A message not taken is queued and sent as a `session/prompt`, whose
   * own line shows it.
   */
  closeSteer(requestId: string, result: unknown): AcpEventInit | undefined {
    const content = this.openSteers.get(requestId)
    if (content === undefined) return undefined
    this.openSteers.delete(requestId)
    const outcome = asRecord(result)?.outcome
    // `startedNewTurn` began a turn of its own, so it does end the one
    // before it.
    if (outcome === 'injected') return { type: 'user', content, steered: true }
    return outcome === 'startedNewTurn' ? { type: 'user', content } : undefined
  }

  /** Project one `session/request_permission` request line. */
  openPermission(requestId: string, params: unknown): AcpEventInit {
    this.openPermissions.add(requestId)
    const { toolCall, options } = parsePermissionRequest(params)
    const thread = this.threadOf(params)
    return {
      type: 'permission-request',
      ...(thread !== undefined ? { thread } : {}),
      requestId,
      ...(toolCall !== undefined ? { toolCall } : {}),
      options,
    }
  }

  /** Project a reply line, or undefined when it does not settle a permission
   *  ask this projection is holding open. */
  closePermission(requestId: string, result: unknown): AcpEventInit | undefined {
    if (!this.openPermissions.delete(requestId)) return undefined
    const decided = parsePermissionOutcome(result)
    return {
      type: 'permission-resolved',
      requestId,
      // An unparseable reply still settles the ask so the pane's card
      // retires; "unreadable" is closest to cancelled.
      outcome: decided?.outcome ?? 'cancelled',
      ...(decided?.optionId !== undefined ? { optionId: decided.optionId } : {}),
    }
  }

  /** Unanswered asks. A conversation with one is blocked on a human, so it
   *  is `waiting`, not `running`. */
  get pendingPermissions(): string[] {
    return [...this.openPermissions]
  }

  /** Project one `session/update`'s params into what a pane renders, which
   *  may be nothing. */
  apply(params: unknown): AcpEventInit[] {
    const update = asRecord(asRecord(params)?.update)
    const claudeCode = asRecord(asRecord(update?._meta)?.claudeCode)
    const parentToolUseId = asString(claudeCode?.parentToolUseId)
    const toolCallId = asString(update?.toolCallId)
    if (claudeCode?.toolName === 'Monitor' && toolCallId !== undefined) this.monitorCalls.add(toolCallId)
    const out: AcpEventInit[] = []
    // claude's subagents run in the main session; their updates name the
    // Agent call that spawned them instead.
    if (parentToolUseId !== undefined && !this.subagents.has(parentToolUseId)) {
      out.push(this.setSubagent({
        id: parentToolUseId,
        ...this.parentOf(parentToolUseId),
        name: this.toolCalls.get(parentToolUseId)?.title ?? 'Subagent',
        task: '',
        state: 'running',
      }))
    }
    const thread = this.threadOf(params) ?? parentToolUseId
    if (update !== undefined) {
      // Only a notification starts a run inside a held prompt; output after
      // any other result (a steer aborting the cycle it interrupts) goes on.
      const held = this.runEnded && this.agentRunning && this.wakes.length > 0
      if (thread === undefined && held && RUN_STARTS.has(String(update.sessionUpdate))) {
        out.push(...this.startRun())
      }
      const ended = this.endRun(update)
      if (ended !== undefined) out.push(ended)
      const lifecycle = this.applyLifecycle(update, thread)
      if (lifecycle !== null) return lifecycle === undefined ? out : [...out, lifecycle]
    }
    const translated = translateSessionUpdate(params)
    if (!translated) return out
    const tag = thread !== undefined ? { thread } : {}
    if (translated.kind === 'event') return [...out, { ...translated.event, ...tag }]
    const { output, ...patch } = translated.patch
    const known = this.toolCalls.get(patch.toolCallId)
    // An update naming nothing about a call never shown (an adapter
    // closing a call it hid) would render as a bare id.
    if (known === undefined && Object.keys(patch).length === 1 && output === undefined) return out
    if (known === undefined || Object.keys(patch).length > 1) {
      const call = mergeToolCall(known, patch)
      this.toolCalls.set(call.toolCallId, call)
      if (known === undefined && thread !== undefined) this.toolThreads.set(call.toolCallId, thread)
      out.push({ type: 'tool', ...tag, call })
      out.push(...this.claimOutputFile(call))
    }
    if (output !== undefined && output !== '') {
      out.push({ type: 'tool-output', ...tag, toolCallId: patch.toolCallId, data: output })
    }
    return out
  }

  /**
   * Project one of the Agent SDK messages claude forwards
   * (`CLAUDE_SDK_MESSAGE`) into subagents and background tasks, which it
   * reports this way to a client that is not JetBrains AIR. A subagent is
   * keyed by the Agent call that spawned it, which is what its own updates
   * name (`parentToolUseId`); a task by the SDK's task id.
   */
  applyClaudeSdk(params: unknown): AcpEventInit[] {
    const m = asRecord(asRecord(params)?.message)
    if (m?.type !== 'system') return []
    if (m.subtype === 'background_tasks_changed') {
      const live = new Set((Array.isArray(m.tasks) ? m.tasks : []).map((t) => asString(asRecord(t)?.task_id)))
      // The live set is authoritative: a task or background subagent missing
      // from it is gone, even if its own end was never reported. A later
      // notification of how it ended still corrects the state.
      const subagents = [...this.backgroundSubagents].flatMap((id) => {
        const s = this.subagents.get(this.subagentTasks.get(id) ?? '')
        return s?.state === 'running' && !live.has(id) ? [this.setSubagent({ ...s, state: 'cancelled' })] : []
      })
      return subagents.concat([...this.tasks.values()]
        .filter((t) => this.claudeTasks.has(t.id) && t.state === 'running' && !live.has(t.id))
        .map((t) => this.setTask({ ...t, state: 'stopped' })))
    }
    const taskId = asString(m.task_id)
    if (taskId === undefined) return []
    const toolUseId = asString(m.tool_use_id)
    const patch = asRecord(m.patch)
    if (m.subtype === 'task_started') {
      if (m.owned_by_subagent === true) this.subagentOwned.add(taskId)
      if (m.task_type === 'local_agent' || m.subagent_type !== undefined) {
        if (toolUseId === undefined) return []
        this.subagentTasks.set(taskId, toolUseId)
        if (m.is_backgrounded === true) this.backgroundSubagents.add(taskId)
        const known = this.subagents.get(toolUseId)
        return [this.setSubagent({
          id: toolUseId,
          ...this.parentOf(toolUseId),
          name: asString(m.description) ?? known?.name ?? 'Subagent',
          task: asString(m.prompt) ?? known?.task ?? '',
          state: 'running',
        })]
      }
      const monitor = toolUseId !== undefined && this.monitorCalls.has(toolUseId)
      const started: AcpTask = {
        id: taskId,
        name: asString(m.workflow_name) ?? asString(m.description) ?? 'Background task',
        kind: monitor ? 'monitor' : CLAUDE_TASK_KINDS[asString(m.task_type) ?? ''] ?? 'task',
        description: asString(m.description) ?? '',
        state: 'running',
        ...(toolUseId !== undefined ? { toolCallId: toolUseId } : {}),
        ...(m.ambient === true ? { ambient: true as const } : {}),
      }
      // A command run in the foreground is a task too, but only one moved
      // to the background is shown; it may be moved later (`task_updated`).
      const backgrounded = m.is_backgrounded === true || (m.is_backgrounded === undefined && m.task_type !== 'local_bash')
      this.claudeTasks.set(taskId, started)
      return backgrounded ? this.announceClaudeTask(started) : []
    }
    const subagentId = this.subagentTasks.get(taskId)
    if (m.subtype === 'task_notification' && (!this.agentRunning || this.runEnded)) {
      this.notified = true
      if (!this.subagentOwned.has(taskId) && this.claudeTasks.get(taskId)?.ambient === undefined) {
        this.wakes.push(this.wakeOf(taskId, subagentId))
      }
    }
    const status = asString(patch?.status) ?? (m.subtype === 'task_notification' ? asString(m.status) : undefined)
    if (subagentId !== undefined) {
      if (patch?.is_backgrounded === true) this.backgroundSubagents.add(taskId)
      const known = this.subagents.get(subagentId)
      const state = CLAUDE_SUBAGENT_STATES[status ?? '']
      const summary = m.subtype === 'task_notification' ? asString(m.summary) : undefined
      if (known === undefined || ((state === undefined || state === known.state) && summary === undefined)) return []
      return [this.setSubagent({
        ...known,
        ...(state !== undefined ? { state } : {}),
        ...(summary !== undefined ? { summary } : {}),
      })]
    }
    const pending = this.claudeTasks.get(taskId)
    if (pending === undefined) return []
    const state = CLAUDE_TASK_STATES[status ?? '']
    const summary = asString(m.summary)
    const outputFile = asString(m.output_file)
    const next: AcpTask = {
      ...pending,
      ...(state !== undefined ? { state } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(outputFile !== undefined ? { outputFile } : {}),
    }
    this.claudeTasks.set(taskId, next)
    if (this.tasks.has(taskId)) return [this.setTask(next)]
    return patch?.is_backgrounded === true ? this.announceClaudeTask(next) : []
  }

  /** Show a claude task, with the output file its call already named. */
  private announceClaudeTask(task: AcpTask): AcpEventInit[] {
    const call = task.toolCallId === undefined ? undefined : this.toolCalls.get(task.toolCallId)
    const outputFile = task.outputFile ?? (call === undefined ? undefined : outputFileOf(call, task.id))
    return [this.setTask(outputFile === undefined ? task : { ...task, outputFile })]
  }

  /**
   * claude names a background command's output file only in its call's
   * result text, which may arrive before or after the task; this covers
   * the call arriving second.
   */
  private claimOutputFile(call: AcpToolCall): AcpEventInit[] {
    const task = [...this.tasks.values()].find((t) => t.toolCallId === call.toolCallId && t.outputFile === undefined)
    const outputFile = task === undefined ? undefined : outputFileOf(call, task.id)
    return task === undefined || outputFile === undefined ? [] : [this.setTask({ ...task, outputFile })]
  }

  private wakeOf(taskId: string, subagentId: string | undefined): AcpWake {
    if (subagentId !== undefined) {
      const name = this.subagents.get(subagentId)?.name
      return { kind: 'subagent', id: subagentId, ...(name !== undefined ? { name } : {}) }
    }
    const task = this.claudeTasks.get(taskId)
    return { kind: task?.kind === 'monitor' ? 'monitor' : 'task', id: taskId, ...(task !== undefined ? { name: task.name } : {}) }
  }

  /**
   * End a claude run at its result, the `usage_update` that names what
   * started it. Only a run started by a task notification is credited, with
   * the causes taken when it began.
   */
  private endRun(update: Record<string, unknown>): AcpEventInit | undefined {
    if (update.sessionUpdate !== 'usage_update') return undefined
    const origin = asRecord(asRecord(update._meta)?.['_claude/origin'])?.kind
    if (origin === undefined) return undefined
    this.runEnded = true
    const causes = this.runCauses
    this.runCauses = []
    return origin === 'task-notification' && causes.length > 0 ? { type: 'woken', causes } : undefined
  }

  private setSubagent(subagent: AcpSubagent): AcpEventInit {
    this.subagents.set(subagent.id, subagent)
    return { type: 'subagent', subagent }
  }

  private setTask(task: AcpTask): AcpEventInit {
    this.tasks.set(task.id, task)
    return { type: 'task', task }
  }

  /** The thread a claude subagent's Agent call ran in, when not the main
   *  one: a subagent spawned by a subagent. */
  private parentOf(toolUseId: string): { parent?: string } {
    const parent = this.toolThreads.get(toolUseId)
    return parent !== undefined ? { parent } : {}
  }

  /**
   * Project one `opencode/session/child_update` into the same events AIR's
   * subagent updates make. A `status` message moves the subagent's state; an
   * `update` carries one `session/update` of the subagent's own, which is
   * projected as if sent under its session id.
   */
  applyChildUpdate(params: unknown): AcpEventInit[] {
    const p = asRecord(params)
    const id = asString(p?.childSessionId)
    if (p === undefined || id === undefined) return []
    const out: AcpEventInit[] = []
    const known = this.subagents.get(id)
    const state = p.type === 'status' ? OPENCODE_CHILD_STATES[asString(p.status) ?? ''] : undefined
    if (known === undefined || (state !== undefined && state !== known.state)) {
      const parent = asString(p.parentSessionId)
      out.push(this.setSubagent({
        id,
        ...(parent !== undefined && this.subagents.has(parent) ? { parent } : {}),
        name: asString(p.title) ?? 'Subagent',
        task: '',
        ...known,
        state: state ?? known?.state ?? 'running',
      }))
    }
    if (p.type === 'update') out.push(...this.apply({ sessionId: id, update: p.update }))
    return out
  }

  /** The subagent a message's `sessionId` names, or undefined for the main
   *  conversation. */
  private threadOf(params: unknown): string | undefined {
    const sessionId = asString(asRecord(params)?.sessionId)
    return sessionId !== undefined && this.subagents.has(sessionId) ? sessionId : undefined
  }

  /**
   * Project a subagent or background-task update (see `clientCapabilities`)
   * into its merged state. Null when the update is neither; undefined when
   * it is one but names nothing known.
   */
  private applyLifecycle(
    update: Record<string, unknown>,
    thread: string | undefined,
  ): AcpEventInit | undefined | null {
    switch (update.sessionUpdate) {
      case 'subagent_spawned': {
        const id = asString(update.subagentSessionId)
        if (id === undefined) return undefined
        const subagent: AcpSubagent = {
          id,
          ...(thread !== undefined ? { parent: thread } : {}),
          name: asString(update.name) ?? 'Subagent',
          task: asString(update.task) ?? '',
          state: 'running',
        }
        this.subagents.set(id, subagent)
        return { type: 'subagent', subagent }
      }
      case 'subagent_state_update': {
        const known = this.subagents.get(asString(update.subagentSessionId) ?? '')
        const state = asString(update.state)
        if (known === undefined || !(SUBAGENT_STATES as readonly string[]).includes(state ?? '')) return undefined
        const subagent = { ...known, state: state as AcpSubagentState }
        this.subagents.set(subagent.id, subagent)
        return { type: 'subagent', subagent }
      }
      case 'async_task_spawned':
      case 'async_task_progress':
      case 'async_task_state_update': {
        const id = asString(update.asyncTaskId)
        if (id === undefined) return undefined
        const known = this.tasks.get(id)
        if (known === undefined && update.sessionUpdate !== 'async_task_spawned') return undefined
        const description = asString(update.description)
        const state = asString(update.state)
        const toolCallId = asString(update.toolCallId)
        const outputFile = asString(update.outputFilePath)
        const summary = asString(update.summary)
        // Progress and state updates name only what changed.
        const task: AcpTask = {
          ...known,
          id,
          name: asString(update.name) ?? known?.name ?? description ?? 'Background task',
          kind: asString(update.taskType) ?? known?.kind ?? 'task',
          description: description ?? known?.description ?? '',
          state: (TASK_STATES as readonly string[]).includes(state ?? '')
            ? state as AcpTaskState
            : known?.state ?? 'running',
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          ...(outputFile !== undefined ? { outputFile } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(update.canStop === true ? { canStop: true as const } : {}),
        }
        this.tasks.set(id, task)
        return { type: 'task', task }
      }
      default:
        return null
    }
  }
}

/**
 * Translate one `session/update` into an event, or undefined when there is
 * nothing to render (an unknown variant, or a mode change). Tool calls come
 * back as patches, since merging needs the caller's `AcpProjection` state.
 */
export type TranslatedUpdate =
  | { kind: 'event'; event: AcpEventInit }
  | { kind: 'tool'; patch: AcpToolCallPatch }

export function translateSessionUpdate(params: unknown): TranslatedUpdate | undefined {
  const p = asRecord(params)
  const update = asRecord(p?.update)
  if (!update) return undefined
  const variant = asString(update.sessionUpdate)

  switch (variant) {
    // Drop chunks with no renderable blocks rather than show an empty
    // bubble. Tool calls and plans are kept even when empty.
    case 'user_message_chunk':
      return chunk('user', update.content)
    case 'agent_message_chunk':
      return chunk('agent', update.content)
    case 'agent_thought_chunk':
      return chunk('thought', update.content)
    case 'plan':
      return event({ type: 'plan', entries: toPlanEntries(update.entries) })
    case 'available_commands_update': {
      const raw = Array.isArray(update.availableCommands) ? update.availableCommands : []
      const commands = raw.flatMap((c) => {
        const rec = asRecord(c)
        const name = asString(rec?.name)
        if (name === undefined) return []
        const description = asString(rec?.description)
        const hint = asString(asRecord(rec?.input)?.hint)
        return [{
          name,
          ...(description !== undefined && description !== '' ? { description } : {}),
          ...(hint !== undefined ? { hint } : {}),
        }]
      })
      return event({ type: 'commands', commands })
    }
    case 'config_option_update': {
      const models = sessionModels(update)
      return models === undefined ? undefined : event({ type: 'models', ...models })
    }
    case 'usage_update': {
      const { used, size } = update
      return typeof used === 'number' && typeof size === 'number' && size > 0
        ? event({ type: 'usage', used, size })
        : undefined
    }
    case 'tool_call':
    case 'tool_call_update': {
      const patch = toToolCallPatch(update)
      return patch === undefined ? undefined : { kind: 'tool', patch }
    }
    default:
      // Mode changes are session state (read via `sessionModeId`), not
      // rendered. Unknown variants from newer adapters are dropped too.
      return undefined
  }
}

function event(e: AcpEventInit): TranslatedUpdate {
  return { kind: 'event', event: e }
}

function chunk(
  type: 'user' | 'agent' | 'thought',
  raw: unknown,
): TranslatedUpdate | undefined {
  const content = toContentList(raw)
  return content.length === 0 ? undefined : event({ type, content })
}

/**
 * The answer to `session/request_permission` under the `bypass` posture:
 * always allow, choosing an option that allows without asking again.
 * Bypass relies on the workspace's isolation rather than prompts.
 *
 * Other postures forward the ask to the pane (`AcpConversation.onRequest`).
 * Adapters can still ask under bypass (a user `permissions.ask` rule is
 * honored even then, and an adapter without `bypassPermissions` runs in its
 * default mode), so this is still needed.
 */
export function chooseAllowOption(params: unknown): string | undefined {
  const options = parsePermissionRequest(params).options
  return (options.find((o) => o.kind === 'allow_always')
    ?? options.find((o) => o.kind === 'allow_once')
    ?? options[0])?.optionId
}

const PERMISSION_OPTION_KINDS: readonly NonNullable<AcpPermissionOption['kind']>[] = [
  'allow_once', 'allow_always', 'reject_once', 'reject_always',
]

/**
 * A `session/request_permission` payload as the pane's question: the tool
 * call it concerns and the options offered. The tool call goes through the
 * same translation as a `tool_call` update. Options without an `optionId`
 * are dropped, and an unknown `kind` becomes absent.
 */
export function parsePermissionRequest(params: unknown): {
  toolCall?: AcpToolCall
  options: AcpPermissionOption[]
} {
  const p = asRecord(params)
  const raw = Array.isArray(p?.options) ? p.options : []
  const options = raw.flatMap((entry): AcpPermissionOption[] => {
    const o = asRecord(entry)
    const optionId = asString(o?.optionId)
    if (optionId === undefined) return []
    const kind = asString(o?.kind)
    return [{
      optionId,
      name: asString(o?.name) ?? optionId,
      ...(kind !== undefined && (PERMISSION_OPTION_KINDS as readonly string[]).includes(kind)
        ? { kind: kind as AcpPermissionOption['kind'] }
        : {}),
    }]
  })
  const call = asRecord(p?.toolCall)
  const patch = call === undefined ? undefined : toToolCallPatch(call)
  return {
    ...(patch !== undefined ? { toolCall: mergeToolCall(undefined, patch) } : {}),
    options,
  }
}

/** The permission reply. An agent offering no option id gets `cancelled`
 *  rather than a malformed `selected`. */
export function permissionReply(optionId: string | undefined): unknown {
  return optionId === undefined
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId } }
}

/** The decision a recorded reply carries, or undefined if the line is not
 *  a permission answer. */
export function parsePermissionOutcome(result: unknown): {
  outcome: 'selected' | 'cancelled'
  optionId?: string
} | undefined {
  const outcome = asRecord(asRecord(result)?.outcome)
  const kind = asString(outcome?.outcome)
  if (kind === 'cancelled') return { outcome: 'cancelled' }
  if (kind !== 'selected') return undefined
  const optionId = asString(outcome?.optionId)
  return { outcome: 'selected', ...(optionId !== undefined ? { optionId } : {}) }
}

/**
 * Whether the session offers this mode. `session/set_mode` throws for an
 * unadvertised mode, and two of claude's are conditional: `auto` needs a
 * model with a classifier, and `bypassPermissions` is withheld when the
 * adapter runs as root outside a sandbox.
 *
 * Both announcement shapes are read (a `modes` block, a `configOptions`
 * entry with `id: 'mode'`); opencode v2 sends only the second. If neither is
 * present the mode is treated as not offered.
 */
export function acpModeOffered(
  session: { modes?: AcpSessionModes; configOptions?: AcpConfigOption[] } | undefined,
  modeId: string,
): boolean {
  if (session?.modes?.availableModes?.some((m) => m.id === modeId) === true) return true
  const mode = session?.configOptions?.find((o) => asString(o.id) === 'mode')
  return mode?.options?.some((o) => asString(o.value) === modeId) === true
}

/**
 * The models a session offers and the one it runs, from any message carrying
 * session state (`session/new`, `session/load` and `session/set_config_option`
 * replies, `config_option_update`), or undefined when it names no model.
 *
 * The `model` config option is preferred, since `session/set_config_option`
 * is how a model is switched and takes its values; a `models` block is read
 * when there is none. Adapters that send both use the same ids in each.
 */
export function sessionModels(state: unknown): { current?: string; models: AcpModel[] } | undefined {
  const r = asRecord(state)
  if (r === undefined) return undefined
  const options = Array.isArray(r.configOptions) ? r.configOptions : []
  const option = options.map(asRecord).find((o) => asString(o?.id) === 'model')
  if (option !== undefined) {
    const current = asString(option.currentValue)
    return {
      ...(current !== undefined ? { current } : {}),
      models: selectChoices(option.options).flatMap((c) => {
        const id = asString(c.value)
        return id === undefined ? [] : [model(id, c.name, c.description)]
      }),
    }
  }
  const block = asRecord(r.models)
  if (block === undefined) return undefined
  const current = asString(block.currentModelId)
  const listed = Array.isArray(block.availableModels) ? block.availableModels : []
  return {
    ...(current !== undefined ? { current } : {}),
    models: listed.map(asRecord).flatMap((m) => {
      const id = asString(m?.modelId)
      return id === undefined ? [] : [model(id, m?.name, m?.description)]
    }),
  }
}

/** A `select` config option's choices, with groups flattened. */
function selectChoices(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.map(asRecord).flatMap((c) => {
    if (c === undefined) return []
    return Array.isArray(c.options) ? selectChoices(c.options) : [c]
  })
}

function model(id: string, name: unknown, description: unknown): AcpModel {
  const n = asString(name)
  const d = asString(description)
  return { id, ...(n !== undefined ? { name: n } : {}), ...(d !== undefined && d !== '' ? { description: d } : {}) }
}

/**
 * The model a session reports (see `sessionModels`), with the adapter's
 * display name when given: claude's adapter reports a picker alias
 * (`opus`) that only its name (`Opus 5.5`) ties to a recognizable model.
 */
export function sessionModel(state: unknown): { id: string; name?: string } | undefined {
  const s = sessionModels(state)
  if (s?.current === undefined) return undefined
  return named(s.current, s.models.find((m) => m.id === s.current)?.name)
}

function named(id: string, name: string | undefined): { id: string; name?: string } {
  return name !== undefined ? { id, name } : { id }
}

/**
 * The mode an update says the session is now in, if any. claude's adapter
 * sends `current_mode_update` when the agent moves itself (e.g. exiting plan
 * mode); codex-acp reports every change as a `config_option_update` for its
 * `mode` option.
 */
export function sessionModeId(update: Record<string, unknown>): string | undefined {
  if (update.sessionUpdate === 'current_mode_update') return asString(update.currentModeId)
  return update.sessionUpdate === 'config_option_update' ? sessionStateModeId(update) : undefined
}

/** The mode a message carrying the session's state names — a `session/new`
 *  or `session/load` reply, a `config_option_update` — in either shape. */
export function sessionStateModeId(state: unknown): string | undefined {
  const r = asRecord(state)
  const current = asString(asRecord(r?.modes)?.currentModeId)
  if (current !== undefined) return current
  const options = Array.isArray(r?.configOptions) ? r.configOptions : []
  return asString(options.map(asRecord).find((o) => asString(o?.id) === 'mode')?.currentValue)
}

/**
 * Agents can start turns on their own (a background task finishing, a
 * scheduled wakeup, a goal continuing, a steer codex turns into a turn of
 * its own), which no `session/prompt` of ours brackets. ACP v1 has no
 * standard running/idle report (v2's `state_update` is still a draft), so
 * each adapter's own is read:
 *
 *  - claude forwards the Agent SDK's `session_state_changed` as a
 *    `CLAUDE_SDK_MESSAGE` notification, once asked for it in the session's
 *    `_meta` (`CLAUDE_SESSION_META`).
 *  - codex-acp sends `session_info_update` with `_meta.codex.threadStatus`.
 *  - pi-acp sends `session_info_update` with `_meta.piAcp.running`, but only
 *    `false` for a run it did not start; see `AcpAdapterProfile.infersRunStart`.
 *
 * opencode's ACP server forwards nothing from a turn it did not start, so
 * there is nothing to read.
 */
export const CLAUDE_SDK_MESSAGE = '_claude/sdkMessage'

/**
 * `_meta` for claude's `session/new` and `session/load`: the Agent SDK
 * messages it forwards as `CLAUDE_SDK_MESSAGE`. Besides the running/idle
 * report, the task messages are how claude reports subagents and background
 * tasks to a client that is not AIR (`AcpProjection.applyClaudeSdk`).
 */
export const CLAUDE_SESSION_META = {
  claudeCode: {
    emitRawSDKMessages: [
      'session_state_changed', 'task_started', 'task_updated', 'task_progress', 'task_notification',
      'background_tasks_changed',
    ].map((subtype) => ({ type: 'system', subtype })),
  },
}

/**
 * Whether a notification is an adapter reporting the agent working (`true`)
 * or idle (`false`); undefined for anything else. Waiting on a permission
 * ask counts as working: the turn is still open.
 */
export function agentRunningReport(method: unknown, params: unknown): boolean | undefined {
  if (method === CLAUDE_SDK_MESSAGE) {
    const message = asRecord(asRecord(params)?.message)
    if (message?.subtype !== 'session_state_changed') return undefined
    const state = asString(message.state)
    return state === undefined ? undefined : state !== 'idle'
  }
  if (method !== ACP.sessionUpdate) return undefined
  const update = asRecord(asRecord(params)?.update)
  if (update?.sessionUpdate !== 'session_info_update') return undefined
  const meta = asRecord(update._meta)
  const threadStatus = asString(asRecord(asRecord(meta?.codex)?.threadStatus)?.type)
  if (threadStatus !== undefined) return threadStatus === 'active'
  const running = asRecord(meta?.piAcp)?.running
  return typeof running === 'boolean' ? running : undefined
}

/**
 * Update variants only a run produces; see `AcpAdapterProfile.infersRunStart`.
 * Plain text is not one: pi-acp also sends `agent_message_chunk` outside any
 * run (an extension's `notify`, a UI request it cannot serve, its startup
 * prelude), and no end report would follow it.
 */
const WORK_UPDATES = new Set(['agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'])

export function isWorkUpdate(params: unknown): boolean {
  const kind = asRecord(asRecord(params)?.update)?.sessionUpdate
  return typeof kind === 'string' && WORK_UPDATES.has(kind)
}

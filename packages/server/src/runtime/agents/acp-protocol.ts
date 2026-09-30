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
  AcpPermissionOption,
  AcpPlanEntry,
  AcpStopReason,
  AcpToolCall,
  AcpToolContent,
  AcpToolKind,
  AcpToolStatus,
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

export interface AcpConfigOption {
  id?: string
  currentValue?: unknown
  options?: Array<{ value?: unknown; name?: string }>
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
 * adapter cannot default them to true.
 */
export function clientCapabilities(): Record<string, unknown> {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  }
}

const TOOL_KINDS: readonly AcpToolKind[] = [
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]
const TOOL_STATUSES: readonly AcpToolStatus[] = ['pending', 'in_progress', 'completed', 'failed']
const STOP_REASONS: readonly AcpStopReason[] = [
  'end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled',
]

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
  kind?: AcpToolKind
  status?: AcpToolStatus
  content?: AcpToolContent[]
  locations?: Array<{ path: string; line?: number }>
}

function toToolCallPatch(update: Record<string, unknown>): AcpToolCallPatch | undefined {
  const toolCallId = asString(update.toolCallId)
  if (toolCallId === undefined) return undefined
  const kind = asString(update.kind)
  const status = asString(update.status)
  const content = 'content' in update ? toToolContent(update.content) : undefined
  const locations = toLocations(update.locations)
  return {
    toolCallId,
    ...(asString(update.title) !== undefined ? { title: asString(update.title) as string } : {}),
    ...(kind !== undefined && (TOOL_KINDS as readonly string[]).includes(kind)
      ? { kind: kind as AcpToolKind }
      : {}),
    ...(status !== undefined && (TOOL_STATUSES as readonly string[]).includes(status)
      ? { status: status as AcpToolStatus }
      : {}),
    ...(content !== undefined ? { content } : {}),
    ...(locations !== undefined ? { locations } : {}),
  }
}

/** Merge a patch onto the last known state of the same call. */
export function mergeToolCall(
  previous: AcpToolCall | undefined,
  patch: AcpToolCallPatch,
): AcpToolCall {
  return {
    toolCallId: patch.toolCallId,
    title: patch.title ?? previous?.title ?? patch.toolCallId,
    kind: patch.kind ?? previous?.kind ?? 'other',
    status: patch.status ?? previous?.status ?? 'pending',
    // Content is cumulative; an update without it is a status change.
    ...(patch.content !== undefined && patch.content.length > 0
      ? { content: patch.content }
      : previous?.content !== undefined ? { content: previous.content } : {}),
    ...(patch.locations ?? previous?.locations
      ? { locations: patch.locations ?? previous?.locations as Array<{ path: string; line?: number }> }
      : {}),
  }
}

/**
 * State for projecting one `session/update` stream into complete events.
 * Tool calls arrive as incremental patches and must be merged. The live
 * path and record replay share this class so they cannot disagree; each
 * stream gets its own instance.
 */
export class AcpProjection {
  private readonly toolCalls = new Map<string, AcpToolCall>()
  /**
   * Permission asks not yet answered. A reply line is just `{id, result}`,
   * so only a seen request identifies it as settling a permission ask.
   */
  private readonly openPermissions = new Set<string>()

  /** Project one `session/request_permission` request line. */
  openPermission(requestId: string, params: unknown): AcpEventInit {
    this.openPermissions.add(requestId)
    const { toolCall, options } = parsePermissionRequest(params)
    return {
      type: 'permission-request',
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

  /** Project one `session/update`'s params, or undefined when it carries
   *  nothing a pane can render. */
  apply(params: unknown): AcpEventInit | undefined {
    const translated = translateSessionUpdate(params)
    if (!translated) return undefined
    if (translated.kind === 'event') return translated.event
    const call = mergeToolCall(this.toolCalls.get(translated.patch.toolCallId), translated.patch)
    this.toolCalls.set(call.toolCallId, call)
    return { type: 'tool', call }
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
        return [{ name, ...(description !== undefined ? { description } : {}) }]
      })
      return event({ type: 'commands', commands })
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
 * The model a session reports, from any message carrying session state
 * (`session/new` and `session/load` replies, `session/set_config_option`
 * replies, `config_option_update`). Reads `models.currentModelId` and the
 * `model` config option.
 *
 * Returns the adapter's display name too, when given: claude's adapter
 * reports a picker alias (`opus[1m]`) that only its name (`Opus 5.5`) ties
 * to a recognizable model.
 */
export function sessionModel(state: unknown): { id: string; name?: string } | undefined {
  const r = asRecord(state)
  if (r === undefined) return undefined
  const models = asRecord(r.models)
  const current = asString(models?.currentModelId)
  if (current !== undefined) {
    const listed = Array.isArray(models?.availableModels) ? models.availableModels : []
    return named(current, asString(listed.map(asRecord).find((m) => asString(m?.modelId) === current)?.name))
  }
  const options = Array.isArray(r.configOptions) ? r.configOptions : []
  const model = options.map(asRecord).find((o) => asString(o?.id) === 'model')
  const value = asString(model?.currentValue)
  if (value === undefined) return undefined
  const choices = Array.isArray(model?.options) ? model.options : []
  return named(value, asString(choices.map(asRecord).find((c) => asString(c?.value) === value)?.name))
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

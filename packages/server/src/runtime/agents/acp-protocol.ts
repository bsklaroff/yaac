/**
 * The Agent Client Protocol, as much of it as yaac speaks — and the
 * translation from its `session/update` notifications into the closed
 * `AcpEvent` union the webapp renders (`@yaac/shared/acp`).
 *
 * This module is the ONLY place in the server that knows ACP's own shapes.
 * That containment is the point: ACP is a live spec with optional
 * capabilities and per-adapter extensions, so an update to it lands here and
 * nowhere else — not in the driver, not in the route, and above all not in
 * React. Everything is parsed defensively: an unrecognized update variant is
 * dropped rather than throwing, because a newer adapter emitting a richer
 * stream must degrade to "yaac renders less", never to a dead conversation.
 *
 * yaac is an unusual ACP client in one way worth stating, because it explains
 * the capabilities declared below. In an editor the agent is remote from the
 * workspace, so the client serves `fs/*` and `terminal/*` on the agent's
 * behalf. Here the agent runs *inside the session container*, on the real
 * /workspace, with its own tools — so yaac declines those capabilities and the
 * agent simply uses its own. That removes a whole class of proxying, and the
 * container boundary (gVisor, the egress proxy, the NetworkPolicy) stays the
 * one thing constraining what the agent may touch.
 */

import type {
  AcpContent,
  AcpEventInit,
  AcpPlanEntry,
  AcpStopReason,
  AcpToolCall,
  AcpToolContent,
  AcpToolKind,
  AcpToolStatus,
} from '@yaac/shared/acp'

/** The ACP revision this client negotiates. */
export const ACP_PROTOCOL_VERSION = 1

/** Method names, verbatim from the spec. Referenced rather than inlined so a
 *  rename is a compile error at every call site. */
export const ACP = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
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

export interface AcpNewSessionResult {
  sessionId: string
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> }
}

export interface AcpPromptResult {
  stopReason?: string
}

/**
 * What yaac tells the agent it can do. `fs` and `terminal` are false by
 * design (see the module header). `readTextFile`/`writeTextFile` are named
 * explicitly rather than omitted so an adapter reading the object cannot
 * default them to true.
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A stop reason yaac doesn't know is reported as `end_turn`: the turn IS
 *  over either way, and inventing a reason would be worse than a plain one. */
export function toStopReason(value: unknown): AcpStopReason {
  const s = asString(value)
  return s !== undefined && (STOP_REASONS as readonly string[]).includes(s)
    ? s as AcpStopReason
    : 'end_turn'
}

/**
 * One ACP content block, or undefined for the variants a container-resident
 * agent never sends us (`audio`, `resource`, `resource_link` — it reads its
 * own files rather than asking us to resolve a URI).
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

/** A chunk update's payload is one block; a tool call's is a list. */
function toContentList(value: unknown): AcpContent[] {
  const list = Array.isArray(value) ? value : [value]
  return list.map(toContent).filter((c): c is AcpContent => c !== undefined)
}

/**
 * A tool call's content entries, which are *wrapped* blocks: `content`
 * carries a block, `diff` carries a before/after pair, `terminal` names a
 * terminal we never created.
 *
 * A diff passes through as a diff. It is the one entry a pane can render
 * better than prose, and flattening it here would be irreversible — the texts
 * read as a diff only because a renderer lines them up, and no amount of
 * markers in a string gets that back. `oldText: null` is how an agent says
 * "new file", so it is dropped to absent rather than becoming the string
 * "null".
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
    // `terminal` entries reference a terminal yaac declined to provide; there
    // is nothing to show.
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
 * A partial tool call, as `tool_call` (full) or `tool_call_update` (a patch
 * naming only what changed). The caller merges patches against what it has
 * already sent, which is why status/title are optional here.
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
    // Content is cumulative: an update that carries none is reporting a
    // status change, not clearing what the call has already produced.
    ...(patch.content !== undefined && patch.content.length > 0
      ? { content: patch.content }
      : previous?.content !== undefined ? { content: previous.content } : {}),
    ...(patch.locations ?? previous?.locations
      ? { locations: patch.locations ?? previous?.locations as Array<{ path: string; line?: number }> }
      : {}),
  }
}

/**
 * A conversation's projection state — everything needed to turn the raw
 * `session/update` stream into complete events, in one owner.
 *
 * Only tool calls need state: ACP sends them as incremental patches, so
 * emitting a *complete* `AcpToolCall` means merging against what came before.
 * Both consumers of the stream need that — the live path and the replay of a
 * record — and giving them a shared class rather than each keeping its own map
 * is what stops the two drifting into different answers about the same
 * conversation.
 *
 * One instance per stream being projected: a live conversation holds one, and
 * each replay of a record makes its own.
 */
export class AcpProjection {
  private readonly toolCalls = new Map<string, AcpToolCall>()

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
 * The translation itself: one `session/update` notification's params into an
 * event, or undefined when there is nothing for a pane to render (an
 * unrecognized variant, or a mode change yaac does not surface).
 *
 * Tool calls come back as a *patch* rather than an event, because merging
 * needs state the caller holds (`AcpProjection`); everything else is
 * self-contained.
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
    // A chunk whose blocks are all unrepresentable here (audio, a resource
    // link) translates to nothing renderable, so it is dropped rather than
    // emitted as an empty message — a pane should show less, not a blank
    // bubble. Tool calls and plans are not filtered this way: an empty one
    // still carries its own meaning.
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
      // `current_mode_update` and anything a newer adapter adds. Deliberately
      // silent: an unknown variant is not an error.
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
 * The permission decision yaac returns for `session/request_permission`.
 *
 * Sessions run the agent with permissions bypassed, because the sandbox, not
 * a prompt, is what constrains a yaac session: the agent is in a gVisor
 * container behind an egress allowlist, on a throwaway git worktree. So the
 * answer is always "allow", and the option to pick is whichever the agent
 * offered that allows *without* also asking again next time.
 *
 * This is why an ACP conversation is `bypass`-only and create refuses the
 * other permission modes: answering a prompt on the user's behalf is the
 * opposite of the restraint they would be asking for. Honoring them means
 * forwarding these requests to the chat pane instead.
 */
export function chooseAllowOption(params: unknown): string | undefined {
  const options = asRecord(params)?.options
  if (!Array.isArray(options)) return undefined
  const parsed = options.flatMap((raw) => {
    const o = asRecord(raw)
    const optionId = asString(o?.optionId)
    return optionId === undefined ? [] : [{ optionId, kind: asString(o?.kind) }]
  })
  return (parsed.find((o) => o.kind === 'allow_always')
    ?? parsed.find((o) => o.kind === 'allow_once')
    ?? parsed[0])?.optionId
}

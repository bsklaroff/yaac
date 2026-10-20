/**
 * Renders a `tui` claude conversation as the same `AcpEvent[]` an `acp` one
 * produces, so it has a readable transcript. A tui conversation has no acpd
 * record, only claude's own session JSONL.
 *
 * The translation is not written here. The pinned `claude-agent-acp` adapter
 * (the version dockerfiles/Dockerfile.tools installs) exposes the two pieces
 * its `session/load` uses: the SDK's `getSessionMessages` and
 * `toAcpNotifications`. This module runs them over a transcript file and
 * feeds the result to `replayAcpLog`, so tui transcripts match what acp
 * renders and no second translation can drift. claude-acp-replay.test.ts
 * pins the version equality.
 *
 * No adapter process runs, so this works for a stopped workspace with no
 * credentials or claude binary, under either driver.
 */

import path from 'node:path'
import { AcpRecordWriter } from './acp-log'
import { ACP, CLAUDE_INTERRUPT, COMPACTION_META } from './acp-protocol'
import { jsonObjects } from './jsonl'
import { openSandboxDir, readSandboxFile, type SandboxFile } from './sandbox-fs'
import { isUuid } from '#lib/uuid'
import { asString } from '#lib/narrow'
import { serverLog } from '#lib/log'
import type { AcpEvent, AcpEventInit } from '@yaac/shared/acp'
// Type-only; the lazy import below is the only runtime load.
import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'

/**
 * Fallback session id. The SDK returns nothing for a non-UUID id; yaac's
 * claude ids are always UUIDs, but a malformed row would fail invisibly, so
 * such an id is replaced. The id selects nothing (the store below returns
 * this transcript regardless) and is dropped by the projection.
 */
const PLACEHOLDER_SESSION_ID = '00000000-0000-0000-0000-000000000000'

/**
 * A conversation's history from claude's transcript, as read by the caller
 * (see `getAgentSessionTranscript`); `ended` when its agent life is over
 * (`AcpRecordWriter`).
 */
export async function claudeTranscriptAsAcp(raw: string, agentSessionId: string, ended = false): Promise<AcpEvent[]> {
  const record = new AcpRecordWriter()
  await synthesizeAcpRecord(raw, agentSessionId, record)
  return record.replay(ended)
}

/** Largest subagent transcript read, and the most of one meta file. */
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 16 * 1024 * 1024
const MAX_SUBAGENT_META_BYTES = 64 * 1024
/** The most subagent meta files read for one conversation. The dir is
 *  workspace-written, so it may hold any number. */
const MAX_SUBAGENT_METAS = 1000

/** The events a subagent's thread shows: its messages and tool calls. Its
 *  task cards, wakes and usage belong to the main conversation. */
const THREAD_EVENTS = new Set<AcpEvent['type']>(['user', 'agent', 'thought', 'tool', 'tool-output', 'plan'])

/**
 * claude subagents' own conversations, as events in their threads (`thread`
 * is the Agent call that launched one). claude keeps each beside the
 * conversation's transcript `session`, as `<session>/subagents/
 * agent-<agentId>.jsonl`, with an `agent-<agentId>.meta.json` naming the
 * call. The metas are read once, and an unreadable one is skipped. The
 * transcripts of `toolUseIds` are then read in order, together at most
 * `maxBytes` (each at most 16 MB, the default); one that would go past it
 * is left out,
 * as is one that is missing. The prompt that opens each is left out too,
 * since a subagent's view shows its task already.
 */
export async function claudeSubagentThreads(
  session: SandboxFile,
  toolUseIds: string[],
  maxBytes = MAX_SUBAGENT_TRANSCRIPT_BYTES,
): Promise<AcpEventInit[]> {
  const dir = `${session.rel.replace(/\.jsonl$/, '')}/subagents`
  const root = await openSandboxDir(session.projectId, session.dir).catch(() => null)
  const wanted = new Set(toolUseIds)
  const agents = new Map<string, string>()
  const metas = (root === null ? [] : await root.readdir(dir))
    .filter((e) => e.isFile() && /^agent-.+\.meta\.json$/.test(e.name))
    .slice(0, MAX_SUBAGENT_METAS)
  for (const entry of metas) {
    if (agents.size === wanted.size) break
    const raw = await readSandboxFile({ ...session, rel: `${dir}/${entry.name}` }, MAX_SUBAGENT_META_BYTES).catch(() => null)
    const toolUseId = jsonObjects(raw?.toString('utf8') ?? '')[0]?.toolUseId
    if (typeof toolUseId === 'string' && wanted.has(toolUseId) && !agents.has(toolUseId)) {
      agents.set(toolUseId, entry.name.slice('agent-'.length, -'.meta.json'.length))
    }
  }
  const out: AcpEventInit[] = []
  let left = maxBytes
  for (const toolUseId of toolUseIds) {
    const agentId = agents.get(toolUseId)
    if (agentId === undefined) continue
    const file = { ...session, rel: `${dir}/agent-${agentId}.jsonl` }
    const raw = await readSandboxFile(file, Math.min(left, MAX_SUBAGENT_TRANSCRIPT_BYTES)).catch(() => null)
    if (raw === null) continue
    left -= raw.length
    const record = new AcpRecordWriter()
    await synthesizeAcpRecord(raw.toString('utf8'), path.basename(session.rel, '.jsonl'), record, true)
    const events = record.replay().filter((e) => THREAD_EVENTS.has(e.type))
    const body = events[0]?.type === 'user' ? events.slice(1) : events
    out.push(...body.map(({ seq: _seq, ...e }) => ({ ...e, thread: toolUseId }) as AcpEventInit))
  }
  return out
}

/**
 * Write a transcript's lines as the record acpd would have written over
 * ACP. A record rather than events, so `replayAcpLog` also handles tool-call
 * merging, sequencing and defensive drops for synthesized conversations.
 *
 * The SDK's parser (`getSessionMessages`) walks one `parentUuid` chain back
 * from the leaf, which stops at a compaction's boundary, so it shows only
 * what followed the latest compaction. claude keeps the whole conversation
 * in the file, so the transcript is cut at each boundary and each part
 * parsed alone. A part after a boundary opens with the compaction, as
 * claude's adapter reports one to a client that declares
 * `session.compaction`, carrying the summary claude kept in place of the
 * user message that holds it, and the boundary's trigger and token counts.
 *
 * A `subagent` transcript's entries are sidechains. They go through the same
 * parser as the main conversation, marked otherwise: the SDK's subagent
 * parser walks one `parentUuid` chain back from the leaf, which drops all
 * but one of a set of parallel tool calls (claude files each as its own
 * entry, and the chain goes on from just one of their results). A
 * subagent's compactions are not shown, as live.
 */
async function synthesizeAcpRecord(
  raw: string,
  agentSessionId: string,
  record: AcpRecordWriter,
  subagent = false,
): Promise<void> {
  const entries = subagent ? jsonObjects(raw).map((e) => ({ ...e, isSidechain: false })) : jsonObjects(raw)
  if (entries.length === 0) return
  // A replay, as `session/load` would send it, so the projection rebuilds
  // subagents and tasks; with no reply, since the conversation may be live.
  record.write({ id: 'replay', method: ACP.sessionLoad, params: {} })

  // Loaded on demand: these packages are megabytes, needed only for the
  // rare transcript read.
  /* eslint-disable no-restricted-syntax -- deferring these is the point; see above */
  const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
  const { stripLocalCommandMetadata, toAcpNotifications } =
    await import('@agentclientprotocol/claude-agent-acp')
  const { isReplayHiddenMetaMessage, messageIdForGrouping } = await import('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js')
  const { compactionSummaryText } = await import('@agentclientprotocol/claude-agent-acp/dist/context-compaction.js')
  /* eslint-enable no-restricted-syntax */

  const sessionId = isUuid(agentSessionId) ? agentSessionId : PLACEHOLDER_SESSION_ID
  // `toolUseCache` spans messages so a `tool_result` finds its `tool_use`
  // (and so a tool call gets its title and kind).
  const toolUseCache = {}
  /** The entries by uuid, which the messages keep. */
  const byUuid = new Map(entries.flatMap((e: Record<string, unknown>) => typeof e.uuid === 'string' ? [[e.uuid, e] as const] : []))
  for (const part of compactedParts(entries)) {
    // A read-only store holding one part. `getSessionMessages` (follows
    // `parentUuid`, drops subagent turns) then reads bytes we supply
    // instead of claude's config dir.
    const sessionStore: SessionStore = {
      load: () => Promise.resolve(part.entries as SessionStoreEntry[]),
      append: () => Promise.reject(new Error('yaac reads transcripts, never writes them')),
    }
    let messages
    try {
      messages = await getSessionMessages(sessionId, { sessionStore })
    } catch (err) {
      // An unparseable part yields nothing, not an error.
      serverLog(`[server] claude transcript replay failed: ${String(err)}`)
      continue
    }

    const isSummary = (m: unknown): boolean => (m as { isCompactSummary?: unknown }).isCompactSummary === true
    if (part.boundary !== undefined && !subagent) {
      const held = (messages.find(isSummary) as { message?: { content?: unknown } } | undefined)?.message?.content
      const summary = typeof held === 'string' ? compactionSummaryText(held) : undefined
      record.write({ method: ACP.sessionUpdate, params: { sessionId, update: compactionUpdate(part.boundary, summary) } })
    }

    // The adapter's `replaySessionHistory` loop minus live-session parts.
    for (const message of messages) {
      const api = (message as { message?: { role?: unknown; content?: unknown } }).message
      const role = api?.role
      if (role !== 'assistant' && role !== 'user') continue
      if (isSummary(message) || isReplayHiddenMetaMessage(message)) continue
      // The live path turns claude's synthetic "Please run /login" message
      // into an auth error; replaying it would show a stale login prompt.
      // The reply claude adds to a stopped turn when it resumes was never
      // shown live.
      const synthetic = role === 'assistant' ? syntheticText(api) : undefined
      if (synthetic?.includes('Please run /login') === true || synthetic === 'No response requested.') continue
      // A stop whose prompt claude never wrote would end the turn before.
      if (role === 'user' && promptMissing(byUuid.get(message.uuid), byUuid)) continue
      let content = api?.content
      // Slash-command bookkeeping (caveat preamble, invocation, stdout) is
      // dropped. A task notification is kept whole: the adapter's stripper
      // removes its markup too, but the projection reads it to settle the
      // tasks the replay rebuilt (`AcpProjection.replayedWake`).
      if (role === 'user' && !isTaskNotification(content)) {
        content = stripLocalCommandMetadata(content)
        if (content === null) continue
      }
      record.time(Date.parse(asString(byUuid.get(message.uuid)?.timestamp) ?? ''))
      for (const notification of toAcpNotifications(
        content as never, role, sessionId, toolUseCache, ACP_CLIENT_UNUSED, SILENT_LOGGER,
        // With hooks off, the adapter returns notifications instead of pushing
        // them through a client. The message id marks a message's chunks as
        // one message, as the adapter's own replay does.
        { registerHooks: false, messageId: messageIdForGrouping(message) },
      )) {
        record.write({ method: ACP.sessionUpdate, params: notification })
      }
    }
  }
}

/**
 * A transcript's entries cut before each compaction boundary claude wrote
 * for the conversation itself; each part after the first carries the
 * boundary that opens it.
 */
function compactedParts(entries: Record<string, unknown>[]): Array<{ boundary?: Record<string, unknown>; entries: Record<string, unknown>[] }> {
  const parts: Array<{ boundary?: Record<string, unknown>; entries: Record<string, unknown>[] }> = [{ entries: [] }]
  for (const entry of entries) {
    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && entry.isSidechain !== true) {
      parts.push({ boundary: entry, entries: [] })
    }
    parts[parts.length - 1].entries.push(entry)
  }
  return parts
}

/** The `compaction_update` a boundary and the summary after it make. */
function compactionUpdate(boundary: Record<string, unknown>, summary: string | undefined): Record<string, unknown> {
  const meta = boundary.compactMetadata as Record<string, unknown> | undefined
  return {
    sessionUpdate: 'compaction_update',
    compactionId: typeof boundary.uuid === 'string' ? boundary.uuid : 'compaction',
    status: 'completed',
    ...(summary !== undefined ? { summary: [{ type: 'text', text: summary }] } : {}),
    _meta: { [COMPACTION_META]: { trigger: meta?.trigger, tokensBefore: meta?.preTokens, tokensAfter: meta?.postTokens } },
  }
}

/**
 * The text of a message claude wrote itself rather than the model, matched
 * like the adapter's internal `isSyntheticLoginMessage`.
 */
function syntheticText(api: { model?: unknown; content?: unknown } | undefined): string | undefined {
  if (api?.model !== '<synthetic>' || !Array.isArray(api.content) || api.content.length !== 1) {
    return undefined
  }
  const block = api.content[0] as { type?: unknown; text?: unknown } | undefined
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

/** A user entry's text, written as a string or as one text block. */
function userText(entry: Record<string, unknown> | undefined): string {
  const content = (entry?.message as { content?: unknown } | undefined)?.content
  const text = Array.isArray(content) && content.length === 1 ? (content[0] as { text?: unknown }).text : content
  return entry?.type === 'user' ? asString(text) ?? '' : ''
}

/** Whether `entry` is claude's message marking where the user stopped a turn. */
function isInterrupt(entry: Record<string, unknown> | undefined): boolean {
  return CLAUDE_INTERRUPT.test(userText(entry))
}

/**
 * Whether `entry` is an interrupt marker whose turn has no prompt in the
 * transcript. A prompt stopped a fraction of a second after it was sent can
 * be left out while its attachments and the marker are kept; the marker then
 * chains, through those attachments (and the system entries closing the turn
 * before), to the previous turn's last message, and its `cancelled` end would
 * read as that turn's.
 *
 * A marker chained to a message directly is a stop mid-reply. One chained
 * through attachments or system entries lacks its prompt when the message
 * they lead back to finished a turn (a reply that calls no tool, an earlier
 * marker, or a local command's output such as `/compact`'s), or when they
 * lead back to the start of a chain. The attachments a running turn writes
 * follow its prompt, a tool result, or a tool call (a hook's output). A link
 * to an entry the transcript lacks says nothing, so it keeps the stop, as
 * does a walk past the transcript's length (a loop: the file is
 * workspace-written).
 */
function promptMissing(entry: Record<string, unknown> | undefined, byUuid: Map<string, Record<string, unknown>>): boolean {
  if (!isInterrupt(entry)) return false
  const between = (e: Record<string, unknown> | undefined): boolean => e?.type === 'attachment' || e?.type === 'system'
  let last = byUuid.get(asString(entry?.parentUuid) ?? '')
  if (!between(last)) return false
  for (let n = 0; between(last) && n < byUuid.size; n++) {
    const parent = asString(last?.parentUuid)
    if (parent === undefined) return true
    last = byUuid.get(parent)
  }
  if (last === undefined || between(last)) return false
  if (last.type === 'user') return isInterrupt(last) || /^<local-command-std(?:out|err)>/.test(userText(last))
  const content = (last.message as { content?: unknown } | undefined)?.content
  return last.type !== 'assistant' || !Array.isArray(content) || !content.some((b) => (b as { type?: unknown }).type === 'tool_use')
}

/** A user message that is claude's report of background work ending, which
 *  claude writes as a string opening with its markup. */
function isTaskNotification(content: unknown): boolean {
  return typeof content === 'string' && content.startsWith('<task-notification>')
}

/**
 * The client `toAcpNotifications` requires but never calls with hooks off
 * (it is used only by the PostToolUse callbacks). Throws, since reaching it
 * would be a bug here.
 */
const ACP_CLIENT_UNUSED = new Proxy({}, {
  get: () => () => {
    throw new Error('claude-acp-replay: the ACP client is not available during replay')
  },
}) as never

/** Drops the adapter's own log output. */
const SILENT_LOGGER = { log: () => {}, error: () => {}, warn: () => {} } as never

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
import { ACP } from './acp-protocol'
import { jsonObjects } from './jsonl'
import { openSandboxDir, readSandboxFile, type SandboxFile } from './sandbox-fs'
import { isUuid } from '#lib/uuid'
import { serverLog } from '#log'
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
 * (see `getAgentSessionTranscript`).
 */
export async function claudeTranscriptAsAcp(raw: string, agentSessionId: string): Promise<AcpEvent[]> {
  const record = new AcpRecordWriter()
  await synthesizeAcpRecord(raw, agentSessionId, record)
  return record.replay()
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
 * A `subagent` transcript's entries are sidechains. They go through the same
 * parser as the main conversation, marked otherwise: the SDK's subagent
 * parser walks one `parentUuid` chain back from the leaf, which drops all
 * but one of a set of parallel tool calls (claude files each as its own
 * entry, and the chain goes on from just one of their results).
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
  /* eslint-enable no-restricted-syntax */

  const sessionId = isUuid(agentSessionId) ? agentSessionId : PLACEHOLDER_SESSION_ID
  // A read-only store holding one session. `getSessionMessages` (the SDK's
  // parser: follows `parentUuid`, drops summaries and subagent turns) then
  // reads bytes we supply instead of claude's config dir.
  const sessionStore: SessionStore = {
    load: () => Promise.resolve(entries as SessionStoreEntry[]),
    append: () => Promise.reject(new Error('yaac reads transcripts, never writes them')),
  }

  let messages
  try {
    messages = await getSessionMessages(sessionId, { sessionStore })
  } catch (err) {
    // An unparseable transcript yields an empty conversation, not an error.
    serverLog(`[server] claude transcript replay failed: ${String(err)}`)
    return
  }

  // The adapter's `replaySessionHistory` loop minus live-session parts.
  // `toolUseCache` spans messages so a `tool_result` finds its `tool_use`
  // (and so a tool call gets its title and kind).
  const toolUseCache = {}
  for (const message of messages) {
    const api = (message as { message?: { role?: unknown; content?: unknown } }).message
    const role = api?.role
    if (role !== 'assistant' && role !== 'user') continue
    // The live path turns claude's synthetic "Please run /login" message
    // into an auth error; replaying it would show a stale login prompt.
    if (role === 'assistant' && isSyntheticLoginMessage(api)) continue
    let content = api?.content
    if (role === 'user') {
      content = stripLocalCommandMetadata(content)
      // Slash-command bookkeeping (caveat preamble, invocation, stdout).
      if (content === null) continue
    }
    for (const notification of toAcpNotifications(
      content as never, role, sessionId, toolUseCache, ACP_CLIENT_UNUSED, SILENT_LOGGER,
      // With hooks off, the adapter returns notifications instead of pushing
      // them through a client.
      { registerHooks: false },
    )) {
      record.write({ method: ACP.sessionUpdate, params: notification })
    }
  }
}

/**
 * claude's synthetic auth message, matched like the adapter's internal
 * `isSyntheticLoginMessage`.
 */
function isSyntheticLoginMessage(api: { model?: unknown; content?: unknown } | undefined): boolean {
  if (api?.model !== '<synthetic>' || !Array.isArray(api.content) || api.content.length !== 1) {
    return false
  }
  const block = api.content[0] as { type?: unknown; text?: unknown } | undefined
  return block?.type === 'text' && typeof block.text === 'string'
    && block.text.includes('Please run /login')
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

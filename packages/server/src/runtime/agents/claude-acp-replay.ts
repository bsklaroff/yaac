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

import { AcpRecordWriter } from './acp-log'
import { ACP } from './acp-protocol'
import { jsonObjects } from './jsonl'
import { isUuid } from '#lib/uuid'
import { serverLog } from '#log'
import type { AcpEvent } from '@yaac/shared/acp'
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

/**
 * Write a transcript's lines as the record acpd would have written over
 * ACP. A record rather than events, so `replayAcpLog` also handles tool-call
 * merging, sequencing and defensive drops for synthesized conversations.
 */
async function synthesizeAcpRecord(raw: string, agentSessionId: string, record: AcpRecordWriter): Promise<void> {
  const entries = jsonObjects(raw)
  if (entries.length === 0) return

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

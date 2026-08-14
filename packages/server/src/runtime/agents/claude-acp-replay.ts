/**
 * A `tui` claude conversation, rendered as the same `AcpEvent[]` an `acp` one
 * produces — so a session that was never driven over ACP still has a readable
 * transcript.
 *
 * An acp conversation has a record: acpd tees the JSON-RPC stream to disk and
 * `readAcpLog` replays it. A tui conversation has no such thing — the agent
 * was driven through a PTY, and the only history it left is claude's own
 * session JSONL. Something has to translate one into the other.
 *
 * That translation is NOT written here. `claude-agent-acp` — the very adapter
 * an acp worktree runs, pinned to the version dockerfiles/Dockerfile.tools
 * installs — exposes as a library the two halves its own `session/load`
 * handler is built from: the SDK's `getSessionMessages` to read a session's
 * messages, and `toAcpNotifications` to turn each one into `session/update`
 * notifications. This module runs that same pair over a transcript file and
 * feeds the result to the same `replayAcpLog` a real record goes through.
 *
 * Reusing the adapter's own function rather than writing a claude-JSONL
 * projector is the whole point: a hand-written one would be a *second*
 * translation of the same data, and the two would disagree the moment claude
 * gained a tool or the adapter changed how it titles one — the transcript a
 * user reads after stopping a worktree would not match what they watched live.
 * Here there is only one translation, and yaac supplies none of it. What is
 * left is plumbing: read the file, hand over the lines, serialize what comes
 * back. `packages/server/test/runtime/agents/claude-acp-replay.test.ts` pins
 * the version equality that makes the reuse honest.
 *
 * No adapter *process* is involved, which is what makes this work for a
 * worktree that is gone: no pod to schedule, no credentials, no claude binary,
 * and the same answer under both drivers.
 */

import fs from 'node:fs/promises'
import { replayAcpLog } from './acp-log'
import { ACP } from './acp-protocol'
import { serverLog } from '#log'
import type { AcpEvent } from '@yaac/shared/acp'
// Type-only, so the lazy runtime import below stays the only load of these
// packages.
import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'

/**
 * The SDK validates the session id it is handed and answers with nothing at
 * all for one that is not a UUID. Every claude conversation id yaac records
 * is one (the founding conversation is pinned to the worktree id, and a
 * `/clear` mints another), so this is a guard against a malformed row rather
 * than an expected shape — but "no messages" would be an invisible way to
 * fail, so an id that cannot pass is replaced with one that can.
 *
 * Substituting is sound because the id does not select anything: the store
 * below answers with this transcript's lines whatever it is asked for, and the
 * `sessionId` it stamps on each notification is dropped by the projection.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACEHOLDER_SESSION_ID = '00000000-0000-0000-0000-000000000000'

/**
 * A conversation's history, read from claude's own transcript.
 *
 * A missing file is not an error — the same verdict `readAcpLog` reaches for a
 * conversation whose agent never spoke: an empty history, not a failure.
 */
export async function readClaudeTranscriptAsAcp(
  transcriptPath: string,
  agentSessionId: string,
): Promise<AcpEvent[]> {
  let raw: string
  try {
    raw = await fs.readFile(transcriptPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      serverLog(`[server] claude transcript ${transcriptPath}: ${String(err)}`)
    }
    return []
  }
  return replayAcpLog(await synthesizeAcpRecord(raw, agentSessionId))
}

/**
 * One transcript's lines as the record acpd would have written had the same
 * conversation been driven over ACP.
 *
 * Building a record rather than `AcpEvent`s directly is what keeps the second
 * half of the pipeline shared as well: `replayAcpLog` owns tool-call patch
 * merging, sequence numbering and the defensive drops, and it must own them
 * for a synthesized conversation exactly as it does for a recorded one.
 */
async function synthesizeAcpRecord(raw: string, agentSessionId: string): Promise<string> {
  const entries = raw.split('\n').flatMap(parseLine)
  if (entries.length === 0) return ''

  // Loaded on demand: between them these two packages are megabytes of
  // adapter and SDK, and nothing else in the server needs them — a transcript
  // being read is rare, while every server start and every unit file would
  // otherwise pay for the import.
  /* eslint-disable no-restricted-syntax -- deferring these is the point; see above */
  const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
  const { stripLocalCommandMetadata, toAcpNotifications } =
    await import('@agentclientprotocol/claude-agent-acp')
  /* eslint-enable no-restricted-syntax */

  const sessionId = UUID_RE.test(agentSessionId) ? agentSessionId : PLACEHOLDER_SESSION_ID
  // A store that only reads, and only ever has one session to answer with.
  // `getSessionMessages` is the SDK's own transcript parser — it threads the
  // `parentUuid` chain, drops summaries and sidechain (subagent) turns, and
  // hands back the messages in order — and taking a store makes it do that
  // over bytes we supply instead of over claude's config directory, which is
  // what lets this run against a project's transcript with no claude install.
  const sessionStore: SessionStore = {
    load: () => Promise.resolve(entries as SessionStoreEntry[]),
    append: () => Promise.reject(new Error('yaac reads transcripts, never writes them')),
  }

  let messages
  try {
    messages = await getSessionMessages(sessionId, { sessionStore })
  } catch (err) {
    // A transcript this SDK cannot parse costs the transcript view, never the
    // request: the stopped worktree still lists, with an empty conversation.
    serverLog(`[server] claude transcript replay failed: ${String(err)}`)
    return ''
  }

  // The adapter's own `replaySessionHistory` loop, with the pieces that only
  // make sense for a live session left out (a client to send to, the message
  // ids `session/rewind` would translate). `toolUseCache` threads across
  // messages on purpose: it is how a `tool_result` finds the `tool_use` it
  // completes, and therefore how a tool call gets its title and kind.
  const toolUseCache = {}
  const lines: string[] = []
  for (const message of messages) {
    const api = (message as { message?: { role?: unknown; content?: unknown } }).message
    const role = api?.role
    if (role !== 'assistant' && role !== 'user') continue
    // The live path turns claude's synthetic "Please run /login" message into
    // an auth error rather than showing its TUI text; that message stays in
    // the transcript forever, so a replay that rendered it would resurface a
    // stale login prompt in every reading of this conversation.
    if (role === 'assistant' && isSyntheticLoginMessage(api)) continue
    let content = api?.content
    if (role === 'user') {
      content = stripLocalCommandMetadata(content as never)
      // Slash-command bookkeeping — the caveat preamble, the invocation, its
      // captured stdout. Real entries in the transcript, but not things anyone
      // said.
      if (content === null) continue
    }
    for (const notification of toAcpNotifications(
      content as never, role, sessionId, toolUseCache, ACP_CLIENT_UNUSED, SILENT_LOGGER,
      // The flag that makes this a pure translation: with hooks off, the
      // adapter builds notifications and returns them instead of registering
      // callbacks that would later push through a client we do not have.
      { registerHooks: false },
    )) {
      lines.push(JSON.stringify({
        jsonrpc: '2.0',
        method: ACP.sessionUpdate,
        params: notification,
      }))
    }
  }
  return lines.join('\n')
}

/** One transcript line as an object; anything unparseable contributes
 *  nothing. A transcript can end mid-write, and a tool that printed something
 *  else into it is not a reason to lose the conversation. */
function parseLine(line: string): unknown[] {
  if (line.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? [parsed] : []
  } catch {
    return []
  }
}

/**
 * claude's synthetic auth message, by the same shape the adapter matches on
 * (`isSyntheticLoginMessage`, not on its public entry).
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
 * The client `toAcpNotifications` takes but never calls when hooks are off:
 * its only use is inside the PostToolUse callbacks `registerHooks: false`
 * declines to register. Reaching it would be a bug in this module's
 * assumptions rather than a runtime condition, so it throws rather than
 * silently doing nothing.
 */
const ACP_CLIENT_UNUSED = new Proxy({}, {
  get: () => () => {
    throw new Error('claude-acp-replay: the ACP client is not available during replay')
  },
}) as never

/** The adapter logs adapter problems; a transcript read is not the place for
 *  them to reach a user's server log. */
const SILENT_LOGGER = { log: () => {}, error: () => {}, warn: () => {} } as never

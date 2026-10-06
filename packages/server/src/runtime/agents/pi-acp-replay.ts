/**
 * Renders a `tui` pi conversation as the same `AcpEvent[]` an `acp` one
 * produces. A tui conversation has no acpd record, only pi's session log
 * (docs/session-format.md in pi's package), so this module writes the
 * `session/update` lines the pinned pi-acp sends live during a turn and
 * feeds them to `replayAcpLog`.
 *
 * pi-acp's own `session/load` replay is not reused: it drops thinking, tool
 * inputs and shell commands. The shapes here follow its live event
 * translation instead (`handlePiEvent`), with these differences:
 *
 *  - An edit's diff is one block per hunk of pi's recorded patch, and a
 *    write's shows the whole file as new, where pi-acp diffs the file
 *    before and after on disk.
 *  - pi-acp's text for a manual `/compact` stands for every compaction,
 *    since the log does not say which kind ran.
 *  - What only pi's TUI shows is rendered too: a branch summary and an
 *    extension's visible message as agent text, a user `!` command as a
 *    shell call.
 *
 * Dropped, since nothing in a transcript renders them or the log does not
 * hold them: pi-acp's startup banner, failed requests' error text (pi-acp
 * shows none either), system prompts, model, thinking-level and usage
 * entries (the projection keeps only the latest model and usage, for the
 * composer), labels, session names, context edits, extension state, hidden
 * extension messages, and every entry off the active branch.
 */

import { isAbsolute, resolve } from 'node:path'
import { AcpRecordWriter } from './acp-log'
import { ACP, asRecord, asString, unifiedDiffHunks } from './acp-protocol'
import { jsonObjects } from './jsonl'
import type { AcpEvent } from '@yaac/shared/acp'

type Entry = Record<string, unknown>

/** A conversation's history from pi's session log. */
export function piTranscriptAsAcp(raw: string): AcpEvent[] {
  const entries = jsonObjects(raw)
  const cwd = asString(entries.find((e) => e.type === 'session')?.cwd)
  const record = new AcpRecordWriter()
  const send = (msg: Entry): void => {
    record.write(msg)
  }
  const update = (u: Entry): void => {
    send({ method: ACP.sessionUpdate, params: { update: u } })
  }
  // pi-acp's report of a run starting or ending; a start is a turn boundary.
  const running = (state: boolean): void => {
    update({ sessionUpdate: 'session_info_update', _meta: { piAcp: { running: state } } })
  }
  // Text shown outside any turn, kept from joining the text before it.
  const agentRun = (content: Entry[]): void => {
    if (content.length === 0) return
    running(false)
    running(true)
    update({ sessionUpdate: 'agent_message_chunk', content })
  }
  const argsById = new Map<string, Entry>()
  let lastRole: unknown

  for (const entry of activeBranch(entries)) {
    if (entry.type === 'compaction') {
      const tokens = typeof entry.tokensBefore === 'number' ? `\nTokens before: ${String(entry.tokensBefore)}` : ''
      agentRun(text(`Compaction completed.${tokens}\n\n${asString(entry.summary) ?? ''}`))
    } else if (entry.type === 'branch_summary') {
      agentRun(text(`**Branch Summary**\n\n${asString(entry.summary) ?? ''}`))
    } else if (entry.type === 'custom_message') {
      if (entry.display === true) agentRun(blocks(entry.content))
    }
    const m = entry.type === 'message' ? asRecord(entry.message) : undefined
    if (m === undefined) continue
    const role = m.role
    if (role === 'user') {
      // A message pi took mid-turn follows a tool result; live, it came in
      // as a steer.
      const content = blocks(m.content)
      if (lastRole === 'toolResult') {
        const id = `steer-${String(entry.id)}`
        send({ id, method: ACP.sessionSteer, params: { prompt: content } })
        send({ id, result: { outcome: 'injected' } })
      } else {
        running(false)
        update({ sessionUpdate: 'user_message_chunk', content })
        running(true)
      }
    } else if (role === 'assistant') {
      for (const block of Array.isArray(m.content) ? m.content.map(asRecord) : []) {
        const thinking = asString(block?.thinking)
        const said = asString(block?.text)
        if (block?.type === 'thinking' && thinking) {
          update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: thinking } })
        } else if (block?.type === 'text' && said) {
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: said } })
        } else if (block?.type === 'toolCall') {
          const id = asString(block.id)
          if (id === undefined) continue
          const name = asString(block.name) ?? 'tool'
          const args = asRecord(block.arguments) ?? {}
          argsById.set(id, args)
          update(isBash(name)
            ? { sessionUpdate: 'tool_call', toolCallId: id, title: bashCommand(args) ?? name, kind: 'execute', status: 'pending' }
            : {
                sessionUpdate: 'tool_call', toolCallId: id, title: name, kind: toolKind(name), status: 'pending',
                ...locations(args, cwd), rawInput: args,
              })
        }
      }
    } else if (role === 'toolResult') {
      const id = asString(m.toolCallId)
      if (id !== undefined) update(toolResult(id, m, argsById.get(id) ?? {}, cwd))
    } else if (role === 'bashExecution') {
      // A command the user ran with `!`.
      const id = `bash-${String(entry.id)}`
      update({ sessionUpdate: 'tool_call', toolCallId: id, title: asString(m.command) ?? 'bash', kind: 'execute', status: 'pending' })
      update({
        sessionUpdate: 'tool_call_update', toolCallId: id, status: m.exitCode === 0 ? 'completed' : 'failed',
        ...output(asString(m.output) ?? ''),
      })
    } else if (role === 'custom' && m.display === true) {
      agentRun(blocks(m.content))
    }
    lastRole = role
  }
  return record.replay()
}

/**
 * The entries pi shows: the path from the last entry (pi's leaf on load)
 * back to the root along `parentId`. A compaction is on that path and its
 * parent is the turn before it, so turns it summarized are kept.
 */
function activeBranch(entries: Entry[]): Entry[] {
  const byId = new Map<unknown, Entry>()
  for (const e of entries) if (e.type !== 'session' && typeof e.id === 'string') byId.set(e.id, e)
  const path: Entry[] = []
  const seen = new Set<Entry>()
  for (let e = [...byId.values()].at(-1); e !== undefined && !seen.has(e); e = byId.get(e.parentId)) {
    seen.add(e)
    path.push(e)
  }
  return path.reverse()
}

/** A tool result as pi-acp's closing `tool_call_update`. */
function toolResult(id: string, m: Entry, args: Entry, cwd: string | undefined): Entry {
  const failed = m.isError === true
  const name = asString(m.toolName) ?? ''
  const base = { sessionUpdate: 'tool_call_update', toolCallId: id, status: failed ? 'failed' : 'completed' }
  const said = resultText(m.content)
  if (isBash(name)) return { ...base, ...output(said) }
  const details = asRecord(m.details)
  const path = toolPath(args)
  if (!failed && path !== undefined) {
    const content = name === 'write' && typeof args.content === 'string'
      ? [{ type: 'diff', path, newText: args.content }]
      : name === 'edit' ? unifiedDiffHunks(asString(details?.patch) ?? '').map((h) => ({ type: 'diff', path, ...h })) : []
    if (content.length > 0) {
      const line = details?.firstChangedLine
      return { ...base, content, ...(typeof line === 'number' ? locations(args, cwd, line) : {}) }
    }
  }
  const diff = asString(details?.diff)
  const shown = diff?.trim() ? diff : said
  return { ...base, ...(shown !== '' ? { content: [{ type: 'content', content: { type: 'text', text: shown } }] } : {}) }
}

function output(data: string): Entry {
  return data === '' ? {} : { _meta: { terminal_output: { data } } }
}

function isBash(name: string): boolean {
  return name.toLowerCase() === 'bash'
}

function bashCommand(args: Entry): string | undefined {
  const command = asString(args.command) ?? asString(args.cmd)
  return command?.trim() ? command : undefined
}

function toolKind(name: string): string {
  if (name === 'read') return 'read'
  return name === 'write' || name === 'edit' ? 'edit' : 'other'
}

function toolPath(args: Entry): string | undefined {
  return asString(args.path) ?? asString(args.file_path)
}

/** The file a tool works on, absolute as pi-acp reports it. */
function locations(args: Entry, cwd: string | undefined, line?: number): Entry {
  const path = toolPath(args)
  if (path === undefined) return {}
  const abs = isAbsolute(path) || cwd === undefined ? path : resolve(cwd, path)
  return { locations: [{ path: abs, ...(line !== undefined ? { line } : {}) }] }
}

function text(t: string): Entry[] {
  return [{ type: 'text', text: t }]
}

/** User or extension content: a string, or text and image blocks. */
function blocks(content: unknown): Entry[] {
  if (typeof content === 'string') return content === '' ? [] : text(content)
  if (!Array.isArray(content)) return []
  return content.flatMap((b) => {
    const block = asRecord(b)
    return block?.type === 'text' || block?.type === 'image' ? [block] : []
  })
}

/** A tool result's text blocks, joined. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((b) => {
    const block = asRecord(b)
    return block?.type === 'text' ? asString(block.text) ?? '' : ''
  }).join('')
}

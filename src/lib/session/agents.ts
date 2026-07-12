/**
 * The sub-agent tree for a session: what the coding agent fanned out into.
 *
 * Claude Code records each spawn as an `Agent` tool_use in the session
 * transcript (with `subagent_type` + `description`), and its completion as the
 * matching `tool_result` (whose content is the sub-agent's final report). Each
 * sub-agent's full internal transcript is a separate file under
 * `<sessionId>/subagents/agent-<hash>.jsonl` (used later for step drill-down).
 *
 * The transcript is hostPath-mounted, so this reads it directly host-side —
 * no pod exec. Codex (subagent-tagged rollouts) and OpenCode (child sessions
 * via its HTTP API) will get their own readers behind the same shape.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { claudeDir } from '@/lib/project/paths'
import type { SubAgent, SessionAgents } from '@/shared/types'

/** Cap a sub-agent's inlined result so the (polled) tree stays light; the
 *  full output lives in its own transcript for drill-down. */
const MAX_RESULT_CHARS = 6000

/** Flatten a message/tool_result `content` (string or block array) to text. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type?: string; text?: string } => !!b && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

function toEpochMs(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : undefined
}

interface Spawn { type: string; task: string; spawnedAt?: number }

/**
 * Parse a Claude Code session transcript (JSONL lines) into the sub-agents it
 * spawned, in spawn order. A sub-agent is `done` once a `tool_result` for its
 * spawn id appears (its content is the final report); otherwise `running`.
 */
export function parseClaudeAgents(lines: Iterable<string>): SubAgent[] {
  const spawns = new Map<string, Spawn>()
  const order: string[] = []
  const results = new Map<string, { result: string; completedAt?: number }>()

  for (const line of lines) {
    if (!line.trim()) continue
    let entry: { timestamp?: unknown; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    const ts = toEpochMs(entry.timestamp)

    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown }
      if (b.type === 'tool_use' && b.name === 'Agent' && typeof b.id === 'string') {
        if (!spawns.has(b.id)) {
          order.push(b.id)
          spawns.set(b.id, {
            type: typeof b.input?.subagent_type === 'string' ? b.input.subagent_type : 'agent',
            task: typeof b.input?.description === 'string' ? b.input.description : '',
            spawnedAt: ts,
          })
        }
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && spawns.has(b.tool_use_id)) {
        // Only Agent spawns are tracked, so this ignores every other tool's result.
        results.set(b.tool_use_id, { result: contentText(b.content).slice(0, MAX_RESULT_CHARS), completedAt: ts })
      }
    }
  }

  return order.map((id) => {
    const spawn = spawns.get(id) as Spawn
    const done = results.get(id)
    const agent: SubAgent = {
      id,
      type: spawn.type,
      task: spawn.task,
      status: done ? 'done' : 'running',
      spawnedAt: spawn.spawnedAt,
    }
    if (done) {
      if (done.result) agent.result = done.result
      agent.completedAt = done.completedAt
    }
    return agent
  })
}

/** Read + parse a Claude session transcript file; empty if it doesn't exist. */
export async function readClaudeAgents(transcriptPath: string): Promise<SubAgent[]> {
  let raw: string
  try {
    raw = await fs.readFile(transcriptPath, 'utf8')
  } catch {
    return []
  }
  return parseClaudeAgents(raw.split('\n'))
}

/** The Claude session transcript path (host-side, hostPath-mounted). */
export function claudeTranscriptPath(projectSlug: string, sessionId: string): string {
  return path.join(claudeDir(projectSlug), 'projects', '-workspace', `${sessionId}.jsonl`)
}

/** The sub-agent tree for a session (Claude for now). */
export async function getSessionAgents(projectSlug: string, sessionId: string): Promise<SessionAgents> {
  return { agents: await readClaudeAgents(claudeTranscriptPath(projectSlug, sessionId)) }
}

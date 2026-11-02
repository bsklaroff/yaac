import { TOOL_LABEL } from '#lib/icons'
import type { AgentTool, SessionEntry } from '@yaac/shared/types'

/**
 * The display name of an agent: the tool, plus the model when known
 * ("Claude · Opus 5").
 *
 * The server sends the catalog's display name (`modelName`) when it has one.
 * Otherwise the raw model id is shortened here, conservatively: an id that
 * isn't recognized is shown as-is, since a wrong short name is worse than a
 * long correct one.
 */

/**
 * Anthropic's id format: `claude-<family>-<major>[-<minor>][-<date>]`, plus
 * an optional `[1m]` long-context suffix. The minor is at most two digits
 * and must end at a boundary, so the date in `claude-sonnet-4-20250514` is
 * not read as a version.
 */
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?=$|-|\[))?/

/**
 * A model id as a person would say it: `claude-opus-4-8` → `Opus 4.8`. A
 * `provider/model` id drops the provider (`openai/gpt-5.6` → `gpt-5.6`),
 * which the tool name beside it already implies.
 */
export function formatModel(model: string): string {
  const bare = model.slice(model.lastIndexOf('/') + 1)
  const claude = CLAUDE_ID.exec(bare)
  if (claude === null) return bare
  const [, family, major, minor] = claude
  const version = minor === undefined ? major : `${major}.${minor}`
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`
}

/** A model as shown: the catalog's name when the server sent one, else the
 *  id shortened by `formatModel`. */
export function modelLabel(named: { model?: string; modelName?: string }): string | undefined {
  return named.modelName ?? (named.model !== undefined ? formatModel(named.model) : undefined)
}

/** "Claude · Opus 5", or just the tool name when no model is known yet, or
 *  "No agent" without a tool (a workspace with no session). */
export function agentLabel(
  tool: AgentTool | undefined,
  named: { model?: string; modelName?: string } | undefined,
): string {
  if (tool === undefined) return 'No agent'
  const model = named !== undefined ? modelLabel(named) : undefined
  return model === undefined ? TOOL_LABEL[tool] : `${TOOL_LABEL[tool]} · ${model}`
}

/**
 * A workspace's agent as one label: its first session's ("Claude ·
 * Opus 5"), or "No agent" for a workspace with none. A stopped workspace's
 * are the sessions a restart brings back.
 */
export function workspaceAgentLabel(workspace: { sessions: SessionEntry[] }): string {
  const [first] = workspace.sessions
  return agentLabel(first?.tool, first)
}

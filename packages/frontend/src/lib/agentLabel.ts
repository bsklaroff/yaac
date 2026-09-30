import { TOOL_LABEL } from '#lib/icons'
import type { AgentSessionEntry, AgentTool } from '@yaac/shared/types'

/**
 * The display name of a workspace's agent: the tool, plus the model when
 * known ("Claude · Opus 5").
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

/** "Claude · Opus 5", or just the tool name when no model is known yet. */
export function agentLabel(
  tool: AgentTool,
  named: { model?: string; modelName?: string } | undefined,
): string {
  const model = named !== undefined ? modelLabel(named) : undefined
  return model === undefined ? TOOL_LABEL[tool] : `${TOOL_LABEL[tool]} · ${model}`
}

/**
 * The agent session whose model names the workspace in its sidebar row.
 * Prefers active sessions, then the lowest ordinal (the primary agent). If
 * no active session has reported a model, falls back to history. On a
 * stopped workspace this is the model last used, which a restart may not
 * resume with.
 */
export function workspaceModel(
  workspace: { agentSessions: AgentSessionEntry[] },
): AgentSessionEntry | undefined {
  const byOrdinal = [...workspace.agentSessions].sort((a, b) => a.ordinal - b.ordinal)
  const named = (s: AgentSessionEntry): boolean => s.model !== undefined
  return byOrdinal.find((s) => s.active && named(s)) ?? byOrdinal.find(named)
}

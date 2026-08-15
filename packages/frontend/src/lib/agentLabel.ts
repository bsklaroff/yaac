import { TOOL_LABEL } from '#lib/icons'
import type { AgentSessionEntry, AgentTool, WorktreeListEntry } from '@yaac/shared/types'

/**
 * How a worktree's agent is named wherever it is named: the tool, and the
 * model it is answering as when the server knows one ("Claude · Opus 5").
 *
 * The model arrives verbatim in the tool's own spelling, which is the right
 * thing to store and the wrong thing to show — `claude-opus-5` beside a tool
 * name reads as a config value, not as a fact about the conversation. So the
 * shortening here is presentational only, and deliberately conservative: an
 * id it does not recognize is shown as-is rather than mangled, since a wrong
 * short name is worse than a long right one.
 */

/**
 * Anthropic's id grammar: `claude-<family>-<major>[-<minor>][-<date>]`, plus
 * the `[1m]` context suffix the long-context variants carry.
 *
 * The minor is bounded to two digits and must be followed by an id boundary,
 * or the optional group swallows the 8-digit date of a major-only dated id
 * (`claude-sonnet-4-20250514`) and renders it as a version — recognizing an id
 * and then mangling it, which is worse than not recognizing it at all.
 */
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?=$|-|\[))?/

/**
 * A model id as a person would say it. `claude-opus-5` → `Opus 5`,
 * `claude-opus-4-8` → `Opus 4.8`; a `provider/model` id keeps only the model
 * half (`anthropic/claude-opus-4-8` → `Opus 4.8`, `openai/gpt-5.6` →
 * `gpt-5.6`), since the provider is already implied by the tool beside it.
 */
export function formatModel(model: string): string {
  const bare = model.slice(model.lastIndexOf('/') + 1)
  const claude = CLAUDE_ID.exec(bare)
  if (claude === null) return bare
  const [, family, major, minor] = claude
  const version = minor === undefined ? major : `${major}.${minor}`
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`
}

/** "Claude · Opus 5", or the bare tool name when no model is known — which is
 *  every conversation before its agent first answers, and every opencode one. */
export function agentLabel(tool: AgentTool, model: string | undefined): string {
  return model === undefined ? TOOL_LABEL[tool] : `${TOOL_LABEL[tool]} · ${formatModel(model)}`
}

/**
 * The model a whole worktree is running, for the one line the sidebar has to
 * say it on. A live conversation is the honest answer, so those are preferred
 * over history; among several, the earliest is the worktree's primary agent
 * (ordinal 0 is the window a restart brings up first).
 *
 * A worktree whose live conversations have not reported a model yet still
 * shows one from its history rather than nothing: the transcript it came from
 * is the same one the live agent is appending to.
 */
export function worktreeModel(worktree: WorktreeListEntry): string | undefined {
  const byOrdinal = [...worktree.agentSessions].sort((a, b) => a.ordinal - b.ordinal)
  const named = (s: AgentSessionEntry): boolean => s.model !== undefined
  return (byOrdinal.find((s) => s.active && named(s)) ?? byOrdinal.find(named))?.model
}

/**
 * The per-tool dispatch table: everything the rest of the server asks about
 * "the agent" without wanting to know which one it is. Each function here
 * switches on an `AgentTool` and delegates to that tool's module, so the
 * tool-specific grammars (claude's spinner titles, opencode's busy markers,
 * codex's rollout files) stay behind this file and never reach a caller.
 *
 * Window naming lives here too, because its two halves are inverses:
 * session setup names an agent's tmux window (`agentWindowName`) and the
 * status watcher reads that name back to pick the tool (`agentWindowTool`).
 * Splitting them across folders is how a rename silently stops a pane from
 * ever being classified.
 */
import { AGENT_TOOLS, MAX_MODEL_LENGTH } from '@yaac/shared/types'
import { codexDir } from '@yaac/shared/project-paths'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'
import { acpAdapterFor, acpPermissionModeFor } from './acp-adapters'
import { classifyClaudeTitle, claudePermissionMode, getFirstUserMessage } from './claude'
import {
  CODEX_MODEL_FORMAT,
  classifyCodexTitle,
  codexModelSlug,
  getCodexFirstUserMessage,
} from './codex'
import {
  OPENCODE_BUSY_MARKERS,
  getSessionOpencodeFirstUserMessage,
  opencodePermissionMode,
} from './opencode'
import { PI_BUSY_MARKERS, getPiFirstUserMessage } from './pi'

/** What an agent pane is doing, as every display path reads it. */
export type AgentPaneStatus = 'running' | 'waiting'

/**
 * One agent session's first user message, read from the transcript recorded
 * for it. There is deliberately no by-id variant: a conversation started by
 * `/clear` has an id yaac never chose, and codex's rollout filename is not
 * derivable from any id at all — the recorded path is the only handle.
 *
 * opencode is the exception it always is: no host transcript, so its first
 * message comes from an HTTP probe into the running container and is
 * unavailable once the pod is gone.
 */
export async function getAgentSessionFirstMessage(
  tool: AgentTool,
  transcriptPath: string | undefined,
  jobName?: string,
): Promise<string | undefined> {
  if (tool === 'opencode') return jobName ? getSessionOpencodeFirstUserMessage(jobName) : undefined
  if (transcriptPath === undefined) return undefined
  if (tool === 'codex') return getCodexFirstUserMessage(transcriptPath)
  if (tool === 'pi') return getPiFirstUserMessage(transcriptPath)
  return getFirstUserMessage(transcriptPath)
}

/**
 * The tmux pane option a tool's in-pane reporter sets to the model it is
 * running (`worktree-bin/yaac-agent-report`) — claude from its `SessionStart`
 * and `PostModelSwitch` hooks, opencode and pi from a plugin and an extension
 * of their own.
 */
export const MODEL_PANE_OPTION = '@yaac-model'

/**
 * The tmux format a pane's model subscription watches. Every tool but codex
 * reports through `MODEL_PANE_OPTION`; codex can run nothing on a model
 * change, but rewrites its title, so its format cuts the model out of that.
 * Either way the value moves the moment the switch lands, and tmux pushes it.
 *
 * The option is filtered to printable ASCII and bounded INSIDE the format.
 * tmux escapes a pane title but expands a user option verbatim into the
 * `%subscription-changed` line, and anything in the workspace can set one —
 * so an unfiltered value could carry a newline and forge control-mode lines
 * (`%exit`, another pane's status, a `%begin` that desyncs replies). Filtering
 * where the value is written would not help: the agent can run `tmux
 * set-option` itself. (Not `[[:cntrl:]]`: its `:` ends the modifier list.)
 */
export function agentModelFormat(tool: AgentTool): string {
  return tool === 'codex'
    ? CODEX_MODEL_FORMAT
    : `#{=${MAX_MODEL_LENGTH};s/[^ -~]//:${MODEL_PANE_OPTION}}`
}

/**
 * The tmux pane option a tool's reporter sets to the permission mode it is in,
 * in its own words: claude's mode name, from its `UserPromptSubmit` and `Stop`
 * hooks, and opencode's agent (`build`, `plan`), from its plugin. Both go
 * through the same script as the model (`worktree-bin/yaac-agent-report`).
 */
export const MODE_PANE_OPTION = '@yaac-permission-mode'

/** Joins the two halves of `agentReportFormat`'s value. The mode half is
 *  filtered to letters and dashes, so the last one is always the join. */
const REPORT_SEPARATOR = '|'

/**
 * The tmux format a pane's report subscription watches: its model
 * (`agentModelFormat`) and its permission mode (`MODE_PANE_OPTION`), in one
 * value so one subscription carries both. The mode is filtered inside the
 * format for the same reason the model is — anything in the workspace can set
 * the option — and more tightly, since every mode name is a word.
 */
export function agentReportFormat(tool: AgentTool): string {
  return `${agentModelFormat(tool)}${REPORT_SEPARATOR}#{=32;s/[^A-Za-z-]//:${MODE_PANE_OPTION}}`
}

/** The two halves of a pushed `agentReportFormat` value; either may be empty
 *  — a pane whose tool has not reported that half yet. */
export function splitAgentReport(value: string): { model: string; mode: string } {
  const at = value.lastIndexOf(REPORT_SEPARATOR)
  return at < 0
    ? { model: value, mode: '' }
    : { model: value.slice(0, at), mode: value.slice(at + REPORT_SEPARATOR.length).trim() }
}

/**
 * The posture an agent's reported mode (`LiveAgent.reportedMode`) stands for,
 * or undefined when it names none yaac has — which is left unrecorded rather
 * than rounded to a neighbour.
 *
 * Under `acp` it is a session mode id, read back through the adapter's
 * profile. Under `tui` it is what the tool's reporter published: claude's own
 * mode name, or opencode's agent, which only means something against the
 * posture the worktree runs under now (`current`). codex publishes none — its
 * hooks can only tell `bypassPermissions` from everything else, so its posture
 * is read from its rollout (`getCodexPermissionMode`) — and pi has no modes.
 */
export function resolveAgentPermissionMode(
  mode: AgentMode,
  tool: AgentTool,
  reported: string,
  current: PermissionMode,
): PermissionMode | undefined {
  if (mode === 'acp') return acpPermissionModeFor(acpAdapterFor(tool), reported)
  if (tool === 'claude') return claudePermissionMode(reported)
  if (tool === 'opencode') return opencodePermissionMode(reported, current)
  return undefined
}

/**
 * The model id a pushed model-format value names, in the tool's own spelling
 * (`claude-opus-5-5[1m]`, `gpt-5.6-sol`, `anthropic/claude-opus-4-8`), or
 * undefined for an empty push — a pane whose tool has not reported yet.
 * Only codex needs a lookup: its title shows the catalog's display name.
 */
export async function resolveAgentModel(
  tool: AgentTool,
  projectSlug: string,
  observed: string,
): Promise<string | undefined> {
  const value = observed.trim()
  if (value === '') return undefined
  return tool === 'codex' ? codexModelSlug(codexDir(projectSlug), value) : value
}

/**
 * Build a tmux format that resolves to `running`/`waiting` by searching the
 * visible pane for any of `markers` (each an ERE, matched case-insensitively
 * via `#{C/ri:}` — a content search over the visible grid). The markers are
 * OR'd; a match in the pane means `running`, none means `waiting`.
 *
 * Markers must obey tmux-ERE limits (see the agent modules' definitions): no
 * `(?:...)` (use `(...)`), no `{n,}` interval (whose `}` would close the
 * `#{...}`), and no literal `,` (the `#{||:}`/`#{?}` argument separator).
 */
function busyStatusFormat(markers: readonly string[]): string {
  const anyBusy = markers
    .map((m) => `#{C/ri:${m}}`)
    .reduceRight((acc, probe) => (acc ? `#{||:${probe},${acc}}` : probe), '')
  return `#{?${anyBusy},running,waiting}`
}

/**
 * The tmux status format a tool's watcher subscribes to. claude/codex expose
 * busy/idle in the pane's OSC title, so the format is `#{pane_title}` and the
 * pushed value is classified server-side (`classifyAgentObservation`).
 * opencode/pi render it into the pane, so the format resolves the verdict
 * inside tmux and pushes `running`/`waiting` directly.
 */
export function agentStatusFormat(tool: AgentTool): string {
  if (tool === 'opencode') return busyStatusFormat(OPENCODE_BUSY_MARKERS)
  if (tool === 'pi') return busyStatusFormat(PI_BUSY_MARKERS)
  return '#{pane_title}'
}

/**
 * Classify a pushed subscription value for a tool. claude/codex push the pane
 * title (classified by its spinner prefix); opencode/pi push an
 * already-resolved verdict from their `agentStatusFormat`.
 */
export function classifyAgentObservation(tool: AgentTool, observed: string): AgentPaneStatus {
  if (tool === 'codex') return classifyCodexTitle(observed)
  if (tool === 'opencode' || tool === 'pi') return observed.trim() === 'running' ? 'running' : 'waiting'
  return classifyClaudeTitle(observed)
}

/**
 * The tmux window name for a worktree's Nth agent. The first keeps the bare
 * tool name, so every existing `yaac:<tool>` target — the prompt paste, the
 * CLI's `attach --agent`, the terminals listing — resolves exactly as before
 * no matter how many agents a worktree ends up holding. Extras are
 * `<tool>-2`, `<tool>-3`, …
 */
export function agentWindowName(tool: AgentTool, index: number): string {
  return index === 0 ? tool : `${tool}-${index + 1}`
}

/**
 * The agent tool a tmux window runs, or undefined when it is not an agent
 * window — the inverse of `agentWindowName`.
 *
 * Any tool matches, not just the worktree's: a worktree can hold a codex
 * conversation beside its claude ones, and matching only the worktree's tool
 * would drop that window from the live pane set — which in turn leaves its
 * link inactive, so the next restart silently forgets a conversation that was
 * running when the worktree stopped.
 *
 * Init-command windows and scratch shells are excluded — they have no agent
 * status to classify. An agent a user starts by hand inside a *scratch*
 * window is therefore linked as a conversation (its hook still fires) but
 * carries no status dot; naming the window after the tool is what opts it in.
 */
export function agentWindowTool(windowName: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => windowName === t || new RegExp(`^${t}-\\d+$`).test(windowName))
}

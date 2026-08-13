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
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { AgentTool } from '@yaac/shared/types'
import { classifyClaudeTitle, getFirstUserMessage } from './claude'
import { classifyCodexTitle, getCodexFirstUserMessage } from './codex'
import { OPENCODE_BUSY_MARKERS, getSessionOpencodeFirstUserMessage } from './opencode'
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
 * title (classified by the Braille-spinner prefix); opencode/pi push an
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

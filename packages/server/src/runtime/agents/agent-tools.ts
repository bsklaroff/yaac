/**
 * Per-tool dispatch: everything the server asks about "the agent" without
 * caring which tool it is. Each function switches on `AgentTool` and
 * delegates to that tool's module, keeping tool-specific formats (claude's
 * spinner titles, opencode's busy markers, codex's rollout files) out of
 * callers.
 *
 * Window naming is here too: setup names an agent's window
 * (`agentWindowName`) and the status watcher parses it back
 * (`agentWindowTool`), so the two must stay in sync.
 */
import path from 'node:path'
import { AGENT_TOOLS, MAX_MODEL_LENGTH, PERMISSION_MODES, agentSessionIdSchema } from '@yaac/shared/types'
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
import type { SandboxFile } from './sandbox-fs'

/** What an agent pane is doing, as every display path reads it. */
export type AgentPaneStatus = 'running' | 'waiting'

/**
 * A conversation's first user message, read from its recorded transcript.
 * There is no by-id variant: a `/clear` conversation has an id yaac did not
 * choose, and codex's rollout filename is not derivable from any id.
 *
 * opencode has no host transcript, so its first message comes from an HTTP
 * probe into the running workspace and is unavailable once it stops.
 */
export async function getAgentSessionFirstMessage(
  tool: AgentTool,
  transcript: SandboxFile | undefined,
  jobName?: string,
  agentSessionId?: string,
): Promise<string | undefined> {
  if (tool === 'opencode') return jobName ? getSessionOpencodeFirstUserMessage(jobName, agentSessionId) : undefined
  if (transcript === undefined) return undefined
  if (tool === 'codex') return getCodexFirstUserMessage(transcript)
  if (tool === 'pi') return getPiFirstUserMessage(transcript)
  return getFirstUserMessage(transcript)
}

/**
 * The pane option a tool's reporter (`workspace-bin/yaac-agent-report`)
 * sets to its current model: claude via hooks, opencode and pi via their
 * plugin/extension.
 */
export const MODEL_PANE_OPTION = '@yaac-model'

/**
 * The tmux format a pane's model subscription watches: `MODEL_PANE_OPTION`
 * for every tool but codex, whose model is cut out of its title instead.
 *
 * The option is filtered to printable ASCII and length-bounded inside the
 * format: tmux expands user options verbatim into `%subscription-changed`
 * lines, and anything in the workspace can set one (e.g. with
 * `tmux set-option`), so a newline could forge control-mode lines. (Not
 * `[[:cntrl:]]`: its `:` ends the modifier list.)
 */
export function agentModelFormat(tool: AgentTool): string {
  return tool === 'codex'
    ? CODEX_MODEL_FORMAT
    : `#{=${MAX_MODEL_LENGTH};s/[^ -~]//:${MODEL_PANE_OPTION}}`
}

/**
 * The pane option a tool's reporter sets to its permission mode, in the
 * tool's own terms: claude's mode name (from hooks) or opencode's agent
 * (`build`, `plan`). Set by `workspace-bin/yaac-agent-report`.
 */
export const MODE_PANE_OPTION = '@yaac-permission-mode'

/** Separator in `agentReportFormat`'s value. The mode half is filtered to
 *  letters and dashes, so the last separator is always the join. */
const REPORT_SEPARATOR = '|'

/**
 * The tmux format for a pane's report subscription: model
 * (`agentModelFormat`) and mode (`MODE_PANE_OPTION`) in one value. The mode
 * is filtered inside the format too, more tightly, since mode names are
 * words.
 */
export function agentReportFormat(tool: AgentTool): string {
  return `${agentModelFormat(tool)}${REPORT_SEPARATOR}#{=32;s/[^A-Za-z-]//:${MODE_PANE_OPTION}}`
}

/** The two halves of a pushed `agentReportFormat` value; either may be
 *  empty if the tool has not reported it yet. */
export function splitAgentReport(value: string): { model: string; mode: string } {
  const at = value.lastIndexOf(REPORT_SEPARATOR)
  return at < 0
    ? { model: value, mode: '' }
    : { model: value.slice(0, at), mode: value.slice(at + REPORT_SEPARATOR.length).trim() }
}

/**
 * The pane option naming the pane's conversation, as
 * `<tool>|<id>|<project-relative transcript>`. Set by
 * `workspace-bin/yaac-agent-links` from each tool's hook or plugin, so it
 * changes on `/clear`, `/new` or resume and dies with the pane. A resume
 * launch sets it first (`nameSessionCommand`).
 */
const SESSION_PANE_OPTION = '@yaac-session'

/**
 * The tmux command naming a conversation on `target`'s pane, as the tool's
 * reporter would, minus the transcript only the tool knows.
 */
export function nameSessionCommand(target: string, tool: AgentTool, agentSessionId: string): string {
  return `set-option -p -t ${target} ${SESSION_PANE_OPTION} '${tool}|${agentSessionId}|'`
}

/**
 * The tmux format for a pane's session subscription, filtered and bounded
 * like `agentModelFormat`.
 */
export const PANE_SESSION_FORMAT = `#{=1024;s/[^ -~]//:${SESSION_PANE_OPTION}}`

/** A conversation as a pane names it (`PANE_SESSION_FORMAT`). */
export interface PaneSession {
  tool: AgentTool
  agentSessionId: string
  /** Project-relative, as the column stores it. */
  transcriptPath?: string
}

/**
 * The conversation a pushed `PANE_SESSION_FORMAT` value names, or undefined
 * if empty or malformed.
 *
 * This is where the untrusted value is validated: the id is later recorded,
 * interpolated into a launch command (`--resume <id>`), and used in path
 * lookups. So the id must match `agentSessionIdSchema` (a bounded charset,
 * never a flag such as `--dangerously-bypass-approvals-and-sandbox`), and an
 * absolute or project-escaping path is dropped. Reads of a recorded path are
 * further confined to the tool's home (`resolveProjectPath`).
 */
export function parsePaneSession(value: string): PaneSession | undefined {
  const [tool, id, ...rest] = value.trim().split('|')
  const rel = rest.join('|')
  if (!AGENT_TOOLS.includes(tool as AgentTool) || !agentSessionIdSchema.safeParse(id).success) return undefined
  const safe = rel !== '' && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..')
  return {
    tool: tool as AgentTool,
    agentSessionId: id,
    ...(safe ? { transcriptPath: rel } : {}),
  }
}

/**
 * The posture an agent's reported mode (`LiveAgent.reportedMode`) maps to,
 * or undefined if none matches.
 *
 * Under `acp` it is a session mode id, mapped through the adapter profile.
 * Under `tui` it is the reporter's value: claude's mode name, or opencode's
 * agent, which is interpreted against the workspace's `current` posture.
 * codex's hooks cannot report a mode, so the registry reads it from the
 * rollout (`getCodexPermissionMode`). pi has no modes.
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
  if (tool === 'codex') return PERMISSION_MODES.find((m) => m === reported)
  return undefined
}

/**
 * The model id in a pushed model-format value, in the tool's own spelling
 * (`claude-opus-5-5[1m]`, `gpt-5.6-sol`, `anthropic/claude-opus-4-8`), or
 * undefined if the tool has not reported yet. Only codex needs a lookup,
 * since its title shows the catalog's display name.
 */
export async function resolveAgentModel(
  tool: AgentTool,
  projectSlug: string,
  observed: string,
): Promise<string | undefined> {
  const value = observed.trim()
  if (value === '') return undefined
  return tool === 'codex' ? codexModelSlug(projectSlug, value) : value
}

/**
 * A tmux format that resolves to `running` if any of `markers` (EREs,
 * case-insensitive, via `#{C/ri:}`) appears in the visible pane, else
 * `waiting`.
 *
 * Markers must fit tmux's ERE limits: no `(?:...)`, no `{n,}` (its `}`
 * closes `#{...}`), and no literal `,` (the argument separator).
 */
function busyStatusFormat(markers: readonly string[]): string {
  const anyBusy = markers
    .map((m) => `#{C/ri:${m}}`)
    .reduceRight((acc, probe) => (acc ? `#{||:${probe},${acc}}` : probe), '')
  return `#{?${anyBusy},running,waiting}`
}

/**
 * The tmux status format a tool's watcher subscribes to. claude/codex show
 * busy/idle in the OSC title, so the format is `#{pane_title}`, classified
 * server-side (`classifyAgentObservation`). opencode/pi draw it in the pane,
 * so the format resolves `running`/`waiting` inside tmux.
 */
export function agentStatusFormat(tool: AgentTool): string {
  if (tool === 'opencode') return busyStatusFormat(OPENCODE_BUSY_MARKERS)
  if (tool === 'pi') return busyStatusFormat(PI_BUSY_MARKERS)
  return '#{pane_title}'
}

/**
 * Classify a pushed subscription value: claude/codex push the title
 * (classified by spinner prefix); opencode/pi push a resolved verdict.
 */
export function classifyAgentObservation(tool: AgentTool, observed: string): AgentPaneStatus {
  if (tool === 'codex') return classifyCodexTitle(observed)
  if (tool === 'opencode' || tool === 'pi') return observed.trim() === 'running' ? 'running' : 'waiting'
  return classifyClaudeTitle(observed)
}

/**
 * The tmux window name for a workspace's Nth agent: the bare tool name for
 * the first (so `yaac:<tool>` targets keep working), then `<tool>-2`,
 * `<tool>-3`, …
 */
export function agentWindowName(tool: AgentTool, index: number): string {
  return index === 0 ? tool : `${tool}-${index + 1}`
}

/**
 * The agent tool a tmux window runs, or undefined for non-agent windows;
 * the inverse of `agentWindowName`.
 *
 * Any tool matches, not just the workspace's, since a workspace can hold a
 * codex conversation beside claude ones; dropping it would make the next
 * restart forget it.
 *
 * Init windows and scratch shells are excluded. An agent started by hand in
 * a scratch window is still linked (its hook fires) but gets no status;
 * naming the window after the tool opts it in.
 */
export function agentWindowTool(windowName: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => windowName === t || new RegExp(`^${t}-\\d+$`).test(windowName))
}

/**
 * Per-tool dispatch: everything the server asks about "the agent" without
 * caring which tool it is. Each function switches on `AgentTool` and
 * delegates to that tool's module, keeping tool-specific formats (claude's
 * spinner titles, opencode's busy markers, codex's rollout files) out of
 * callers.
 */
import path from 'node:path'
import { AGENT_TOOLS, MAX_MODEL_LENGTH, PERMISSION_MODES, conversationIdSchema } from '@yaac/shared/types'
import type { AgentMode, AgentStatus, AgentTool, PermissionMode } from '@yaac/shared/types'
import { acpPermissionModeFor } from './acp-client'
import { acpAdapterFor } from './acp-adapters'
import { classifyClaudeTitle, claudePermissionMode, getClaudeSessionTitle, getFirstUserMessage } from './claude'
import {
  CODEX_MODEL_FORMAT,
  classifyCodexTitle,
  codexModelSlug,
  getCodexFirstUserMessage,
  getCodexThreadName,
} from './codex'
import {
  OPENCODE_BUSY_MARKERS,
  getOpencodeSessionTitle,
  opencodePermissionMode,
} from './opencode'
import { PI_BUSY_MARKERS, getPiFirstUserMessage } from './pi'
import type { SandboxFile } from './sandbox-fs'

/**
 * A conversation's first user message, read from its recorded transcript.
 * There is no by-id variant: a `/clear` conversation has an id yaac did not
 * choose, and codex's rollout filename is not derivable from any id.
 * opencode has no host transcript, so it has none.
 */
export async function getConversationFirstMessage(
  tool: AgentTool,
  transcript: SandboxFile | undefined,
): Promise<string | undefined> {
  if (tool === 'opencode' || transcript === undefined) return undefined
  if (tool === 'codex') return getCodexFirstUserMessage(transcript)
  if (tool === 'pi') return getPiFirstUserMessage(transcript)
  return getFirstUserMessage(transcript)
}

/** What `getConversationTitle` reads a conversation's title from. */
export interface AgentTitleSource {
  projectId: string
  conversationId: string
  /** claude's transcript, under either mode. */
  transcript?: SandboxFile
  /** The running workspace, which opencode's lookup runs in. */
  jobName: string
}

/**
 * The title the agent gave its own conversation, or undefined while it has
 * none. Each tool keeps it in its own store, which `tui` and `acp` share:
 * claude in its transcript, codex in its session index, opencode in its
 * database. pi titles nothing. The adapters' ACP `session_info_update`
 * titles are not used: codex-acp sends the raw opening message before its
 * generated title, and opencode's server sends none.
 */
export async function getConversationTitle(tool: AgentTool, src: AgentTitleSource): Promise<string | undefined> {
  switch (tool) {
    case 'claude': return src.transcript !== undefined ? getClaudeSessionTitle(src.transcript) : undefined
    case 'codex': return getCodexThreadName(src.projectId, src.conversationId)
    case 'opencode': return getOpencodeSessionTitle(src.jobName, src.conversationId)
    case 'pi': return undefined
  }
}

/** Whether a tool titles its own conversations (`getConversationTitle`), so
 *  yaac has no title to generate for them. */
export function agentTitlesItself(tool: AgentTool): boolean {
  return tool !== 'pi'
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

/**
 * The pane option a tool's reporter sets to its effort level, in the tool's
 * words (docs/effort-levels.md). Set by `workspace-bin/yaac-agent-report`;
 * codex's comes from its rollout instead.
 */
export const EFFORT_PANE_OPTION = '@yaac-effort'

/** Separator in `agentReportFormat`'s value. The mode and effort parts are
 *  filtered to letters and dashes, so the last two separators are the
 *  joins. */
const REPORT_SEPARATOR = '|'

/**
 * The tmux format for a pane's report subscription: model
 * (`agentModelFormat`), mode (`MODE_PANE_OPTION`) and effort
 * (`EFFORT_PANE_OPTION`) in one value. Mode and effort are filtered inside
 * the format too, more tightly, since both are words.
 */
export function agentReportFormat(tool: AgentTool): string {
  return `${agentModelFormat(tool)}${REPORT_SEPARATOR}#{=32;s/[^A-Za-z-]//:${MODE_PANE_OPTION}}`
    + `${REPORT_SEPARATOR}#{=32;s/[^a-z]//:${EFFORT_PANE_OPTION}}`
}

/** The parts of a pushed `agentReportFormat` value; any may be empty if
 *  the tool has not reported it yet. */
export function splitAgentReport(value: string): { model: string; mode: string; effort: string } {
  const parts = value.split(REPORT_SEPARATOR)
  if (parts.length < 3) return { model: value, mode: '', effort: '' }
  const effort = parts.pop()?.trim() ?? ''
  const mode = parts.pop()?.trim() ?? ''
  return { model: parts.join(REPORT_SEPARATOR), mode, effort }
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
export function nameSessionCommand(target: string, tool: AgentTool, conversationId: string): string {
  return `set-option -p -t ${target} ${SESSION_PANE_OPTION} '${tool}|${conversationId}|'`
}

/**
 * The tmux format for a pane's session subscription, filtered and bounded
 * like `agentModelFormat`.
 */
export const PANE_SESSION_FORMAT = `#{=1024;s/[^ -~]//:${SESSION_PANE_OPTION}}`

/** A conversation as a pane names it (`PANE_SESSION_FORMAT`). */
export interface PaneSession {
  tool: AgentTool
  conversationId: string
  /** Project-relative, as the column stores it. */
  transcriptPath?: string
}

/**
 * The conversation a pushed `PANE_SESSION_FORMAT` value names, or undefined
 * if empty or malformed.
 *
 * This is where the untrusted value is validated: the id is later recorded,
 * interpolated into a launch command (`--resume <id>`), and used in path
 * lookups. So the id must match `conversationIdSchema` (a bounded charset,
 * never a flag such as `--dangerously-bypass-approvals-and-sandbox`), and an
 * absolute or project-escaping path is dropped. Reads of a recorded path are
 * further confined to the tool's home (`resolveProjectPath`).
 */
export function parsePaneSession(value: string): PaneSession | undefined {
  const [tool, id, ...rest] = value.trim().split('|')
  const rel = rest.join('|')
  if (!AGENT_TOOLS.includes(tool as AgentTool) || !conversationIdSchema.safeParse(id).success) return undefined
  const safe = rel !== '' && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..')
  return {
    tool: tool as AgentTool,
    conversationId: id,
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
 * rollout (`getCodexRolloutSettings`). pi has no modes.
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
  projectId: string,
  observed: string,
): Promise<string | undefined> {
  const value = observed.trim()
  if (value === '') return undefined
  return tool === 'codex' ? codexModelSlug(projectId, value) : value
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
export function classifyAgentObservation(tool: AgentTool, observed: string): AgentStatus {
  if (tool === 'codex') return classifyCodexTitle(observed)
  if (tool === 'opencode' || tool === 'pi') return observed.trim() === 'running' ? 'running' : 'waiting'
  return classifyClaudeTitle(observed)
}


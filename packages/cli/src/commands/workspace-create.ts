import { api, resolveProjectId } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { testEnv } from '@yaac/shared/env'
import { reportDeviceTimeZone } from '@yaac/shared/time-zone-report'
import { formatInZone, parseDuration } from '@yaac/shared/schedule'
import type { AgentMode, AgentTool, PermissionMode } from '@yaac/shared/types'

export interface WorkspaceCreateOptions {
  tool?: AgentTool
  /**
   * Reference branch, without `origin/`. Defaults to the project's configured
   * branch.
   */
  branch?: string
  /** Initial prompt typed into the agent pane once the workspace is up. */
  prompt?: string
  /**
   * Model override: an id or alias for claude/codex, `provider/model` for
   * opencode/pi.
   */
  model?: string
  /** Effort level, in the tool's words; the server refuses one the model
   *  lacks. See docs/effort-levels.md. */
  effort?: string
  /** How the agent is driven; defaults to this project's last choice for
   *  the tool, else acp. See docs/agent-modes.md. */
  mode?: AgentMode
  /**
   * How much the agent may do before it asks. Defaults to the project's last
   * choice, else the driver's default; the server rejects a mode the tool
   * does not support.
   */
  permissionMode?: PermissionMode
  /** Sidebar group, by name or id. An unknown name creates the group. */
  group?: string
  /** How long it runs before the server stops it, like `2h` or `1h30m`. */
  timeout?: string
  /** Queue it to start at this time (`HH:MM`, `YYYY-MM-DD HH:MM`, or ISO
   *  8601), read in your yaac time zone. */
  startAt?: string
  /** Queue it to start after this long, like `30m`. */
  startIn?: string
}

/**
 * `yaac workspace create`: ask the server to create the workspace, then
 * attach the terminal to its tmux session, or for an `acp` workspace point
 * at the web app.
 *
 * Options left unset are omitted so the server fills them from what the
 * project last used, matching the web app's form and the prewarmed spare.
 */
export async function workspaceCreate(project: string, options: WorkspaceCreateOptions): Promise<void> {
  const timeout = options.timeout !== undefined ? durationOption('--timeout', options.timeout) : undefined
  const startIn = options.startIn !== undefined ? durationOption('--start-in', options.startIn) : undefined
  if (options.startAt !== undefined && startIn !== undefined) {
    throw new Error('Give --start-at or --start-in, not both.')
  }
  // Best-effort, so a CLI-only user's workspaces get their zone too, and a
  // `--start-at` is read in it.
  await reportDeviceTimeZone().catch(() => {})
  const settings = {
    project: await resolveProjectId(project),
    tool: options.tool,
    branch: options.branch,
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    permissionMode: options.permissionMode,
    group: options.group,
    timeout,
  }

  if (options.startAt !== undefined || startIn !== undefined) {
    if (options.prompt === undefined) throw new Error('A scheduled workspace needs --prompt: nobody is watching it start.')
    const entry = await api.workspace.queue.create.$post({
      json: { ...settings, prompt: options.prompt, startAt: options.startAt, startIn },
    })
    const { timeZone } = await api.config['time-zone'].$get()
    const zone = timeZone ?? 'UTC'
    console.log(`Queued workspace ${entry.id}: starts at about ${formatInZone(new Date(entry.startAt ?? ''), zone)} ${zone}.`)
    console.log('Discard it with: yaac workspace delete ' + entry.id.slice(0, 8))
    return
  }
  await attachStarted(await api.workspace.create.$post({ json: { ...settings, prompt: options.prompt } }))
}

/** A duration option in whole minutes, refusing anything else. */
export function durationOption(flag: string, text: string): number {
  const minutes = parseDuration(text)
  if (minutes === undefined) throw new Error(`${flag} takes whole minutes or more, like 45m, 2h or 1h30m (got "${text}").`)
  return minutes
}

/**
 * Read a create or restart NDJSON stream, then attach the terminal to the
 * workspace it started. An ACP workspace's conversation is in the web app's
 * chat pane (its tmux window only shows the acpd supervisor's log), and e2e
 * runs have no TTY to attach.
 */
export async function attachStarted(res: Response): Promise<void> {
  const { workspaceId, mode } = await consumeNdjsonStream<{ workspaceId: string; mode: AgentMode }>(res)
  if (mode === 'acp') {
    console.log(`Workspace ${workspaceId} is running in ACP mode — open it in the web app to chat with the agent.`)
  } else if (!testEnv.e2eNoAttach) {
    await attachWorkspacePty(workspaceId, 'native')
  }
}

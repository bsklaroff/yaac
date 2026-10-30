import fs from 'node:fs/promises'
import { api, resolveProjectId } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { testEnv } from '@yaac/shared/env'
import { reportDeviceTimeZone } from '@yaac/shared/time-zone-report'
import { formatInZone, parseDuration } from '@yaac/shared/schedule'
import type { AgentMode, AgentTool, PermissionMode, SessionEntry } from '@yaac/shared/types'

export interface WorkspaceCreateOptions {
  tool?: AgentTool
  /**
   * Reference branch, without `origin/`. Defaults to the project's configured
   * branch.
   */
  branch?: string
  /** Initial prompt typed into the agent pane once the workspace is up;
   *  `-` reads it from stdin. */
  prompt?: string
  /** A file to read the initial prompt from, in place of `prompt`. */
  promptFile?: string
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
  /** A running workspace to open the session in, instead of a new one. */
  workspace?: string
  /** With `workspace`: one of its earlier conversations to resume. */
  resume?: string
  /** Start a workspace with no session (commander's `--no-session`). */
  session?: boolean
}

/**
 * `yaac workspace create`: ask the server to create the workspace, or with
 * `--workspace` to open a session in a running one (docs/sessions.md), then
 * attach the terminal to its session's window, or for an `acp` session
 * point at the web app. `--no-session` starts a workspace with no agent.
 *
 * Options left unset are omitted so the server fills them from what the
 * project last used, matching the web app's form and the prewarmed spare.
 */
export async function workspaceCreate(project: string | undefined, options: WorkspaceCreateOptions): Promise<void> {
  const noSession = options.session === false
  if (options.workspace !== undefined) {
    if (project !== undefined) throw new Error('Give a project or --workspace, not both: the workspace names its project.')
    for (const [flag, set] of [['--branch', options.branch], ['--group', options.group], ['--timeout', options.timeout],
      ['--start-at', options.startAt], ['--start-in', options.startIn]] as const) {
      if (set !== undefined) throw new Error(`${flag} is a workspace's setting, which --workspace (a session in a running one) does not take.`)
    }
    if (noSession) throw new Error('--no-session starts a new workspace; it does not take --workspace.')
    await openSession(options.workspace, options)
    return
  }
  if (project === undefined) throw new Error('Name the project to create the workspace in, or --workspace to open a session in a running one.')
  if (options.resume !== undefined) throw new Error('--resume needs --workspace: a conversation resumes in the workspace that holds it.')
  if (noSession) {
    for (const [flag, set] of [['--tool', options.tool], ['--model', options.model], ['--effort', options.effort],
      ['--mode', options.mode], ['--permission-mode', options.permissionMode], ['--prompt', options.prompt],
      ['--prompt-file', options.promptFile], ['--start-at', options.startAt], ['--start-in', options.startIn]] as const) {
      if (set !== undefined) throw new Error(`--no-session does not take ${flag}: a workspace with no session runs no agent.`)
    }
  }
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

  const source = promptSource(options)
  const prompt = source !== undefined ? await readPrompt(source) : options.prompt

  if (options.startAt !== undefined || startIn !== undefined) {
    if (prompt === undefined) throw new Error('A scheduled workspace needs a prompt: nobody is watching it start.')
    const entry = await api.workspace.queue.create.$post({
      json: { ...settings, prompt, startAt: options.startAt, startIn },
    })
    const { timeZone } = await api.config['time-zone'].$get()
    const zone = timeZone ?? 'UTC'
    console.log(`Queued workspace ${entry.id}: starts at about ${formatInZone(new Date(entry.startAt ?? ''), zone)} ${zone}.`)
    console.log('Discard it with: yaac workspace delete ' + entry.id.slice(0, 8))
    return
  }
  const res = await api.workspace.create.$post({ json: { ...settings, prompt, ...(noSession ? { noSession: true } : {}) } })
  // Stdin carried the prompt and has ended, so it cannot drive a terminal.
  await attachStarted(res, { attach: source !== '-' })
}

/** `--workspace`: open a session in a running workspace and attach to it. */
async function openSession(workspace: string, options: WorkspaceCreateOptions): Promise<void> {
  const resolved = await api.workspace[':id'].$get({ param: { id: workspace } })
  const source = promptSource(options)
  const prompt = source !== undefined ? await readPrompt(source) : options.prompt
  const { sessionId } = await api.workspace[':id'].sessions.$post({
    param: { id: resolved.workspaceId },
    json: {
      tool: options.tool,
      model: options.model,
      effort: options.effort,
      mode: options.mode,
      permissionMode: options.permissionMode,
      prompt,
      resume: options.resume,
    },
  })
  await attachSession(resolved.workspaceId, sessionId, { attach: source !== '-' })
}

/** A duration option in whole minutes, refusing anything else. */
export function durationOption(flag: string, text: string): number {
  const minutes = parseDuration(text)
  if (minutes === undefined) throw new Error(`${flag} takes whole minutes or more, like 45m, 2h or 1h30m (got "${text}").`)
  return minutes
}

/**
 * Where the prompt is read from, if not from `--prompt` itself: a file
 * (`--prompt-file`), or `-` for stdin (`--prompt -`). These carry a long
 * prompt, which a single argument cannot: Linux caps one at 128 KiB.
 */
export function promptSource(options: { prompt?: string; promptFile?: string }): string | undefined {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw new Error('Give the prompt with --prompt or --prompt-file, not both.')
  }
  return options.promptFile ?? (options.prompt === '-' ? '-' : undefined)
}

/** The prompt `source` holds. An empty or unreadable one is refused rather
 *  than sent as no prompt. */
export async function readPrompt(source: string): Promise<string> {
  const name = source === '-' ? 'stdin' : source
  let text: string
  try {
    text = source === '-' ? await readStdin() : await fs.readFile(source, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read the prompt from ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (text === '') throw new Error(`The prompt from ${name} is empty.`)
  return text
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Read a create or restart NDJSON stream, then attach the terminal to the
 * session it opened, if any.
 */
export async function attachStarted(res: Response, { attach = true } = {}): Promise<void> {
  const { workspaceId, sessionId } = await consumeNdjsonStream<{ workspaceId: string; sessionId?: string }>(res)
  if (sessionId === undefined) {
    console.log(`Workspace ${workspaceId} is running — attach with \`yaac workspace attach ${workspaceId}\`.`)
    return
  }
  await attachSession(workspaceId, sessionId, { attach })
}

/**
 * Attach the terminal to a session's window. An `acp` session's
 * conversation is in the web app's chat pane (its tmux window only shows the
 * acpd supervisor's log), and e2e runs have no TTY to attach.
 */
async function attachSession(workspaceId: string, sessionId: string, { attach }: { attach: boolean }): Promise<void> {
  const session = await findSession(workspaceId, sessionId)
  if (session?.mode === 'acp') {
    console.log(`Session ${sessionId} of workspace ${workspaceId} runs in ACP mode — open it in the web app to chat with the agent.`)
  } else if (!attach || session === undefined) {
    console.log(`Session ${sessionId} of workspace ${workspaceId} is running — attach with `
      + `\`yaac workspace attach --session ${sessionId} ${workspaceId}\`.`)
  } else if (!testEnv.e2eNoAttach) {
    await attachWorkspacePty(workspaceId, `native:${session.window}`)
  }
}

/** A running workspace's open session. */
export async function findSession(workspaceId: string, sessionId: string): Promise<SessionEntry | undefined> {
  const { workspaces } = await api.workspace.list.$get({ query: {} })
  return workspaces.find((w) => w.workspaceId === workspaceId)?.sessions
    .find((s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId))
}

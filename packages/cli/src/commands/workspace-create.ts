import fs from 'node:fs/promises'
import { api, resolveProjectId } from '#commands/api'
import { attachWorkspacePty } from '#commands/ws-terminal'
import { consumeNdjsonStream } from '@yaac/shared/ndjson'
import { testEnv } from '@yaac/shared/env'
import { reportDeviceTimeZone } from '@yaac/shared/time-zone-report'
import { formatInZone, parseDuration } from '@yaac/shared/schedule'
import { InvalidArgumentError } from 'commander'
import { selectionOf, type SelectionOptions } from '#commands/repo-selection'
import { AGENT_OPTION_NAMES, type AgentMode, type AgentOption, type AgentOptions, type AgentTool, type PermissionMode, type SessionEntry } from '@yaac/shared/types'

export interface WorkspaceCreateOptions extends SelectionOptions {
  tool?: AgentTool
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
  /** From each `--agent-option`; the server refuses one the tool lacks. */
  agentOption?: AgentOptions
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
  /** A volume of the project to mount (docs/workspace-volumes.md). */
  volume?: string
  /** A JSON file of the steps to start with in place of the project's init
   *  steps; false (`--no-steps`) for none (docs/workspace-steps.md). */
  steps?: string | false
  /** A workflow whose current revision it starts with instead
   *  (docs/workflows.md). */
  workflow?: string
  /** Run `steps` untouched, with no session, and stop when they settle. */
  nonInteractive?: boolean
  /** With `nonInteractive`: wait for the outcome, exiting non-zero unless
   *  it succeeded. */
  wait?: boolean
}

/**
 * `yaac workspace create`: ask the server to create the workspace, or with
 * `--workspace` to open a session in a running one (docs/sessions.md), then
 * attach the terminal to its session's window, or for an `acp` session
 * point at the web app. `--no-session` starts a workspace with no agent, and
 * `--non-interactive` one that runs `--steps` untouched and stops
 * (docs/workspace-steps.md), which `--wait` waits out.
 *
 * Options left unset are omitted so the server fills them from what the
 * project last used, matching the web app's form and the prewarmed spare.
 */
export async function workspaceCreate(project: string | undefined, options: WorkspaceCreateOptions): Promise<void> {
  const noSession = options.session === false
  const nonInteractive = options.nonInteractive === true
  if (options.workspace !== undefined) {
    if (project !== undefined) throw new Error('Give a project or --workspace, not both: the workspace names its project.')
    for (const [flag, set] of [['--branch', options.branch], ['--repo', options.repo],
      ['--no-repos', options.repos === false ? true : undefined],
      [options.nested === false ? '--no-nested' : '--nested', options.nested],
      ['--group', options.group], ['--timeout', options.timeout],
      ['--start-at', options.startAt], ['--start-in', options.startIn], ['--volume', options.volume],
      ['--commit', options.commit], [options.steps === false ? '--no-steps' : '--steps', options.steps],
      ['--workflow', options.workflow],
      ['--non-interactive', options.nonInteractive], ['--wait', options.wait]] as const) {
      if (set !== undefined) throw new Error(`${flag} is a workspace's setting, which --workspace (a session in a running one) does not take.`)
    }
    if (noSession) throw new Error('--no-session starts a new workspace; it does not take --workspace.')
    await openSession(options.workspace, options)
    return
  }
  if (project === undefined) throw new Error('Name the project to create the workspace in, or --workspace to open a session in a running one.')
  if (options.resume !== undefined) throw new Error('--resume needs --workspace: a conversation resumes in the workspace that holds it.')
  const selection = selectionOf(options)
  if (noSession && nonInteractive) throw new Error('--non-interactive already starts no session; drop --no-session.')
  if (noSession || nonInteractive) {
    const flag = noSession ? '--no-session' : '--non-interactive'
    const agentOptions: Array<[string, unknown]> = [['--tool', options.tool], ['--model', options.model],
      ['--effort', options.effort], ['--agent-option', options.agentOption], ['--mode', options.mode],
      ['--permission-mode', options.permissionMode],
      ['--prompt', options.prompt], ['--prompt-file', options.promptFile]]
    // A non-interactive workspace may be scheduled: it needs no prompt.
    if (noSession) agentOptions.push(['--start-at', options.startAt], ['--start-in', options.startIn])
    for (const [name, set] of agentOptions) {
      if (set !== undefined) throw new Error(`${flag} does not take ${name}: a workspace with no session runs no agent.`)
    }
  }
  if (options.workflow !== undefined && options.steps !== undefined) throw new Error('Give --steps or --workflow, not both.')
  if (nonInteractive && typeof options.steps !== 'string' && options.workflow === undefined) {
    throw new Error('--non-interactive runs the steps --steps <file> or --workflow names; it never runs the project\'s init steps.')
  }
  if (options.wait === true && !nonInteractive) throw new Error('--wait goes with --non-interactive: only it ends by itself.')
  if (options.wait === true && (options.startAt !== undefined || options.startIn !== undefined)) {
    throw new Error('--wait waits for a workspace started now; a scheduled one starts later.')
  }
  const timeout = options.timeout !== undefined ? durationOption('--timeout', options.timeout) : undefined
  const startIn = options.startIn !== undefined ? durationOption('--start-in', options.startIn) : undefined
  if (options.startAt !== undefined && startIn !== undefined) {
    throw new Error('Give --start-at or --start-in, not both.')
  }
  // Best-effort, so a CLI-only user's workspaces get their zone too, and a
  // `--start-at` is read in it.
  await reportDeviceTimeZone().catch(() => {})
  const steps = options.steps === undefined ? undefined : options.steps === false ? null : await readSteps(options.steps)
  const settings = {
    project: await resolveProjectId(project),
    tool: options.tool,
    ...selection,
    model: options.model,
    effort: options.effort,
    agentOptions: options.agentOption,
    mode: options.mode,
    permissionMode: options.permissionMode,
    group: options.group,
    timeout,
    ...(steps !== undefined ? { steps } : {}),
    ...(nonInteractive ? { nonInteractive: true } : {}),
  }

  const source = promptSource(options)
  const prompt = source !== undefined ? await readPrompt(source) : options.prompt

  if (options.startAt !== undefined || startIn !== undefined) {
    if (prompt === undefined && !nonInteractive) throw new Error('A scheduled workspace needs a prompt: nobody is watching it start.')
    if (options.volume !== undefined) throw new Error('--volume starts a workspace now; a scheduled one cannot take it.')
    if (options.workflow !== undefined) throw new Error('--workflow starts a workspace now; a scheduled one cannot take it.')
    const entry = await api.workspace.queue.create.$post({
      json: { ...settings, prompt, startAt: options.startAt, startIn },
    })
    const { timeZone } = await api.config['time-zone'].$get()
    const zone = timeZone ?? 'UTC'
    console.log(`Queued workspace ${entry.id}: starts at about ${formatInZone(new Date(entry.startAt ?? ''), zone)} ${zone}.`)
    console.log('Discard it with: yaac workspace delete ' + entry.id.slice(0, 8))
    return
  }
  const res = await api.workspace.create.$post({ json: {
    ...settings,
    prompt,
    ...(noSession ? { noSession: true } : {}),
    ...(options.volume !== undefined ? { volume: options.volume } : {}),
    ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
  } })
  if (nonInteractive) {
    await followNonInteractive(res, { wait: options.wait === true })
    return
  }
  // Stdin carried the prompt and has ended, so it cannot drive a terminal.
  await attachStarted(res, { attach: source !== '-' })
}

/** A `--steps` file's graph, parsed as JSON; the server checks its shape. */
export async function readSteps(file: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read the steps from ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    throw new Error(`The steps in ${file} are not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Read a non-interactive create's (or rerun's) NDJSON stream, then say how
 * to follow it, or with `wait` wait for its outcome: it has none to attach
 * to (docs/workspace-steps.md "Non-interactive workspaces").
 */
export async function followNonInteractive(res: Response, { wait }: { wait: boolean }): Promise<void> {
  const { workspaceId } = await consumeNdjsonStream<{ workspaceId: string }>(res)
  if (!wait) {
    console.log(`Non-interactive workspace ${workspaceId} is running its steps — follow them with `
      + `\`yaac workspace logs ${workspaceId} <step>\`; it stops when they finish.`)
    return
  }
  console.log(`Non-interactive workspace ${workspaceId} is running its steps; waiting for them to finish...`)
  const outcome = await waitForOutcome(workspaceId)
  console.log(outcome === 'succeeded' ? 'Its steps succeeded.'
    : outcome === 'failed' ? `Its steps failed; see \`yaac workspace logs ${workspaceId}\`.`
    : 'It was stopped before its steps finished.')
  if (outcome !== 'succeeded') process.exitCode = 1
}

/** How often `--wait` asks whether a workspace has stopped. */
const WAIT_POLL_MS = 3_000

/** Once a workspace has stopped, how its steps ended: its outcome, or
 *  undefined for one stopped before they settled. */
async function waitForOutcome(workspaceId: string): Promise<string | undefined> {
  for (;;) {
    const { entries } = await api.workspace['list-stopped'].$get({ query: { workspace: workspaceId } })
    if (entries[0] !== undefined) return entries[0].stepsOutcome
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
  }
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
      agentOptions: options.agentOption,
      mode: options.mode,
      permissionMode: options.permissionMode,
      prompt,
      resume: options.resume,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    },
  })
  await attachSession(resolved.workspaceId, sessionId, { attach: source !== '-' })
}

/** An agent option's name on the command line: `idle-compaction`. */
const agentOptionFlag = (o: AgentOption): string => o.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** The `--agent-option` help, naming every option. */
export const AGENT_OPTION_HELP = 'Turn an agent option on or off, as <name>=<on|off>; repeatable. Each is off unless '
  + `turned on, and defaults to this project's last choice for the tool. Names: ${AGENT_OPTION_NAMES.map(agentOptionFlag).join(', ')} `
  + '(see docs/sessions.md)'

/** Commander's parser for a repeated `--agent-option <name>=<on|off>`,
 *  gathering the agent options it names. */
export function agentOptionArg(value: string, previous: AgentOptions = {}): AgentOptions {
  const [name, setting, extra] = value.split('=')
  const option = AGENT_OPTION_NAMES.find((o) => agentOptionFlag(o) === name)
  if (option === undefined || (setting !== 'on' && setting !== 'off') || extra !== undefined) {
    throw new InvalidArgumentError(`expected <name>=<on|off>, with a name of ${AGENT_OPTION_NAMES.map(agentOptionFlag).join(', ')}`)
  }
  return { ...previous, [option]: setting === 'on' }
}

/** A duration option in whole minutes, refusing anything else. */
export function durationOption(flag: string, text: string): number {
  const minutes = parseDuration(text)
  if (minutes === undefined) throw new Error(`${flag} takes whole minutes or more, like 45m, 2h or 1h30m (got "${text}").`)
  return minutes
}

/**
 * Where the prompt is read from, if not from `--prompt` itself: a file
 * (`--prompt-file`), or `-` for stdin (`--prompt -`). These spare a long
 * prompt the shell's quoting.
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
    console.log(`Workspace ${workspaceId} is running in ACP mode — open it in the web app to chat with the agent `
      + `(session ${sessionId}).`)
  } else if (!attach || session === undefined) {
    console.log(`Workspace ${workspaceId} is running — attach with `
      + `\`yaac workspace attach --session ${sessionId} ${workspaceId}\`.`)
  } else if (!testEnv.e2eNoAttach) {
    await attachWorkspacePty(workspaceId, `native:${session.window}`)
  }
}

/** A running workspace's open session, by its full id. */
async function findSession(workspaceId: string, sessionId: string): Promise<SessionEntry | undefined> {
  const { workspaces } = await api.workspace.list.$get({ query: {} })
  return workspaces.find((w) => w.workspaceId === workspaceId)?.sessions.find((s) => s.sessionId === sessionId)
}

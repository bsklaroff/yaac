import { WorkspaceExecError, type WorkspacePaths } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import {
  PI_DEFAULT_PROVIDER,
  piProviderInfo,
  type PiProvider,
} from '@yaac/shared/tool-providers'
import {
  launchablePermissionMode,
  type AgentTool,
  type InitCommandSpec,
  type PermissionMode,
  type YaacConfig,
} from '@yaac/shared/types'
import { doubleQuoted, envJsonAssignment, shellEscape } from '#lib/shell'
import { CODEX_TITLE_ITEMS, codexLaunchConfig } from './codex'

/**
 * Prefix for every `tmux` invocation here, pointing at the driver's socket
 * (`WorkspacePaths.tmuxSock`). Each pod has its own kernel so one fixed path
 * is fine there, but host processes share one, and a fixed path would put
 * every containerless workspace on a single tmux server.
 */
export function tmuxCmd(paths: Pick<WorkspacePaths, 'tmuxSock'>): string {
  // Unquoted because it is also embedded inside single-quoted scripts.
  // Safe because driver paths are shell-safe (`assertShellSafePaths` checks
  // the driver whose paths are not constants).
  return `tmux -S ${paths.tmuxSock}`
}

export interface InitWindow {
  name: string
  /** Already shell-escaped and joined with `&&`. */
  cmd: string
  /** When false, the window is set `remain-on-exit on` so the user can
   *  inspect output after the commands finish or error. */
  hidePane: boolean
}

/**
 * Resolve `config.initCommands` into the tmux windows to spawn:
 *
 *   - string[]            → one `init` window with the commands chained `&&`
 *   - InitCommandSpec[]   → one window per spec, named by spec.name
 *   - undefined / []      → no windows
 */
export function resolveInitWindows(config: YaacConfig): InitWindow[] {
  const entries = config.initCommands
  if (!entries || entries.length === 0) return []

  const topHide = config.hideInitPane ?? false
  if (typeof entries[0] === 'string') {
    const cmd = (entries as string[]).map(shellEscape).join(' && ')
    return [{ name: 'init', cmd, hidePane: topHide }]
  }
  return (entries as InitCommandSpec[]).map((e) => ({
    name: e.name,
    cmd: e.commands.map(shellEscape).join(' && '),
    hidePane: e.hidePane ?? topHide,
  }))
}

/** What one agent's launch command is built from. */
export interface AgentCmdSpec {
  tool: AgentTool
  workspaceId: string
  resume?: boolean
  /** pi only — provider whose default model is passed to `pi --model`
   *  when no explicit `model` override is given. */
  piProvider?: PiProvider
  /** Model for the agent's `--model` flag: an id or alias for claude/codex
   *  (`opus`, `gpt-5.2-codex`), `provider/model` for opencode and pi.
   *  Validated against MODEL_RE by the create route, so it can be embedded
   *  bare in the single-quoted respawn-window wrapper. */
  model?: string
  /**
   * The permission posture to launch in. Required, not defaulted: without a
   * sandbox it decides what the agent may do to this machine unsupervised.
   * The workspace row remembers it across restarts.
   */
  permissionMode: PermissionMode
  /** codex only — the workspace to run it in and launch it trusting
   *  (`codexLaunchConfig`). The tui driver always passes it. */
  paths?: Pick<WorkspacePaths, 'workspaceDir'>
}

/**
 * The posture to launch `tool` in. Create refuses unsupported postures, so
 * this only adjusts rows written by a different build, which must still
 * restart. It picks the loosest supported posture no looser than the row's
 * (`launchablePermissionMode`): opencode `auto` → `accept-edits`; codex's
 * strictest is `read-only` and claude/opencode's is `plan`, so each maps to
 * the other's; pi has no permission system, so always `bypass`.
 */
function postureFor(tool: AgentTool, mode: PermissionMode): PermissionMode {
  return launchablePermissionMode(tool, mode)
}

/**
 * opencode's posture is config, not flags. `OPENCODE_CONFIG_CONTENT` is read
 * per process and merged over the project's shared `opencode.json` (its keys
 * win), which makes the posture per-workspace.
 *
 * Rules go in opencode's ordered `permissions` array, after a base policy
 * (`* allow`, then `ask` for `external_directory` and `.env` reads) and
 * before a built-in agent's own rules (`plan` adds `edit deny`). Last match
 * wins, so a posture states only what it changes.
 *
 * **A wrong rule fails open, silently.** An unknown action matches nothing,
 * leaving `* allow` in force. For the same reason `bypass` states `* allow`
 * explicitly rather than relying on the base policy.
 */
interface OpencodeRule { action: string; resource: string; effect: 'allow' | 'ask' }

interface OpencodeConfig {
  default_agent?: string
  permissions?: OpencodeRule[]
}

/**
 * The permission actions opencode knows, read off the pinned binary
 * (`@opencode/cli@2.0.12`): its tools plus the wildcard and
 * `external_directory`. Unknown actions are accepted silently and match
 * nothing, so `agent-command.test.ts` checks every action used below against
 * this list. Re-read it when the pin in dockerfiles/Dockerfile.tools moves.
 */
export const OPENCODE_ACTIONS: readonly string[] = [
  '*', 'edit', 'glob', 'grep', 'question', 'read', 'shell', 'skill', 'subagent',
  'webfetch', 'websearch', 'execute', 'external_directory',
]

const rule = (action: string, effect: OpencodeRule['effect']): OpencodeRule =>
  ({ action, resource: '*', effect })

/**
 * Ask before anything that acts, except reads. The wildcard comes first to
 * cover tools not listed here (websearch, subagents, skills, MCP tools);
 * reads are then allowed, with the base policy's `.env` asks restated since
 * `read allow` would otherwise be the last match.
 */
const OPENCODE_ASK_TO_ACT: OpencodeRule[] = [
  rule('*', 'ask'),
  ...['read', 'glob', 'grep', 'question'].map((action) => rule(action, 'allow')),
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
]

// Ask-to-act, but allow `edit` (asserted by opencode's edit, write and
// patch tools), like claude's `acceptEdits`. Edits outside the tree still
// ask via `external_directory`. Unlike claude, no filesystem shell commands
// are allowed: how opencode matches chained commands is unverified, and a
// pattern matching `rm x; curl …` would fail open.
const OPENCODE_ACCEPT_EDITS: OpencodeConfig = {
  permissions: [...OPENCODE_ASK_TO_ACT, rule('edit', 'allow')],
}

const OPENCODE_POSTURE: Record<PermissionMode, OpencodeConfig> = {
  bypass: { permissions: [rule('*', 'allow')] },
  // Unreachable (`postureFor` maps `auto` to `accept-edits`), but kept so
  // the table has no gaps.
  auto: OPENCODE_ACCEPT_EDITS,
  'accept-edits': OPENCODE_ACCEPT_EDITS,
  // opencode's `plan` agent only denies edits; the ask-to-act rules keep it
  // from running commands unprompted.
  plan: { default_agent: 'plan', permissions: OPENCODE_ASK_TO_ACT },
  manual: { permissions: OPENCODE_ASK_TO_ACT },
  // Unreachable (`postureFor` maps it to `plan`).
  'read-only': { default_agent: 'plan', permissions: OPENCODE_ASK_TO_ACT },
}

/**
 * The `OPENCODE_CONFIG_CONTENT` assignment for the launch command: the
 * posture plus the model, if given (`provider/model`; otherwise opencode
 * uses the model saved in the shared config or its default). Quoting is
 * `envJsonAssignment`'s.
 */
export function opencodeConfigArg(mode: PermissionMode, model: string | undefined): string {
  const config = {
    ...OPENCODE_POSTURE[postureFor('opencode', mode)],
    ...(model === undefined ? {} : { model }),
  }
  return envJsonAssignment('OPENCODE_CONFIG_CONTENT', config)
}

export function buildAgentCmd(spec: AgentCmdSpec): string {
  const { tool, workspaceId, piProvider, model } = spec
  const mode = postureFor(tool, spec.permissionMode)
  const resume = spec.resume ?? false
  if (tool === 'codex') {
    // codex postures are an approval policy plus a sandbox:
    //  - accept-edits: codex's default preset (workspace-write, on-request),
    //    no flags. Network is off in the sandbox, so network access asks.
    //  - auto: same sandbox, approvals by a reviewer model.
    //  - read-only: the read-only sandbox.
    //  - plan and manual map to read-only via `postureFor`, but are listed
    //    so the table has no gaps.
    const posture = {
      bypass: '--yolo',
      auto: '--approve-for-me',
      'accept-edits': '',
      manual: '--sandbox read-only',
      plan: '--sandbox read-only',
      'read-only': '--sandbox read-only',
    }[mode]
    // --model goes last so it binds to `codex resume` too.
    //
    // The title items report `/model` changes to yaac (`CODEX_TITLE_ITEMS`).
    // The rest, with the hook-trust bypass (hooks live in its home's
    // hooks.json, `ensureAgentReporters`), keeps codex from showing startup
    // screens (`codexLaunchConfig`).
    const config = [
      `tui.terminal_title=${JSON.stringify(CODEX_TITLE_ITEMS)}`,
      ...codexLaunchConfig(spec.paths?.workspaceDir),
    ]
    // Name the workspace with `-C`: a resume from a different cwd than the
    // one recorded stops on a "session or current directory?" screen.
    return [
      'codex',
      spec.paths ? `-C ${spec.paths.workspaceDir}` : '',
      ...config.map((c) => `-c ${doubleQuoted(c)}`),
      '--dangerously-bypass-hook-trust',
      posture,
      resume ? `resume ${workspaceId}` : '',
      model ? `--model ${model}` : '',
    ].filter(Boolean).join(' ')
  }
  if (tool === 'pi') {
    // pi has no permission system, so `bypass` is its only posture.
    // `--approve` accepts the project trust prompt (loading `.pi/`
    // settings), which would otherwise appear on every launch.
    // `--model <provider>/<id>` picks the provider whose api-key env var
    // the proxy swaps; an override naming another provider shows as an auth
    // error. `--session-id` creates or resumes the session by id, so resume
    // needs no branch.
    const piModel = model ?? piProviderInfo(piProvider ?? PI_DEFAULT_PROVIDER).defaultModel
    // Guard against a provider with no default model.
    const modelFlag = piModel ? ` --model ${piModel}` : ''
    const pi = `pi --approve${modelFlag} --session-id ${workspaceId}`
    // On a fresh run pi warns on stderr that no session with this id exists
    // and it is creating one. The id is chosen by yaac on purpose (pi embeds
    // it in its JSONL filename; see transcripts.ts), so this always fires
    // and would linger at the top of the pane.
    //
    // Filter stderr through sed to delete only the first such line. The
    // regex allows leading SGR color codes (pi colors it because stdout is a
    // TTY) and requires the full message tail, so real errors pass through.
    // `sed -u` keeps other lines unbuffered. The pod's shell is zsh, so
    // process substitution works, and the string has no single quotes so it
    // survives the `respawn-window '<cmd>'` wrapper.
    const warn = 'Warning: No project session found with id .*creating a new session with that id\\.'
    return `${pi} 2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*${warn}/{//d}" >&2)`
  }
  if (tool === 'opencode') {
    // --standalone runs a private server as a child instead of a shared
    // background service, so the config (posture, model) comes from this
    // process's env and nothing stale outlives the window. The TUI rejects
    // unknown flags, and takes model and agent only via config.
    return [
      opencodeConfigArg(mode, model),
      'opencode --standalone',
      resume ? `--session ${workspaceId}` : '',
    ].filter(Boolean).join(' ')
  }
  // claude takes every posture on `--permission-mode`
  // (`bypassPermissions` rather than `--dangerously-skip-permissions`, to
  // keep one flag). `auto` depends on the subscription plan; an ineligible
  // account fails in the pane. `manual` rather than the undocumented
  // `default`: if it is ever dropped, launch fails loudly instead of
  // running lax.
  const posture = {
    bypass: 'bypassPermissions',
    auto: 'auto',
    'accept-edits': 'acceptEdits',
    manual: 'manual',
    plan: 'plan',
    // Unreachable (`postureFor` maps it to `plan`).
    'read-only': 'plan',
  }[mode]
  // `env -u TMUX` makes claude's status work (see `SPINNER_PREFIX` in
  // claude.ts): claude animates its spinner in the pane title only when
  // `$TMUX` is unset. The OSC title still reaches tmux via the pty.
  //
  // `TMUX_PANE` is kept for the hooks (workspace-bin/yaac-agent-links,
  // yaac-agent-report), which find the tmux server through `YAAC_TMUX`.
  //
  // Costs: agent teams run in-process instead of as tmux panes (claude
  // checks `$TMUX` for that too; yaac does not depend on those panes), the
  // clipboard falls back to OSC 52, and a footer scrollback hint is lost.
  return [
    `env -u TMUX YAAC_TMUX="$TMUX" CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode ${posture}`,
    model ? `--model ${model}` : '',
    resume ? `--resume ${workspaceId}` : `--session-id ${workspaceId}`,
  ].filter(Boolean).join(' ')
}

/**
 * In-workspace command that pastes an initial prompt into the agent's TUI
 * and submits it. A prompt pasted while the TUI is starting is silently
 * lost (seen with claude in the create e2e suite), and no user is attached
 * to resend it, so:
 *
 *  1. Wait for `#{alternate_on}`, the earliest tool-agnostic sign the TUI
 *     accepts input; give up waiting after 60s and paste anyway.
 *  2. Paste, then check `capture-pane` for the first 40 chars of the first
 *     line (the pane is 500 cols wide, so no wrapping), re-pasting until
 *     it appears.
 *  3. Send Enter separately, then again after a moment, since a TUI
 *     finishing startup can drop the first one; a repeat on an empty input
 *     does nothing.
 *
 * The prompt travels base64-encoded so any text survives the shell layers,
 * and `paste-buffer -p` uses bracketed paste so a multiline prompt is not
 * submitted line by line.
 */
export function buildPromptPasteCmd(
  target: string,
  prompt: string,
  paths: WorkspacePaths,
): string {
  return `sh -c '${promptPasteScript(target, prompt, paths)}'`
}

/** The paste-and-submit shell script buildPromptPasteCmd wraps. `paneTarget`
 *  is any tmux target — a window (`yaac:claude`) or a pane id (`%3`). */
function promptPasteScript(
  paneTarget: string,
  prompt: string,
  paths: WorkspacePaths,
): string {
  const TMUX = tmuxCmd(paths)
  const b64 = Buffer.from(prompt, 'utf8').toString('base64')
  const target = `-t ${paneTarget}`
  // A whitespace-only prompt has nothing to match, so paste it once blind.
  const probeLine = prompt.split('\n').find((l) => l.trim() !== '')?.slice(0, 40)
  const probeB64 = probeLine === undefined
    ? undefined
    : Buffer.from(probeLine, 'utf8').toString('base64')
  const paste = `printf %s ${b64} | base64 -d | ${TMUX} load-buffer -b yaac-prompt -; `
    + `${TMUX} paste-buffer -p -d -b yaac-prompt ${target}`
  return (
    `i=0; while [ $i -lt 120 ]; do [ "$(${TMUX} display -p ${target} "#{alternate_on}")" = "1" ] && break; i=$((i+1)); sleep 0.5; done; `
    + 'sleep 1; '
    + (probeB64 === undefined
      ? `${paste}; `
      : `probe="$(printf %s ${probeB64} | base64 -d)"; `
        + `i=0; while [ $i -lt 10 ]; do ${TMUX} capture-pane ${target} -p | grep -qF -- "$probe" && break; `
        + `${paste}; i=$((i+1)); sleep 2; done; `)
    + `${TMUX} send-keys ${target} Enter; sleep 2; ${TMUX} send-keys ${target} Enter`
  )
}

/**
 * `buildPromptPasteCmd`, detached: write the script to a workspace-local
 * file and setsid it, so the exec returns at once instead of waiting through
 * the script's polling (5s+ on a fresh agent). The script survives the exec
 * stream closing and logs to `yaac-prompt.log` in the scratch dir.
 */
export function buildPromptPasteBgCmd(
  target: string,
  prompt: string,
  paths: WorkspacePaths,
): string {
  const b64 = Buffer.from(promptPasteScript(target, prompt, paths), 'utf8').toString('base64')
  const script = `${paths.scratchDir}/.yaac-prompt.sh`
  const log = `${paths.scratchDir}/yaac-prompt.log`
  return `printf %s ${b64} | base64 -d > ${script}`
    + ` && setsid sh ${script} >${log} 2>&1 </dev/null &`
}

/**
 * In-workspace probe that every agent window survived its respawn.
 * `respawn-window` succeeds even when the command dies at once (e.g. the
 * tool binary is missing), after which tmux closes the window and the pane
 * silently falls back to another window (see attachArgs). The sleep gives
 * such a command time to exit; slower crashes are not caught.
 *
 * Takes a list because one launch can open several conversations
 * (`claude`, `claude-2`, `codex`). Each missing window is printed to stderr.
 * Window names are tool names with an optional `-N`, so they need no
 * escaping.
 */
export function buildAgentWindowCheck(windowNames: string[], paths: WorkspacePaths): string {
  const probes = windowNames
    .map((name) => `echo \\"\\$names\\" | grep -qxF ${name} || { echo ${name} >&2; rc=1; }`)
    .join('; ')
  return `sh -c "sleep 1; rc=0; names=\\$(${tmuxCmd(paths)} list-windows -t =yaac `
    + `-F '#{window_name}') || exit 1; ${probes}; exit \\$rc"`
}

/**
 * The probe reached the workspace and the agent windows are gone.
 *
 * A distinct type because create runs the probe unawaited and its `.catch`
 * sees every rejection. A transport blip must not be reported as a dead
 * agent: a failed provisioning row hides its workspace from the snapshot.
 */
export class AgentLaunchDeadError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts)
    this.name = 'AgentLaunchDeadError'
  }
}

/**
 * Check that a launch's agent windows are alive. Only a
 * `WorkspaceExecError` (the probe ran and found windows missing) becomes
 * `AgentLaunchDeadError`; transport failures propagate unchanged. The probe
 * also fails if the tmux server is gone, and its stderr distinguishes that.
 * The message says "failed to start" because the probe cannot tell a
 * missing binary from a bad interpreter or an immediate auth exit.
 */
export async function verifyAgentWindowAlive(
  jobName: string,
  windowNames: string[],
): Promise<void> {
  const driver = workspaceDriver()
  try {
    await driver.exec(jobName, buildAgentWindowCheck(windowNames, driver.workspacePaths(jobName)))
  } catch (err) {
    if (!(err instanceof WorkspaceExecError)) throw err
    const detail = err.stderr.trim()
    const label = windowNames.length === 1
      ? `agent "${windowNames[0]}"`
      : `agents ${windowNames.join(', ')}`
    throw new AgentLaunchDeadError(
      `${label} exited right after launch in ${jobName} — the agent command `
      + 'failed to start'
      + (detail ? ` (probe stderr: ${detail})` : ''),
      { cause: err },
    )
  }
}

/**
 * The tmux command that creates one init-command window, shared by fresh
 * setup and claim-time prep so both produce the same window. Without
 * remain-on-exit the window closes when its command finishes, and the
 * webapp's tabs follow the window list.
 */
export function initWindowCommand(win: InitWindow, paths: WorkspacePaths): string {
  return `${tmuxCmd(paths)} new-window -d -t yaac -n ${win.name} `
    + `'cd ${paths.workspaceDir} && ${win.cmd}'`
    + (win.hidePane ? '' : ` \\; set-option -t yaac:${win.name} remain-on-exit on`)
}

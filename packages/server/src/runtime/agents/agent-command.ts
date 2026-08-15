import { WorkspaceExecError, type WorkspacePaths } from '#drivers/contract'
import { worktreeDriver } from '#drivers/driver'
import {
  PI_DEFAULT_PROVIDER,
  piProviderInfo,
  type PiProvider,
} from '@yaac/shared/tool-providers'
import {
  toolSupportsPermissionMode,
  type AgentTool,
  type InitCommandSpec,
  type PermissionMode,
  type YaacConfig,
} from '@yaac/shared/types'
import { shellEscape } from '#lib/shell'

/**
 * Every `tmux` invocation this file authors routes through this prefix so
 * they all reach the same server socket — WHICH socket being the driver's
 * answer, not ours (`WorkspacePaths.tmuxSock`).
 *
 * It has to be, because the two drivers need different answers for the same
 * reason: a UNIX socket only rendezvouses within the kernel that bound it.
 * A pod has its own, so one fixed in-container path is safe for every
 * workspace; host processes share one, so a fixed path would land every
 * worktree on a single tmux server, where `has-session -t yaac` and
 * `respawn-window -t yaac:<tool>` would answer for whichever worktree got
 * there first.
 */
export function tmuxCmd(paths: Pick<WorkspacePaths, 'tmuxSock'>): string {
  // Unquoted, and it has to be: this prefix is embedded both at the top
  // level of an `exec` and INSIDE single-quoted script bodies (the prompt
  // paste, an init window's `'cd … && …'`), where a quote would end the
  // enclosing string. What keeps it safe is the other end — a driver's
  // paths are shell-safe by construction, which `assertShellSafePaths`
  // enforces at launch for the one driver whose paths are not constants.
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
 * Resolve `config.initCommands` into the concrete set of tmux windows to
 * spawn. Pure (no side effects) so it can be unit-tested directly.
 *
 *   - string[]            → one `init` window with the commands chained `&&`
 *   - InitCommandSpec[]   → one window per spec, name taken from spec.name
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
  worktreeId: string
  resume?: boolean
  /** pi only — provider whose default model is passed to `pi --model`
   *  when no explicit `model` override is given. */
  piProvider?: PiProvider
  /** Model passed to the agent's `--model` flag: a model id or alias for
   *  claude/codex (`opus`, `gpt-5.2-codex`), `provider/model` for
   *  opencode and pi. Validated by the create route to MODEL_RE, so it is
   *  safe to embed bare in the single-quoted respawn-window wrapper. */
  model?: string
  /**
   * The permission posture to launch in — how much the agent may do before
   * it stops to ask.
   *
   * Required rather than defaulted: it decides whether an agent can act
   * unsupervised, and on a runtime with no sandbox around it that is the
   * difference between a worktree and this machine. A caller states it,
   * and the worktree's row is what remembers the answer across a restart.
   */
  permissionMode: PermissionMode
}

/**
 * The posture to actually launch `tool` in, given what the worktree's row
 * asks for.
 *
 * Create refuses a posture its tool doesn't have, so this only fires on a row
 * written by a different build — where refusing would strand a worktree that
 * cannot be restarted. Each fallback is the nearest posture the tool really
 * has: opencode has no reviewer model, so `auto` lands on `accept-edits`; pi
 * has no permission system at all, so every posture is `bypass` in practice
 * and saying so beats launching flags that do nothing.
 */
function postureFor(tool: AgentTool, mode: PermissionMode): PermissionMode {
  if (toolSupportsPermissionMode(tool, mode)) return mode
  return tool === 'opencode' ? 'accept-edits' : 'bypass'
}

/**
 * opencode's approval posture is config, not flags. `OPENCODE_PERMISSION`
 * takes the same JSON as the config file's `permission` block and is read per
 * process, which is what makes it per-worktree — the `opencode.json` session
 * create writes is shared by every worktree in the project.
 *
 * **Every posture is stated in full, and only in keys opencode actually
 * has.** Its permission config is a plain zod object over exactly `edit`,
 * `bash`, `webfetch`, `doom_loop` and `external_directory` — no top-level
 * wildcard — and a plain zod object *strips* what it does not know. An
 * unrecognized key is therefore not a partial posture but an empty one, which
 * `mergeAgentPermissions` then fills with `edit: allow`, `webfetch: allow`,
 * `bash: {"*": "allow"}`. A posture spelled wrong here does not fail: it runs
 * unrestrained, silently, on a containerless worktree's real filesystem.
 *
 * That is also why `bypass` states allow-everything rather than passing no
 * config at all. Inheriting opencode's near-permissive defaults happens to
 * land in the right place today, but `doom_loop` and `external_directory`
 * already default to `ask`, and a future default that tightens would quietly
 * stop meaning bypass with nothing to signal it.
 */
const OPENCODE_PERMISSION_RULES: Partial<Record<PermissionMode, Record<string, string>>> = {
  bypass: {
    edit: 'allow', bash: 'allow', webfetch: 'allow',
    doom_loop: 'allow', external_directory: 'allow',
  },
  // The two left at opencode's own `ask` default are the point of the mode:
  // edits inside the worktree land unprompted, stepping outside it does not.
  'accept-edits': { edit: 'allow', bash: 'ask', webfetch: 'allow' },
  manual: {
    edit: 'ask', bash: 'ask', webfetch: 'ask',
    doom_loop: 'ask', external_directory: 'ask',
  },
}

/**
 * The value for `OPENCODE_PERMISSION`, escaped for the launch command.
 *
 * Double-quoted with escaped inner quotes rather than single-quoted: the whole
 * command is embedded in `respawn-window '<cmd>'`, so a single quote would end
 * it early, and bare `{...}` would hit zsh brace expansion. Serialized rather
 * than hand-written so the escaping cannot drift from the shape.
 */
function opencodePermissionArg(mode: PermissionMode): string | undefined {
  const rules = OPENCODE_PERMISSION_RULES[mode]
  if (rules === undefined) return undefined
  return `OPENCODE_PERMISSION="${JSON.stringify(rules).replace(/"/g, '\\"')}"`
}

export function buildAgentCmd(spec: AgentCmdSpec): string {
  const { tool, worktreeId, piProvider, model } = spec
  const mode = postureFor(tool, spec.permissionMode)
  const resume = spec.resume ?? false
  if (tool === 'codex') {
    // codex splits the posture across two orthogonal axes — an approval
    // policy and a sandbox — so each mode picks the pair that adds up to it:
    //  - accept-edits is codex's own default preset (workspace-write +
    //    on-request), hence no flags. Its sandbox has network off, which is
    //    what makes it *ask* to escalate for anything reaching the network.
    //  - auto keeps that sandbox and hands the approvals to a reviewer model.
    //  - plan is the read-only sandbox; codex has no plan feature of its own.
    //  - manual asks for everything but known-safe reads.
    const posture = {
      bypass: '--yolo',
      auto: '--approve-for-me',
      'accept-edits': '',
      plan: '--sandbox read-only',
      manual: '--ask-for-approval untrusted',
    }[mode]
    // --model goes after the resume subcommand: codex defines -m/--model on
    // both the root TUI command and `codex resume`, so trailing placement
    // binds it to whichever command runs.
    return [
      'codex',
      posture,
      resume ? `resume ${worktreeId}` : '',
      model ? `--model ${model}` : '',
    ].filter(Boolean).join(' ')
  }
  if (tool === 'pi') {
    // pi runs its TUI in tmux (like claude/codex). It has no permission
    // system by design — tools execute immediately, nothing prompts — which
    // is why `bypass` is the only posture it is offered, and why `--approve`
    // is unconditional here: it accepts the *project trust* prompt (which
    // gates loading `.pi/` settings, not tool execution), and without it pi
    // stops to ask about the checkout on every launch.
    // `--model <provider>/<id>` selects the
    // provider (pi reads that provider's api-key env var, which the proxy
    // swaps). `--session-id <id>` addresses this session by id in the shared
    // `.pi` home — creating it on a fresh run, resuming it otherwise (the same
    // flag both ways, like `claude --session-id`), so `resume` needs no branch.
    // An explicit override wins over the provider's generated default; the
    // proxy only swaps the authenticated provider's key, so an override
    // naming a different provider surfaces as an auth error in the pane.
    const piModel = model ?? piProviderInfo(piProvider ?? PI_DEFAULT_PROVIDER).defaultModel
    // `--model` is dropped only if there is no override and the chosen
    // provider has no generated default (every current pi provider has one;
    // guarded so a future registry gap falls back to pi's own default rather
    // than `--model undefined`).
    const modelFlag = piModel ? ` --model ${piModel}` : ''
    const pi = `pi --approve${modelFlag} --session-id ${worktreeId}`
    // On a fresh run that `--session-id` names a session that doesn't exist
    // yet, so pi prints a yellow "Warning: No project session found with id
    // '<id>'; creating a new session with that id." to stderr, which then
    // lingers at the top of the pane for the whole session. The id is
    // caller-chosen by design (it must match yaac's so pi embeds it in the
    // JSONL log filename — see lib/session/pi-status.ts), so this fires on
    // every new pi session; it is expected, not an error.
    //
    // Route pi's stderr through sed to drop exactly that one line, leaving the
    // TUI (stdout) and any genuine stderr (auth failures, bad-model errors)
    // intact. `0,/re/{//d}` deletes only the *first* match (the warning prints
    // once at startup), and `sed -u` keeps surviving lines unbuffered so a
    // startup error still reaches the pane before pi exits. The pattern is
    // anchored at `^` with `.*` standing in for the variable id and the full
    // "creating a new session with that id." tail required, so a genuine error
    // is never swallowed. It runs the agent with stdout on the pane's PTY, and
    // pi colors this line via chalk keyed off *stdout* being a TTY — so it
    // arrives on stderr wrapped in SGR escapes (`\x1b[33m…\x1b[39m`). The
    // leading `(\x1b\[[0-9;]*m)*` absorbs those (zero-or-more, so a plain-text
    // line off-TTY still matches). tmux runs this under the pod's zsh
    // (SHELL=/bin/zsh), so process substitution is available; the pattern uses
    // `.*` rather than the literal quotes around the id, keeping the whole
    // string free of single quotes so it survives the single-quoted
    // `respawn-window '<cmd>'` wrapper it is embedded in.
    const warn = 'Warning: No project session found with id .*creating a new session with that id\\.'
    return `${pi} 2> >(sed -u -E "0,/^(\\x1b\\[[0-9;]*m)*${warn}/{//d}" >&2)`
  }
  if (tool === 'opencode') {
    // --port + --hostname enable opencode's built-in HTTP server on
    // container loopback. yaac reads /session and /session/status from
    // there (via `kubectl exec curl`) for status + first-message lookup.
    // --continue resumes the one session stored in the per-yaac-worktree
    // data dir (isolated per container — no cwd-collision concern).
    // --model takes `provider/model`; omitted, opencode uses the model
    // persisted in its shared config (or its own default).
    //
    // The posture arrives two different ways because opencode expresses it
    // two different ways. `plan` is one of its own built-in agents, and its
    // rules are stronger than anything worth restating here — `edit: deny`
    // plus a curated read-only bash allowlist — so `--agent plan` selects it
    // rather than hand-writing an approximation. Every other posture is
    // permission rules, which `OPENCODE_PERMISSION` carries per process.
    //
    // Deliberately no posture *flag*: opencode's TUI takes only model,
    // continue, session, prompt, agent, port and hostname, and its parser is
    // non-strict — an invented flag is dropped without a word, leaving the
    // posture as whatever the defaults say.
    return [
      opencodePermissionArg(mode) ?? '',
      'opencode',
      mode === 'plan' ? '--agent plan' : '',
      '--port 4096 --hostname 127.0.0.1',
      model ? `--model ${model}` : '',
      resume ? '--continue' : '',
    ].filter(Boolean).join(' ')
  }
  // claude names all five postures on one flag, so the mapping is a rename.
  // `--permission-mode bypassPermissions` over the older
  // `--dangerously-skip-permissions` spelling: same posture, and stating it
  // on the same flag as the rest keeps one axis instead of two.
  // `auto` is gated by subscription plan — an ineligible account fails in the
  // pane, which is the honest place for it: nothing here can check first.
  //
  // `manual` over the `default` this flag also still accepts: `default` is
  // absent from the flag's advertised choices, which reads like a compat
  // alias on its way out. Naming the documented one keeps the cell off a
  // spelling that could be dropped — and if it ever is, commander rejects the
  // value and the pane dies at launch rather than running lax.
  const posture = {
    bypass: 'bypassPermissions',
    auto: 'auto',
    'accept-edits': 'acceptEdits',
    plan: 'plan',
    manual: 'manual',
  }[mode]
  return [
    `CLAUDE_CODE_NO_FLICKER=1 claude --permission-mode ${posture}`,
    model ? `--model ${model}` : '',
    resume ? `--resume ${worktreeId}` : `--session-id ${worktreeId}`,
  ].filter(Boolean).join(' ')
}

/**
 * In-pod command that delivers an initial prompt to the agent's pane: it
 * pastes the text into the TUI's input and submits it. Three timing hazards
 * shape the script — a prompt pasted into a TUI that is still starting up
 * is silently discarded (observed with claude in the create e2e suite), and
 * with no user attached nothing would ever re-send it:
 *
 *  1. Readiness gate: wait for `#{alternate_on}` — every agent TUI switches
 *     the pane to the alternate screen when its render loop comes up, which
 *     is the earliest tool-agnostic "accepting input" signal. Falls through
 *     after 60s so a TUI that never flips still gets a best-effort paste.
 *  2. Verified paste: paste, then check `capture-pane` for the prompt's
 *     first line (its first 40 chars — the pane is created 500 cols wide
 *     and nothing attaches before provisioning finishes, so no wrap) and
 *     re-paste until it is visibly in the input box.
 *  3. Submit + guard: Enter is sent separately (a paste never
 *     self-submits) and re-sent after a beat — a TUI finishing its startup
 *     render can keep the pasted text but drop the first Enter; on an
 *     already-submitted prompt the repeat is a no-op on an empty input box.
 *
 * The prompt travels base64-encoded — its alphabet has no quotes or shell
 * metacharacters, so arbitrary text (quotes, `$`, newlines) survives the
 * host shell and the in-pod single-quoted `sh -c` with no escaping logic;
 * `paste-buffer -p` honors bracketed paste so a multiline prompt lands in
 * the input box instead of submitting line by line.
 */
export function buildPromptPasteCmd(
  target: string,
  prompt: string,
  paths: WorkspacePaths,
): string {
  return `sh -c '${promptPasteScript(target, prompt, paths)}'`
}

/**
 * The tmux target for a tool's primary agent window — where session create's
 * initial ask goes. A *later* message addresses the conversation's pane id
 * instead (see the tui driver's `deliverPrompt`), because a worktree with
 * several conversations has several panes and only one `yaac:<tool>` window.
 */
export function agentWindowTarget(tool: AgentTool): string {
  return `yaac:${tool}`
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
  // First non-empty line anchors the paste verification; a whitespace-only
  // prompt (nothing capture-pane could match) degrades to one blind paste.
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
 * `buildPromptPasteCmd`, detached: decode the paste script to a pod-local
 * file and setsid it, so the exec returns immediately instead of holding
 * the caller through the script's readiness polling and settle sleeps
 * (~5s+ on a fresh agent). The script survives the exec stream closing
 * (reparented to the container's init), retries entirely in-pod, and logs
 * to /tmp/yaac-prompt.log for postmortems. The script travels
 * base64-encoded so its quoting survives the single shell pass unchanged.
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
 * Type `prompt` into a running session's agent pane, fire-and-forget (see
 * buildPromptPasteBgCmd). Rides the stream relay — both callers (session
 * create, the spare-claim route) run after the pod's streamd is up.
 * Single-attempt: RelayDialError also covers reply-read failures AFTER the
 * command ran (readAll timeout, mid-read socket errors), and a retry there
 * would detach a second paste script — duplicated paste or a stray empty
 * submission.
 */
export async function typeInitialPrompt(
  jobName: string,
  tool: AgentTool,
  prompt: string,
): Promise<void> {
  const driver = worktreeDriver()
  const cmd = buildPromptPasteBgCmd(
    agentWindowTarget(tool),
    prompt,
    driver.workspacePaths(jobName),
  )
  await driver.exec(jobName, cmd, { maxAttempts: 1, timeout: 15_000 })
}

/**
 * In-workspace probe that every agent window survived its respawn.
 * `respawn-window` reports success even when its command dies instantly
 * (the tool binary missing from the image a spare was warmed from, or from
 * a containerless host): the pane exits, tmux closes the window, and the
 * yaac session lives on through its init windows — so the caller would hand
 * over a "healthy" session whose agent pane silently falls back to the
 * lowest-index window (see attachArgs). The in-workspace sleep gives a
 * doomed command time to exit before the existence probe; a slow crash past
 * it still slips through — this catches the deterministic spawn-failure
 * class, not every crash.
 *
 * A window-name LIST rather than a tool, because a launch can open several
 * conversations at once (a restart resuming a multi-agent worktree), whose
 * windows are `agentWindowName(tool, i)` — `claude`, `claude-2`, `codex`.
 * One `list-windows`, one sleep, one exit code for the whole set; each
 * missing window names itself on stderr, which is what the caller's message
 * reports. Window names are tool names with an optional `-N` suffix, so
 * they embed in the double-quoted `sh -c` with nothing to escape.
 */
export function buildAgentWindowCheck(windowNames: string[], paths: WorkspacePaths): string {
  const probes = windowNames
    .map((name) => `echo \\"\\$names\\" | grep -qxF ${name} || { echo ${name} >&2; rc=1; }`)
    .join('; ')
  return `sh -c "sleep 1; rc=0; names=\\$(${tmuxCmd(paths)} list-windows -t =yaac `
    + `-F '#{window_name}') || exit 1; ${probes}; exit \\$rc"`
}

/**
 * The probe's VERDICT: it reached the workspace, and the windows the launch
 * asked for are not there.
 *
 * A type rather than a message, because the split it carries has to survive
 * a caller that cannot use `try`/`catch` control flow to honor it. The
 * create fires this probe without awaiting it, so its whole `.catch` sees
 * every rejection — and reporting a transport blip as a dead agent there
 * does not merely add noise: a failed provisioning row HIDES its worktree
 * from the snapshot, so a false positive makes a live, working worktree
 * vanish behind an error until the user dismisses it.
 */
export class AgentLaunchDeadError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts)
    this.name = 'AgentLaunchDeadError'
  }
}

/**
 * Runs after the launch that opened the windows — on the claim path after
 * `waitForStreamd`, so it rides the relay. Only a `WorkspaceExecError` is a
 * verdict about the windows: the probe reached the workspace and did not
 * find them, which is what rejects as `AgentLaunchDeadError`. A transport
 * failure proves nothing about the agent, so it propagates as itself rather
 * than masquerading as a dead agent.
 *
 * The probe also exits nonzero when the tmux server is gone entirely — its
 * stderr ("no server running on ...") is the difference between that and a
 * closed agent window, and carrying it keeps the reader off the wrong
 * trail. Deliberately says the command "failed to start" rather than naming
 * a cause: a missing binary is the common one, but a bad interpreter, a
 * half-finished install and an immediate auth exit all land here, and the
 * probe cannot tell them apart.
 */
export async function verifyAgentWindowAlive(
  jobName: string,
  windowNames: string[],
): Promise<void> {
  const driver = worktreeDriver()
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
 * The tmux invocation that creates one init-command window. Shared between
 * fresh-session setup and the claim-time re-branch prep so a re-created
 * window is indistinguishable from a warm-time one. Without remain-on-exit
 * the window closes when its command finishes — and the webapp pane/tab
 * follows the window list, so a hidePane init window shows while running and
 * disappears once done.
 */
export function initWindowCommand(win: InitWindow, paths: WorkspacePaths): string {
  return `${tmuxCmd(paths)} new-window -d -t yaac -n ${win.name} `
    + `'cd ${paths.workspaceDir} && ${win.cmd}'`
    + (win.hidePane ? '' : ` \\; set-option -t yaac:${win.name} remain-on-exit on`)
}

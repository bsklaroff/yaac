import { WorkspaceExecError } from '#drivers/contract'
import { worktreeDriver } from '#drivers/driver'
import { CONTAINER_TMUX_SOCK } from '@yaac/shared/paths'
import {
  PI_DEFAULT_PROVIDER,
  piProviderInfo,
  type PiProvider,
} from '@yaac/shared/tool-providers'
import type { AgentTool, YaacConfig, InitCommandSpec } from '@yaac/shared/types'
import { shellEscape } from '#lib/shell'

// Every in-container `tmux` invocation routes through this prefix so they
// all reach the same server socket, on the pod's own emptyDir. Nothing
// host-side connects to it — a UNIX socket only rendezvouses within the
// kernel that bound it — so liveness and pane-content probes reach tmux
// through `kubectl exec` in the pod, like every other consumer.
export const TMUX = `tmux -S ${CONTAINER_TMUX_SOCK}`

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

export function buildAgentCmd(
  tool: AgentTool,
  worktreeId: string,
  resume = false,
  /** pi only — provider whose default model is passed to `pi --model`
   *  when no explicit `model` override is given. */
  piProvider?: PiProvider,
  /** Model passed to the agent's `--model` flag: a model id or alias for
   *  claude/codex (`opus`, `gpt-5.2-codex`), `provider/model` for
   *  opencode and pi. Validated by the create route to MODEL_RE, so it is
   *  safe to embed bare in the single-quoted respawn-window wrapper. */
  model?: string,
): string {
  if (tool === 'codex') {
    // --model goes after the resume subcommand: codex defines -m/--model on
    // both the root TUI command and `codex resume`, so trailing placement
    // binds it to whichever command runs.
    return [
      'codex --yolo',
      resume ? `resume ${worktreeId}` : '',
      model ? `--model ${model}` : '',
    ].filter(Boolean).join(' ')
  }
  if (tool === 'pi') {
    // pi runs its TUI in tmux (like claude/codex). `--approve` accepts the
    // project trust prompt for the run; pi has no sandbox and executes tools
    // without per-call approval. `--model <provider>/<id>` selects the
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
    return [
      'opencode',
      '--port 4096 --hostname 127.0.0.1',
      model ? `--model ${model}` : '',
      resume ? '--continue' : '',
    ].filter(Boolean).join(' ')
  }
  return [
    'CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions',
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
export function buildPromptPasteCmd(target: string, prompt: string): string {
  return `sh -c '${promptPasteScript(target, prompt)}'`
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
function promptPasteScript(paneTarget: string, prompt: string): string {
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
export function buildPromptPasteBgCmd(target: string, prompt: string): string {
  const b64 = Buffer.from(promptPasteScript(target, prompt), 'utf8').toString('base64')
  return `printf %s ${b64} | base64 -d > /tmp/.yaac-prompt.sh`
    + ' && setsid sh /tmp/.yaac-prompt.sh >/tmp/yaac-prompt.log 2>&1 </dev/null &'
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
  await worktreeDriver().exec(jobName, buildPromptPasteBgCmd(agentWindowTarget(tool), prompt), {
    maxAttempts: 1,
    timeout: 15_000,
  })
}

/**
 * In-pod probe that the agent window survived a claim-time respawn.
 * `respawn-window` reports success even when its command dies instantly
 * (e.g. the tool binary is missing from the image the spare was warmed
 * from): the pane exits, tmux closes the window, and the yaac session
 * lives on through its init windows — so the claim would hand over a
 * "healthy" session whose agent pane silently falls back to the
 * lowest-index window (see attachArgs). The in-pod sleep gives a doomed
 * command time to exit before the existence probe; a slow crash past it
 * still slips through — this catches the deterministic spawn-failure
 * class, not every crash.
 */
export function buildAgentWindowCheck(tool: AgentTool): string {
  return `sh -c "sleep 1; ${TMUX} list-windows -t =yaac -F '#{window_name}' | grep -qxF ${tool}"`
}

/**
 * Runs on the claim path, after `waitForStreamd`, so it rides the relay.
 * Only a `WorkspaceExecError` is a verdict about the window: the probe
 * reached the workspace and `grep` found no such window. A transport failure
 * proves nothing about the agent, so it propagates as itself rather than
 * masquerading as a missing tool.
 *
 * The probe is `list-windows | grep`, so a dead tmux server exits nonzero
 * too — its stderr ("no server running on ...") is the difference between
 * that and a missing tool, and carrying it keeps the operator off the
 * wrong trail.
 */
export async function verifyAgentWindowAlive(jobName: string, tool: AgentTool): Promise<void> {
  try {
    await worktreeDriver().exec(jobName, buildAgentWindowCheck(tool))
  } catch (err) {
    if (!(err instanceof WorkspaceExecError)) throw err
    const detail = err.stderr.trim()
    throw new Error(
      `agent "${tool}" exited right after its respawn in ${jobName} — `
      + 'likely not installed in the image this spare was warmed from'
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
export function initWindowCommand(win: InitWindow): string {
  return `${TMUX} new-window -d -t yaac -n ${win.name} 'cd /workspace && ${win.cmd}'`
    + (win.hidePane ? '' : ` \\; set-option -t yaac:${win.name} remain-on-exit on`)
}

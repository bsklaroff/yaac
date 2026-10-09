import { stripControlChars } from '@yaac/shared/ansi'
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
  /** Effort level, in the tool's words (docs/effort-levels.md). Shape-checked
   *  (`EFFORT_RE`), so it embeds bare like the model. Absent passes none. */
  effort?: string
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
  agent?: Record<string, { model: string; variant: string }>
}

/**
 * The permission actions opencode knows, read off the pinned binary
 * (`@opencode/cli@2.0.21`): its tools plus the wildcard and
 * `external_directory`. Unknown actions are accepted silently and match
 * nothing, so `agent-command.test.ts` checks every action used below against
 * this list. Re-read it when the pin in dockerfiles/Dockerfile.tools moves.
 */
export const OPENCODE_ACTIONS: readonly string[] = [
  '*', 'browser', 'edit', 'glob', 'grep', 'question', 'read', 'shell', 'skill',
  'subagent', 'webfetch', 'websearch', 'execute', 'external_directory',
  'opencode_list_mcp_resources', 'opencode_read_mcp_resource',
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
 *
 * An effort is a model variant, which opencode's config takes only on an
 * agent, beside the model it applies to (a `model#variant` there is dropped
 * as a legacy reference, checked against 2.0.21). It goes on both built-in
 * agents, so a Tab between them keeps it. `default` (no variant) needs no
 * entry.
 */
export function opencodeConfigArg(
  mode: PermissionMode,
  model: string | undefined,
  effort?: string,
): string {
  const variant = model !== undefined && effort !== undefined && effort !== 'default'
    ? { model, variant: effort }
    : undefined
  const config: OpencodeConfig & { model?: string } = {
    ...OPENCODE_POSTURE[postureFor('opencode', mode)],
    ...(model === undefined ? {} : { model }),
    ...(variant === undefined ? {} : { agent: { build: variant, plan: variant } }),
  }
  return envJsonAssignment('OPENCODE_CONFIG_CONTENT', config)
}

export function buildAgentCmd(spec: AgentCmdSpec): string {
  const { tool, workspaceId, piProvider, model, effort } = spec
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
      ...(effort !== undefined ? [`model_reasoning_effort=${effort}`] : []),
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
    // needs no branch. `--tui-mode fullscreen` because its regular mode
    // leaves the mouse to the terminal, so a tool call cannot be clicked open
    // there (docs/terminal-mirror.md).
    const piModel = model ?? piProviderInfo(piProvider ?? PI_DEFAULT_PROVIDER).defaultModel
    // Guard against a provider with no default model.
    const modelFlag = piModel ? ` --model ${piModel}` : ''
    const thinkingFlag = effort !== undefined ? ` --thinking ${effort}` : ''
    const pi = `pi --approve --tui-mode fullscreen${modelFlag}${thinkingFlag} --session-id ${workspaceId}`
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
      opencodeConfigArg(mode, model, effort),
      envJsonAssignment('OPENCODE_CLI_CONFIG_CONTENT', { keybinds: OPENCODE_TUI_KEYBINDS }),
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
    // Outranks the effort a `/effort` in another workspace saved to the
    // shared settings.
    effort !== undefined ? `--effort ${effort}` : '',
    resume ? `--resume ${workspaceId}` : `--session-id ${workspaceId}`,
  ].filter(Boolean).join(' ')
}

/**
 * In-workspace command that pastes an initial prompt into a fresh agent's
 * TUI and submits it. A prompt pasted while the TUI is starting is silently
 * lost (seen with claude in the create e2e suite), and no user is attached
 * to resend it, so:
 *
 *  1. Wait for `#{alternate_on}`, the earliest tool-agnostic sign the TUI
 *     accepts input; give up waiting after 60s and paste anyway, since
 *     claude's startup dialogs never set it.
 *  2. Paste, then check `capture-pane` until the paste shows, re-pasting
 *     if it doesn't (`pasteParts`). If it never shows, stop without pressing
 *     Enter: the pane is showing something other than an input box, such as
 *     claude's folder-trust dialog.
 *  3. Send Enter separately, then again after a moment, since a TUI
 *     finishing startup can drop the first one; a repeat on an empty input
 *     does nothing.
 *
 * Exits 1 when the paste never showed.
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
  const target = `-t ${paneTarget}`
  const { paste, copies } = pasteParts(paneTarget, prompt, TMUX)
  return `i=0; while [ $i -lt 120 ]; do [ "$(${TMUX} display -p ${target} "#{alternate_on}")" = "1" ] && break; i=$((i+1)); sleep 0.5; done; `
    + 'sleep 1; '
    + (copies === undefined
      ? `${paste}; `
      : `${copies}before=$(copies); `
        + 'i=0; while [ "$(copies)" -le "$before" ]; do '
        + '[ $i -ge 10 ] && { echo "prompt never appeared in the pane; not submitting" >&2; exit 1; }; '
        + `${paste}; i=$((i+1)); sleep 2; done; `)
    + `${TMUX} send-keys ${target} Enter; sleep 2; ${TMUX} send-keys ${target} Enter`
}

/**
 * The shell pieces both pastes share: `paste`, which pastes the prompt, and
 * `copies`, a function counting how many copies of it the pane shows (absent
 * for a whitespace-only prompt, which has nothing to match and is pasted
 * blind).
 *
 * A paste counts as shown when the pane holds MORE copies of the prompt's
 * first or last 20 visible characters (an input box scrolls to its last
 * lines when the pane is small), or of a TUI's collapsed-paste marker such as
 * pi's `[paste #1 +13 lines]`, than it did before: text already on screen,
 * such as an earlier message or a dialog the prompt quotes, proves nothing.
 * Whitespace is dropped on both sides, since TUIs wrap lines and render tabs
 * as spaces.
 *
 * Control characters other than newline and tab are dropped from the
 * prompt: inside a paste, an escape sequence could end the bracketed paste
 * and type the rest as keystrokes. The prompt travels base64-encoded so any
 * text survives the shell layers, `paste-buffer -p` uses bracketed paste so
 * a multiline prompt is not submitted line by line, and each script pastes
 * from its own buffer, so concurrent deliveries never paste each other's.
 */
function pasteParts(paneTarget: string, prompt: string, TMUX: string): { paste: string; copies?: string } {
  const text = stripControlChars(prompt)
  const target = `-t ${paneTarget}`
  // By code point, so a probe never ends in half a surrogate pair.
  const visible = [...text].filter((c) => !/[\x00-\x20\x7f]/.test(c))
  const probe = (chars: string[]): string => Buffer.from(chars.join(''), 'utf8').toString('base64')
  const paste = `printf %s ${Buffer.from(text, 'utf8').toString('base64')} | base64 -d | ${TMUX} load-buffer -b yaac-prompt-$$ -; `
    + `${TMUX} paste-buffer -p -d -b yaac-prompt-$$ ${target}`
  if (visible.length === 0) return { paste }
  return {
    paste,
    copies: `head="$(printf %s ${probe(visible.slice(0, 20))} | base64 -d)"; `
      + `last="$(printf %s ${probe(visible.slice(-20))} | base64 -d)"; `
      + `copies() { p="$(${TMUX} capture-pane ${target} -p | tr -d "[:space:]")"; `
      + '{ printf %s "$p" | grep -oF -- "$head"; printf %s "$p" | grep -oF -- "$last"; '
      + 'printf %s "$p" | grep -oE "\\[(paste#|PastedContent|Pasted~|Pastedtext#)"; } | wc -l; }; ',
  }
}

/** A conversation id safe to put in a shell script, as every tool's is. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/

/**
 * In-workspace command that hands a running agent a message from someone
 * other than its user (`yaac-mama send`), submitted on its own whatever the
 * user has left in the input box. The agent may be idle, mid-turn (its input
 * queues what is typed) or showing a dialog. Exit codes:
 *
 *  - 0: submitted, and any draft of the user's is back in the input box.
 *  - 1: the paste never showed; nothing was submitted, and the draft is back.
 *  - 3: the agent shows a dialog (`atInputTest`), so nothing was typed.
 *  - 4: a dialog opened once the text was in; it sits unsubmitted, and any
 *    draft stays set aside.
 *  - 5: the user's draft could not be set aside, so nothing was typed.
 *
 * A pi agent is handed the message by yaac's pi extension, which submits it
 * without touching the editor (`PI_MESSAGE_KEY`). The others are pasted
 * into:
 *
 *  1. If the input box holds a draft (`draftHandling`), set it aside with
 *     the tool's own stash where it has one.
 *  2. Paste once (`pasteParts`) and wait for it to show; the agent is past
 *     startup, so there is no wait before it and no re-paste.
 *  3. A second after it shows (codex drops an Enter that follows a paste at
 *     once), check again for a dialog and that the text still shows, then
 *     send Enter, once: a second Enter could answer a prompt the first one
 *     raised.
 *  4. Put the draft back.
 *
 * The script contains quotes, so it travels base64-encoded and is decoded
 * into `sh -c`.
 */
export function buildMessageCmd(
  target: string,
  message: string,
  paths: WorkspacePaths,
  conversation: { tool: AgentTool; agentSessionId: string },
): string {
  const script = messageScript(target, message, paths, conversation)
  return `sh -c "$(printf %s ${Buffer.from(script, 'utf8').toString('base64')} | base64 -d)"`
}

function messageScript(
  paneTarget: string,
  message: string,
  paths: WorkspacePaths,
  { tool, agentSessionId }: { tool: AgentTool; agentSessionId: string },
): string {
  if (!SAFE_SESSION_ID.test(agentSessionId)) return 'echo "unexpected conversation id" >&2; exit 3'
  const TMUX = tmuxCmd(paths)
  const target = `-t ${paneTarget}`
  if (tool === 'pi') {
    // The extension takes the file, so its being gone is the delivery.
    const b64 = Buffer.from(stripControlChars(message), 'utf8').toString('base64')
    return `f="$PI_CODING_AGENT_DIR/yaac-messages/${agentSessionId}.txt"; mkdir -p "\${f%/*}" || exit 1
printf %s ${b64} | base64 -d > "$f.tmp" && mv "$f.tmp" "$f" || exit 1
${TMUX} send-keys ${target} ${PI_MESSAGE_KEY}
i=0; while [ -e "$f" ]; do
  [ $i -ge 40 ] && { rm -f "$f"; echo "pi never took the message" >&2; exit 1; }
  i=$((i+1)); sleep 0.25
done`
  }
  const draft = draftHandling(tool, TMUX, target)
  const { paste, copies } = pasteParts(paneTarget, message, TMUX)
  return `tm() { ${TMUX} "$@"; }
at_input() { ${atInputTest(tool, TMUX, target, agentSessionId)}; }
${draft.defs ?? ''}
box() { ${draft.box}; }
wait_box() { i=0; until box; [ $? = "$1" ]; do [ $i -ge 20 ] && return 1; i=$((i+1)); sleep 0.25; done; }
keys() { at_input && { box; [ $? != 2 ]; } && tm send-keys ${target} "$@"; }
had=0
fail() { [ $had = 1 ] && box && { ${draft.unstash}; }; echo "$2" >&2; exit $1; }
${copies ?? 'copies() { echo 1; }; '}
at_input || { echo "the agent is showing a prompt" >&2; exit 3; }
box; state=$?
[ $state = 2 ] && { echo "its input box is not on screen" >&2; exit 3; }
${draft.prepare}
if [ $state = 1 ]; then had=1; ${draft.stash}; fi
before=$(copies)
${paste}
i=0; while [ "$(copies)" -le "$before" ]; do
  [ $i -ge 10 ] && fail 1 "the message never appeared in the pane; not submitting"
  i=$((i+1)); sleep 1
done
sleep 1
at_input && [ "$(copies)" -gt "$before" ] || { echo "a prompt opened after the message was typed" >&2; exit 4; }
tm send-keys ${target} Enter
${draft.finish}
exit 0`
}

/** The key yaac's pi extension takes a `yaac-mama send` message on. */
export const PI_MESSAGE_KEY = 'f9'

/**
 * The shell test `buildMessageCmd` runs before typing, before Enter and
 * before any key that sets a draft aside or puts it back: it holds while a
 * running agent is at its input or mid-turn, and fails while it shows a
 * dialog that pasted text or a key could answer (a permission prompt, a
 * question, a plan to approve). Per tool, checked against the pinned
 * versions:
 *
 *  - claude keeps a presence file per process in
 *    `$CLAUDE_CONFIG_DIR/sessions/`, naming its conversation and a
 *    `status` of `idle` or `busy` at its input, and `waiting` under any
 *    dialog (`waitingFor` says which). The newest naming the conversation
 *    is read, since a resumed conversation leaves its old process's behind;
 *    there is none until the TUI is past its startup dialogs.
 *  - codex titles its pane "Action Required" under an approval or a
 *    question, and hides the cursor under every dialog, its "Implement this
 *    plan?" prompt and startup screens included; at the composer, idle or
 *    mid-turn, the cursor shows.
 *  - opencode keeps its title, but marks the session's tab label on the
 *    pane's first row ` ! ` under a permission prompt and ` ? ` under a
 *    question or form, where a paste fills the free-text answer.
 */
function atInputTest(tool: AgentTool, TMUX: string, target: string, agentSessionId: string): string {
  switch (tool) {
    case 'claude':
      return 'f=$(ls -t "$CLAUDE_CONFIG_DIR"/sessions/*.json 2>/dev/null | while read -r x; do '
        + `grep -qF "\\"sessionId\\":\\"${agentSessionId}\\"" "$x" && { echo "$x"; break; }; done); `
        + '[ -n "$f" ] && case "$(sed -n "s/.*\\"status\\":\\"\\([a-z]*\\)\\".*/\\1/p" "$f")" in '
        + 'idle|busy) true ;; *) false ;; esac'
    case 'codex':
      return `case "$(${TMUX} display -p ${target} "#{pane_title}")" in *"Action Required"*) false ;; *) `
        + `[ "$(${TMUX} display -p ${target} "#{cursor_flag}")" = 1 ] ;; esac`
    case 'opencode':
      return `! ${TMUX} capture-pane -p ${target} | head -n 1 | grep -qE "^ [!?] "`
    case 'pi':
      return 'true'
  }
}

/**
 * How `buildMessageCmd` sets a user's draft aside and puts it back, per
 * tool, checked against the pinned versions by driving each:
 *
 *  - `defs` are shell functions the others use.
 *  - `box` finds the input box on screen and exits 0 when it holds nothing
 *    but its placeholder (dim, so claude's and codex's are told apart by
 *    their colour), 1 when it holds text, and 2 when it cannot find it, which
 *    refuses the message before any key is sent.
 *  - `prepare` runs first; `stash` with a draft in the box, leaving it
 *    empty or exiting through `fail`; `finish` after Enter, `$had` saying
 *    whether there was a draft; `unstash` to bring the draft back into an
 *    empty box when delivery fails. Each key goes through `keys`, which
 *    sends nothing unless the box is on screen with no dialog over it: a
 *    dialog our message raises keeps the draft set aside, in claude's stash,
 *    codex's history or opencode's stack. A draft cut from beside a claude
 *    user's own stash is then only in claude's kill ring, unmarked, where
 *    `C-y` brings it back until something else is cut.
 *
 * claude stashes with `C-s` and restores the stash by itself on the next
 * submit, so a draft needs no `finish`; `C-s` on an empty box pops the
 * stash, which is the `unstash`. It keeps one stash, marked `› stashed`
 * above the box, and a user who has one keeps it: our submit restores it
 * into the box, and it is stashed again. A draft beside it is cut instead,
 * from its end with `C-u` until the box is empty, and yanked back with
 * `C-y` once the stash is back in place; the kill ring outlives a submit.
 * It keeps only text, so a draft holding a collapsed paste or an image, whose
 * placeholder would come back but not what it stands for, is refused.
 *
 * codex has no stash. `C-c` clears a box that holds text into its history,
 * so after our message `Up Up` recalls the draft (the first `Up` recalls our
 * message), though not where its cursor was. `C-c` is only ever sent to a
 * box found holding text: in an empty one it arms quit, or interrupts a
 * turn. The box is found by the cursor, which sits in it.
 *
 * opencode has a stash stack but binds no keys to it, so yaac's launch binds
 * two (`OPENCODE_TUI_KEYBINDS`). Pop replaces what is in the box, so it only
 * follows a push that happened, which the stash file changing shows.
 */
function draftHandling(tool: Exclude<AgentTool, 'pi'>, TMUX: string, target: string): {
  defs?: string; box: string; prepare: string; stash: string; finish: string; unstash: string
} {
  switch (tool) {
    case 'claude': {
      // The box sits between the last two rules of `─`; its first line
      // starts `❯` and a no-break space, and the stash's mark sits above it.
      // `claude_box state` exits as `box` does; `lines` prints how many
      // lines it holds; `stashed` and `pasted` exit 0 for a stash, and for
      // a collapsed paste or image in the box.
      const claudeBox = `claude_box() { ${TMUX} capture-pane -p -e ${target} | awk -v want="$1" '
  { s=$0; gsub(/\\033\\[[0-9;]*m/, "", s) }
  s ~ /^(─)+$/ { prev=last; last=NR; next }
  { raw[NR]=$0; txt[NR]=s }
  END {
    found = prev && last-prev>=2 && index(txt[prev+1], "❯") == 1
    if (want == "stashed") exit (found && txt[prev-1] ~ /› stashed[ \\t]*$/) ? 0 : 1
    if (want == "lines") { print found ? last-prev-1 : 0; exit }
    if (want == "pasted") { for (i=prev+1; i<last; i++) if (txt[i] ~ /\\[(Pasted text|Image) #[0-9]+/) exit 0; exit 1 }
    if (!found) exit 2; if (last-prev>2) exit 1; r=raw[prev+1]; t=txt[prev+1];
    sub(/^(\\033\\[[0-9;]*m)*❯\\302\\240/, "", r); if (r ~ /^\\033\\[2m/) exit 0;
    sub(/^❯\\302\\240/, "", t); exit (t ~ /^[ \\t]*$/) ? 0 : 1 }'; }`
      return {
        defs: claudeBox,
        box: 'claude_box state',
        prepare: 'user_stash=0; claude_box stashed && user_stash=1; cut=0',
        stash: 'if [ $user_stash = 0 ]; then '
          + 'keys C-s && wait_box 0 || fail 5 "claude did not stash its user\'s draft"; '
          + 'else '
          + 'claude_box pasted && fail 5 "its user has a stashed prompt, and a draft holding a paste that only the stash keeps whole"; '
          + 'n=$(claude_box lines); while [ $n -gt 0 ]; do keys Down; n=$((n-1)); done; keys C-e; '
          + 'cut=1; i=0; until box; do [ $i -ge 50 ] && fail 5 "claude did not cut its user\'s draft"; keys C-u; i=$((i+1)); done; '
          + 'fi',
        finish: '[ $user_stash = 1 ] && wait_box 1 && keys C-s && [ $had = 1 ] && wait_box 0 && keys C-y',
        unstash: 'if [ $cut = 1 ]; then keys C-y; else keys C-s; fi',
      }
    }
    case 'codex':
      return {
        // The composer is the last line starting `›` at or above the
        // cursor, with only its own indented lines between.
        box: `set -- $(${TMUX} display -p ${target} "#{cursor_flag} #{cursor_y}"); [ "$1" = 1 ] || return 2
  ${TMUX} capture-pane -p -e ${target} | awk -v row=$(($2 + 1)) '
  { raw[NR]=$0; s=$0; gsub(/\\033\\[[0-9;]*m/, "", s); txt[NR]=s; if (NR <= row && index(s, "›") == 1) c=NR }
  END { if (!c) exit 2; for (i=c+1; i<=row; i++) if (txt[i] !~ /^(  |$)/) exit 2;
    if (row > c) exit 1; r=raw[c];
    sub(/^(\\033\\[[0-9;]*m)*›(\\033\\[[0-9;]*m)* /, "", r); if (r ~ /^\\033\\[2m/) exit 0;
    t=txt[c]; sub(/^› ?/, "", t); exit (t ~ /^[ \\t]*$/) ? 0 : 1 }'`,
        prepare: '',
        stash: 'keys C-c && wait_box 0 || fail 5 "codex did not clear its user\'s draft"',
        finish: '[ $had = 1 ] && wait_box 0 && keys Up Up',
        unstash: 'keys Up',
      }
    case 'opencode':
      return {
        // The box is the last run of `┃` lines, ending in its agent line;
        // above that, its lines are blank but for the placeholder.
        box: `${TMUX} capture-pane -p ${target} | awk '
  { sub(/^[ \\t]+/, "") }
  /^┃/ { if (!run) start=NR; run=1; line[NR]=$0; if ($0 ~ /^┃  [^ ].* · /) agent=NR; next }
  { run=0 }
  END { if (!agent) exit 2;
    for (i=start+1; i<agent-1; i++) { t=line[i]; sub(/^┃ */, "", t);
      if (t ~ /^[ \\t]*$/) continue;
      if (i==start+1 && agent-start==3 && (t ~ /^Ask anything… "/ || t ~ /^Run a command… "/)) continue;
      exit 1 }
    exit 0 }'`,
        prepare: 'sf="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/prompt-stash.jsonl"; pushed=0',
        stash: 'sum=$(cat "$sf" 2>/dev/null | cksum); '
          + `keys ${OPENCODE_TUI_KEYBINDS['prompt.stash']} && wait_box 0 `
          + '&& [ "$(cat "$sf" 2>/dev/null | cksum)" != "$sum" ] && pushed=1 || fail 5 "opencode did not stash its user\'s draft"',
        finish: `[ $pushed = 1 ] && wait_box 0 && keys ${OPENCODE_TUI_KEYBINDS['prompt.stash.pop']}`,
        unstash: `[ $pushed = 1 ] && keys ${OPENCODE_TUI_KEYBINDS['prompt.stash.pop']}`,
      }
  }
}

/**
 * Keys yaac's opencode launch binds (`OPENCODE_CLI_CONFIG_CONTENT`) to its
 * prompt stash, which ships unbound, for `buildMessageCmd`. tmux reads key
 * names in any case, so the same names serve `send-keys`.
 */
export const OPENCODE_TUI_KEYBINDS = { 'prompt.stash': 'f9', 'prompt.stash.pop': 'f10' } as const

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

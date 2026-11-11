/**
 * Pure builders for what a workspace runs to log its terminals and run its
 * steps (docs/workspace-steps.md). The server writes the files they produce
 * into the life's log dir, which the workspace sees at
 * `WorkspacePaths.terminalLogDir`, so no command text nests a script inside
 * shell and tmux quoting.
 */
import { pipeToLogCommand, tmuxCmd } from '#runtime/agents'
import { shellQuote } from '#lib/shell'
import type { WorkspacePaths } from '#drivers/contract'
import { AGENT_TOOLS } from '@yaac/shared/types'
import type { StepSpec } from '@yaac/shared/steps'

/** The window option a service's ready check sets once it passes. */
export const STEP_READY_OPTION = '@yaac-step-ready'

/**
 * The tmux config a life sources: where its logs go, a hook that pipes
 * every new window but a session's into the log writer (an `acp` session's
 * window is piped as it opens, by `buildWindowsExec`), and one that
 * renames a window whose pane died to its own name. The rename sends
 * control clients a `%window-renamed`, so the status watcher re-lists at
 * once and sees the exit status of a step, which no other notification
 * reports. A step's window holds a `.`, which no session's does, so a
 * workflow named after a tool is still logged.
 */
export function lifeHooksConfig(paths: WorkspacePaths, logDir: string): string {
  const tool = AGENT_TOOLS.map((t) => `#{m:${t}-*,#{window_name}}`)
    .reduce((acc, m) => `#{||:${acc},${m}}`)
  const session = `#{?#{m:*.*,#{window_name}},0,${tool}}`
  return [
    `set-option -g @yaac-log-dir "${logDir}"`,
    'set-hook -g after-new-window {',
    `  if-shell -F "${session}" {} {`,
    `    ${pipeToLogCommand()}`,
    '  }',
    '}',
    'set-hook -g pane-died {',
    `  run-shell "${tmuxCmd(paths)} rename-window -t '#{hook_pane}' '#{window_name}'"`,
    '}',
    '',
  ].join('\n')
}

/** The command that sources a life's hooks config, at its in-workspace
 *  path. */
export function sourceHooksCommand(paths: WorkspacePaths, configPath: string): string {
  return `${tmuxCmd(paths)} source-file ${shellQuote(configPath)}`
}

/**
 * A step's script. Its first act keeps its pane when it exits
 * (`remain-on-exit`), which is how the exit status is read, set on its own
 * pane since a step's name cannot target its window. Its commands run in
 * order in one shell, stopping at the first failure, whose status the
 * script exits with. The shell is the workspace's `$SHELL` when that is a
 * POSIX-family one, as init commands always ran in (zsh reads
 * `~/.zshenv`, which shims a PATH), else bash, else sh. It starts in `cwd`,
 * else the workspace's default cwd. Around each command it appends
 * `start <i> <time>` and `end <i> <status> <time>` to the events file, the
 * end from an EXIT trap too, so a command that exits the script still
 * closes its own. A service starts its ready check in the background just
 * before its last command, and the check sets `STEP_READY_OPTION` on the
 * window and renames it to itself so the watcher re-lists. `env` holds
 * `NAME=VALUE` entries exported for this step alone.
 */
export function stepScript(
  name: string,
  spec: StepSpec,
  eventsPath: string,
  env: string[] = [],
  cwd?: string,
): string {
  const relist = `tmux rename-window -t "$TMUX_PANE" ${shellQuote(name)}`
  const ready = `tmux set-option -w -t "$TMUX_PANE" ${STEP_READY_OPTION} 1; ${relist}`
  const last = spec.run.length - 1
  const lines = [
    `# yaac step ${JSON.stringify(name)}, written by the server (docs/workspace-steps.md).`,
    'if [ -z "${YAAC_STEP_SHELL:-}" ]; then',
    '  tmux set-option -w -t "$TMUX_PANE" remain-on-exit on',
    '  export YAAC_STEP_SHELL=1',
    '  case "${SHELL##*/}" in bash|zsh|sh|dash|ksh) exec "$SHELL" "$0" ;; esac',
    '  ! command -v bash >/dev/null 2>&1 || exec bash "$0"',
    'fi',
    'unset YAAC_STEP_SHELL',
    ...env.map((entry) => {
      const at = entry.indexOf('=')
      return `export ${entry.slice(0, at)}=${shellQuote(entry.slice(at + 1))}`
    }),
    // The workspace's default cwd is the one its tmux session started in.
    cwd !== undefined ? `cd ${shellQuote(cwd)} || exit 1` : 'cd "$(tmux display-message -p \'#{session_path}\')" || exit 1',
    `yaac_mark() { printf '%s %s\\n' "$*" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ${shellQuote(eventsPath)}; }`,
    'yaac_i=; yaac_probe=',
    'trap \'yaac_rc=$?; [ -z "$yaac_i" ] || yaac_mark end "$yaac_i" "$yaac_rc"; [ -z "$yaac_probe" ] || kill "$yaac_probe" 2>/dev/null\' EXIT',
  ]
  spec.run.forEach((command, i) => {
    if (spec.service === true && i === last) {
      lines.push(spec.ready === undefined
        ? `{ ${ready}; } >/dev/null 2>&1`
        : `( until ${spec.ready}\ndo sleep 2; done; ${ready} ) >/dev/null 2>&1 &\nyaac_probe=$!`)
    }
    lines.push(`yaac_i=${i}; yaac_mark start ${i}`, command,
      `yaac_rc=$?; yaac_i=; yaac_mark end ${i} $yaac_rc; [ $yaac_rc -eq 0 ] || exit $yaac_rc`)
  })
  return `${lines.join('\n')}\n`
}

/** Kill every window of the yaac session named `name`, found by name in
 *  the window listing and killed by id, since a step's name cannot target
 *  its window (`windowTarget`). */
function killWindowsNamed(tmux: string, name: string): string {
  return `for w in $(${tmux} list-windows -t =yaac -F '#{window_id} #{window_name}' 2>/dev/null `
    + `| awk -v n=${shellQuote(name)} '{ id = $1; sub(/^[^ ]* /, ""); if ($0 == n) print id }'); `
    + `do ${tmux} kill-window -t "$w" 2>/dev/null; done`
}

/** Open a step's window running its script, after killing any window of
 *  its name (a rerun's dead one). */
export function stepWindowExec(name: string, paths: WorkspacePaths, scriptPath: string): string {
  const tmux = tmuxCmd(paths)
  return `${killWindowsNamed(tmux, name)}; `
    + `${tmux} new-window -d -t yaac -n ${shellQuote(name)} -c '#{session_path}' ${shellQuote(`sh ${shellQuote(scriptPath)}`)}`
}

/** Kill a step's window, if it has one. */
export function killStepWindowExec(name: string, paths: WorkspacePaths): string {
  return `${killWindowsNamed(tmuxCmd(paths), name)}; true`
}

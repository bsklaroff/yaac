/**
 * Pure builders for what a workspace runs to log its terminals and run its
 * steps (docs/workspace-steps.md). The server writes the files they produce
 * into the life's log dir, which the workspace sees at
 * `WorkspacePaths.terminalLogDir`, so no command text nests a script inside
 * shell and tmux quoting.
 */
import { pipeToLogCommand, tmuxCmd, windowTarget } from '#runtime/agents'
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
 * reports.
 */
export function lifeHooksConfig(paths: WorkspacePaths, logDir: string): string {
  const session = AGENT_TOOLS.map((t) => `#{m:${t}-*,#{window_name}}`)
    .reduce((acc, m) => `#{||:${acc},${m}}`)
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
 * A step's script. Its commands run in order in one shell, stopping at the
 * first failure, whose status the script exits with. The shell is the
 * workspace's `$SHELL` when that is a POSIX-family one, as init commands
 * always ran in (zsh reads `~/.zshenv`, which shims a PATH), else bash,
 * else sh. Around each command it appends `start <i> <time>` and
 * `end <i> <status> <time>` to the events file, the end from an EXIT trap
 * too, so a command that exits the script still closes its own. A service
 * starts its ready check in the background just before its last command,
 * and the check sets `STEP_READY_OPTION` on the window and renames it to
 * itself so the watcher re-lists. `env` holds `NAME=VALUE` entries
 * exported for this step alone.
 */
export function stepScript(
  name: string,
  spec: StepSpec,
  paths: WorkspacePaths,
  eventsPath: string,
  env: string[] = [],
): string {
  const relist = `tmux rename-window -t "$TMUX_PANE" ${shellQuote(name)}`
  const ready = `tmux set-option -w -t "$TMUX_PANE" ${STEP_READY_OPTION} 1; ${relist}`
  const last = spec.run.length - 1
  const lines = [
    `# yaac step ${JSON.stringify(name)}, written by the server (docs/workspace-steps.md).`,
    'if [ -z "${YAAC_STEP_SHELL:-}" ]; then',
    '  export YAAC_STEP_SHELL=1',
    '  case "${SHELL##*/}" in bash|zsh|sh|dash|ksh) exec "$SHELL" "$0" ;; esac',
    '  ! command -v bash >/dev/null 2>&1 || exec bash "$0"',
    'fi',
    'unset YAAC_STEP_SHELL',
    ...env.map((entry) => {
      const at = entry.indexOf('=')
      return `export ${entry.slice(0, at)}=${shellQuote(entry.slice(at + 1))}`
    }),
    `cd ${shellQuote(paths.workspaceDir)} || exit 1`,
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

/**
 * Open a step's window running its script, after killing any window of its
 * name (a rerun's dead one). The window keeps its pane when the script
 * exits, which is how its exit status is read.
 */
export function stepWindowExec(name: string, paths: WorkspacePaths, scriptPath: string): string {
  const tmux = tmuxCmd(paths)
  const target = windowTarget(name)
  return `${tmux} kill-window -t ${target} 2>/dev/null; `
    + `${tmux} new-window -d -t yaac -n ${shellQuote(name)} -c ${shellQuote(paths.workspaceDir)} `
    + `${shellQuote(`sh ${shellQuote(scriptPath)}`)} \\; set-option -t ${target} remain-on-exit on`
}

/** Kill a step's window, if it has one. */
export function killStepWindowExec(name: string, paths: WorkspacePaths): string {
  return `${tmuxCmd(paths)} kill-window -t ${windowTarget(name)} 2>/dev/null || true`
}

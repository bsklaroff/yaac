import { WorkspaceExecError } from '#drivers/contract'
import { workspaceDriver } from '#drivers/driver'
import { tmuxCmd } from '#runtime/agents'
import type { WorkspaceTerminalEntry } from '@yaac/shared/types'

/**
 * Manage a workspace's webapp terminals: the windows of its `yaac` tmux
 * session that run no session. Kills refuse the keeper window, which holds
 * the tmux server open (`KEEPER_WINDOW`); a session's window is closed by
 * closing its session. Scratch shells ('shell', 'shell-2', …) are ordinary
 * windows created on demand.
 */

const WINDOW_ID = /^@\d{1,6}$/
const CREATED = /^(@\d{1,6}) (shell(?:-\d{1,4})?)$/
/** Exit codes of the kill script's refusals. */
const KILL_BLIND = 90
const KILL_KEEPER = 91

/**
 * Create a scratch-shell window under the first free name (shell, shell-2,
 * shell-3, …) and return its entry, so the caller knows which pane to focus.
 * One script picks the name and creates the window, since each exec is a
 * round trip into the workspace (under k8s, a connection through the
 * apiserver).
 */
export async function createShellWindow(jobName: string): Promise<WorkspaceTerminalEntry> {
  const driver = workspaceDriver()
  const paths = driver.workspacePaths(jobName)
  const tmux = tmuxCmd(paths)
  const { stdout } = await driver.exec(
    jobName,
    `names=$(${tmux} list-windows -t yaac -F '#{window_name}'); n=shell; i=2; `
    + `while printf '%s\\n' "$names" | grep -qxF "$n"; do n=shell-$i; i=$((i+1)); done; `
    + `${tmux} new-window -d -P -F '#{window_id} #{window_name}' -t yaac -n "$n" -c ${paths.workspaceDir}`,
    { maxAttempts: 1 },
  )
  const m = CREATED.exec(stdout.trim())
  if (!m) throw new Error(`new-window returned no window id: ${stdout}`)
  return { target: `window:${m[1]}`, name: m[2] }
}

/**
 * Kill a window and what runs in it. The keeper (the first listed) is
 * refused: as the last window, killing it would end the whole tmux session,
 * which then gets reaped as a zombie. The check runs in the same script as
 * the kill, for the round trip `createShellWindow` saves.
 */
export async function killWindowTerminal(jobName: string, target: string): Promise<void> {
  const id = target.startsWith('window:') ? target.slice('window:'.length) : ''
  if (!WINDOW_ID.test(id)) throw new Error(`not a window target: ${target}`)
  const driver = workspaceDriver()
  const tmux = tmuxCmd(driver.workspacePaths(jobName))
  try {
    await driver.exec(
      jobName,
      `a=$(${tmux} list-windows -t yaac -F '#{window_id}' | head -n 1); `
      + `[ -n "$a" ] || exit ${KILL_BLIND}; [ "$a" != ${id} ] || exit ${KILL_KEEPER}; `
      + `${tmux} kill-window -t ${id}`,
      { maxAttempts: 1 },
    )
  } catch (err) {
    if (err instanceof WorkspaceExecError && err.code === KILL_BLIND) {
      throw new Error('no yaac windows listed; refusing to kill blind', { cause: err })
    }
    if (err instanceof WorkspaceExecError && err.code === KILL_KEEPER) {
      throw new Error('refusing to kill the keeper window', { cause: err })
    }
    throw err
  }
}

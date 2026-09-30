import { workspaceDriver } from '#drivers/driver'
import { tmuxCmd } from '#runtime/agents'
import { workspaceControlStreamSend } from '#runtime/status'
import type { WorkspaceTerminalEntry } from '@yaac/shared/types'

/**
 * List and manage a workspace's webapp terminals: the windows of its `yaac`
 * tmux session. The lowest-index window is the agent, reached through the
 * 'agent' target, so listings skip it and kills refuse it. Scratch shells
 * ('shell', 'shell-2', …) are ordinary windows created on demand.
 */

/** The name stays last — it may contain pipes. */
const WINDOW_FORMAT = "'#{window_index}|#{window_id}|#{window_name}'"
const WINDOW_LINE = /^(\d+)\|(@\d+)\|(.*)$/
const WINDOW_ID = /^@\d{1,6}$/
const SHELL_NAME = /^shell(?:-\d{1,4})?$/

interface WindowRow {
  index: number
  id: string
  name: string
}

function parseWindows(stdout: string): WindowRow[] {
  const rows: WindowRow[] = []
  for (const line of stdout.split('\n')) {
    const m = WINDOW_LINE.exec(line.trim())
    if (m) rows.push({ index: Number(m[1]), id: m[2], name: m[3] })
  }
  return rows
}

/** Parse the window listing into webapp terminal entries — every window
 *  except the agent's (lowest index). */
function parseWindowList(stdout: string): WorkspaceTerminalEntry[] {
  const rows = parseWindows(stdout)
  if (rows.length === 0) return []
  const agentIndex = Math.min(...rows.map((r) => r.index))
  return rows
    .filter((r) => r.index !== agentIndex)
    .map((r) => ({ target: `window:${r.id}`, name: r.name }))
}

/** Next free scratch-shell window name: shell, shell-2, shell-3, … */
function nextShellName(existing: WorkspaceTerminalEntry[]): string {
  const names = new Set(existing.filter((e) => SHELL_NAME.test(e.name)).map((e) => e.name))
  if (!names.has('shell')) return 'shell'
  for (let i = 2; ; i++) {
    if (!names.has(`shell-${i}`)) return `shell-${i}`
  }
}

/**
 * Run a read-only tmux command, preferring the status watcher's control-mode
 * stream and falling back to a one-shot exec when no stream is up (spares,
 * mid-respawn) or the send fails. Mutating commands must not use this: the
 * watcher's client is read-only and tmux refuses them.
 */
async function tmuxOut(jobName: string, tmuxArgs: string): Promise<string> {
  const send = workspaceControlStreamSend(jobName)
  if (send) {
    try {
      return await send(tmuxArgs)
    } catch {
      // The stream just died (the watcher will respawn it); use the one-shot
      // path.
    }
  }
  try {
    const driver = workspaceDriver()
    const { stdout } = await driver.exec(
      jobName,
      `${tmuxCmd(driver.workspacePaths(jobName))} ${tmuxArgs}`,
      { maxAttempts: 1 },
    )
    return stdout
  } catch {
    return ''
  }
}

/** List a workspace's webapp-attachable terminals. */
export async function listWorkspaceTerminals(jobName: string): Promise<WorkspaceTerminalEntry[]> {
  return parseWindowList(await tmuxOut(jobName, `list-windows -t yaac -F ${WINDOW_FORMAT}`))
}

/** Create a scratch-shell window and return its entry. `-P -F` prints the
 *  new window's id, so the caller can attach without waiting for the next
 *  terminals poll. */
export async function createShellWindow(jobName: string): Promise<WorkspaceTerminalEntry> {
  const name = nextShellName(await listWorkspaceTerminals(jobName))
  const driver = workspaceDriver()
  const paths = driver.workspacePaths(jobName)
  const { stdout } = await driver.exec(
    jobName,
    `${tmuxCmd(paths)} new-window -d -P -F '#{window_id}' -t yaac -n ${name} `
    + `-c ${paths.workspaceDir}`,
    { maxAttempts: 1 },
  )
  const id = stdout.trim()
  if (!WINDOW_ID.test(id)) throw new Error(`new-window returned no window id: ${stdout}`)
  return { target: `window:${id}`, name }
}

/** Kill a window and what runs in it. The agent window is refused: killing
 *  it stops the agent (and, as the last window, the whole tmux session,
 *  which then gets reaped as a zombie). */
export async function killWindowTerminal(jobName: string, target: string): Promise<void> {
  const id = target.startsWith('window:') ? target.slice('window:'.length) : ''
  if (!WINDOW_ID.test(id)) throw new Error(`not a window target: ${target}`)
  const rows = parseWindows(await tmuxOut(jobName, `list-windows -t yaac -F ${WINDOW_FORMAT}`))
  if (rows.length === 0) throw new Error('no yaac windows listed; refusing to kill blind')
  const agentIndex = Math.min(...rows.map((r) => r.index))
  if (rows.find((r) => r.index === agentIndex)?.id === id) {
    throw new Error('refusing to kill the agent window')
  }
  const driver = workspaceDriver()
  await driver.exec(
    jobName,
    `${tmuxCmd(driver.workspacePaths(jobName))} kill-window -t ${id}`,
    { maxAttempts: 1 },
  )
}

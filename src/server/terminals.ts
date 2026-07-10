import { containerExec } from '@/lib/k8s/exec'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
import type { SessionTerminalEntry } from '@/shared/types'

/**
 * Enumerate and manage the terminals a session's pod offers the webapp —
 * the windows of the `yaac` tmux session. The first (lowest-index) window
 * is the agent itself: it's covered by the dedicated 'agent' target, so
 * listings skip it and kills refuse it. Scratch shells are plain windows
 * too ('shell', 'shell-2', …), created on demand — there are no separate
 * shell tmux sessions.
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
export function parseWindowList(stdout: string): SessionTerminalEntry[] {
  const rows = parseWindows(stdout)
  if (rows.length === 0) return []
  const agentIndex = Math.min(...rows.map((r) => r.index))
  return rows
    .filter((r) => r.index !== agentIndex)
    .map((r) => ({ target: `window:${r.id}`, name: r.name }))
}

/** Next free scratch-shell window name: shell, shell-2, shell-3, … */
export function nextShellName(existing: SessionTerminalEntry[]): string {
  const names = new Set(existing.filter((e) => SHELL_NAME.test(e.name)).map((e) => e.name))
  if (!names.has('shell')) return 'shell'
  for (let i = 2; ; i++) {
    if (!names.has(`shell-${i}`)) return `shell-${i}`
  }
}

async function tmuxOut(jobName: string, tmuxArgs: string): Promise<string> {
  try {
    const { stdout } = await containerExec(
      jobName,
      `tmux -S ${CONTAINER_TMUX_SOCK} ${tmuxArgs}`,
      { maxAttempts: 1 },
    )
    return stdout
  } catch {
    return ''
  }
}

/** List a session's webapp-attachable terminals. */
export async function listSessionTerminals(jobName: string): Promise<SessionTerminalEntry[]> {
  return parseWindowList(await tmuxOut(jobName, `list-windows -t yaac -F ${WINDOW_FORMAT}`))
}

/** Create a scratch-shell window in the `yaac` session and return its
 *  entry. `-P -F` prints the new window's id, so the caller can attach
 *  (and open a pane) without waiting for the next terminals poll. */
export async function createShellWindow(jobName: string): Promise<SessionTerminalEntry> {
  const name = nextShellName(await listSessionTerminals(jobName))
  const { stdout } = await containerExec(
    jobName,
    `tmux -S ${CONTAINER_TMUX_SOCK} new-window -d -P -F '#{window_id}' -t yaac -n ${name} -c /workspace`,
    { maxAttempts: 1 },
  )
  const id = stdout.trim()
  if (!WINDOW_ID.test(id)) throw new Error(`new-window returned no window id: ${stdout}`)
  return { target: `window:${id}`, name }
}

/** Kill a window (and whatever runs in it). The agent window is refused —
 *  killing it would take down the agent (and, if it's the last window, the
 *  whole tmux session, reaping the session as a zombie). */
export async function killWindowTerminal(jobName: string, target: string): Promise<void> {
  const id = target.startsWith('window:') ? target.slice('window:'.length) : ''
  if (!WINDOW_ID.test(id)) throw new Error(`not a window target: ${target}`)
  const rows = parseWindows(await tmuxOut(jobName, `list-windows -t yaac -F ${WINDOW_FORMAT}`))
  if (rows.length === 0) throw new Error('no yaac windows listed; refusing to kill blind')
  const agentIndex = Math.min(...rows.map((r) => r.index))
  if (rows.find((r) => r.index === agentIndex)?.id === id) {
    throw new Error('refusing to kill the agent window')
  }
  await containerExec(
    jobName,
    `tmux -S ${CONTAINER_TMUX_SOCK} kill-window -t ${id}`,
    { maxAttempts: 1 },
  )
}

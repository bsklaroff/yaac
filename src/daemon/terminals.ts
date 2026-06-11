import { containerExec } from '@/lib/k8s/exec'
import { CONTAINER_TMUX_SOCK } from '@/shared/paths'
import type { SessionTerminalEntry } from '@/shared/types'

/**
 * Enumerate the terminals a session's pod offers the webapp:
 *  - the extra windows of the `yaac` tmux session (initCommands dev servers,
 *    watchers, …) — the first window is the agent itself and is covered by
 *    the dedicated 'agent' target, so it's skipped here;
 *  - the scratch-shell tmux sessions ('shell', 'shell-2', …).
 */

const WINDOW_LINE = /^(\d+)\|(@\d+)\|(.*)$/
const SHELL_SESSION = /^shell(?:-[0-9]{1,4})?$/

/** Parse `list-windows -F '#{window_index}|#{window_id}|#{window_name}'`. */
export function parseWindowList(stdout: string): SessionTerminalEntry[] {
  const entries: Array<{ index: number; id: string; name: string }> = []
  for (const line of stdout.split('\n')) {
    const m = WINDOW_LINE.exec(line.trim())
    if (m) entries.push({ index: Number(m[1]), id: m[2], name: m[3] })
  }
  if (entries.length === 0) return []
  const agentIndex = Math.min(...entries.map((e) => e.index))
  return entries
    .filter((e) => e.index !== agentIndex)
    .map((e) => ({ target: `window:${e.id}`, name: e.name, kind: 'window' as const }))
}

/** Parse `list-sessions -F '#{session_name}'`, keeping only scratch shells. */
export function parseShellSessions(stdout: string): SessionTerminalEntry[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((name) => SHELL_SESSION.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => ({ target: `shell:${name}`, name, kind: 'shell' as const }))
}

/** Next free scratch-shell name: shell, shell-2, shell-3, … */
export function nextShellName(existing: SessionTerminalEntry[]): string {
  const names = new Set(existing.filter((e) => e.kind === 'shell').map((e) => e.name))
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

/** List a session's webapp-attachable terminals (windows + shells). */
export async function listSessionTerminals(jobName: string): Promise<SessionTerminalEntry[]> {
  const [windows, sessions] = await Promise.all([
    tmuxOut(jobName, "list-windows -t yaac -F '#{window_index}|#{window_id}|#{window_name}'"),
    tmuxOut(jobName, "list-sessions -F '#{session_name}'"),
  ])
  return [...parseWindowList(windows), ...parseShellSessions(sessions)]
}

/** Kill a scratch-shell tmux session. Only shell targets are killable. */
export async function killShellTerminal(jobName: string, target: string): Promise<void> {
  const name = target.startsWith('shell:') ? target.slice('shell:'.length) : ''
  if (!SHELL_SESSION.test(name)) throw new Error(`not a shell target: ${target}`)
  await containerExec(
    jobName,
    `tmux -S ${CONTAINER_TMUX_SOCK} kill-session -t ${name}`,
    { maxAttempts: 1 },
  )
}

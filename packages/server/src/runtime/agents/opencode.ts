import { worktreeDriver } from '#drivers/driver'
import type { PermissionMode } from '@yaac/shared/types'

/**
 * Status markers + first-message lookup for opencode sessions.
 *
 * Status is read from the rendered tmux pane (window `yaac:opencode.0`),
 * not from opencode's server: its session state stays busy while opencode
 * is paused on a tool-permission prompt or a question-tool prompt — both
 * states where yaac should report `waiting` — and the pane carries an
 * unambiguous marker for each. The busy/idle classification runs *inside
 * tmux*: the session's status watcher (`#runtime/status`) subscribes to a
 * format built from `OPENCODE_BUSY_MARKERS`, so only the resolved word
 * crosses the control-mode stream — the rendered pane never does.
 *
 * First-message lookup asks opencode itself: `opencode api` over a private
 * server on the same per-worktree data dir (`--standalone`, as the TUI runs
 * — its server is a child on stdio, so there is no port to ask), from the
 * checkout, which is what scopes `session.list` to this worktree's project.
 * opencode titles a session off its opening prompt, and that title is what
 * the TUI's own switcher displays — using it here keeps the two views
 * consistent. It runs once per session (the capture step persists the
 * result on the session row), so it needs no cache of its own.
 */

/** A private server has to come up first, which is most of the wait. */
const PROBE_TIMEOUT_MS = 15_000

interface OpencodeSessionRow {
  id: string
  title?: string
  parentID?: string
  time?: { created?: number; updated?: number }
}

/**
 * The busy footer: a `⬝⬝⬝⬝■■■■` progress strip beside `esc interrupt` (or
 * `esc again to interrupt` once armed).
 */
export const OPENCODE_BUSY_MARKERS: readonly string[] = [
  'esc\\s+(again\\s+to\\s+)?interrupt',
  '[■⬝][■⬝][■⬝][■⬝]',
]

async function probeOpencode(jobName: string): Promise<OpencodeSessionRow[] | null> {
  let stdout: string
  try {
    ({ stdout } = await worktreeDriver().exec(
      jobName,
      'opencode api --standalone session.list',
      { maxAttempts: 2, timeout: PROBE_TIMEOUT_MS },
    ))
  } catch {
    return null
  }
  try {
    const { data } = JSON.parse(stdout.trim()) as { data?: unknown }
    return Array.isArray(data) ? data as OpencodeSessionRow[] : null
  } catch {
    return null
  }
}

/**
 * "This worktree's" session. With the per-worktree data dir there is only
 * ever one root (plus forks, which carry a parentID), but the newest root is
 * still picked defensively.
 */
export function pickOpencodeSession(sessions: OpencodeSessionRow[]): OpencodeSessionRow | undefined {
  const roots = sessions.filter((s) => !s.parentID)
  const candidates = roots.length > 0 ? roots : sessions
  return [...candidates].sort(
    (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
  )[0]
}

/**
 * First user message for an opencode session — its title, probed once:
 * opencode keeps its history in a per-worktree sqlite DB and leaves no host
 * transcript, and the capture step persists the result on the session row,
 * which is what deleted-session listings and restarts read afterwards.
 */
export async function getSessionOpencodeFirstUserMessage(
  jobName: string,
): Promise<string | undefined> {
  const sessions = await probeOpencode(jobName)
  return sessions ? pickOpencodeSession(sessions)?.title : undefined
}

/**
 * The posture an opencode agent switch adds up to, read against the posture
 * the worktree runs under now.
 *
 * opencode's in-TUI switch is between its agents, and an agent is only half a
 * posture: the permission rules ride the launch config, which no switch
 * changes. `plan` launches the plan agent over the same ask-to-act rules
 * `manual` has, so those two are one switch apart in either direction; `build`
 * under any other posture is that posture. The plan agent over a looser
 * posture's rules is no posture yaac has, and neither is an agent of a
 * project's own — both are left unrecorded.
 *
 * `current` stands in for the launch: an opencode worktree's posture only ever
 * moves between `plan` and `manual`, whose rules are the same, so the two
 * always agree on the rules the running process has.
 */
export function opencodePermissionMode(agent: string, current: PermissionMode): PermissionMode | undefined {
  const askToAct = current === 'plan' || current === 'manual'
  if (agent === 'build') return askToAct ? 'manual' : current
  if (agent === 'plan') return askToAct ? 'plan' : undefined
  return undefined
}

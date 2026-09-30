import { workspaceDriver } from '#drivers/driver'
import type { PermissionMode } from '@yaac/shared/types'

/**
 * Status markers and first-message lookup for opencode.
 *
 * Status is read from the rendered pane, not opencode's server, whose
 * session state stays busy during a permission or question prompt (which
 * yaac reports as `waiting`). The classification runs inside tmux: the
 * status watcher subscribes to a format built from `OPENCODE_BUSY_MARKERS`,
 * so only the resolved word crosses the control-mode stream.
 *
 * The first message comes from opencode itself: `opencode api` over a
 * private `--standalone` server on the same per-workspace data dir, run from
 * the checkout to scope it to this project. It returns the session title
 * (derived from the opening prompt, as the TUI's switcher shows). It runs
 * once per session; the result is stored on the session row.
 */

/** Mostly the time for a private server to start. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * The busy footer: a `⬝⬝⬝⬝■■■■` progress strip beside `esc interrupt` (or
 * `esc again to interrupt` once armed).
 */
export const OPENCODE_BUSY_MARKERS: readonly string[] = [
  'esc\\s+(again\\s+to\\s+)?interrupt',
  '[■⬝][■⬝][■⬝][■⬝]',
]

/** opencode's own session ids, as its plugin reports them on the pane. */
const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]+$/

/**
 * An opencode session's first message (its title), probed once. opencode
 * keeps history in a per-workspace sqlite DB, not a host transcript; the
 * result is stored on the session row for later listings and restarts.
 *
 * Only an id opencode minted is looked up; anything else (such as the
 * workspace-id placeholder a create records first) yields no title. The id
 * pattern is also the shell-safety check. An exec failure (`session.get`
 * exits 1 for an unknown id) or an untitled session also yields none.
 */
export async function getSessionOpencodeFirstUserMessage(
  jobName: string,
  agentSessionId?: string,
): Promise<string | undefined> {
  if (agentSessionId === undefined || !OPENCODE_SESSION_ID.test(agentSessionId)) return undefined
  try {
    const { stdout } = await workspaceDriver().exec(
      jobName,
      `opencode api --standalone session.get --param sessionID=${agentSessionId}`,
      { maxAttempts: 2, timeout: PROBE_TIMEOUT_MS },
    )
    const { data } = JSON.parse(stdout.trim()) as { data?: { title?: unknown } }
    return typeof data?.title === 'string' ? data.title : undefined
  } catch {
    return undefined
  }
}

/**
 * The posture an opencode agent switch amounts to, given the workspace's
 * current posture. A switch changes only the agent; the permission rules
 * come from the launch config. `plan` and `manual` share the ask-to-act
 * rules, so switching between the plan and build agents moves between
 * them; `build` under any other posture is that posture. Other combinations
 * (plan over looser rules, a project's own agents) map to nothing.
 *
 * `current` stands in for the launch posture: it only ever moves between
 * `plan` and `manual`, which share rules.
 */
export function opencodePermissionMode(agent: string, current: PermissionMode): PermissionMode | undefined {
  const askToAct = current === 'plan' || current === 'manual'
  if (agent === 'build') return askToAct ? 'manual' : current
  if (agent === 'plan') return askToAct ? 'plan' : undefined
  return undefined
}

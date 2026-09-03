import fs from 'node:fs/promises'
import path from 'node:path'
import { worktreeDriver } from '#drivers/driver'
import type { PermissionMode } from '@yaac/shared/types'

/**
 * Status markers + first-message lookup for opencode sessions.
 *
 * Status is read from the rendered tmux pane (window `yaac:opencode.0`),
 * not opencode's `/session/status` HTTP endpoint. The HTTP `type` field
 * (`idle` | `busy` | `retry`) stays at `busy` while opencode is paused on
 * a tool-permission prompt or a question-tool prompt — both states where
 * yaac should report `waiting`. The pane carries unambiguous markers for
 * each. The busy/idle classification runs *inside tmux*: the session's
 * status watcher (`#runtime/status`) subscribes to a format
 * built from `OPENCODE_BUSY_MARKERS`, so only the resolved word crosses
 * the control-mode stream — the rendered pane never does.
 *
 * First-message lookup still goes through the HTTP server: opencode
 * auto-populates `session.title` from the first user prompt, which is
 * what the TUI's own switcher displays — using it here keeps the two
 * views consistent. It runs once per session (the capture step persists
 * the result on the session row), so it needs no cache of its own.
 */

const PROBE_TIMEOUT_MS = 3000

interface OpencodeProbe {
  sessions: OpencodeSessionRow[]
}

interface OpencodeSessionRow {
  id: string
  title?: string
  directory?: string
  parentID?: string
  time?: { created?: number; updated?: number }
}

/**
 * opencode's approval posture is config, not flags, and it is the same
 * config in both agent modes — the TUI and `opencode acp` read the same
 * variable, so one table answers for both. `OPENCODE_PERMISSION`
 * takes the same JSON as the config file's `permission` block and is read per
 * process, which is what makes it per-worktree — the `opencode.json` session
 * create writes is shared by every worktree in the project.
 *
 * **Every posture is stated in full, and only in keys opencode actually
 * has.** Its permission config is a plain zod object over exactly `edit`,
 * `bash`, `webfetch`, `doom_loop` and `external_directory` — no top-level
 * wildcard — and a plain zod object *strips* what it does not know. An
 * unrecognized key is therefore not a partial posture but an empty one, which
 * `mergeAgentPermissions` then fills with `edit: allow`, `webfetch: allow`,
 * `bash: {"*": "allow"}`. A posture spelled wrong here does not fail: it runs
 * unrestrained, silently, on a containerless worktree's real filesystem.
 *
 * That is also why `bypass` states allow-everything rather than passing no
 * config at all. Inheriting opencode's near-permissive defaults happens to
 * land in the right place today, but `doom_loop` and `external_directory`
 * already default to `ask`, and a future default that tightens would quietly
 * stop meaning bypass with nothing to signal it.
 */
const OPENCODE_PERMISSION_RULES: Partial<Record<PermissionMode, Record<string, string>>> = {
  bypass: {
    edit: 'allow', bash: 'allow', webfetch: 'allow',
    doom_loop: 'allow', external_directory: 'allow',
  },
  // The two left at opencode's own `ask` default are the point of the mode:
  // edits inside the worktree land unprompted, stepping outside it does not.
  'accept-edits': { edit: 'allow', bash: 'ask', webfetch: 'allow' },
  manual: {
    edit: 'ask', bash: 'ask', webfetch: 'ask',
    doom_loop: 'ask', external_directory: 'ask',
  },
}

/**
 * The permission rules for a posture, or undefined for one opencode expresses
 * some other way — `plan`, which is one of its own AGENTS (`--agent plan` for
 * the TUI, the `plan` session mode over ACP) whose rules are stronger than
 * anything worth restating: `edit: deny` plus a curated read-only bash
 * allowlist. Stating rules here as well would not add a floor under it, it
 * would REPLACE it: opencode merges the user's `permission` config over the
 * agent's own, so an all-ask block would turn plan's `edit: deny` into
 * `edit: ask` — a weaker plan mode, arrived at by trying to harden it.
 */
export function opencodePermissionRules(
  mode: PermissionMode,
): Record<string, string> | undefined {
  return OPENCODE_PERMISSION_RULES[mode]
}

export const OPENCODE_BUSY_MARKERS: readonly string[] = [
  'esc\\s+(again\\s+to\\s+)?interrupt',
  '[■⬝][■⬝][■⬝][■⬝]',
]

async function probeOpencode(jobName: string): Promise<OpencodeProbe | null> {
  // One relay exec → curl /session. -sf suppresses output on curl
  // failure (HTTP server not up yet, etc.); we then see empty/non-JSON
  // below and return null.
  let stdout: string
  try {
    const result = await worktreeDriver().exec(
      jobName,
      'curl -sf http://127.0.0.1:4096/session',
      { maxAttempts: 2, timeout: PROBE_TIMEOUT_MS },
    )
    stdout = result.stdout
  } catch {
    return null
  }

  if (!stdout) return null
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (!Array.isArray(parsed)) return null
    return { sessions: parsed as OpencodeSessionRow[] }
  } catch {
    return null
  }
}

/**
 * Pick "this container's" session from the probe. With per-yaac-worktree
 * data dir isolation there should only ever be one (plus optional forks
 * with non-null parentID), but we still pick the most-recently-updated
 * root session defensively.
 */
export function pickOpencodeSession(probe: OpencodeProbe): OpencodeSessionRow | undefined {
  const roots = probe.sessions.filter((s) => !s.parentID)
  const candidates = roots.length > 0 ? roots : probe.sessions
  return [...candidates].sort(
    (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
  )[0]
}

/**
 * First user message for an opencode session. opencode auto-generates
 * `session.title` from the first prompt, which is what the TUI's own
 * session switcher displays — using it here keeps the two views in sync.
 *
 * Probe-only, and probe-once in practice: opencode keeps its history in a
 * per-session sqlite DB inside the container and leaves no host transcript,
 * so this is the only way to read it — and the capture step persists the
 * result on the session row, which is what deleted-session listings and
 * restarts read afterwards.
 */
export async function getSessionOpencodeFirstUserMessage(
  jobName: string,
): Promise<string | undefined> {
  const probe = await probeOpencode(jobName)
  const session = probe ? pickOpencodeSession(probe) : undefined
  return session?.title
}

// ---------------------------------------------------------------------------
// Config seeding
// ---------------------------------------------------------------------------

interface OpencodeConfig {
  permission?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Ensures the shared opencode.json grants the websearch permission so
 * opencode's Exa-backed websearch tool is usable. Merges with any
 * existing keys rather than overwriting — opencode itself writes to
 * this file via `Config.updateGlobal()` (model selection, etc.).
 *
 * The tool is also gated on `OPENCODE_ENABLE_EXA=true` in the
 * container env; without that env var the tool isn't registered no
 * matter what the permission says.
 */
export async function ensureOpencodeConfigJson(
  opencodeConfigDir: string,
): Promise<void> {
  const configPath = path.join(opencodeConfigDir, 'opencode.json')

  let config: OpencodeConfig = {}
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as OpencodeConfig
    }
  } catch {
    // No existing config or invalid — start fresh
  }

  const permission: Record<string, unknown> = config.permission ?? {}
  if (permission.websearch === 'allow') return

  permission.websearch = 'allow'
  config.permission = permission
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
}

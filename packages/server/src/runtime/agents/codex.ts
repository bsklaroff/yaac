import type { FileHandle } from 'node:fs/promises'
import { codexDir } from '@yaac/shared/project-paths'
import { scanJsonlForward } from './jsonl'
import { openSandboxDir, openSandboxFile, type SandboxFile } from './sandbox-fs'
import type { PermissionMode } from '@yaac/shared/types'

// ---------------------------------------------------------------------------
// Status + first-message
// ---------------------------------------------------------------------------

interface CodexEntry {
  type: string
  payload?: {
    type?: string
    message?: string
    item?: { type?: string; content?: Array<{ type?: string; text?: string }> }
  }
}

/**
 * A user turn's text: a `user_message` event, or (codex-cli 0.159.3) an
 * `item_completed` event with a `UserMessage` item. Never a user-role
 * `response_item`, which also carries injected bootstrap context
 * (AGENTS.md).
 */
function getUserMessageText(entry: CodexEntry): string | undefined {
  const p = entry.payload
  const text = p?.type === 'user_message'
    ? p.message
    : p?.type === 'item_completed' && p.item?.type === 'UserMessage'
      ? p.item.content?.find((c) => c.type === 'text')?.text
      : undefined
  return typeof text === 'string' && text.length > 0 ? text : undefined
}

/**
 * Classifies Codex's busy state from the pane's OSC title (like claude.ts).
 * The title is built from `CODEX_TITLE_ITEMS`: during a turn the activity
 * item shows a Braille spinner frame (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, within U+2800–U+28FF)
 * first, which disappears when the turn ends. When Codex blocks on an
 * approval the spinner is replaced by "[ ! ] Action Required", so every
 * user-blocked state reads as 'waiting' (verified against codex-cli
 * 0.142.4, codex-rs/tui/src/chatwidget/status_surfaces.rs).
 *
 * Before Codex sets a title the pane shows the hostname, which reads as
 * 'waiting'.
 */
const BRAILLE_SPINNER_PREFIX = /^[\u2800-\u28FF]/

export function classifyCodexTitle(title: string): 'running' | 'waiting' {
  return BRAILLE_SPINNER_PREFIX.test(title) ? 'running' : 'waiting'
}

/**
 * Reads the beginning of a Codex JSONL session log and returns the text of
 * the first user message, or undefined if none is found.
 */
export async function getCodexFirstUserMessage(file: SandboxFile): Promise<string | undefined> {
  return scanJsonlForward(file, (entry) => getUserMessageText(entry as CodexEntry))
}

/**
 * The items codex builds its title from: its default pair plus the model.
 * Idle reads `workspace | GPT-5.6-Sol`, a turn `⠙ workspace | GPT-5.6-Sol`,
 * and `/model` updates the last segment immediately (codex-cli 0.159.3).
 * This is codex's only model-change signal: no hook fires, and the rollout
 * does not exist before the first turn.
 *
 * `activity` must stay first for `classifyCodexTitle`, and `project-name`
 * must precede the model so `CODEX_MODEL_FORMAT` has a separator.
 */
export const CODEX_TITLE_ITEMS = ['activity', 'project-name', 'model'] as const

/**
 * `-c` settings that trust the repository root (codex keys folder trust on
 * it), skip the startup update check, and keep codex from starting its
 * shared background server (which `-c` overrides rule out anyway, with a
 * startup warning).
 *
 * With `--dangerously-bypass-hook-trust` (`buildAgentCmd`) codex shows no
 * startup screen ("Trust this folder?", "Hooks need review", "Update
 * available"), any of which would swallow the pasted prompt. Known cost: a
 * trusted folder loads the repo's own `.codex/` config, rules, MCP servers
 * and hooks, so a repo can loosen the posture and run code at startup
 * (docs/permission-modes.md).
 */
export function codexLaunchConfig(workspaceDir?: string): string[] {
  return [
    'check_for_update_on_startup=false',
    'features.daemon_auto_start=false',
    ...(workspaceDir !== undefined
      ? [`projects={${JSON.stringify(workspaceDir)}={trust_level="trusted"}}`]
      : []),
  ]
}

/**
 * A tmux format for the model segment of the title (after the last ` | `),
 * or empty before codex sets a title. Resolved inside tmux so the
 * subscription fires on model changes, not every spinner frame.
 */
export const CODEX_MODEL_FORMAT = '#{?#{m/r: [|] ,#{pane_title}},#{s/^.* [|] //:pane_title},}'

/**
 * The slug for the model named in codex's title, which shows the catalog
 * display name (`GPT-5.6-Sol` for `gpt-5.6-sol`). Looked up in the catalog
 * codex caches in its home. That cache may be missing (api-key auth, failed
 * fetch) or stale, so a miss falls back to the catalogs' naming rule
 * (lowercase, spaces to dashes), which leaves a slug unchanged.
 */
export async function codexModelSlug(projectId: string, shown: string): Promise<string> {
  try {
    const home = await openSandboxDir(projectId, codexDir(projectId))
    const raw = await home.readFile('models_cache.json', { maxBytes: MODELS_CACHE_MAX_BYTES })
    const cache = JSON.parse(raw?.toString('utf8') ?? '{}') as {
      models?: Array<{ slug?: unknown; display_name?: unknown }>
    }
    const model = cache.models?.find((m) => m.display_name === shown)?.slug
    if (typeof model === 'string' && model !== '') return model
  } catch {
    // No cache yet, or an unrecognized format.
  }
  return shown.toLowerCase().replace(/ /g, '-')
}

/** Size cap for the catalog cache, which lives in an agent-writable home. */
const MODELS_CACHE_MAX_BYTES = 8 * 1024 * 1024

/** How much of a rollout's tail to read for its newest settings, written at
 *  every turn start and change. If a turn pushed them further back, the
 *  previous answer stands. */
const ROLLOUT_TAIL_BYTES = 1024 * 1024

/** Each rollout's last answer, keyed by its size and mtime, so an
 *  unchanged rollout costs only a `stat`. */
const rolloutPostures = new Map<string, { size: number; mtimeMs: number; posture: CodexPosture | undefined }>()

/** The posture a rollout's newest settings map to, and when they were
 *  written (to tell this process's settings from a pre-restart one's). */
export interface CodexPosture {
  permissionMode: PermissionMode
  atMs: number
}

/**
 * codex's current posture from the newest settings in its rollout, with
 * their timestamp, or undefined if none are found or they match no posture.
 *
 * codex's hooks only report `bypassPermissions` or `default`. The rollout
 * says more: `thread_settings_applied` is written as soon as
 * `/permissions` or Shift+Tab changes anything, and `turn_context` at every
 * turn, both naming the approval policy, reviewer and permission profile
 * (codex-cli 0.159.3). The newer wins.
 *
 * The profile is read rather than `sandbox_policy` (only in
 * `turn_context`): `disabled` is full access; a managed profile is
 * workspace-write if it grants any write, else read-only. This inverts
 * `buildAgentCmd`'s launch table; other combinations map to the nearest
 * posture no looser than them.
 *
 * The collaboration mode is ignored: codex's plan mode is just model
 * instructions and restricts nothing.
 */
export async function getCodexPermissionMode(rollout: SandboxFile): Promise<CodexPosture | undefined> {
  const key = `${rollout.dir}/${rollout.rel}`
  let handle: FileHandle | null = null
  try {
    handle = await openSandboxFile(rollout)
    if (handle === null) return undefined
    const { size, mtimeMs } = await handle.stat()
    const known = rolloutPostures.get(key)
    if (known?.size === size && known.mtimeMs === mtimeMs) return known.posture
    const start = Math.max(0, size - ROLLOUT_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
    // A read that starts mid-file starts mid-line.
    if (start > 0) lines.shift()
    let posture: CodexPosture | undefined
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = rolloutSettings(lines[i])
      if (entry === undefined) continue
      const permissionMode = codexPosture(entry.settings)
      if (permissionMode !== undefined) posture = { permissionMode, atMs: entry.atMs }
      break
    }
    rolloutPostures.set(key, { size, mtimeMs, posture })
    return posture
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/** The settings a rollout line records, when it is one that records them. */
interface CodexThreadSettings {
  approval_policy?: unknown
  approvals_reviewer?: unknown
  permission_profile?: { type?: unknown; file_system?: { entries?: unknown } }
}

function rolloutSettings(line: string): { settings: CodexThreadSettings; atMs: number } | undefined {
  let entry: {
    timestamp?: unknown
    type?: unknown
    payload?: CodexThreadSettings & { type?: unknown; thread_settings?: CodexThreadSettings }
  }
  try {
    entry = JSON.parse(line) as typeof entry
  } catch {
    return undefined
  }
  const settings = entry.type === 'turn_context'
    ? entry.payload
    : entry.type === 'event_msg' && entry.payload?.type === 'thread_settings_applied'
      ? entry.payload.thread_settings
      : undefined
  const atMs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
  return settings === undefined ? undefined : { settings, atMs: Number.isNaN(atMs) ? 0 : atMs }
}

function codexPosture(s: CodexThreadSettings): PermissionMode | undefined {
  const profile = s.permission_profile
  const entries: unknown[] = Array.isArray(profile?.file_system?.entries) ? profile.file_system.entries : []
  const sandbox = profile?.type === 'disabled'
    ? 'full'
    : profile?.type !== 'managed'
      ? undefined
      : entries.some((e) => (e as { access?: unknown } | null)?.access === 'write') ? 'workspace' : 'read-only'
  const reviewer = s.approvals_reviewer ?? 'user'
  if (sandbox === undefined || (s.approval_policy !== 'on-request' && s.approval_policy !== 'never')) return undefined
  // Outside the launch table, pick the loosest posture that allows no more
  // than the agent can do unasked.
  if (sandbox === 'full') return 'bypass'
  if (reviewer === 'auto_review' && s.approval_policy === 'on-request') return 'auto'
  if (reviewer !== 'user' && reviewer !== 'auto_review') return undefined
  return sandbox === 'read-only' ? 'read-only' : 'accept-edits'
}

/**
 * The thread id from a rollout filename,
 * `rollout-<YYYY-MM-DDTHH-MM-SS>-<thread id>.jsonl` (also `.jsonl.zst`;
 * codex-cli 0.159.3). Undefined for other files.
 */
export function codexRolloutThreadId(fileName: string): string | undefined {
  return /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+?)\.jsonl(\.zst)?$/.exec(fileName)?.[1]
}

/** How much of a rollout's head to read for its first line (`session_meta`
 *  holds ~20 KB of base instructions in 0.159.3). */
const ROLLOUT_META_BYTES = 256 * 1024

/**
 * The thread a rollout descends from, or undefined for a root. A
 * `spawn_agent` child names its parent as `parent_thread_id` in its
 * `session_meta` source (found wherever it nests, since only the field name
 * is pinned); a `/fork` names its origin as `forked_from_id`. Only the first
 * line has these, and a child may never fire a hook, so this is the only
 * link to its parent.
 */
export async function codexRolloutParent(rollout: SandboxFile): Promise<string | undefined> {
  let handle: FileHandle | null = null
  try {
    handle = await openSandboxFile(rollout)
    if (handle === null) return undefined
    const buf = Buffer.alloc(ROLLOUT_META_BYTES)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const eol = text.indexOf('\n')
    const entry = JSON.parse(eol < 0 ? text : text.slice(0, eol)) as {
      type?: unknown
      payload?: { forked_from_id?: unknown; source?: unknown }
    }
    if (entry.type !== 'session_meta') return undefined
    const parent = spawnParent(entry.payload?.source) ?? entry.payload?.forked_from_id
    return typeof parent === 'string' && parent !== '' ? parent : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

function spawnParent(source: unknown): unknown {
  if (source === null || typeof source !== 'object') return undefined
  const own = (source as { parent_thread_id?: unknown }).parent_thread_id
  if (own !== undefined) return own
  for (const value of Object.values(source)) {
    const found = spawnParent(value)
    if (found !== undefined) return found
  }
  return undefined
}

/** Test helper: forget what each rollout last answered. */
export function _resetCodexPosturesForTests(): void {
  rolloutPostures.clear()
}

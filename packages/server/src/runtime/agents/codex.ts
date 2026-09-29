import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
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
 * A user turn's text: a `user_message` event, or — as codex-cli 0.156.1
 * writes it — an `item_completed` event carrying a `UserMessage` item. Never
 * a `response_item` with the user role, which also carries the bootstrap
 * context (AGENTS.md) codex injects ahead of the first real turn.
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
 * Classifies Codex's "actively working" state from the pane's OSC
 * terminal title, mirroring claude-status.ts. Titles are pushed at the
 * server by the session's status watcher (`#runtime/status`)
 * via a tmux control-mode subscription; reads happen via the status
 * store, never by probing the pod. Codex builds its terminal title from
 * the `[tui].terminal_title` items yaac launches it with
 * (`CODEX_TITLE_ITEMS`): while a task is running the activity item renders a
 * Braille spinner frame (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, all inside U+2800–U+28FF) ahead of
 * the rest, and the moment the turn ends the spinner drops away. When Codex blocks on user input (an approval
 * prompt) the spinner is suppressed entirely and the title instead gains
 * a blinking "[ ! ] Action Required" prefix — so the leading-Braille test
 * classifies every user-blocked state as 'waiting', which is exactly what
 * the JSONL transcript could not reliably tell us (verified against
 * codex-cli 0.142.4: codex-rs/tui/src/chatwidget/status_surfaces.rs, and
 * live — a turn in flight cycles all ten spinner frames in the title).
 *
 * Before Codex sets a title the pane reports tmux's default (the pod
 * hostname), which classifies as 'waiting' — the right answer for a
 * session still booting.
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
 * The items codex builds its terminal title from — its default pair, plus the
 * model. With them the idle title reads `workspace | GPT-5.6-Sol`, a turn in
 * flight `⠙ workspace | GPT-5.6-Sol`, and a `/model` rewrites the last segment
 * the moment it is confirmed, before any turn (verified against codex-cli
 * 0.156.1). That is the only push codex offers: no hook fires on a model
 * change, and the rollout does not exist until the first turn.
 *
 * `activity` stays first, which is what keeps `classifyCodexTitle`'s
 * leading-spinner test true; `project-name` stays ahead of the model, which is
 * what gives `CODEX_MODEL_FORMAT` a separator to find.
 */
export const CODEX_TITLE_ITEMS = ['activity', 'project-name', 'model'] as const

/**
 * The `-c` settings that trust the repository root codex keys folder trust on
 * (the parent of `repoGitDir`) and skip its startup update check — the same
 * on every substrate, since nothing here needs an image to carry it.
 *
 * With the launch's `--dangerously-bypass-hook-trust` (`buildAgentCmd`),
 * codex opens no startup screen at all: no "Trust this folder?", no "Hooks
 * need review", and no "Update available" (which a host codex behind the
 * latest release otherwise opens), any of which would swallow the prompt
 * pasted into it. That
 * is a choice with a known cost: a trusted folder loads the repository's own
 * `.codex/` config, rules, MCP servers and hooks, so a repository can loosen
 * the posture yaac launched in and run code at startup, and yaac accepts that
 * (docs/permission-modes.md).
 */
export function codexLaunchConfig(repoGitDir?: string): string[] {
  return [
    'check_for_update_on_startup=false',
    ...(repoGitDir !== undefined
      ? [`projects={${JSON.stringify(path.dirname(repoGitDir))}={trust_level="trusted"}}`]
      : []),
  ]
}

/**
 * A tmux format resolving to the model segment of the title — everything after
 * the last ` | ` — or empty before codex has set one (the pane then shows tmux's
 * default, the hostname, which has no separator). Resolved inside tmux, so the
 * subscription pushes when the model changes rather than on every spinner
 * frame.
 */
export const CODEX_MODEL_FORMAT = '#{?#{m/r: [|] ,#{pane_title}},#{s/^.* [|] //:pane_title},}'

/**
 * The slug for a model codex's title names. The title shows the active
 * catalog's display name (`GPT-5.6-Sol` for `gpt-5.6-sol`), and no title item
 * carries the slug, so the name is looked up in the catalog codex caches in
 * its home.
 *
 * That cache is not always there, or current: api-key auth and a failed fetch
 * never write it, and one written by an older codex lacks the newer models —
 * while the title still shows a display name from the catalog codex bundles.
 * So a miss falls back to the spelling rule the catalogs follow (lowercase,
 * spaces to dashes: `GPT-6-Astra` → `gpt-6-astra`), which also leaves a slug
 * unchanged, and a model in no catalog is titled by its slug.
 */
export async function codexModelSlug(slug: string, shown: string): Promise<string> {
  try {
    const home = await openSandboxDir(slug, codexDir(slug))
    const raw = await home.readFile('models_cache.json', { maxBytes: MODELS_CACHE_MAX_BYTES })
    const cache = JSON.parse(raw?.toString('utf8') ?? '{}') as {
      models?: Array<{ slug?: unknown; display_name?: unknown }>
    }
    const model = cache.models?.find((m) => m.display_name === shown)?.slug
    if (typeof model === 'string' && model !== '') return model
  } catch {
    // No cache yet, or one this reader does not understand.
  }
  return shown.toLowerCase().replace(/ /g, '-')
}

/** Far past any catalog codex caches; the file is in a home the agent can
 *  write, so it is not read without bound. */
const MODELS_CACHE_MAX_BYTES = 8 * 1024 * 1024

/** How much of a rollout's end is read for its newest settings. They are
 *  written at every turn's start and on every change, so they sit near the
 *  end; a turn whose output has pushed them further back than this reads as
 *  saying nothing, which leaves the last answer standing. */
const ROLLOUT_TAIL_BYTES = 1024 * 1024

/** What each rollout last answered, against the size and mtime it had then —
 *  a settled conversation costs a `stat`, not a read. */
const rolloutPostures = new Map<string, { size: number; mtimeMs: number; posture: CodexPosture | undefined }>()

/** The posture a rollout's newest settings stand for, and when they were
 *  written — which is what says whether they are this process's or the one
 *  before a restart. */
export interface CodexPosture {
  permissionMode: PermissionMode
  atMs: number
}

/**
 * The posture codex is running under, from the newest settings its rollout
 * records, with when they were written — or undefined when those name no
 * posture yaac has, or none were found.
 *
 * codex's hooks carry `permission_mode` only as `bypassPermissions` or
 * `default`, two answers for four postures, but its rollout says more, and at
 * once. A `thread_settings_applied` event is written the moment `/permissions`
 * or Shift+Tab changes anything, and a `turn_context` at every turn, both
 * naming the approval policy, who reviews approvals and the permission
 * profile (verified against codex-cli 0.156.1). The newer of the two wins.
 *
 * The profile is read rather than `sandbox_policy`, which only `turn_context`
 * has: `disabled` is full access, and a managed one is workspace-write when it
 * grants a write anywhere and read-only when it grants none. That inverts the
 * launch table in `buildAgentCmd`. A combination the table never launches
 * (the `never` policy over a sandbox, `on-request` over full access) reads as
 * the nearest posture no looser than it, rather than as nothing.
 *
 * The collaboration mode those entries also name is not read: codex's plan
 * mode is instructions to the model over whatever sandbox is in force, so it
 * restrains nothing the posture is about.
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
  // Past the launch table, a combination reads as the most permissive posture
  // that lets the agent do no more unasked than it can: nothing sandboxes a
  // full-access agent, and a policy that never asks does not widen a sandbox.
  if (sandbox === 'full') return 'bypass'
  if (reviewer === 'auto_review' && s.approval_policy === 'on-request') return 'auto'
  if (reviewer !== 'user' && reviewer !== 'auto_review') return undefined
  return sandbox === 'read-only' ? 'read-only' : 'accept-edits'
}

/** Test helper: forget what each rollout last answered. */
export function _resetCodexPosturesForTests(): void {
  rolloutPostures.clear()
}

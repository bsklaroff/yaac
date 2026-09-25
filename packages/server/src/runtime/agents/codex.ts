import fs from 'node:fs/promises'
import path from 'node:path'
import { scanJsonlForward } from './jsonl'

// ---------------------------------------------------------------------------
// Status + first-message
// ---------------------------------------------------------------------------

interface CodexEntry {
  type: string
  payload?: {
    type?: string
    message?: string
  }
}

function getUserMessageText(entry: CodexEntry): string | undefined {
  if (entry.payload?.type === 'user_message' && typeof entry.payload.message === 'string' && entry.payload.message.length > 0) {
    return entry.payload.message
  }
  return undefined
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
export async function getCodexFirstUserMessage(jsonlPath: string): Promise<string | undefined> {
  return scanJsonlForward(jsonlPath, (entry) => getUserMessageText(entry as CodexEntry))
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
export async function codexModelSlug(codexHome: string, shown: string): Promise<string> {
  try {
    const cache = JSON.parse(await fs.readFile(path.join(codexHome, 'models_cache.json'), 'utf8')) as {
      models?: Array<{ slug?: unknown; display_name?: unknown }>
    }
    const slug = cache.models?.find((m) => m.display_name === shown)?.slug
    if (typeof slug === 'string' && slug !== '') return slug
  } catch {
    // No cache yet, or one this reader does not understand.
  }
  return shown.toLowerCase().replace(/ /g, '-')
}

/**
 * Turns a session's first user message into a short display title, using a
 * pinned llama.cpp binary and a small local model on the server host. The
 * binary (~12MB) and model (~330MB) download once; each title is one
 * short-lived subprocess.
 *
 * Requests run one at a time, since concurrent runs would each load the
 * model into memory. A failed setup (offline, or egress to huggingface.co
 * blocked) is logged and retried only after a backoff.
 */
import { ensureLlamaCpp, ensureGgufModel, runChatCompletion } from './llama-cpp'
import { normalizeTitle } from '@yaac/shared/titles'
import { serverLog } from '#log'

/** Qwen2.5-0.5B-Instruct at IQ4_XS: the smallest model and quant that
 *  reliably wrote on-topic titles in docs/workspace-title-model-eval.md.
 *  Re-verify title quality before swapping the model or quant. */
export const TITLE_MODEL_URL
  = 'https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-IQ4_XS.gguf'
export const TITLE_MODEL_FILENAME = 'Qwen2.5-0.5B-Instruct-IQ4_XS.gguf'

/** Instruction for the title model, kept in the system role so the user turn
 *  is just the (untrusted) first message wrapped with a short ask. */
const TITLE_SYSTEM_PROMPT
  = "You write concise, specific titles for a developer tool's session list."

/** Prompts at or under this length already fit the sidebar as-is; running
 *  the model would mostly parrot them back. */
const SHORT_PROMPT_MAX = 48

/** Input cap, well under the model's context. It keeps the title focused on
 *  the opening ask. */
const MAX_INPUT_CHARS = 1000

/** Enough for a full ~6-word title without truncating the descriptive ones. */
const MAX_NEW_TOKENS = 32

/** How long a failed setup (binary/model download) blocks further attempts. */
const SETUP_RETRY_MS = 10 * 60_000

type TitleRunner = (input: string) => Promise<string>

async function createRunner(): Promise<TitleRunner> {
  const bin = await ensureLlamaCpp()
  const model = await ensureGgufModel(TITLE_MODEL_URL, TITLE_MODEL_FILENAME)
  return (input) => runChatCompletion(bin, model, TITLE_SYSTEM_PROMPT, input, MAX_NEW_TOKENS)
}

let runner: TitleRunner | undefined
let setupFailedAtMs: number | undefined
/** Tail of the queue; each summarize call runs after it. */
let chain: Promise<unknown> = Promise.resolve()

/** Whether a first message is worth summarizing at all. A session with no
 *  captured message has nothing to summarize and never gets here. */
export function shouldGenerateTitle(prompt: string): boolean {
  return normalizeTitle(prompt).length > SHORT_PROMPT_MAX
}

/**
 * Summarize a session's first message into a short title. Never rejects
 * (so the queue cannot stall): returns `undefined` when setup fails or the
 * output is unusable, and callers keep their prompt fallback.
 */
export function summarizeTitle(prompt: string): Promise<string | undefined> {
  const run = chain.then(() => runOne(prompt))
  chain = run
  return run
}

async function runOne(prompt: string): Promise<string | undefined> {
  const r = await ensureRunner()
  if (r === undefined) return undefined
  try {
    const title = postProcess(await r(buildInput(prompt)))
    if (title !== undefined && !sharesVocabulary(prompt, title)) return undefined
    return title
  } catch (err) {
    serverLog(`[titles] inference failed: ${String(err)}`)
    return undefined
  }
}

/**
 * Guards against off-topic titles (e.g. "adolescent symphony" for a
 * refactoring request): at least one word of 4+ chars in the title must
 * appear in the prompt. Substring match, so "action" matches "actions".
 * Titles with no such words are kept, since there is nothing to judge.
 */
function sharesVocabulary(prompt: string, title: string): boolean {
  const contentWords = title.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []
  if (contentWords.length === 0) return true
  const haystack = prompt.toLowerCase()
  return contentWords.some((w) => haystack.includes(w))
}

async function ensureRunner(): Promise<TitleRunner | undefined> {
  if (runner) return runner
  if (setupFailedAtMs !== undefined && Date.now() - setupFailedAtMs < SETUP_RETRY_MS) {
    return undefined
  }
  try {
    runner = await createRunner()
    setupFailedAtMs = undefined
    return runner
  } catch (err) {
    setupFailedAtMs = Date.now()
    serverLog(
      `[titles] model setup failed (next attempt in ${SETUP_RETRY_MS / 60_000} min): ${String(err)}`,
    )
    return undefined
  }
}

function buildInput(prompt: string): string {
  const text = prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS)
  return 'Write a short, specific title (3 to 6 words) that captures the main '
    + 'point of this request. Reply with ONLY the title — no quotes, no '
    + `punctuation at the end.\n\n${text}`
}

/** Strip wrapping quotes and trailing periods, then normalize like a user
 *  title. Empty output becomes `undefined`. */
function postProcess(raw: string): string | undefined {
  let text = raw.trim()
  const pairs: Array<[string, string]> = [
    ['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’'],
  ]
  for (let stripped = true; stripped && text.length >= 2;) {
    stripped = false
    for (const [open, close] of pairs) {
      if (text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(1, -1).trim()
        stripped = true
      }
    }
  }
  text = text.replace(/[.…]+$/, '')
  const normalized = normalizeTitle(text)
  return normalized === '' ? undefined : normalized
}

/** Test helper: drop the cached runner, backoff mark, and queue. */
export function _resetTitleSummarizerForTests(): void {
  runner = undefined
  setupFailedAtMs = undefined
  chain = Promise.resolve()
}

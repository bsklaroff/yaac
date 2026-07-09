/**
 * Local-model title summarization: turns a session's first user message
 * into a short display title by shelling out to a pinned llama.cpp
 * binary running a tiny flan-t5 GGUF, entirely on the daemon host. The
 * only network traffic is the one-time binary (~12MB, github.com) and
 * model (~114MB, huggingface.co) download; each title is one short-lived
 * subprocess, so nothing stays resident in the daemon between calls.
 *
 * Inference requests serialize one at a time (concurrent spawns would
 * stack model-load memory), and a failed setup (offline, or a nested
 * daemon whose egress allowlist blocks huggingface.co) logs and backs
 * off instead of retrying every caller.
 */
import { ensureLlamaCpp, ensureGgufModel, runCompletion } from '@/daemon/llama-cpp'
import { normalizeTitle } from '@/lib/session/titles'
import { daemonLog } from '@/daemon/log'

/** The artifact choice matters: ONNX q8/q4, GGUF Q4_0, AND the same
 *  repo's F16 GGUF all emit degenerate text ("on on on…"), while GGUF
 *  Q8_0 matches the known-good fp16 ONNX output token-for-token at
 *  temp 0 (all verified empirically — re-verify before swapping). */
export const TITLE_MODEL_URL
  = 'https://huggingface.co/Felladrin/gguf-flan-t5-small/resolve/main/flan-t5-small.Q8_0.gguf'
export const TITLE_MODEL_FILENAME = 'flan-t5-small.Q8_0.gguf'

/** Prompts at or under this length already fit the sidebar as-is; running
 *  the model would mostly parrot them back. */
const SHORT_PROMPT_MAX = 48

/** Payload cap before templating: the model's encoder takes 512 tokens, so
 *  1000 chars (~250 tokens) plus the instruction stays well inside. */
const MAX_INPUT_CHARS = 1000

const MAX_NEW_TOKENS = 16

/** How long a failed setup (binary/model download) blocks further attempts. */
const SETUP_RETRY_MS = 10 * 60_000

type TitleRunner = (input: string) => Promise<string>

async function defaultRunnerFactory(): Promise<TitleRunner> {
  const bin = await ensureLlamaCpp()
  const model = await ensureGgufModel(TITLE_MODEL_URL, TITLE_MODEL_FILENAME)
  return (input) => runCompletion(bin, model, input, MAX_NEW_TOKENS)
}

let runnerFactory: () => Promise<TitleRunner> = defaultRunnerFactory
let runner: TitleRunner | undefined
let setupFailedAtMs: number | undefined
/** Tail of the serialization chain — each summarize call queues behind it. */
let chain: Promise<unknown> = Promise.resolve()

/** Whether a first message is worth summarizing at all. */
export function shouldGenerateTitle(prompt: string | undefined): boolean {
  if (prompt === undefined) return false
  return normalizeTitle(prompt).length > SHORT_PROMPT_MAX
}

/**
 * Summarize a session's first message into a short title. Never throws:
 * returns `undefined` when setup fails (logged, with backoff) or the
 * output is unusable, so callers just keep their prompt fallback.
 */
export function summarizeTitle(prompt: string): Promise<string | undefined> {
  const run = chain.then(() => runOne(prompt))
  chain = run.catch(() => undefined)
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
    daemonLog(`[titles] inference failed: ${String(err)}`)
    return undefined
  }
}

/**
 * Hallucination guard: the model occasionally emits an off-topic title
 * (e.g. "adolescent symphony" for a refactoring request), which would
 * persist something worse than the prompt fallback. Require at least one
 * content word (4+ chars) of the title to appear in the prompt; substring
 * containment so "action" matches "actions". Titles with no content
 * words are kept — there is nothing to judge them by.
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
    runner = await runnerFactory()
    setupFailedAtMs = undefined
    return runner
  } catch (err) {
    setupFailedAtMs = Date.now()
    daemonLog(
      `[titles] model setup failed (next attempt in ${SETUP_RETRY_MS / 60_000} min): ${String(err)}`,
    )
    return undefined
  }
}

function buildInput(prompt: string): string {
  const text = prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS)
  // Chosen empirically: instruction wordings mentioning "summarize" or
  // "developer request" leak those words into flan-t5-small's output.
  return `Write a very short title for this task: ${text}`
}

/** Strip wrapping quotes/backticks and trailing periods, then normalize
 *  like a user title. Unusable (empty) output → `undefined`. */
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

/** Test helper: replace the runner factory (avoids downloads and spawns). */
export function _setTitleRunnerFactoryForTests(f: () => Promise<TitleRunner>): void {
  runnerFactory = f
}

/** Test helper: drop the cached runner, backoff mark, and queue. */
export function _resetTitleSummarizerForTests(): void {
  runnerFactory = defaultRunnerFactory
  runner = undefined
  setupFailedAtMs = undefined
  chain = Promise.resolve()
}

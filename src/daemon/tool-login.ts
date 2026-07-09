import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import * as pty from '@lydell/node-pty'
import { ensureDataDir, getDataDir } from '@/lib/project/paths'
import { persistToolLogin } from '@/lib/project/tool-auth'
import {
  claudeKeychainService,
  deleteScratchClaudeKeychainItem,
  extractClaudeOAuthBundle,
  extractCodexOAuthBundle,
  readClaudeKeychainPayload,
} from '@/shared/tool-auth-interactive'
import { resolveToolCliPath } from '@/daemon/cli-resolve'
import { DaemonError } from '@/daemon/errors'
import { testEnv } from '@/shared/env'
import type { AgentTool, ToolLoginView } from '@/shared/types'

/**
 * Web-driven tool sign-in: the daemon runs the vendor's own browser login in
 * a subprocess. Both CLIs open the user's browser themselves and complete via
 * a localhost callback, so with the daemon on the same machine as the browser
 * (the supported setup) the whole flow is hands-free — the webapp only shows
 * "finish in your browser" and polls for the outcome.
 *
 *  - claude: `claude auth login` under a PTY (it's an Ink TUI), with
 *    CLAUDE_CONFIG_DIR pointed at a scratch dir so the flow starts from a
 *    clean slate (no re-login prompts) and the host's own config is never
 *    touched. Success is detected by watching for the credentials the CLI
 *    writes — the scratch `.credentials.json`, or on macOS the Keychain item
 *    scoped to the scratch config dir (the CLI suffixes the service name
 *    with a config-dir hash) — then persisted as a full OAuth bundle. The
 *    scratch Keychain item is deleted with the scratch dir so live tokens
 *    never linger.
 *  - codex: `codex login` over pipes with CODEX_HOME pointed at a scratch
 *    dir; it exits 0 after the localhost:1455 callback, leaving an
 *    `auth.json` that is persisted like an import.
 *
 * Sessions are one-per-tool, time out after 15 minutes, and linger for a few
 * minutes after finishing so the webapp's polling sees the terminal state.
 */

export type { ToolLoginView }

/** How long a login may sit unfinished before it is killed. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
/** How long a finished session stays pollable before it is dropped. */
const LINGER_MS = 5 * 60 * 1000
/** How often the claude watcher looks for freshly-written credentials. */
const CLAUDE_POLL_MS = 500

const ANSI_RE = /\x1b\[[0-9;?]*[0-9A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]|[\x00-\x08\x0b-\x1f]/g

/** Strip ANSI escapes and control characters (newlines survive). */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '')
}

/** Last few non-empty output lines — the error message when a CLI fails. */
export function outputTail(text: string, lines = 4): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-lines).join(' | ')
}

/**
 * claude's stdin prompt. The webapp renders its own paste-code box right
 * below the output, so the CLI's echoed prompt is dropped as a duplicate;
 * anything Ink appends after it (e.g. "Login successful.") survives alone.
 */
const PASTE_PROMPT_RE = /^\s*Paste code here if prompted >?\s*/

/**
 * The CLI output as shown to the user: spinner-frame lines (Ink redraws leave
 * one glyph per frame), consecutive duplicate lines, and claude's paste-code
 * prompt dropped, then capped to the last `maxChars`. The webapp renders this
 * so the user can follow the printed sign-in URL when the daemon couldn't
 * open a browser.
 */
export function presentableOutput(buf: string, maxChars = 4000): string {
  const lines: string[] = []
  for (const raw of buf.split('\n')) {
    let line = raw.trimEnd()
    if (PASTE_PROMPT_RE.test(line)) {
      line = line.replace(PASTE_PROMPT_RE, '')
      if (line === '') continue
    }
    const t = line.trim()
    if (t.length === 1 && !/[0-9A-Za-z]/.test(t)) continue // spinner frame
    if (t === '' && lines[lines.length - 1]?.trim() === '') continue
    if (t !== '' && t === lines[lines.length - 1]?.trim()) continue // Ink re-render
    lines.push(line)
  }
  return lines.join('\n').trim().slice(-maxChars)
}

/** The spawned process surface the manager needs (PTY or piped child). */
interface LoginProc {
  /** Forward a line to the CLI's stdin (PTY flows only — null for pipes). */
  write: ((data: string) => void) | null
  kill: () => void
}

interface LoginSession {
  view: ToolLoginView
  /** Accumulated ANSI-stripped output, kept only for error tails. */
  buf: string
  proc: LoginProc | null
  scratchDir: string
  timer: ReturnType<typeof setTimeout>
  poller: ReturnType<typeof setInterval> | null
  /** Guards the async success path from double-firing (poll + exit). */
  persisting: boolean
}

const sessions = new Map<string, LoginSession>()

/** Drop every session (test isolation). */
export function clearAllToolLoginsForTests(): void {
  for (const s of sessions.values()) {
    clearTimeout(s.timer)
    if (s.poller) clearInterval(s.poller)
    s.proc?.kill()
  }
  sessions.clear()
}

function liveSessionForTool(tool: AgentTool): LoginSession | undefined {
  for (const s of sessions.values()) {
    if (s.view.tool === tool && s.proc) return s
  }
  return undefined
}

function finish(s: LoginSession, status: 'success' | 'error', error?: string): void {
  s.proc?.kill()
  s.proc = null
  if (s.poller) clearInterval(s.poller)
  s.poller = null
  s.view.status = status
  s.view.error = error
  clearTimeout(s.timer)
  s.timer = setTimeout(() => { sessions.delete(s.view.id) }, LINGER_MS)
  s.timer.unref?.()
  discardScratch(s)
}

/** Drop the scratch config home and (claude) its scoped Keychain item. */
function discardScratch(s: LoginSession): void {
  if (s.view.tool === 'claude') {
    deleteScratchClaudeKeychainItem(claudeKeychainService(s.scratchDir))
  }
  void fs.rm(s.scratchDir, { recursive: true, force: true }).catch(() => {})
}

/**
 * The claude credentials the login has produced so far: the scratch
 * `.credentials.json`, else (macOS) the Keychain. Null while the user is
 * still in the browser.
 */
async function readFreshClaudeCreds(s: LoginSession): Promise<string | null> {
  try {
    return await fs.readFile(path.join(s.scratchDir, '.credentials.json'), 'utf8')
  } catch {
    // not written (yet) — fall through to the keychain
  }
  // macOS: the CLI prefers the Keychain over the scratch file, under a
  // service name suffixed with a hash of CLAUDE_CONFIG_DIR — the scratch
  // login gets its own item, so its mere presence marks completion.
  return readClaudeKeychainPayload(claudeKeychainService(s.scratchDir))
}

/** One watcher tick: if credentials landed, persist them and finish. */
async function pollClaude(s: LoginSession): Promise<void> {
  if (s.persisting || !s.proc) return
  const raw = await readFreshClaudeCreds(s)
  if (raw === null) return
  const bundle = extractClaudeOAuthBundle(raw)
  if (!bundle) return
  s.persisting = true
  try {
    await persistToolLogin('claude', { apiKey: bundle.accessToken, kind: 'oauth', claudeBundle: bundle })
    finish(s, 'success')
  } catch (err) {
    finish(s, 'error', err instanceof Error ? err.message : String(err))
  }
}

/** Persist whatever `codex login` left in the scratch $CODEX_HOME. */
async function persistCodexScratchAuth(scratchDir: string): Promise<void> {
  const raw = await fs.readFile(path.join(scratchDir, 'auth.json'), 'utf8')
  const bundle = extractCodexOAuthBundle(raw)
  if (bundle) {
    await persistToolLogin('codex', { apiKey: bundle.accessToken, kind: 'oauth', codexBundle: bundle })
    return
  }
  // Browser login always lands in ChatGPT mode today; tolerate an api-key
  // shape anyway rather than failing a completed login.
  const parsed = JSON.parse(raw) as Record<string, unknown>
  for (const key of ['OPENAI_API_KEY', 'api_key', 'apiKey']) {
    const val = parsed[key]
    if (typeof val === 'string' && val) {
      await persistToolLogin('codex', { apiKey: val, kind: 'api-key' })
      return
    }
  }
  throw new Error('Codex login finished but wrote no usable credentials.')
}

function spawnClaude(s: LoginSession, argv: string[]): void {
  const proc = pty.spawn(argv[0], argv.slice(1), {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    // eslint-disable-next-line no-process-env -- env forwarded wholesale to the CLI
    env: { ...process.env, CLAUDE_CONFIG_DIR: s.scratchDir },
  })
  s.proc = { write: (d) => proc.write(d), kill: () => proc.kill() }
  proc.onData((d) => { s.buf += stripAnsi(d) })
  s.poller = setInterval(() => { void pollClaude(s) }, CLAUDE_POLL_MS)
  s.poller.unref?.()
  proc.onExit(() => {
    if (s.view.status !== 'running' || s.persisting) return
    // The CLI may exit right as (or just after) it writes the credentials —
    // give the watcher one final look before calling it a failure.
    void pollClaude(s).then(() => {
      if (s.view.status === 'running' && !s.persisting) {
        finish(s, 'error', outputTail(s.buf) || 'claude auth login exited before completing.')
      }
    })
  })
}

function spawnCodex(s: LoginSession, argv: string[]): void {
  const child = spawn(argv[0], argv.slice(1), {
    // eslint-disable-next-line no-process-env -- env forwarded wholesale to the CLI
    env: { ...process.env, CODEX_HOME: s.scratchDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  s.proc = { write: null, kill: () => child.kill() }
  child.stdout.on('data', (d: Buffer) => { s.buf += stripAnsi(d.toString('utf8')) })
  child.stderr.on('data', (d: Buffer) => { s.buf += stripAnsi(d.toString('utf8')) })
  child.on('error', (err) => {
    // Belt-and-braces: the preflight resolution should catch a missing CLI,
    // but a spawn ENOENT (deleted between resolve and spawn) means the same.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') s.view.cliMissing = true
    finish(s, 'error', err.message)
  })
  child.on('close', (code) => {
    if (s.view.status !== 'running') return
    if (code !== 0) {
      finish(s, 'error', outputTail(s.buf) || `codex login exited with code ${String(code)}.`)
      return
    }
    persistCodexScratchAuth(s.scratchDir)
      .then(() => finish(s, 'success'))
      .catch((err: unknown) => finish(s, 'error', err instanceof Error ? err.message : String(err)))
  })
}

/**
 * Start (or restart) the sign-in flow for a tool. Any still-running flow for
 * the same tool is cancelled first — the webapp drives one at a time.
 */
export async function startToolLogin(tool: AgentTool): Promise<ToolLoginView> {
  if (tool !== 'claude' && tool !== 'codex') {
    throw new DaemonError('VALIDATION', 'Web sign-in exists for claude and codex only — opencode uses an API key.')
  }
  const existing = liveSessionForTool(tool)
  if (existing) cancelToolLogin(existing.view.id)

  // Scratch config homes live under the data dir, not /tmp — codex refuses
  // to set up its helper binaries under a temp dir and warns loudly.
  await ensureDataDir()
  const scratchDir = await fs.mkdtemp(path.join(getDataDir(), 'login-'))
  const s: LoginSession = {
    view: { id: crypto.randomUUID(), tool, status: 'running' },
    buf: '',
    proc: null,
    scratchDir,
    timer: setTimeout(() => {
      finish(s, 'error', 'Sign-in timed out after 15 minutes.')
    }, LOGIN_TIMEOUT_MS),
    poller: null,
    persisting: false,
  }
  s.timer.unref?.()
  sessions.set(s.view.id, s)

  let argv = testEnv.toolLoginCliHook(tool)
  if (!argv) {
    const cli = resolveToolCliPath(tool)
    if (!cli) {
      // Decided up front: a PTY spawn of a missing binary gives no usable
      // signal (silent exit 1). The webapp turns cliMissing into an
      // "Install …" button instead of a retry.
      s.view.cliMissing = true
      finish(s, 'error', tool === 'claude'
        ? 'Claude Code is not installed on this machine.'
        : 'Codex is not installed on this machine.')
      return getToolLogin(s.view.id)
    }
    // Spawn the path the preflight resolved so both always agree.
    argv = tool === 'claude' ? [cli, 'auth', 'login'] : [cli, 'login']
  }
  try {
    if (tool === 'claude') spawnClaude(s, argv)
    else spawnCodex(s, argv)
  } catch (err) {
    finish(s, 'error', err instanceof Error ? err.message : String(err))
  }
  return getToolLogin(s.view.id)
}

/** Poll a login's state (output included for the "browser didn't open" case). */
export function getToolLogin(id: string): ToolLoginView {
  const s = sessions.get(id)
  if (!s) throw new DaemonError('NOT_FOUND', `No sign-in session "${id}".`)
  return { ...s.view, output: presentableOutput(s.buf) }
}

/**
 * The only stdin a login CLI legitimately needs: the authorize page's
 * `code#state` paste-back — base64url characters plus the `#` separator.
 * (The observed shape is two ~43-char base64url strings; 512 is headroom.)
 */
const LOGIN_INPUT_RE = /^[A-Za-z0-9_#-]{1,512}$/

/**
 * Forward the pasted authorize code to the CLI — how the user answers
 * claude's "Paste code here if prompted >" after following the printed URL
 * manually (that page displays a code instead of hitting the localhost
 * callback).
 *
 * Validation is a strict whitelist, not a control-char blacklist: the write
 * lands on the login CLI's PTY, so nothing that could read as a key chord,
 * escape sequence, or extra line may pass. The process is always the vendor
 * login CLI spawned directly (argv exec — no shell is ever involved), but
 * the accepted alphabet keeps the surface minimal regardless.
 */
export function sendToolLoginInput(id: string, text: string): ToolLoginView {
  const s = sessions.get(id)
  if (!s) throw new DaemonError('NOT_FOUND', `No sign-in session "${id}".`)
  if (!s.proc?.write) {
    throw new DaemonError('CONFLICT', 'This sign-in is not accepting input.')
  }
  const cleaned = text.trim()
  if (!LOGIN_INPUT_RE.test(cleaned)) {
    throw new DaemonError(
      'VALIDATION',
      'Expected the code from the authorize page (letters, digits, "#", "-", "_" only).',
    )
  }
  s.proc.write(cleaned + '\r')
  return getToolLogin(id)
}

/** Kill a login flow and forget it. Unknown ids are a no-op (already gone). */
export function cancelToolLogin(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  clearTimeout(s.timer)
  if (s.poller) clearInterval(s.poller)
  s.proc?.kill()
  s.proc = null
  sessions.delete(id)
  discardScratch(s)
}

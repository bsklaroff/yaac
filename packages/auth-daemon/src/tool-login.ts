import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import * as pty from '@lydell/node-pty'
import { ensureDataDir, serverLocalRoot } from '@yaac/shared/project-paths'
import { persistToolLogin } from '@yaac/shared/tool-auth'
import {
  claudeKeychainService,
  deleteScopedClaudeKeychainItem,
  extractClaudeOAuthBundle,
  extractCodexOAuthBundle,
  readClaudeKeychainPayload,
} from '@yaac/shared/tool-auth-interactive'
import { resolveToolCliPath } from '#cli-resolve'
import { createCliSessionRegistry, outputTail, type CliSession } from '#cli-session'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import type { ToolLoginView } from '@yaac/shared/types'

/**
 * Web-driven tool sign-in: the server runs the vendor's own browser login in
 * a subprocess. Both CLIs open the user's browser themselves and complete via
 * a localhost callback, so with the server on the same machine as the browser
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
 * Session lifecycle (one per tool, 15-minute timeout, post-finish linger for
 * the webapp's polling) lives in the shared cli-session registry.
 */

/** How often the claude watcher looks for freshly-written credentials. */
const CLAUDE_POLL_MS = 500

/**
 * Where a completed login's credentials go. Defaults to the local
 * persistence (data-dir credential files + placeholder fan-out) — right
 * when this code runs inside the machine that owns the data dir. The
 * auth server overrides it with an RPC `PUT /auth/:tool` so bundles land
 * on the (possibly remote) main server instead of this machine.
 */
type PersistToolLogin = typeof persistToolLogin
let persistResult: PersistToolLogin = persistToolLogin

export function setToolLoginPersistence(fn: PersistToolLogin): void {
  persistResult = fn
}

/** The spawned process surface the manager needs (PTY or piped child). */
interface LoginProc {
  /** Forward a line to the CLI's stdin (PTY flows only — null for pipes). */
  write: ((data: string) => void) | null
  kill: () => void
}

interface LoginSession extends CliSession<ToolLoginView> {
  proc: LoginProc | null
  scratchDir: string
  /** Guards the async success path from double-firing (poll + exit). */
  persisting: boolean
}

const registry = createCliSessionRegistry<LoginSession>({
  noun: 'sign-in session',
  onRelease: discardScratch,
})

/** Drop every session (test isolation). */
export function clearAllToolLoginsForTests(): void {
  registry.clearAllForTests()
}

/** Kill every login subprocess — auth-daemon shutdown, so vendor CLIs
 *  never outlive the broker that relays them. */
export function killAllToolLogins(): void {
  registry.clearAllForTests()
}

/** Drop the scratch config home and (claude) its scoped Keychain item. */
function discardScratch(s: LoginSession): void {
  if (s.view.tool === 'claude') {
    deleteScopedClaudeKeychainItem(claudeKeychainService(s.scratchDir))
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
    await persistResult('claude', { apiKey: bundle.accessToken, kind: 'oauth', claudeBundle: bundle })
    registry.finish(s, 'success')
  } catch (err) {
    registry.finish(s, 'error', err instanceof Error ? err.message : String(err))
  }
}

/** Persist whatever `codex login` left in the scratch $CODEX_HOME. */
async function persistCodexScratchAuth(scratchDir: string): Promise<void> {
  const raw = await fs.readFile(path.join(scratchDir, 'auth.json'), 'utf8')
  const bundle = extractCodexOAuthBundle(raw)
  if (bundle) {
    await persistResult('codex', { apiKey: bundle.accessToken, kind: 'oauth', codexBundle: bundle })
    return
  }
  // Browser login always lands in ChatGPT mode today; tolerate an api-key
  // shape anyway rather than failing a completed login.
  const parsed = JSON.parse(raw) as Record<string, unknown>
  for (const key of ['OPENAI_API_KEY', 'api_key', 'apiKey']) {
    const val = parsed[key]
    if (typeof val === 'string' && val) {
      await persistResult('codex', { apiKey: val, kind: 'api-key' })
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
  proc.onData((d) => { registry.ingest(s, d) })
  s.poller = setInterval(() => { void pollClaude(s) }, CLAUDE_POLL_MS)
  s.poller.unref?.()
  proc.onExit(() => {
    if (s.view.status !== 'running' || s.persisting) return
    // The CLI may exit right as (or just after) it writes the credentials —
    // give the watcher one final look before calling it a failure.
    void pollClaude(s).then(() => {
      if (s.view.status === 'running' && !s.persisting) {
        registry.finish(s, 'error', outputTail(s.buf) || 'claude auth login exited before completing.')
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
  child.stdout.on('data', (d: Buffer) => { registry.ingest(s, d.toString('utf8')) })
  child.stderr.on('data', (d: Buffer) => { registry.ingest(s, d.toString('utf8')) })
  child.on('error', (err) => {
    // Belt-and-braces: the preflight resolution should catch a missing CLI,
    // but a spawn ENOENT (deleted between resolve and spawn) means the same.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') s.view.cliMissing = true
    registry.finish(s, 'error', err.message)
  })
  child.on('close', (code) => {
    if (s.view.status !== 'running') return
    if (code !== 0) {
      registry.finish(s, 'error', outputTail(s.buf) || `codex login exited with code ${String(code)}.`)
      return
    }
    persistCodexScratchAuth(s.scratchDir)
      .then(() => registry.finish(s, 'success'))
      .catch((err: unknown) => registry.finish(s, 'error', err instanceof Error ? err.message : String(err)))
  })
}

/**
 * Start (or restart) the sign-in flow for a tool. Any still-running flow for
 * the same tool is cancelled first — clients drive one at a time. `id` is
 * supplied by the relay (the main server mints flow ids so its routes can
 * answer synchronously); direct callers/tests may omit it.
 */
export async function startToolLogin(tool: 'claude' | 'codex', id?: string): Promise<ToolLoginView> {
  const existing = registry.liveForTool(tool)
  if (existing) cancelToolLogin(existing.view.id)

  // Scratch config homes live under the data dir, not /tmp — codex refuses
  // to set up its helper binaries under a temp dir and warns loudly.
  // SERVER-LOCAL, and mkdtemp does not create parents: `ensureDataDir()`
  // only makes the shared projects tree, so this root needs its own mkdir
  // for the day the two are different volumes.
  await ensureDataDir()
  await fs.mkdir(serverLocalRoot(), { recursive: true })
  const scratchDir = await fs.mkdtemp(path.join(serverLocalRoot(), 'login-'))
  const s = registry.create(
    { id: id ?? crypto.randomUUID(), tool, status: 'running' },
    'Sign-in timed out after 15 minutes.',
    { scratchDir, persisting: false },
  )

  let argv = testEnv.toolLoginCliHook(tool)
  if (!argv) {
    const cli = resolveToolCliPath(tool)
    if (!cli) {
      // Decided up front: a PTY spawn of a missing binary gives no usable
      // signal (silent exit 1). The webapp turns cliMissing into an
      // "Install …" button instead of a retry.
      s.view.cliMissing = true
      registry.finish(s, 'error', tool === 'claude'
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
    registry.finish(s, 'error', err instanceof Error ? err.message : String(err))
  }
  return getToolLogin(s.view.id)
}

/** Poll a login's state (output included for the "browser didn't open" case). */
export function getToolLogin(id: string): ToolLoginView {
  return registry.getView(id)
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
  const s = registry.getById(id)
  if (!s.proc?.write) {
    throw new ServerError('CONFLICT', 'This sign-in is not accepting input.')
  }
  const cleaned = text.trim()
  if (!LOGIN_INPUT_RE.test(cleaned)) {
    throw new ServerError(
      'VALIDATION',
      'Expected the code from the authorize page (letters, digits, "#", "-", "_" only).',
    )
  }
  s.proc.write(cleaned + '\r')
  return getToolLogin(id)
}

/** Kill a login flow and forget it. Unknown ids are a no-op (already gone). */
export function cancelToolLogin(id: string): void {
  registry.cancel(id)
}

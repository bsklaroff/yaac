import fs from 'node:fs/promises'
import { rmSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import * as pty from '@lydell/node-pty'
import { clientLocalRoot, ensureClientLocalRoot } from '@yaac/shared/project-paths'
import {
  claudeKeychainService,
  deleteScopedClaudeKeychainItem,
  extractClaudeOAuthBundle,
  extractCodexOAuthBundle,
  readClaudeKeychainPayload,
  type ToolLoginResult,
} from '@yaac/shared/tool-auth-interactive'
import { resolveToolCliPath } from '#cli-resolve'
import { createCliSessionRegistry, outputTail, type CliSession } from '#cli-session'
import { ServerError } from '@yaac/shared/errors'
import { testEnv } from '@yaac/shared/env'
import type { AgentTool, ToolLoginView } from '@yaac/shared/types'

/**
 * Web-driven tool sign-in: runs the vendor's own browser login in a
 * subprocess on the user's machine. Both CLIs open the browser themselves and
 * complete through a localhost callback, so the webapp only shows "finish in
 * your browser" and polls for the outcome.
 *
 *  - claude: `claude auth login` under a PTY (it is an Ink TUI), with
 *    CLAUDE_CONFIG_DIR set to a scratch dir so the flow starts clean and the
 *    user's own config is untouched. Success is detected by polling for the
 *    credentials it writes: the scratch `.credentials.json`, or on macOS a
 *    Keychain item scoped to the scratch dir. That item is deleted along with
 *    the scratch dir.
 *  - codex: `codex login` over pipes with CODEX_HOME set to a scratch dir. It
 *    exits 0 after the callback, leaving an `auth.json` to persist.
 */

/** How often the claude watcher looks for freshly-written credentials. */
const CLAUDE_POLL_MS = 500

/**
 * Where a completed login's credentials go: `runAuthDaemon` sets a
 * `PUT /auth/:tool` to the server, which stores them for the signed-in user
 * and seeds that user's project tool homes.
 */
type PersistToolLogin = (tool: AgentTool, result: ToolLoginResult) => Promise<void>
let persistResult: PersistToolLogin = () => Promise.reject(new Error('no login persistence is set'))

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

/** Kill every login subprocess and forget its session (auth-daemon
 *  shutdown, test isolation). */
export function killAllToolLogins(): void {
  registry.killAll()
}

/** Drop the scratch config home and (claude) its scoped Keychain item.
 *  Synchronous, so a shutdown that exits right after `killAll` finishes it. */
function discardScratch(s: LoginSession): void {
  if (s.view.tool === 'claude') {
    deleteScopedClaudeKeychainItem(claudeKeychainService(s.scratchDir))
  }
  rmSync(s.scratchDir, { recursive: true, force: true })
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
    // not written yet
  }
  // On macOS the CLI writes to the Keychain instead, under a service name
  // derived from CLAUDE_CONFIG_DIR, so the scratch login gets its own item.
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
  // Browser login yields ChatGPT OAuth; accept an API key anyway rather than
  // fail a completed login.
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
    // The CLI may exit just after writing credentials; check once more.
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
    // ENOENT: the CLI vanished between the $PATH lookup and the spawn.
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
 * Start (or restart) the sign-in flow for a tool, cancelling any flow still
 * running for it. The relay passes the server-minted `id` so the server's
 * routes can answer synchronously; tests may omit it.
 */
export async function startToolLogin(tool: 'claude' | 'codex', id?: string): Promise<ToolLoginView> {
  const existing = registry.liveForTool(tool)
  if (existing) cancelToolLogin(existing.view.id)

  // Not under /tmp: codex refuses to install its helper binaries in a temp
  // dir. mkdtemp does not create parents, hence ensureClientLocalRoot.
  await ensureClientLocalRoot()
  const scratchDir = await fs.mkdtemp(path.join(clientLocalRoot(), 'login-'))
  const s = registry.create(
    { id: id ?? crypto.randomUUID(), tool, status: 'running' },
    'Sign-in timed out after 15 minutes.',
    { scratchDir, persisting: false },
  )

  let argv = testEnv.toolLoginCliHook(tool)
  if (!argv) {
    const cli = resolveToolCliPath(tool)
    if (!cli) {
      // Checked up front because a PTY spawn of a missing binary just exits
      // 1. The webapp shows an "Install" button for cliMissing.
      s.view.cliMissing = true
      registry.finish(s, 'error', tool === 'claude'
        ? 'Claude Code is not installed on this machine.'
        : 'Codex is not installed on this machine.')
      return getToolLogin(s.view.id)
    }
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
 * The only input a login CLI needs: the authorize page's `code#state`
 * paste-back (base64url plus `#`; about 87 chars in practice).
 */
const LOGIN_INPUT_RE = /^[A-Za-z0-9_#-]{1,512}$/

/**
 * Forward a pasted authorize code to claude's "Paste code here if prompted >"
 * prompt, used when the user opened the printed URL by hand. The input goes
 * to a PTY, so it is checked against a strict allow-list to keep out escape
 * sequences, key chords and extra lines.
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

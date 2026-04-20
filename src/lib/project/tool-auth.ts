import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn, execFileSync } from 'node:child_process'
import os from 'node:os'
import {
  claudeCredentialsPath,
  codexCredentialsPath,
  credentialsDir,
  ensureDataDir,
  getProjectsDir,
  claudeDir,
  codexDir,
  projectClaudeCredentialsFile,
  projectCodexAuthFile,
} from '@/lib/project/paths'
import { DaemonError } from '@/lib/daemon/errors'
import type {
  AgentTool,
  ToolAuthKind,
  ToolAuthEntry,
  ClaudeCredentialsFile,
  ClaudeOAuthBundle,
  CodexCredentialsFile,
  CodexOAuthBundle,
} from '@/types'

/** Placeholder tokens written into project-local Claude credentials. */
export const PLACEHOLDER_ACCESS_TOKEN = 'yaac-ph-access'
export const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'

/**
 * Auto-detect the auth kind from a token string.
 * - Anthropic API keys start with "sk-ant-api03-"
 * - Anthropic OAuth tokens start with "sk-ant-oat"
 * - Everything else defaults to 'api-key'
 */
export function detectAuthKind(tool: AgentTool, token: string): ToolAuthKind {
  if (tool === 'claude') {
    if (token.startsWith('sk-ant-oat')) return 'oauth'
    return 'api-key'
  }
  return 'api-key'
}

async function ensureCredentialsDir(): Promise<void> {
  await ensureDataDir()
  await fs.mkdir(credentialsDir(), { recursive: true, mode: 0o700 })
}

function isClaudeOAuthBundle(v: unknown): v is ClaudeOAuthBundle {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  // refreshToken + expiresAt may be empty/zero when saveToolAuth was called
  // with a bare OAuth access token — the proxy will refresh on first use and
  // fill in real values. The file is still a valid yaac-managed OAuth entry.
  return typeof o.accessToken === 'string' && o.accessToken !== ''
    && typeof o.refreshToken === 'string'
    && typeof o.expiresAt === 'number'
    && Array.isArray(o.scopes)
    && o.scopes.every((s) => typeof s === 'string')
}

/**
 * Read the yaac-managed Claude credentials file.
 */
export async function loadClaudeCredentialsFile(): Promise<ClaudeCredentialsFile | null> {
  try {
    const raw = await fs.readFile(claudeCredentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'oauth' && typeof o.savedAt === 'string' && isClaudeOAuthBundle(o.claudeAiOauth)) {
      return { kind: 'oauth', savedAt: o.savedAt, claudeAiOauth: o.claudeAiOauth }
    }
    if (o.kind === 'api-key' && typeof o.savedAt === 'string' && typeof o.apiKey === 'string' && o.apiKey !== '') {
      return { kind: 'api-key', savedAt: o.savedAt, apiKey: o.apiKey }
    }
    return null
  } catch {
    return null
  }
}

export async function saveClaudeCredentialsFile(creds: ClaudeCredentialsFile): Promise<void> {
  await ensureCredentialsDir()
  await fs.writeFile(
    claudeCredentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
    { mode: 0o600 },
  )
}

function isCodexOAuthBundle(v: unknown): v is CodexOAuthBundle {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.accessToken === 'string' && o.accessToken !== ''
    && typeof o.refreshToken === 'string' && o.refreshToken !== ''
    && typeof o.idTokenRawJwt === 'string' && o.idTokenRawJwt !== ''
    && typeof o.expiresAt === 'number'
    && typeof o.lastRefresh === 'string'
    && (o.accountId === undefined || typeof o.accountId === 'string')
}

export async function loadCodexCredentialsFile(): Promise<CodexCredentialsFile | null> {
  try {
    const raw = await fs.readFile(codexCredentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'oauth' && typeof o.savedAt === 'string' && isCodexOAuthBundle(o.codexOauth)) {
      return { kind: 'oauth', savedAt: o.savedAt, codexOauth: o.codexOauth }
    }
    if (o.kind === 'api-key' && typeof o.savedAt === 'string' && typeof o.apiKey === 'string' && o.apiKey !== '') {
      return { kind: 'api-key', savedAt: o.savedAt, apiKey: o.apiKey }
    }
    return null
  } catch {
    return null
  }
}

export async function saveCodexCredentialsFile(creds: CodexCredentialsFile): Promise<void> {
  await ensureCredentialsDir()
  await fs.writeFile(
    codexCredentialsPath(),
    JSON.stringify(creds, null, 2) + '\n',
    { mode: 0o600 },
  )
}

/**
 * Save a full Codex OAuth bundle (with refresh token + expiry + id_token).
 */
export async function saveCodexOAuthBundle(bundle: CodexOAuthBundle): Promise<void> {
  await saveCodexCredentialsFile({
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    codexOauth: bundle,
  })
}

/**
 * Load the stored auth entry for a specific tool.
 * Returns null if no credentials are configured.
 */
export async function loadToolAuthEntry(tool: AgentTool): Promise<ToolAuthEntry | null> {
  if (tool === 'claude') {
    const f = await loadClaudeCredentialsFile()
    if (!f) return null
    if (f.kind === 'oauth') {
      return {
        tool: 'claude',
        kind: 'oauth',
        apiKey: f.claudeAiOauth.accessToken,
        savedAt: f.savedAt,
        refreshToken: f.claudeAiOauth.refreshToken,
        expiresAt: f.claudeAiOauth.expiresAt,
        scopes: f.claudeAiOauth.scopes,
        subscriptionType: f.claudeAiOauth.subscriptionType,
      }
    }
    return { tool: 'claude', kind: 'api-key', apiKey: f.apiKey, savedAt: f.savedAt }
  }
  const f = await loadCodexCredentialsFile()
  if (!f) return null
  if (f.kind === 'oauth') {
    return {
      tool: 'codex',
      kind: 'oauth',
      apiKey: f.codexOauth.accessToken,
      savedAt: f.savedAt,
      refreshToken: f.codexOauth.refreshToken,
      expiresAt: f.codexOauth.expiresAt,
      codexBundle: f.codexOauth,
    }
  }
  return { tool: 'codex', kind: 'api-key', apiKey: f.apiKey, savedAt: f.savedAt }
}

/**
 * Save tool credentials. For Claude OAuth, callers should use
 * `saveClaudeOAuthBundle` to preserve the full bundle (refreshToken, expiresAt,
 * etc). The `apiKey` form here loses those extra fields.
 */
export async function saveToolAuth(tool: AgentTool, apiKey: string, kind: ToolAuthKind): Promise<void> {
  const savedAt = new Date().toISOString()
  if (tool === 'claude') {
    if (kind === 'oauth') {
      // OAuth without a bundle can't be refreshed — callers should use
      // saveClaudeOAuthBundle. Fall back to a minimal bundle with an already-
      // expired timestamp so the proxy will force a refresh on first use.
      await saveClaudeCredentialsFile({
        kind: 'oauth',
        savedAt,
        claudeAiOauth: {
          accessToken: apiKey,
          refreshToken: '',
          expiresAt: 0,
          scopes: [],
        },
      })
      return
    }
    await saveClaudeCredentialsFile({ kind: 'api-key', savedAt, apiKey })
    return
  }
  if (kind === 'oauth') {
    // OAuth without a bundle can't be refreshed — callers should use
    // saveCodexOAuthBundle. Fall through to api-key so the proxy still
    // injects the token until the user re-runs `yaac auth update`.
    await saveCodexCredentialsFile({ kind: 'api-key', savedAt, apiKey })
    return
  }
  await saveCodexCredentialsFile({ kind: 'api-key', savedAt, apiKey })
}

/**
 * Save a full Claude OAuth bundle (with refresh token + expiry + scopes).
 */
export async function saveClaudeOAuthBundle(bundle: ClaudeOAuthBundle): Promise<void> {
  await saveClaudeCredentialsFile({
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    claudeAiOauth: bundle,
  })
}

/**
 * Remove stored auth for a specific tool. Returns true if an entry was present.
 */
export async function removeToolAuth(tool: AgentTool): Promise<boolean> {
  const target = tool === 'claude' ? claudeCredentialsPath() : codexCredentialsPath()
  try {
    await fs.unlink(target)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * Parse a raw blob of Claude Code's native `.credentials.json` (or the
 * equivalent macOS Keychain payload) into a full OAuth bundle.
 */
export function extractClaudeOAuthBundle(raw: string): ClaudeOAuthBundle | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const oauth = o.claudeAiOauth
  if (!isClaudeOAuthBundle(oauth)) return null
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType,
  }
}

/**
 * On macOS, Claude Code stores OAuth credentials in the Keychain.
 * Fetch them via `security find-generic-password`.
 */
function readClaudeKeychainPayload(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return out.trim()
  } catch {
    return null
  }
}

/**
 * Read Claude Code's native OAuth bundle from its config (or macOS Keychain).
 */
export async function readClaudeOAuthFromHost(): Promise<ClaudeOAuthBundle | null> {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json')
    const raw = await fs.readFile(credPath, 'utf8')
    const bundle = extractClaudeOAuthBundle(raw)
    if (bundle) return bundle
  } catch {
    // fall through to keychain
  }
  const kc = readClaudeKeychainPayload()
  if (kc) return extractClaudeOAuthBundle(kc)
  return null
}

/**
 * Decode a JWT's middle segment (payload) and return `exp` as unix epoch ms.
 * Returns null for malformed JWTs or missing `exp`. No dep on a JWT library —
 * this is two base64url decodes and a JSON parse, all in a try/catch.
 */
export function decodeJwtExp(jwt: string): number | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!payload || typeof payload !== 'object') return null
    const exp = (payload as Record<string, unknown>).exp
    if (typeof exp !== 'number') return null
    return exp * 1000
  } catch {
    return null
  }
}

const CODEX_DEFAULT_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000

/**
 * Parse a raw Codex `auth.json` blob into a full OAuth bundle. Returns null
 * unless `auth_mode` is the ChatGPT mode (case-insensitive — codex-cli 0.121+
 * writes `"chatgpt"` lowercase, older versions used `"ChatGPT"`) and the
 * nested tokens are all present. Computes `expiresAt` from the access_token
 * JWT `exp`, falling back to now + 28d so the proxy still treats the bundle
 * as live.
 */
export function extractCodexOAuthBundle(raw: string): CodexOAuthBundle | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (typeof o.auth_mode !== 'string' || o.auth_mode.toLowerCase() !== 'chatgpt') return null
  const tokens = o.tokens
  if (!tokens || typeof tokens !== 'object') return null
  const t = tokens as Record<string, unknown>
  const accessToken = typeof t.access_token === 'string' ? t.access_token : null
  const refreshToken = typeof t.refresh_token === 'string' ? t.refresh_token : null
  if (!accessToken || !refreshToken) return null

  const idTokenRawJwt = typeof t.id_token === 'string' ? t.id_token : null
  if (!idTokenRawJwt) return null

  const accountId = typeof t.account_id === 'string' ? t.account_id : undefined
  const lastRefresh = typeof o.last_refresh === 'string' && o.last_refresh
    ? o.last_refresh
    : new Date().toISOString()
  const exp = decodeJwtExp(accessToken)
  const expiresAt = exp ?? (Date.now() + CODEX_DEFAULT_REFRESH_WINDOW_MS)

  return {
    accessToken,
    refreshToken,
    idTokenRawJwt,
    expiresAt,
    lastRefresh,
    accountId,
  }
}

/**
 * Read Codex's native `~/.codex/auth.json`. Returns a full OAuth bundle when
 * the file is in ChatGPT mode, otherwise null. Callers fall back to the
 * api-key extractor.
 */
export async function readCodexOAuthFromHost(): Promise<CodexOAuthBundle | null> {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json')
    const raw = await fs.readFile(authPath, 'utf8')
    return extractCodexOAuthBundle(raw)
  } catch {
    return null
  }
}

/**
 * Read Codex's stored API key from its native config.
 */
export async function readCodexCredentials(): Promise<string | null> {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json')
    const raw = await fs.readFile(authPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const key of ['api_key', 'apiKey', 'token', 'access_token']) {
      const val = parsed[key]
      if (typeof val === 'string' && val) {
        return val
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Spawn a CLI command and wait for it to exit. Inherits stdio so the user
 * can drive the login flow interactively.
 */
function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', reject)
  })
}

/**
 * Result of running the tool's native login CLI.
 */
export interface ToolLoginResult {
  apiKey: string
  kind: ToolAuthKind
  /** Present when Claude OAuth login succeeded — the full bundle. */
  claudeBundle?: ClaudeOAuthBundle
  /** Present when Codex OAuth login succeeded — the full bundle. */
  codexBundle?: CodexOAuthBundle
}

/**
 * Run the tool's native login CLI and extract the resulting credentials.
 */
export async function runToolLogin(tool: AgentTool): Promise<ToolLoginResult> {
  const toolLabel = tool === 'claude' ? 'Claude Code' : 'Codex'
  console.log(`Starting ${toolLabel} login flow...`)

  if (tool === 'claude') {
    const code = await runInteractive('claude', ['auth', 'login'])
    if (code !== 0) {
      console.warn(`Claude Code login exited with code ${code}.`)
    }

    const bundle = await readClaudeOAuthFromHost()
    if (bundle) {
      return { apiKey: bundle.accessToken, kind: 'oauth', claudeBundle: bundle }
    }

    console.log('Could not read OAuth credentials from Claude Code config.')
    return promptForApiKey(tool)
  }

  const code = await runInteractive('codex', ['login'])
  if (code !== 0) {
    console.warn(`Codex login exited with code ${code}.`)
  }

  const codexBundle = await readCodexOAuthFromHost()
  if (codexBundle) {
    return { apiKey: codexBundle.accessToken, kind: 'oauth', codexBundle }
  }

  const token = await readCodexCredentials()
  if (token) {
    return { apiKey: token, kind: detectAuthKind('codex', token) }
  }

  console.log('Could not read credentials from Codex config.')
  return promptForApiKey(tool)
}

/**
 * Prompt the user to paste their API key directly.
 */
export async function promptForApiKey(tool: AgentTool): Promise<ToolLoginResult> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const label = tool === 'claude' ? 'Anthropic API key or OAuth token' : 'OpenAI API key'
  const key = (await rl.question(`Paste your ${label}: `)).trim()
  rl.close()
  if (!key) {
    console.error('Key cannot be empty.')
    process.exit(1)
  }
  return { apiKey: key, kind: detectAuthKind(tool, key) }
}

/**
 * Persist the result of a login flow. For Claude OAuth this stores the full
 * bundle (with refresh token + expiry) so the proxy can refresh later.
 */
export async function persistToolLogin(tool: AgentTool, result: ToolLoginResult): Promise<void> {
  if (tool === 'claude' && result.kind === 'oauth' && result.claudeBundle) {
    await saveClaudeOAuthBundle(result.claudeBundle)
    await fanOutClaudePlaceholders(result.claudeBundle)
    return
  }
  if (tool === 'codex' && result.kind === 'oauth' && result.codexBundle) {
    await saveCodexOAuthBundle(result.codexBundle)
    await fanOutCodexPlaceholders(result.codexBundle)
    return
  }
  await saveToolAuth(tool, result.apiKey, result.kind)
}

/**
 * Validate and persist a tool-auth payload the CLI sent after running
 * the native login flow locally. Throws `VALIDATION` for anything we
 * don't recognize.
 */
export async function persistToolAuthPayload(tool: AgentTool, payload: unknown): Promise<void> {
  if (tool !== 'claude' && tool !== 'codex') {
    throw new DaemonError('VALIDATION', `Unknown tool "${String(tool)}".`)
  }
  if (!payload || typeof payload !== 'object') {
    throw new DaemonError('VALIDATION', 'Expected { kind, ... } body.')
  }
  const p = payload as Record<string, unknown>
  if (p.kind === 'api-key') {
    if (typeof p.apiKey !== 'string' || p.apiKey === '') {
      throw new DaemonError('VALIDATION', 'api-key payload requires a non-empty apiKey.')
    }
    await persistToolLogin(tool, { apiKey: p.apiKey, kind: 'api-key' })
    return
  }
  if (p.kind === 'oauth') {
    if (tool === 'claude') {
      if (!isClaudeOAuthBundle(p.bundle)) {
        throw new DaemonError('VALIDATION', 'Claude oauth payload needs a valid bundle.')
      }
      await persistToolLogin('claude', {
        apiKey: p.bundle.accessToken,
        kind: 'oauth',
        claudeBundle: p.bundle,
      })
      return
    }
    if (!isCodexOAuthBundle(p.bundle)) {
      throw new DaemonError('VALIDATION', 'Codex oauth payload needs a valid bundle.')
    }
    await persistToolLogin('codex', {
      apiKey: p.bundle.accessToken,
      kind: 'oauth',
      codexBundle: p.bundle,
    })
    return
  }
  throw new DaemonError('VALIDATION', `Unknown payload kind "${String(p.kind)}".`)
}

/**
 * Ensure the given tool has stored credentials. If not, runs the native login
 * flow and saves the result.
 */
export async function ensureToolAuth(tool: AgentTool): Promise<ToolAuthEntry> {
  const existing = await loadToolAuthEntry(tool)
  if (existing) return existing

  const result = await runToolLogin(tool)
  await persistToolLogin(tool, result)
  const toolLabel = tool === 'claude' ? 'Claude Code' : 'Codex'
  console.log(`${toolLabel} credentials saved.`)
  const saved = await loadToolAuthEntry(tool)
  if (!saved) throw new Error(`Failed to persist ${toolLabel} credentials.`)
  return saved
}

/**
 * Build the placeholder bundle written into a project's `.claude/.credentials.json`.
 * Real tokens are replaced with sentinels; non-secret fields (expiresAt, scopes,
 * subscriptionType) are preserved so Claude Code inside the container sees a
 * plausible bundle and doesn't prompt for login.
 */
export function buildPlaceholderBundle(bundle: ClaudeOAuthBundle): ClaudeOAuthBundle {
  return {
    accessToken: PLACEHOLDER_ACCESS_TOKEN,
    refreshToken: PLACEHOLDER_REFRESH_TOKEN,
    expiresAt: bundle.expiresAt,
    scopes: bundle.scopes,
    subscriptionType: bundle.subscriptionType,
  }
}

/**
 * Write a placeholder `.credentials.json` to a single project's Claude dir.
 */
export async function writeProjectClaudePlaceholder(
  slug: string,
  bundle: ClaudeOAuthBundle,
): Promise<void> {
  await fs.mkdir(claudeDir(slug), { recursive: true })
  const payload = { claudeAiOauth: buildPlaceholderBundle(bundle) }
  await fs.writeFile(
    projectClaudeCredentialsFile(slug),
    JSON.stringify(payload, null, 2) + '\n',
    { mode: 0o600 },
  )
}

/**
 * After a successful Claude OAuth login, seed every existing project's
 * `.claude/.credentials.json` with a placeholder bundle. Fresh projects get
 * seeded on `project add`.
 */
export async function fanOutClaudePlaceholders(bundle: ClaudeOAuthBundle): Promise<void> {
  let projects: string[]
  try {
    projects = await fs.readdir(getProjectsDir())
  } catch {
    return
  }
  for (const slug of projects) {
    try {
      await writeProjectClaudePlaceholder(slug, bundle)
    } catch (err) {
      console.warn(`Warning: failed to seed placeholder creds for project "${slug}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * Build the placeholder Codex bundle written into a project's `auth.json`.
 * Only `accessToken` and `refreshToken` get sentineled — `idTokenRawJwt`,
 * `expiresAt`, `lastRefresh`, and `accountId` stay real so Codex's Rust
 * deserializer accepts the bundle and so the top-level `account_id` drives
 * the correct `ChatGPT-Account-Id` header on api.openai.com.
 */
export function buildCodexPlaceholderBundle(bundle: CodexOAuthBundle): CodexOAuthBundle {
  return {
    accessToken: PLACEHOLDER_ACCESS_TOKEN,
    refreshToken: PLACEHOLDER_REFRESH_TOKEN,
    idTokenRawJwt: bundle.idTokenRawJwt,
    expiresAt: bundle.expiresAt,
    lastRefresh: bundle.lastRefresh,
    accountId: bundle.accountId,
  }
}

/**
 * Write a placeholder Codex `auth.json` to a single project's codex dir.
 * The on-disk shape matches Codex's `AuthDotJson` deserializer: `auth_mode:
 * "chatgpt"`, `tokens.id_token` as a plain JWT string, plus `access_token`,
 * `refresh_token`, `account_id`, and a top-level `last_refresh`. Codex
 * re-parses the JWT claims at load time.
 */
export async function writeProjectCodexPlaceholder(
  slug: string,
  bundle: CodexOAuthBundle,
): Promise<void> {
  await fs.mkdir(codexDir(slug), { recursive: true })
  const placeholder = buildCodexPlaceholderBundle(bundle)
  const payload: Record<string, unknown> = {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: placeholder.idTokenRawJwt,
      access_token: placeholder.accessToken,
      refresh_token: placeholder.refreshToken,
      account_id: placeholder.accountId ?? null,
    },
    last_refresh: placeholder.lastRefresh,
  }
  await fs.writeFile(
    projectCodexAuthFile(slug),
    JSON.stringify(payload, null, 2) + '\n',
    { mode: 0o600 },
  )
}

/**
 * After a successful Codex OAuth login, seed every existing project's
 * `codex/auth.json` with a placeholder bundle.
 */
export async function fanOutCodexPlaceholders(bundle: CodexOAuthBundle): Promise<void> {
  let projects: string[]
  try {
    projects = await fs.readdir(getProjectsDir())
  } catch {
    return
  }
  for (const slug of projects) {
    try {
      await writeProjectCodexPlaceholder(slug, bundle)
    } catch (err) {
      console.warn(`Warning: failed to seed Codex placeholder for project "${slug}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function unlinkIgnoreMissing(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Remove the project-local `.claude/.credentials.json` placeholder from
 * every tracked project. Used by `auth clear` to make sure running
 * containers don't keep using a placeholder that the proxy will no longer
 * swap for a real token.
 */
export async function cleanupProjectClaudePlaceholders(): Promise<void> {
  let projects: string[]
  try {
    projects = await fs.readdir(getProjectsDir())
  } catch {
    return
  }
  for (const slug of projects) {
    try {
      await unlinkIgnoreMissing(projectClaudeCredentialsFile(slug))
    } catch (err) {
      console.warn(`Warning: failed to remove Claude placeholder for project "${slug}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * Remove the project-local `codex/auth.json` placeholder from every tracked
 * project. Leaves the rest of the codex dir (hooks, config.toml, transcripts)
 * in place.
 */
export async function cleanupProjectCodexPlaceholders(): Promise<void> {
  let projects: string[]
  try {
    projects = await fs.readdir(getProjectsDir())
  } catch {
    return
  }
  for (const slug of projects) {
    try {
      await unlinkIgnoreMissing(projectCodexAuthFile(slug))
    } catch (err) {
      console.warn(`Warning: failed to remove Codex placeholder for project "${slug}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

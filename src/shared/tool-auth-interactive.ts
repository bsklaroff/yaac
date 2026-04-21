import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline/promises'
import { spawn, execFileSync } from 'node:child_process'
import {
  claudeOAuthBundleSchema,
  type AgentTool,
  type ClaudeOAuthBundle,
  type CodexOAuthBundle,
  type ToolAuthKind,
} from '@/shared/types'

/**
 * Auto-detect the auth kind from a token string.
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

function isClaudeOAuthBundle(v: unknown): v is ClaudeOAuthBundle {
  return claudeOAuthBundleSchema.safeParse(v).success
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
    child.on('close', (code) => resolve(code ?? 0))
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
  // Test-only hook: e2e-cli can't drive the native `claude login` /
  // `codex login` OAuth flow end-to-end, so these env vars short-circuit
  // with a JSON-serialised bundle. The CLI → daemon persistence path is
  // still exercised exactly as in production.
  const hookVar = tool === 'claude' ? 'YAAC_E2E_CLAUDE_LOGIN' : 'YAAC_E2E_CODEX_LOGIN'
  const hookRaw = process.env[hookVar]
  if (hookRaw) {
    if (tool === 'claude') {
      const bundle = claudeOAuthBundleSchema.parse(JSON.parse(hookRaw))
      return { apiKey: bundle.accessToken, kind: 'oauth', claudeBundle: bundle }
    }
    const bundle = JSON.parse(hookRaw) as CodexOAuthBundle
    return { apiKey: bundle.accessToken, kind: 'oauth', codexBundle: bundle }
  }

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

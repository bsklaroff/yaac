import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { execFileSync } from 'node:child_process'
import {
  claudeOAuthBundleSchema,
  type AgentTool,
  type ClaudeOAuthBundle,
  type CodexOAuthBundle,
  type OpencodeProvider,
  type ToolAuthKind,
} from '@/shared/types'
import { testEnv } from '@/shared/env'

/**
 * Auto-detect the auth kind from a token string.
 * - Anthropic OAuth tokens start with "sk-ant-oat"
 * - opencode is OpenRouter api-key only in v1
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

/** Keychain service name of a default (no CLAUDE_CONFIG_DIR) claude install. */
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

/**
 * The macOS Keychain service name claude CLI stores its OAuth credentials
 * under. With no custom config dir it is the plain "Claude Code-credentials";
 * when CLAUDE_CONFIG_DIR is set, the CLI (observed in 2.1.201) appends
 * "-<first 8 hex chars of sha256(configDir)>" so each config home gets its
 * own item. The hash input is the raw env value NFC-normalized — not a
 * resolved path — so callers must pass the exact string they put in the env.
 */
export function claudeKeychainService(configDir?: string): string {
  if (!configDir) return CLAUDE_KEYCHAIN_SERVICE
  const hash = crypto.createHash('sha256')
    .update(configDir.normalize('NFC'))
    .digest('hex')
    .slice(0, 8)
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`
}

/**
 * On macOS, Claude Code stores OAuth credentials in the Keychain.
 * Fetch them via `security find-generic-password`. Exported for the daemon's
 * web sign-in flow, which watches the scratch config dir's own item (see
 * `claudeKeychainService`). Non-darwin: null.
 */
export function readClaudeKeychainPayload(
  service: string = CLAUDE_KEYCHAIN_SERVICE,
): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    )
    return out.trim()
  } catch {
    return null
  }
}

/**
 * Delete a scratch login's Keychain item once its credentials have been
 * persisted (or the flow abandoned) — live OAuth tokens must not linger in
 * items nothing reads anymore. Refuses the un-suffixed host service so no
 * caller bug can ever log the user's own claude install out. Missing items
 * and non-darwin are no-ops.
 */
export function deleteScratchClaudeKeychainItem(service: string): void {
  if (process.platform !== 'darwin' || service === CLAUDE_KEYCHAIN_SERVICE) return
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-s', service],
      { stdio: 'ignore', timeout: 5000 },
    )
  } catch {
    // never created (login failed before the CLI wrote it) — nothing to clean
  }
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
 * Result of running the tool's native login CLI.
 */
export interface ToolLoginResult {
  apiKey: string
  kind: ToolAuthKind
  /** Present when Claude OAuth login succeeded — the full bundle. */
  claudeBundle?: ClaudeOAuthBundle
  /** Present when Codex OAuth login succeeded — the full bundle. */
  codexBundle?: CodexOAuthBundle
  /** opencode only — backend the captured api-key authenticates against. */
  opencodeProvider?: OpencodeProvider
}

/**
 * The login-capture shortcuts that need no relayed flow: the e2e hook
 * (serialized bundle) and opencode's api-key prompt. Returns null for
 * claude/codex without a hook — those sign in through the relayed
 * auth-daemon flow (src/commands/relayed-login.ts), which persists the
 * bundle itself.
 */
export async function runToolLogin(tool: AgentTool): Promise<ToolLoginResult | null> {
  // Test-only hook: e2e-cli can't drive the native `claude login` /
  // `codex login` OAuth flow end-to-end, so these env vars short-circuit
  // with a JSON-serialised bundle. The CLI → daemon persistence path is
  // still exercised exactly as in production. opencode skips the native
  // CLI entirely (OpenRouter api-key only), so its hook payload is a
  // bare api-key string.
  const hookRaw = testEnv.toolLoginHook(tool)
  if (hookRaw) {
    if (tool === 'claude') {
      const bundle = claudeOAuthBundleSchema.parse(JSON.parse(hookRaw))
      return { apiKey: bundle.accessToken, kind: 'oauth', claudeBundle: bundle }
    }
    if (tool === 'codex') {
      const bundle = JSON.parse(hookRaw) as CodexOAuthBundle
      return { apiKey: bundle.accessToken, kind: 'oauth', codexBundle: bundle }
    }
    // opencode: the env var holds a raw api-key; an optional sibling var
    // picks the provider (defaults to openrouter) so e2e can drive the
    // NeuralWatt branch without a TTY.
    return {
      apiKey: hookRaw,
      kind: 'api-key',
      opencodeProvider: parseOpencodeProvider(testEnv.opencodeProviderHook),
    }
  }

  if (tool === 'opencode') {
    // No native login flow — OpenRouter is api-key only and we don't
    // shell out to `opencode auth login` in v1.
    return promptForApiKey(tool)
  }

  return null
}

/**
 * The `PUT /auth/:tool` request body: how a client (the CLI's api-key
 * path, or the auth daemon after a completed login) ships captured
 * credentials to the daemon.
 */
export type ToolAuthPayload =
  | { kind: 'api-key'; apiKey: string; provider?: OpencodeProvider }
  | { kind: 'oauth'; bundle: ClaudeOAuthBundle | CodexOAuthBundle }

/** Shape a login result into the `PUT /auth/:tool` body. */
export function buildAuthPayload(tool: AgentTool, result: ToolLoginResult): ToolAuthPayload {
  if (tool === 'claude' && result.kind === 'oauth' && result.claudeBundle) {
    return { kind: 'oauth', bundle: result.claudeBundle }
  }
  if (tool === 'codex' && result.kind === 'oauth' && result.codexBundle) {
    return { kind: 'oauth', bundle: result.codexBundle }
  }
  if (!result.apiKey) {
    throw new Error('No credentials captured from tool login.')
  }
  if (tool === 'opencode') {
    return {
      kind: 'api-key',
      apiKey: result.apiKey,
      provider: result.opencodeProvider ?? 'openrouter',
    }
  }
  return { kind: 'api-key', apiKey: result.apiKey }
}

/**
 * Coerce a raw provider string to an OpencodeProvider, defaulting to
 * 'openrouter' for anything unrecognized (including undefined).
 */
export function parseOpencodeProvider(value: string | undefined): OpencodeProvider {
  return value === 'neuralwatt' ? 'neuralwatt' : 'openrouter'
}

/**
 * Prompt for which backend an opencode api-key authenticates against.
 * Defaults to OpenRouter when the user just hits enter.
 */
async function promptForOpencodeProvider(
  rl: readline.Interface,
): Promise<OpencodeProvider> {
  console.log('Which opencode provider?')
  console.log('  1) OpenRouter (default)')
  console.log('  2) NeuralWatt')
  const answer = (await rl.question('Choice [1-2]: ')).trim()
  return answer === '2' ? 'neuralwatt' : 'openrouter'
}

/**
 * Prompt the user to paste their API key directly. For opencode, first asks
 * which provider the key belongs to so the session and proxy know which env
 * var / host to use.
 */
export async function promptForApiKey(tool: AgentTool): Promise<ToolLoginResult> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let opencodeProvider: OpencodeProvider | undefined
  if (tool === 'opencode') {
    opencodeProvider = await promptForOpencodeProvider(rl)
  }
  const label =
    tool === 'claude' ? 'Anthropic API key or OAuth token' :
    tool === 'codex' ? 'OpenAI API key' :
    opencodeProvider === 'neuralwatt' ? 'NeuralWatt API key' :
    'OpenRouter API key'
  const key = (await rl.question(`Paste your ${label}: `)).trim()
  rl.close()
  if (!key) {
    console.error('Key cannot be empty.')
    process.exit(1)
  }
  return { apiKey: key, kind: detectAuthKind(tool, key), opencodeProvider }
}

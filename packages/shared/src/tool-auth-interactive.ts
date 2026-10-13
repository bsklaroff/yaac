import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  claudeOAuthBundleSchema,
  type AgentTool,
  type ClaudeOAuthBundle,
  type CodexOAuthBundle,
  type ToolAuthKind,
  type ToolAuthPayload,
} from '#types'
import type { OpencodeProvider, PiProvider } from '#tool-providers'

/** A claude token starting with "sk-ant-oat" is OAuth; anything else is an api key. */
export function detectAuthKind(tool: AgentTool, token: string): ToolAuthKind {
  if (tool === 'claude') {
    if (token.startsWith('sk-ant-oat')) return 'oauth'
    return 'api-key'
  }
  return 'api-key'
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
  return claudeOAuthBundleSchema.safeParse((parsed as Record<string, unknown>).claudeAiOauth).data ?? null
}

/** Keychain service name of a default (no CLAUDE_CONFIG_DIR) claude install. */
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

/**
 * The macOS Keychain service name the claude CLI stores OAuth credentials
 * under. With CLAUDE_CONFIG_DIR set, the CLI (as of 2.1.201) appends
 * "-<first 8 hex of sha256(configDir)>". The hash is of the NFC-normalized
 * env value, not a resolved path, so pass the exact string set in the env.
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
 * Read a claude Keychain item via `security find-generic-password`. Null
 * when missing or not on macOS.
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
 * Read a Keychain item created by one of yaac's own claude invocations.
 * Refuses the unsuffixed service, which belongs to the user's own claude
 * install. Null when missing or not on macOS.
 */
export function readScopedClaudeKeychainPayload(service: string): string | null {
  if (service === CLAUDE_KEYCHAIN_SERVICE) return null
  return readClaudeKeychainPayload(service)
}

/**
 * Delete a Keychain item created by one of yaac's own claude invocations
 * (a finished or abandoned scratch login, or a project's item on
 * `auth clear`) so live tokens do not linger. Refuses the unsuffixed
 * service so the user's own claude install is never logged out. Missing
 * items and non-macOS are no-ops.
 */
export function deleteScopedClaudeKeychainItem(service: string): void {
  if (process.platform !== 'darwin' || service === CLAUDE_KEYCHAIN_SERVICE) return
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-s', service],
      { stdio: 'ignore', timeout: 5000 },
    )
  } catch {
    // item never created
  }
}

/**
 * A JWT's payload claims, or null if malformed. Does not verify the
 * signature, so only for reading claims, never for trusting them.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** A JWT's `exp` as unix epoch ms, or null if malformed or missing. */
export function decodeJwtExp(jwt: string): number | null {
  const exp = decodeJwtPayload(jwt)?.exp
  return typeof exp === 'number' ? exp * 1000 : null
}

/** A Codex bundle's expiry when its access token has no decodable `exp`:
 *  codex's proactive-refresh window, so the bundle still reads as live. */
export const CODEX_DEFAULT_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000

/**
 * Parse a Codex `auth.json` into an OAuth bundle. Null unless `auth_mode`
 * is ChatGPT (compared case-insensitively, as versions differ) and all
 * tokens are present. `expiresAt` comes from the access token's `exp`, or
 * now + 28d so the proxy still treats the bundle as live.
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

/** Credentials captured by a tool login. */
export interface ToolLoginResult {
  apiKey: string
  kind: ToolAuthKind
  claudeBundle?: ClaudeOAuthBundle
  codexBundle?: CodexOAuthBundle
  /** opencode only: the provider the api key is for. */
  opencodeProvider?: OpencodeProvider
  /** pi only: the provider the api key is for. */
  piProvider?: PiProvider
}

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
      // No default here, so the server's validation catches a missing one.
      provider: result.opencodeProvider,
    }
  }
  if (tool === 'pi') {
    return {
      kind: 'api-key',
      apiKey: result.apiKey,
      provider: result.piProvider,
    }
  }
  return { kind: 'api-key', apiKey: result.apiKey }
}

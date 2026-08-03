import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { execFileSync } from 'node:child_process'
import {
  claudeOAuthBundleSchema,
  type AgentTool,
  type ClaudeOAuthBundle,
  type CodexOAuthBundle,
  type ToolAuthKind,
} from '#types'
import {
  OPENCODE_DEFAULT_PROVIDER,
  OPENCODE_PROVIDERS,
  PI_DEFAULT_PROVIDER,
  PI_PROVIDERS,
  opencodeProviderInfo,
  parseOpencodeProvider,
  parsePiProvider,
  piProviderInfo,
  type OpencodeProvider,
  type PiProvider,
  type ToolProviderInfo,
} from '#tool-providers'
import { testEnv } from '#env'

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
 * Fetch them via `security find-generic-password`. Exported for the server's
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
  /** pi only — provider the captured api-key authenticates against. */
  piProvider?: PiProvider
}

/**
 * The login-capture shortcuts that need no relayed flow: the e2e hook
 * (serialized bundle) and opencode's api-key prompt. Returns null for
 * claude/codex without a hook — those sign in through the relayed
 * auth-daemon flow (src/commands/relayed-login.ts), which persists the
 * bundle itself.
 */
/**
 * Resolve an e2e provider hook: unset takes the tool's default (so a test that
 * only wants the default branch need not set it), but a value that is set and
 * unrecognized is a broken test rather than a request for the default —
 * silently substituting it would green a run that never exercised the branch
 * it named.
 */
function hookProvider<T extends string>(
  tool: 'opencode' | 'pi',
  raw: string | undefined,
  parse: (value: string | undefined) => T | undefined,
  defaultId: T,
): T {
  if (raw === undefined || raw === '') return defaultId
  const provider = parse(raw)
  if (!provider) {
    throw new Error(`${tool} provider hook names unknown provider "${raw}".`)
  }
  return provider
}

export async function runToolLogin(tool: AgentTool): Promise<ToolLoginResult | null> {
  // Test-only hook: e2e-cli can't drive the native `claude login` /
  // `codex login` OAuth flow end-to-end, so these env vars short-circuit
  // with a JSON-serialised bundle. The CLI → server persistence path is
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
    if (tool === 'pi') {
      // pi: the env var holds a raw api-key; an optional sibling var picks the
      // provider so e2e can drive any provider branch without a TTY.
      return {
        apiKey: hookRaw,
        kind: 'api-key',
        piProvider: hookProvider('pi', testEnv.piProviderHook, parsePiProvider, PI_DEFAULT_PROVIDER),
      }
    }
    // opencode: the env var holds a raw api-key; an optional sibling var
    // picks the provider (defaults to openrouter) so e2e can drive the
    // NeuralWatt branch without a TTY.
    return {
      apiKey: hookRaw,
      kind: 'api-key',
      opencodeProvider: hookProvider('opencode', testEnv.opencodeProviderHook, parseOpencodeProvider, OPENCODE_DEFAULT_PROVIDER),
    }
  }

  if (tool === 'opencode' || tool === 'pi') {
    // No native login flow — both are api-key only and we don't shell out to
    // a vendor `auth login` for them.
    return promptForApiKey(tool)
  }

  return null
}

/**
 * The `PUT /auth/:tool` request body: how a client (the CLI's api-key
 * path, or the auth server after a completed login) ships captured
 * credentials to the server.
 */
export type ToolAuthPayload =
  // `provider` is a raw wire string (opencode/pi), validated server-side
  // against that tool's registry — a missing or unknown id is rejected, never
  // coerced to a default.
  | { kind: 'api-key'; apiKey: string; provider?: string }
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
      // No fallback: an omitted provider must reach the server's validation
      // rather than being stamped with a default here, which would hide the
      // exact producer bug that validation exists to catch.
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

/**
 * Prompt for which provider an opencode/pi api-key authenticates against. Both
 * tools support 100+ / dozens of providers (a numbered menu is out), so the
 * user types the provider id; "?" lists them all and a bare Enter takes the
 * default. Re-prompts on an unrecognized id. Returns a raw string — the caller
 * coerces it with the tool's `parse*Provider`.
 */
async function promptForProvider<T extends string>(
  rl: readline.Interface,
  tool: 'opencode' | 'pi',
  list: readonly ToolProviderInfo[],
  defaultId: T,
): Promise<T> {
  console.log(`Which ${tool} provider? Type its id, "?" to list all ${list.length}, or Enter for "${defaultId}".`)
  for (;;) {
    const answer = (await rl.question(`Provider [${defaultId}]: `)).trim()
    if (!answer) return defaultId
    if (answer === '?') {
      for (const p of list) console.log(`  ${p.id}  —  ${p.label}`)
      continue
    }
    // The loop only exits on a registry entry, so the id is a T by
    // construction — callers need no second parse.
    const match = list.find((p) => p.id === answer)
    if (match) return match.id as T
    console.log(`Unknown provider "${answer}". Type "?" to see the full list.`)
  }
}

/**
 * Prompt the user to paste their API key directly. For opencode/pi, first asks
 * which provider the key belongs to so the session and proxy know which env
 * var / host to use.
 */
export async function promptForApiKey(tool: AgentTool): Promise<ToolLoginResult> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let opencodeProvider: OpencodeProvider | undefined
  let piProvider: PiProvider | undefined
  if (tool === 'opencode') {
    opencodeProvider = await promptForProvider(rl, 'opencode', OPENCODE_PROVIDERS, OPENCODE_DEFAULT_PROVIDER)
  }
  if (tool === 'pi') {
    piProvider = await promptForProvider(rl, 'pi', PI_PROVIDERS, PI_DEFAULT_PROVIDER)
  }
  const label =
    tool === 'claude' ? 'Anthropic API key or OAuth token' :
    tool === 'codex' ? 'OpenAI API key' :
    tool === 'opencode' && opencodeProvider ? `${opencodeProviderInfo(opencodeProvider).label} API key` :
    tool === 'pi' && piProvider ? `${piProviderInfo(piProvider).label} API key` :
    'API key'
  const key = (await rl.question(`Paste your ${label}: `)).trim()
  rl.close()
  if (!key) {
    console.error('Key cannot be empty.')
    process.exit(1)
  }
  return { apiKey: key, kind: detectAuthKind(tool, key), opencodeProvider, piProvider }
}

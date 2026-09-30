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

/** A claude token starting with "sk-ant-oat" is OAuth; anything else is an api key. */
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
 * A JWT's `exp` as unix epoch ms, or null if malformed or missing. Does not
 * verify the signature.
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

/**
 * Resolve an e2e provider hook. Unset means the tool's default; an unknown
 * value throws so a test never silently runs the wrong branch.
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

/**
 * The logins that need no relayed flow: the e2e login hook (a JSON bundle
 * for claude/codex, a raw api key for opencode/pi) and the opencode/pi
 * api-key prompt. Returns null for claude/codex without a hook; those sign
 * in through the relayed flow (packages/cli/src/commands/relayed-login.ts).
 */
export async function runToolLogin(tool: AgentTool): Promise<ToolLoginResult | null> {
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
      return {
        apiKey: hookRaw,
        kind: 'api-key',
        piProvider: hookProvider('pi', testEnv.piProviderHook, parsePiProvider, PI_DEFAULT_PROVIDER),
      }
    }
    return {
      apiKey: hookRaw,
      kind: 'api-key',
      opencodeProvider: hookProvider('opencode', testEnv.opencodeProviderHook, parseOpencodeProvider, OPENCODE_DEFAULT_PROVIDER),
    }
  }

  if (tool === 'opencode' || tool === 'pi') {
    return promptForApiKey(tool)
  }

  return null
}

/**
 * The `PUT /auth/:tool` request body carrying captured credentials. For
 * opencode/pi, `provider` is validated by the server; a missing or unknown
 * id is rejected rather than defaulted.
 */
export type ToolAuthPayload =
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

/**
 * Ask which provider an opencode/pi api key is for. There are too many for
 * a numbered menu, so the user types an id; "?" lists them and Enter takes
 * the default. Re-prompts on an unknown id.
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
    const match = list.find((p) => p.id === answer)
    if (match) return match.id as T
    console.log(`Unknown provider "${answer}". Type "?" to see the full list.`)
  }
}

/** Prompt the user to paste an API key, asking for the provider first on opencode/pi. */
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

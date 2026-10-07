import { ServerError } from '@yaac/shared/errors'
import {
  BUILT_IN_USER_ID,
  getToolCredential,
  listProjectRows,
  setToolCredential,
} from '#db'
import {
  parseOpencodeProvider,
  parsePiProvider,
} from '@yaac/shared/tool-providers'
import {
  claudeOAuthBundleSchema,
  codexOAuthBundleSchema,
  type AgentTool,
  type ClaudeOAuthBundle,
  type CodexOAuthBundle,
  type ToolAuthEntry,
  type ToolAuthPayload,
} from '@yaac/shared/types'

/**
 * Typed access to each user's tool sign-ins (`#db` tool_credentials), and
 * the owner keys the egress runtime files each user's credentials under.
 */

/**
 * The runtime owner key of the built-in user, which owned the install's one
 * credential set before credentials were per user. Every other user's key is
 * its id (docs/legacy-compat-shims.md "The built-in user's credentials keep
 * the `install` key").
 */
const BUILT_IN_OWNER_KEY = 'install'

/** The key a user's credentials are pushed under and their workspaces'
 *  egress registrations name. */
export function credentialOwnerKey(userId: string): string {
  return userId === BUILT_IN_USER_ID ? BUILT_IN_OWNER_KEY : userId
}

/**
 * The user an owner key names. `''` is where a proxy older than owner keys
 * left its captures, which were the built-in user's
 * (docs/legacy-compat-shims.md).
 */
export function ownerOfCredentialKey(key: string): string {
  return key === BUILT_IN_OWNER_KEY || key === '' ? BUILT_IN_USER_ID : key
}

/** The ids of a user's projects, whose tool homes hold that user's
 *  credentials. */
export async function ownedProjectIds(owner: string): Promise<string[]> {
  return (await listProjectRows()).filter((p) => p.owner === owner).map((p) => p.id)
}

/**
 * A user's sign-in for a tool as one entry, or null when signed out. A
 * literal tool narrows the result, e.g. `loadToolAuthEntry(owner, 'pi')`
 * has the pi variant's required `piProvider`.
 */
export async function loadToolAuthEntry<T extends AgentTool>(
  owner: string,
  tool: T,
): Promise<Extract<ToolAuthEntry, { tool: T }> | null> {
  // TS can't infer that each branch returns its own tool's variant.
  return loadEntry(owner, tool) as Promise<Extract<ToolAuthEntry, { tool: T }> | null>
}

async function loadEntry(owner: string, tool: AgentTool): Promise<ToolAuthEntry | null> {
  if (tool === 'claude') {
    const f = await getToolCredential(owner, 'claude')
    if (!f) return null
    const apiKey = f.kind === 'oauth' ? f.claudeAiOauth.accessToken : f.apiKey
    return { tool: 'claude', kind: f.kind, apiKey, savedAt: f.savedAt }
  }
  if (tool === 'opencode') {
    const f = await getToolCredential(owner, 'opencode')
    return f && { tool: 'opencode', kind: 'api-key', apiKey: f.apiKey, savedAt: f.savedAt, opencodeProvider: f.provider }
  }
  if (tool === 'pi') {
    const f = await getToolCredential(owner, 'pi')
    return f && { tool: 'pi', kind: 'api-key', apiKey: f.apiKey, savedAt: f.savedAt, piProvider: f.provider }
  }
  const f = await getToolCredential(owner, 'codex')
  if (!f) return null
  const apiKey = f.kind === 'oauth' ? f.codexOauth.accessToken : f.apiKey
  return { tool: 'codex', kind: f.kind, apiKey, savedAt: f.savedAt }
}

/** Store a full Claude OAuth bundle (refresh token, expiry, scopes). */
export async function saveClaudeOAuthBundle(owner: string, bundle: ClaudeOAuthBundle): Promise<void> {
  await setToolCredential(owner, 'claude', { kind: 'oauth', savedAt: new Date().toISOString(), claudeAiOauth: bundle })
}

/** Store a full Codex OAuth bundle (refresh token, expiry, id_token). */
export async function saveCodexOAuthBundle(owner: string, bundle: CodexOAuthBundle): Promise<void> {
  await setToolCredential(owner, 'codex', { kind: 'oauth', savedAt: new Date().toISOString(), codexOauth: bundle })
}

/**
 * Shorten a rejected value before echoing it. The field is free-form, so a
 * mis-pasted api key could land in it and then in responses and logs.
 */
function truncateForMessage(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value
}

/**
 * Parse a provider on a write path. A missing or unknown id throws rather
 * than being guessed, since the provider decides where the key is sent.
 */
function requireProvider<P>(tool: 'opencode' | 'pi', value: string | undefined, parse: (v: string | undefined) => P | undefined): P {
  const provider = parse(value)
  if (provider !== undefined) return provider
  const repair = `Run \`yaac auth update ${tool}\` or pass a provider id from \`yaac-mama models\`.`
  throw new ServerError(
    'VALIDATION',
    value === undefined || value === ''
      ? `${tool} credentials require a provider. ${repair}`
      : `Unknown ${tool} provider "${truncateForMessage(value)}". ${repair}`,
  )
}

/**
 * Store a user's api key for a tool. OAuth for claude and codex is stored
 * through the bundle savers, since an api key loses the refresh token.
 * `provider` is required for opencode and pi and validated against that
 * tool's registry; it is ignored for claude and codex.
 */
async function saveApiKey(owner: string, tool: AgentTool, apiKey: string, provider?: string): Promise<void> {
  const savedAt = new Date().toISOString()
  if (tool === 'opencode') {
    await setToolCredential(owner, 'opencode', {
      kind: 'api-key', provider: requireProvider('opencode', provider, parseOpencodeProvider), savedAt, apiKey,
    })
  } else if (tool === 'pi') {
    await setToolCredential(owner, 'pi', {
      kind: 'api-key', provider: requireProvider('pi', provider, parsePiProvider), savedAt, apiKey,
    })
  } else {
    await setToolCredential(owner, tool, { kind: 'api-key', savedAt, apiKey })
  }
}

/**
 * Store a `PUT /auth/:tool` body, already shaped by `toolAuthPayloadSchema`,
 * as the user's sign-in after checking it against the named tool. Throws
 * `VALIDATION` for another tool's OAuth bundle, OAuth for an api-key-only
 * tool, or a bad provider.
 */
export async function persistToolAuthPayload(owner: string, tool: AgentTool, payload: ToolAuthPayload): Promise<void> {
  if (payload.kind === 'api-key') return saveApiKey(owner, tool, payload.apiKey, payload.provider)
  if (tool === 'opencode' || tool === 'pi') {
    throw new ServerError('VALIDATION', `${tool} only supports api-key auth.`)
  }
  if (tool === 'claude') {
    const bundle = claudeOAuthBundleSchema.safeParse(payload.bundle)
    if (bundle.success) return saveClaudeOAuthBundle(owner, bundle.data)
  } else {
    const bundle = codexOAuthBundleSchema.safeParse(payload.bundle)
    if (bundle.success) return saveCodexOAuthBundle(owner, bundle.data)
  }
  throw new ServerError('VALIDATION', `The oauth bundle is not a valid ${tool} bundle.`)
}

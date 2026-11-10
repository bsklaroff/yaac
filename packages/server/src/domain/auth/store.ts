import { ServerError } from '@yaac/shared/errors'
import {
  BUILT_IN_USER_ID,
  getToolCredential,
  listProjectRows,
  setToolCredential,
} from '#db'
import { workspaceDriver } from '#drivers/driver'
import {
  CUSTOM_PROVIDER,
  isApiKeyTool,
  parseOmpProvider,
  parseOpencodeProvider,
  parsePiProvider,
  type ApiKeyTool,
  type CustomEndpoint,
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
 * The runtime owner key of the built-in user; every other user's key is its
 * id. Running workspaces' egress registrations name this key, so changing it
 * cuts them off from their credentials until they are recreated.
 */
const BUILT_IN_OWNER_KEY = 'install'

/**
 * The owner key a public site's release registers under
 * (docs/public-sites.md): no user's credentials are pushed under it, so the
 * proxy swaps no tool, git or ssh credential into a workspace that serves
 * the internet. A user's key is a uuid or `BUILT_IN_OWNER_KEY`, never this.
 */
export const NO_CREDENTIALS_OWNER_KEY = 'none'

/** The key a user's credentials are pushed under and their workspaces'
 *  egress registrations name. */
export function credentialOwnerKey(userId: string): string {
  return userId === BUILT_IN_USER_ID ? BUILT_IN_OWNER_KEY : userId
}

/** The user an owner key names. */
export function ownerOfCredentialKey(key: string): string {
  return key === BUILT_IN_OWNER_KEY ? BUILT_IN_USER_ID : key
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
    return f && {
      tool: 'opencode', kind: 'api-key', apiKey: f.apiKey, savedAt: f.savedAt, opencodeProvider: f.provider,
      ...(f.endpoint !== undefined ? { endpoint: f.endpoint } : {}),
    }
  }
  if (tool === 'pi') {
    const f = await getToolCredential(owner, 'pi')
    return f && {
      tool: 'pi', kind: 'api-key', apiKey: f.apiKey, savedAt: f.savedAt, piProvider: f.provider,
      ...(f.endpoint !== undefined ? { endpoint: f.endpoint } : {}),
    }
  }
  if (tool === 'omp') {
    const f = await getToolCredential(owner, 'omp')
    return f && {
      tool: 'omp', kind: 'api-key', apiKey: f.apiKey, savedAt: f.savedAt, ompProvider: f.provider,
      ...(f.endpoint !== undefined ? { endpoint: f.endpoint } : {}),
    }
  }
  const f = await getToolCredential(owner, 'codex')
  if (!f) return null
  const apiKey = f.kind === 'oauth' ? f.codexOauth.accessToken : f.apiKey
  return { tool: 'codex', kind: f.kind, apiKey, savedAt: f.savedAt }
}

/** An api-key tool's credential's provider; undefined for claude and codex,
 *  whose credential names none. */
export function authEntryProvider(entry: ToolAuthEntry | null | undefined): string | undefined {
  if (entry?.tool === 'opencode') return entry.opencodeProvider
  if (entry?.tool === 'pi') return entry.piProvider
  if (entry?.tool === 'omp') return entry.ompProvider
  return undefined
}

/** An api-key tool's credential's endpoint, when its provider is `custom`. */
export function authEntryEndpoint(entry: ToolAuthEntry | null | undefined): CustomEndpoint | undefined {
  return entry !== null && entry !== undefined && 'endpoint' in entry ? entry.endpoint : undefined
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
function requireProvider<P>(tool: ApiKeyTool, value: string | undefined, parse: (v: string | undefined) => P | undefined): P {
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
 * `provider` is required for an api-key tool and validated against that
 * tool's registry; it is ignored for claude and codex.
 */
async function saveApiKey(
  owner: string,
  tool: AgentTool,
  apiKey: string,
  provider?: string,
  endpoint?: CustomEndpoint,
): Promise<void> {
  const savedAt = new Date().toISOString()
  if (tool === 'opencode') {
    const parsed = requireProvider(tool, provider, parseOpencodeProvider)
    await setToolCredential(owner, tool, { ...apiKeyToolCredential(tool, parsed, apiKey, endpoint), savedAt })
  } else if (tool === 'pi') {
    const parsed = requireProvider(tool, provider, parsePiProvider)
    await setToolCredential(owner, tool, { ...apiKeyToolCredential(tool, parsed, apiKey, endpoint), savedAt })
  } else if (tool === 'omp') {
    const parsed = requireProvider(tool, provider, parseOmpProvider)
    await setToolCredential(owner, tool, { ...apiKeyToolCredential(tool, parsed, apiKey, endpoint), savedAt })
  } else {
    if (apiKey === '') throw new ServerError('VALIDATION', `${tool} needs an api key.`)
    if (endpoint !== undefined) throw new ServerError('VALIDATION', `${tool} does not take an endpoint.`)
    await setToolCredential(owner, tool, { kind: 'api-key', savedAt, apiKey })
  }
}

/**
 * An api-key tool's sign-in, checked: only the `custom` provider takes an
 * endpoint, which it requires, and only it may have an empty key. A key for
 * a plain-HTTP endpoint is refused where the proxy mediates egress: it never
 * injects a key over HTTP, so the endpoint would only see the placeholder.
 */
function apiKeyToolCredential<P extends string>(
  tool: ApiKeyTool,
  provider: P,
  apiKey: string,
  endpoint: CustomEndpoint | undefined,
): { kind: 'api-key'; provider: P; apiKey: string; endpoint?: CustomEndpoint } {
  const custom = provider === CUSTOM_PROVIDER
  if (custom && endpoint === undefined) {
    throw new ServerError('VALIDATION', `The custom ${tool} provider needs an endpoint URL and its models.`)
  }
  if (!custom && endpoint !== undefined) {
    throw new ServerError('VALIDATION', `Only the custom ${tool} provider takes an endpoint.`)
  }
  if (!custom && apiKey === '') throw new ServerError('VALIDATION', `${tool} needs an api key.`)
  if (endpoint !== undefined && apiKey !== '' && new URL(endpoint.baseUrl).protocol === 'http:'
    && workspaceDriver().kind === 'k8s') {
    throw new ServerError(
      'VALIDATION',
      'Cluster workspaces never send a key over plain HTTP, so this endpoint would only see a placeholder. '
        + 'Use an https:// URL, or save it without a key.',
    )
  }
  return { kind: 'api-key', provider, apiKey, ...(endpoint !== undefined ? { endpoint } : {}) }
}

/**
 * Store a `PUT /auth/:tool` body, already shaped by `toolAuthPayloadSchema`,
 * as the user's sign-in after checking it against the named tool. Throws
 * `VALIDATION` for another tool's OAuth bundle, OAuth for an api-key-only
 * tool, or a bad provider.
 */
export async function persistToolAuthPayload(owner: string, tool: AgentTool, payload: ToolAuthPayload): Promise<void> {
  if (payload.kind === 'api-key') return saveApiKey(owner, tool, payload.apiKey, payload.provider, payload.endpoint)
  if (isApiKeyTool(tool)) {
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

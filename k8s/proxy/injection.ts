/**
 * What the proxy injects into a MITM'd request: the registration's rules,
 * with secret refs resolved, and the tool and git credentials it swaps in
 * for placeholders (docs/workspace-egress.md). Pure functions over the
 * watched objects, read per request so edits apply at once.
 */

import type http from 'node:http'
import type { ProxyObjects } from './object-watch'
import type { HostInjectionRule } from './objects'

export const CLAUDE_TOKEN_URL_HOST = 'platform.claude.com'
export const CLAUDE_TOKEN_URL_PATH = '/v1/oauth/token'
const ANTHROPIC_API_HOST = 'api.anthropic.com'
// claude's claude.ai MCP connectors use the same OAuth bearer here. Without
// the swap, the placeholder gets a 401 and claude forces a refresh on every
// start.
const CLAUDE_MCP_PROXY_HOST = 'mcp-proxy.anthropic.com'
const OPENAI_API_HOST = 'api.openai.com'
export const OPENAI_TOKEN_URL_HOST = 'auth.openai.com'
export const OPENAI_TOKEN_URL_PATH = '/oauth/token'
// Codex in ChatGPT auth mode sends inference to chatgpt.com/backend-api, so
// that host gets the same Authorization swap.
const CHATGPT_HOST = 'chatgpt.com'

export const PLACEHOLDER_ACCESS_TOKEN = 'yaac-ph-access'
export const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'
export const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'
export const PLACEHOLDER_GH_TOKEN = 'yaac-ph-gh-token'

export type Injection =
  | { action: 'set_header'; name: string; value: string }
  | { action: 'replace_header'; name: string; value: string }
  | { action: 'remove_header'; name: string }
  | { action: 'replace_body_param'; name: string; value: string }

export type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

/**
 * Resolve a registration's injections into concrete values. An injection
 * whose secret ref does not resolve is dropped rather than sent empty. Refs
 * resolve only within the registration's own project.
 */
export function resolveRegisteredRules(
  objects: ProxyObjects,
  rules: HostInjectionRule[],
  projectSlug: string | undefined,
): InjectionRule[] {
  const out: InjectionRule[] = []
  for (const rule of rules) {
    const injections: Injection[] = []
    for (const inj of rule.injections) {
      if (inj.action === 'remove_header') {
        injections.push({ action: 'remove_header', name: inj.name })
        continue
      }
      let value = inj.value
      if (typeof value !== 'string' && inj.secretRef
        && projectSlug !== undefined && inj.secretRef.startsWith(`${projectSlug}/`)) {
        const secret = objects.secret(inj.secretRef)
        if (secret !== undefined) value = (inj.prefix ?? '') + secret
      }
      if (typeof value !== 'string') {
        console.error(`[proxy] Dropping injection for ${inj.name}: unresolvable secretRef ${inj.secretRef ?? '(none)'}`)
        continue
      }
      injections.push({ action: inj.action, name: inj.name, value })
    }
    out.push({ pathPattern: rule.pathPattern, injections })
  }
  return out
}

/** The host of an `https://` git remote naming a repo path, else null. */
function httpsRemoteHost(remoteUrl: string | undefined): string | null {
  if (!remoteUrl?.startsWith('https://')) return null
  try {
    const url = new URL(remoteUrl)
    return url.pathname.replace(/^\//, '').replace(/\.git$/, '') ? url.hostname : null
  } catch {
    return null
  }
}

/**
 * The HTTPS credential assigned to a workspace's project, with the host of
 * its https remote. Callers send the token only to that host.
 */
function resolveHttpsCredentialForWorkspace(objects: ProxyObjects, workspaceId: string): { token: string; host: string } | null {
  const registration = objects.registration(workspaceId)
  if (!registration) return null
  const entry = objects.credentials.git.find((e) => e.projects.includes(registration.projectSlug))
  if (!entry) return null
  const host = httpsRemoteHost(registration.repoUrl)
  return host ? { token: entry.token, host } : null
}

function pathMatches(requestPath: string, pattern: string): boolean {
  if (pattern === '/*' || pattern === '*') return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return requestPath === prefix || requestPath.startsWith(prefix + '/')
  }
  return requestPath === pattern
}

function hostMatches(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true
  if (!pattern.includes('*')) return false
  if (pattern.startsWith('*.') && !pattern.slice(2).includes('*')) {
    const suffix = pattern.slice(1) // e.g. ".example.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  // Other wildcards match label by label.
  const patternParts = pattern.split('.')
  const hostParts = hostname.split('.')
  if (patternParts.length !== hostParts.length) return false
  return patternParts.every((p, i) => p === '*' || p === hostParts[i])
}

export function findRulesForHost(objects: ProxyObjects, workspaceId: string, hostname: string): HostInjectionRule[] {
  const rules = objects.registration(workspaceId)?.rules
  if (!rules) return []
  return rules.filter((r) => hostMatches(hostname, r.hostPattern))
}

export function isHostAllowed(objects: ProxyObjects, workspaceId: string, hostname: string): boolean {
  const allowed = objects.registration(workspaceId)?.allowedHosts
  if (!allowed) return false
  if (allowed.length === 1 && allowed[0] === '*') return true
  return allowed.some((pattern) => hostMatches(hostname, pattern))
}

/**
 * True for git smart-HTTP endpoints (`info/refs` and the upload/receive-pack
 * RPCs), so a 401 from another API on the same host does not flag the git
 * credential.
 */
export function isGitSmartHttpPath(requestPath: string): boolean {
  const [pathname, query = ''] = requestPath.split('?', 2)
  if (pathname.endsWith('/info/refs')) {
    const service = new URLSearchParams(query).get('service')
    return service === 'git-upload-pack' || service === 'git-receive-pack'
  }
  return pathname.endsWith('/git-upload-pack') || pathname.endsWith('/git-receive-pack')
}

export function applyInjections(
  headers: http.OutgoingHttpHeaders,
  requestPath: string,
  rules: InjectionRule[],
): number {
  let count = 0
  for (const rule of rules) {
    if (!pathMatches(requestPath, rule.pathPattern)) continue
    for (const inj of rule.injections) {
      if (inj.action === 'replace_body_param') continue
      const headerLower = inj.name.toLowerCase()
      if (inj.action === 'set_header') {
        headers[headerLower] = inj.value
        count++
      } else if (inj.action === 'replace_header') {
        if (headers[headerLower] !== undefined) {
          headers[headerLower] = inj.value
          count++
        }
      } else if (inj.action === 'remove_header') {
        delete headers[headerLower]
        count++
      }
    }
  }
  return count
}

/** One body-parameter substitution, resolved and ready to apply. */
export type BodyParamSwap = { name: string; value: string }

export function collectBodyInjections(
  requestPath: string,
  rules: InjectionRule[],
): BodyParamSwap[] {
  const params: BodyParamSwap[] = []
  for (const rule of rules) {
    if (!pathMatches(requestPath, rule.pathPattern)) continue
    for (const inj of rule.injections) {
      if (inj.action === 'replace_body_param') {
        params.push({ name: inj.name, value: inj.value })
      }
    }
  }
  return params
}

/**
 * A request body's parameters: a JSON object when the content type says
 * JSON and it parses as one, else form-encoded.
 */
type BodyParams = { json: Record<string, unknown> } | { form: URLSearchParams }

function parseBodyParams(body: Buffer, contentType: string | undefined): BodyParams {
  const text = body.toString('utf8')
  if (contentType?.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object') return { json: parsed as Record<string, unknown> }
    } catch {
      // Not valid JSON: treat as form-encoded.
    }
  }
  return { form: new URLSearchParams(text) }
}

/** Replace each named parameter the body already carries. */
export function applyBodyInjections(
  body: Buffer,
  contentType: string | undefined,
  injections: BodyParamSwap[],
): Buffer {
  const params = parseBodyParams(body, contentType)
  for (const { name, value } of injections) {
    if ('json' in params) {
      if (name in params.json) params.json[name] = value
    } else if (params.form.has(name)) {
      params.form.set(name, value)
    }
  }
  return Buffer.from('json' in params ? JSON.stringify(params.json) : params.form.toString(), 'utf8')
}

/**
 * True if a JSON or form-encoded request body's `refresh_token` is the
 * placeholder. Only such requests get their response captured, so another
 * exchange on the same endpoint (e.g. `authorization_code`) cannot overwrite
 * the stored credential.
 */
export function bodyHasPlaceholderRefreshToken(body: Buffer, contentType: string | undefined): boolean {
  const params = parseBodyParams(body, contentType)
  const token = 'json' in params ? params.json.refresh_token : params.form.get('refresh_token')
  return token === PLACEHOLDER_REFRESH_TOKEN
}

/**
 * True for hosts the proxy MITMs to inject tool or git credentials,
 * independent of the workspace's registered rules. Port 22 is never MITM'd.
 */
export function hostNeedsDynamicMitm(
  objects: ProxyObjects,
  workspaceId: string,
  hostname: string,
  port: number,
): boolean {
  if (port === 22) return false
  if (hostname === ANTHROPIC_API_HOST || hostname === CLAUDE_MCP_PROXY_HOST) return true
  if (hostname === CLAUDE_TOKEN_URL_HOST) return true
  if (hostname === OPENAI_API_HOST) return true
  if (hostname === OPENAI_TOKEN_URL_HOST) return true
  if (hostname === CHATGPT_HOST) return true
  // opencode / pi: only the provider host the credential points at, and
  // only for a workspace running that tool.
  const tool = objects.registration(workspaceId)?.tool
  if (tool === 'opencode') {
    const creds = objects.credentials.opencode
    if (creds && hostname === creds.apiHost) return true
  }
  if (tool === 'pi') {
    const creds = objects.credentials.pi
    if (creds && hostname === creds.apiHost) return true
  }
  if (workspaceHasHttpsCredentialForHost(objects, workspaceId, hostname)) return true
  // gh CLI talks to api.github.com, not the git remote host.
  if (resolveGithubApiTokenForWorkspace(objects, workspaceId, hostname) !== null) return true
  return false
}

export function workspaceHasHttpsCredentialForHost(objects: ProxyObjects, workspaceId: string, hostname: string): boolean {
  const cred = resolveHttpsCredentialForWorkspace(objects, workspaceId)
  return cred?.host === hostname
}

/**
 * The API host `gh` uses for a git host. Mirrors ghApiHostForGitHost in
 * packages/shared/src/credentials.ts.
 */
function ghApiHostForGitHost(host: string): string | null {
  if (host === 'github.com') return 'api.github.com'
  return null
}

/**
 * The workspace's HTTPS git token, if `hostname` is the `gh` API host for
 * that credential's git host; otherwise null.
 */
function resolveGithubApiTokenForWorkspace(objects: ProxyObjects, workspaceId: string, hostname: string): string | null {
  const cred = resolveHttpsCredentialForWorkspace(objects, workspaceId)
  if (!cred) return null
  if (ghApiHostForGitHost(cred.host) !== hostname) return null
  return cred.token
}

function headerValue(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v[0]
  return undefined
}

/**
 * Swap the API-key placeholder for the real key on an opencode/pi request.
 * Providers differ on the header (`x-api-key` or `Authorization: Bearer`),
 * so the key goes wherever the placeholder is. A request without the
 * placeholder is left alone.
 */
function swapApiKeyHeader(
  rules: InjectionRule[],
  reqHeaders: http.IncomingHttpHeaders,
  apiKey: string,
): void {
  if (headerValue(reqHeaders, 'x-api-key') === PLACEHOLDER_API_KEY) {
    rules.push({
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'x-api-key', value: apiKey }],
    })
  } else if (headerValue(reqHeaders, 'authorization') === 'Bearer ' + PLACEHOLDER_API_KEY) {
    rules.push({
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: 'Bearer ' + apiKey }],
    })
  }
}

/**
 * Injection rules for `hostname` derived from the credentials Secret, built
 * per request so `yaac auth update` applies without restarts.
 *
 * Each tool credential swap fires only when the request carries the matching
 * placeholder, so a user's own key passes through unchanged. The rules here
 * don't check the workspace's tool, but they apply only to hosts the proxy
 * MITMs: the Claude and Codex hosts always, the opencode/pi provider host
 * only for a workspace of that tool (see `hostNeedsDynamicMitm`).
 */
export function buildDynamicRules(
  objects: ProxyObjects,
  workspaceId: string,
  hostname: string,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  const rules: InjectionRule[] = []

  // Git token, only to the workspace's https remote host.
  const httpsCred = resolveHttpsCredentialForWorkspace(objects, workspaceId)
  if (httpsCred && httpsCred.host === hostname) {
    const basic = 'Basic ' + Buffer.from(`x-access-token:${httpsCred.token}`).toString('base64')
    rules.push({
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: basic }],
    })
  }

  // gh sends GH_TOKEN's placeholder as `token <ph>` or `Bearer <ph>`; swap
  // in the project's git token and keep gh's scheme.
  const ghApiToken = resolveGithubApiTokenForWorkspace(objects, workspaceId, hostname)
  if (ghApiToken) {
    const incomingAuth = headerValue(reqHeaders, 'authorization')
    if (incomingAuth && incomingAuth.includes(PLACEHOLDER_GH_TOKEN)) {
      rules.push({
        pathPattern: '*',
        injections: [{
          action: 'set_header',
          name: 'Authorization',
          // Function replacer so a token with `$` can't trigger replace's
          // special-pattern substitution.
          value: incomingAuth.replace(PLACEHOLDER_GH_TOKEN, () => ghApiToken),
        }],
      })
    }
  }

  if (hostname === ANTHROPIC_API_HOST || hostname === CLAUDE_MCP_PROXY_HOST) {
    const creds = objects.credentials.claude
    const incomingApiKey = headerValue(reqHeaders, 'x-api-key')
    const incomingAuth = headerValue(reqHeaders, 'authorization')
    // The connectors' host takes only the claude.ai bearer, never a key.
    if (creds && creds.kind === 'api-key' && incomingApiKey === PLACEHOLDER_API_KEY
      && hostname === ANTHROPIC_API_HOST) {
      rules.push({
        pathPattern: '*',
        injections: [{ action: 'set_header', name: 'x-api-key', value: creds.apiKey }],
      })
    } else if (creds && creds.kind === 'oauth'
      && incomingAuth === 'Bearer ' + PLACEHOLDER_ACCESS_TOKEN) {
      rules.push({
        pathPattern: '*',
        injections: [{
          action: 'replace_header',
          name: 'Authorization',
          // The captured rotation while it is newer than the pushed bundle.
          value: 'Bearer ' + (objects.claudeOAuthBundle() ?? creds.bundle).accessToken,
        }],
      })
    }
  }

  // Codex sends either the API-key or the OAuth access-token placeholder as
  // a bearer. `ChatGPT-Account-Id` is already real and passes through.
  if (hostname === OPENAI_API_HOST || hostname === CHATGPT_HOST) {
    const creds = objects.credentials.codex
    const incomingAuth = headerValue(reqHeaders, 'authorization')
    if (creds && creds.kind === 'api-key'
      && incomingAuth === 'Bearer ' + PLACEHOLDER_API_KEY) {
      rules.push({
        pathPattern: '*',
        injections: [{
          action: 'set_header',
          name: 'Authorization',
          value: 'Bearer ' + creds.apiKey,
        }],
      })
    } else if (creds && creds.kind === 'oauth'
      && incomingAuth === 'Bearer ' + PLACEHOLDER_ACCESS_TOKEN) {
      rules.push({
        pathPattern: '*',
        injections: [{
          action: 'replace_header',
          name: 'Authorization',
          value: 'Bearer ' + (objects.codexOAuthBundle() ?? creds.bundle).accessToken,
        }],
      })
    }
  }

  // opencode / pi: API key on the credential's provider host.
  {
    const creds = objects.credentials.opencode
    if (creds && hostname === creds.apiHost) {
      swapApiKeyHeader(rules, reqHeaders, creds.apiKey)
    }
  }
  {
    const creds = objects.credentials.pi
    if (creds && hostname === creds.apiHost) {
      swapApiKeyHeader(rules, reqHeaders, creds.apiKey)
    }
  }

  return rules
}

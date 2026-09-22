/**
 * The Kubernetes objects the proxy is told through, and the ones it reports
 * through — their names, their labels, and the codecs between an object's
 * `data` and the proxy's in-memory views.
 *
 * Everything the proxy needs arrives as objects it watches (the credentials
 * Secret, one Secret per project's secret values, one ConfigMap per worktree
 * registration) and everything it reports goes out as objects the server
 * watches (the refreshed OAuth bundles, the CA, the blocked-host and
 * git-auth-failure records). One writer per object: the server writes the
 * inputs, this process writes the outputs, and nothing is ever read back
 * from the process that wrote it (docs/worktree-egress.md).
 *
 * Pure and unit-tested, like tools-report.ts: a decoder that goes wrong
 * fails SILENTLY — the credential simply does not arrive, or a registration
 * is dropped and the worktree fails closed — so the shapes are pinned here
 * rather than inside the listener that cannot be imported.
 *
 * Names and labels must match packages/server/src/drivers/k8s/substrate/
 * proxy-constants.ts (the proxy cannot import src/).
 */

import { OPENCODE_PROVIDER_HOSTS, PI_PROVIDER_HOSTS } from './tool-providers.generated'

/** Label naming which input an object is: `credentials`, `secrets` or
 *  `registration`. The server stamps it; the three informers select on it. */
export const LABEL_PROXY_INPUT = 'yaac.proxy-input'
/** Label naming which output an object is: `refreshed`, `ca` or `state`.
 *  Pre-created by the server (RBAC cannot scope `create` by name), written
 *  here, watched there. */
export const LABEL_PROXY_OUTPUT = 'yaac.proxy-output'
/** The worktree a registration ConfigMap belongs to — the same key every
 *  worktree pod carries (pod-watch.ts). */
export const LABEL_WORKTREE_ID = 'yaac.worktree-id'

export const CREDENTIALS_SECRET_NAME = 'yaac-proxy-credentials'
export const REFRESHED_SECRET_NAME = 'yaac-proxy-refreshed'
export const CA_SECRET_NAME = 'yaac-proxy-ca'
export const STATE_CONFIGMAP_NAME = 'yaac-proxy-state'

// ── Credential shapes ──────────────────────────────────────────────────

export type ClaudeOAuthBundle = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType?: string
}

export type ClaudeCreds =
  | { kind: 'oauth'; bundle: ClaudeOAuthBundle }
  | { kind: 'api-key'; apiKey: string }

export type CodexOAuthBundle = {
  accessToken: string
  refreshToken: string
  idTokenRawJwt: string
  expiresAt: number
  lastRefresh: string
  accountId?: string
}

export type CodexCreds =
  | { kind: 'oauth'; bundle: CodexOAuthBundle }
  | { kind: 'api-key'; apiKey: string }

export type OpencodeCreds = { kind: 'api-key'; apiKey: string; provider: string }

export type PiCreds = { kind: 'api-key'; apiKey: string; provider: string }

export type HttpsCredentialEntry = { pattern: string; token: string }

/** One ssh identity for the agent: the OpenSSH-encoded private key and the
 *  known_hosts line `ssh-add -h <host>` needs to constrain it. */
export type SshKeyEntry = { host: string; privateKey: string; knownHostsEntry: string }

/** Everything the credentials Secret carries, decoded. */
export type ProxyCredentials = {
  claude: ClaudeCreds | null
  codex: CodexCreds | null
  opencode: OpencodeCreds | null
  pi: PiCreds | null
  git: HttpsCredentialEntry[]
  ssh: SshKeyEntry[]
}

export const EMPTY_CREDENTIALS: ProxyCredentials = {
  claude: null, codex: null, opencode: null, pi: null, git: [], ssh: [],
}

// ── Registration shapes ────────────────────────────────────────────────

/**
 * An injection as registered. Instead of a literal `value`, it may carry a
 * `secretRef` naming one of the values in a project's secrets Secret (plus
 * an optional header `prefix`, e.g. "Bearer "). References keep
 * registrations secret-free; the value is resolved per request from the
 * secrets map, which also means a rotation applies to live worktrees
 * immediately.
 */
export type RegisteredInjection = {
  action: 'set_header' | 'replace_header' | 'remove_header' | 'replace_body_param'
  name: string
  value?: string
  secretRef?: string
  prefix?: string
}

export type HostInjectionRule = {
  hostPattern: string
  pathPattern: string
  injections: RegisteredInjection[]
}

/**
 * Per-worktree upstream redirect: when the proxy MITMs `hostname`, forward
 * the inner HTTP request to this target instead of the real upstream. Only
 * applied inside the MITM path — the client still sees a TLS handshake for
 * the original hostname, and credential injection still runs before
 * forward. Test-only: lets e2e route "api.anthropic.com" to a mock pod.
 */
export type UpstreamRedirect = { host: string; port: number; tls?: boolean }

/** One worktree's registration — the payload of its ConfigMap. */
export type WorktreeRegistration = {
  rules: HostInjectionRule[]
  /** Absent means block all — fail closed. */
  allowedHosts: string[]
  repoUrl?: string
  tool: string
  projectSlug: string
  upstreamRedirects?: Record<string, UpstreamRedirect>
}

// ── Output shapes ──────────────────────────────────────────────────────

export interface GitAuthFailureRecord {
  /** HTTP status the upstream returned (401 or 403). */
  status: number
  /** Epoch ms when the failure was first seen. */
  atMs: number
}

export type ProxyState = {
  /** worktreeId -> blocked hostnames */
  blockedHosts: Record<string, string[]>
  /** projectSlug -> failures by host */
  gitAuthFailures: Record<string, Array<{ host: string } & GitAuthFailureRecord>>
}

export type RefreshedBundles = { claude?: ClaudeOAuthBundle; codex?: CodexOAuthBundle }

export type CaMaterial = { keyPem: string; certPem: string }

/** The subset of a Secret / ConfigMap object the codecs read. */
export interface RawObject {
  metadata?: { name?: string; labels?: Record<string, string> }
  data?: Record<string, string>
}

// ── Git credential patterns ────────────────────────────────────────────

type ParsedPattern = { host: string; kind: 'any' | 'exact' | 'prefix'; path: string }

function isHostSegment(s: string): boolean {
  return s.includes('.') || s === 'localhost'
}

export function parsePattern(pattern: string): ParsedPattern | null {
  if (!pattern || pattern.includes(' ')) return null
  const parts = pattern.split('/')
  if (parts.length < 2) return null
  const host = parts[0]
  if (!host || host.includes('*') || !isHostSegment(host)) return null
  const rest = parts.slice(1)
  if (rest.length === 1 && rest[0] === '*') {
    return { host, kind: 'any', path: '' }
  }
  if (rest[rest.length - 1] === '*') {
    const prefixParts = rest.slice(0, -1)
    if (prefixParts.some((p) => !p || p.includes('*'))) return null
    return { host, kind: 'prefix', path: prefixParts.join('/') }
  }
  if (rest.some((p) => !p || p.includes('*'))) return null
  return { host, kind: 'exact', path: rest.join('/') }
}

export function matchPattern(pattern: string, host: string, path: string): boolean {
  const p = parsePattern(pattern)
  if (!p) return false
  if (p.host !== host) return false
  if (p.kind === 'any') return true
  if (p.kind === 'exact') return path === p.path
  return path === p.path || path.startsWith(p.path + '/')
}

/**
 * Patterns already complained about, so a dropped entry is named once
 * rather than on every credentials update. The server logs the same
 * rejection with the same rewrite (its `patternComplaint`); this side says
 * it too because the proxy is where the request that lost its credential
 * actually dies.
 */
const complainedPatterns = new Set<string>()

function complainAboutPattern(pattern: string): void {
  if (complainedPatterns.has(pattern)) return
  complainedPatterns.add(pattern)
  const qualified = `github.com/${pattern}`
  const complaint = parsePattern(qualified)
    ? `names no host — use "${qualified}" to mean the same thing on github.com`
    : 'is not a valid <host>/<path> pattern'
  console.log(`[proxy] ignoring git credential: pattern "${pattern}" ${complaint}`)
}

// ── Decoders ───────────────────────────────────────────────────────────

/** A Secret's `data` is base64; a ConfigMap's is plain text. */
function secretString(obj: RawObject, key: string): string | undefined {
  const raw = obj.data?.[key]
  return raw === undefined ? undefined : Buffer.from(raw, 'base64').toString('utf8')
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function decodeClaude(o: Record<string, unknown> | null): ClaudeCreds | null {
  if (!o) return null
  if (o.kind === 'oauth' && o.claudeAiOauth && typeof o.claudeAiOauth === 'object') {
    const b = o.claudeAiOauth as Record<string, unknown>
    if (typeof b.accessToken === 'string' && typeof b.refreshToken === 'string'
      && typeof b.expiresAt === 'number' && Array.isArray(b.scopes)) {
      return {
        kind: 'oauth',
        bundle: {
          accessToken: b.accessToken,
          refreshToken: b.refreshToken,
          expiresAt: b.expiresAt,
          scopes: b.scopes as string[],
          subscriptionType: typeof b.subscriptionType === 'string' ? b.subscriptionType : undefined,
        },
      }
    }
    return null
  }
  if (o.kind === 'api-key' && typeof o.apiKey === 'string' && o.apiKey) {
    return { kind: 'api-key', apiKey: o.apiKey }
  }
  return null
}

function decodeCodexBundle(b: unknown): CodexOAuthBundle | null {
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>
  if (typeof o.accessToken === 'string' && o.accessToken
    && typeof o.refreshToken === 'string' && o.refreshToken
    && typeof o.idTokenRawJwt === 'string' && o.idTokenRawJwt
    && typeof o.expiresAt === 'number'
    && typeof o.lastRefresh === 'string') {
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      idTokenRawJwt: o.idTokenRawJwt,
      expiresAt: o.expiresAt,
      lastRefresh: o.lastRefresh,
      accountId: typeof o.accountId === 'string' ? o.accountId : undefined,
    }
  }
  return null
}

function decodeCodex(o: Record<string, unknown> | null): CodexCreds | null {
  if (!o) return null
  if (o.kind === 'oauth') {
    const bundle = decodeCodexBundle(o.codexOauth)
    return bundle ? { kind: 'oauth', bundle } : null
  }
  if (o.kind === 'api-key' && typeof o.apiKey === 'string' && o.apiKey) {
    return { kind: 'api-key', apiKey: o.apiKey }
  }
  return null
}

/**
 * The provider must be recorded and known to this registry: it selects the
 * host the key is swapped on, so defaulting a missing one would inject the
 * key on a vendor the user never chose. Validated against the host map
 * rather than assumed — matching the server, which treats a credential
 * without a usable provider as unconfigured. Disagreeing here would report
 * the tool as authed on /tools while the server thinks it is not.
 *
 * hasOwn, not a truthiness index: the map is a plain object, so keys from
 * its prototype chain ("constructor", "toString", …) would index to a truthy
 * inherited member and pass.
 */
function decodeApiKeyTool(
  o: Record<string, unknown> | null,
  hosts: Record<string, string>,
): { kind: 'api-key'; apiKey: string; provider: string } | null {
  if (!o) return null
  if (o.kind !== 'api-key' || typeof o.apiKey !== 'string' || !o.apiKey) return null
  const provider = typeof o.provider === 'string' ? o.provider : ''
  if (!Object.hasOwn(hosts, provider)) return null
  return { kind: 'api-key', apiKey: o.apiKey, provider }
}

function decodeGit(o: Record<string, unknown> | null): HttpsCredentialEntry[] {
  if (!o || !Array.isArray(o.tokens)) return []
  const result: HttpsCredentialEntry[] = []
  for (const entry of o.tokens as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if ((e.kind ?? 'https') !== 'https') continue
    if (typeof e.pattern !== 'string' || typeof e.token !== 'string' || !e.token) continue
    if (!parsePattern(e.pattern)) {
      complainAboutPattern(e.pattern)
      continue
    }
    result.push({ pattern: e.pattern, token: e.token })
  }
  return result
}

function decodeSsh(text: string | undefined): SshKeyEntry[] {
  if (text === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: SshKeyEntry[] = []
  for (const entry of parsed as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.host !== 'string' || !e.host
      || typeof e.privateKey !== 'string' || !e.privateKey
      || typeof e.knownHostsEntry !== 'string' || !e.knownHostsEntry) continue
    out.push({ host: e.host, privateKey: e.privateKey, knownHostsEntry: e.knownHostsEntry })
  }
  return out
}

/**
 * The credentials Secret: one key per host-store file (`claude.json`,
 * `codex.json`, `opencode.json`, `pi.json`, `github.json`, each the file's
 * JSON verbatim) plus `ssh-keys.json`. A missing or malformed key reads as
 * "no credential of that kind", exactly as a missing file did.
 */
export function decodeCredentials(secret: RawObject): ProxyCredentials {
  return {
    claude: decodeClaude(parseJson(secretString(secret, 'claude.json'))),
    codex: decodeCodex(parseJson(secretString(secret, 'codex.json'))),
    opencode: decodeApiKeyTool(parseJson(secretString(secret, 'opencode.json')), OPENCODE_PROVIDER_HOSTS),
    pi: decodeApiKeyTool(parseJson(secretString(secret, 'pi.json')), PI_PROVIDER_HOSTS),
    git: decodeGit(parseJson(secretString(secret, 'github.json'))),
    ssh: decodeSsh(secretString(secret, 'ssh-keys.json')),
  }
}

/** A project's secrets Secret: `values.json` is `{ "<slug>/<NAME>": value }`.
 *  Empty or non-string values are dropped — never inject an empty credential. */
export function decodeProjectSecrets(secret: RawObject): Record<string, string> {
  const o = parseJson(secretString(secret, 'values.json'))
  const out: Record<string, string> = {}
  if (!o) return out
  for (const [ref, value] of Object.entries(o)) {
    if (typeof value === 'string' && value !== '') out[ref] = value
  }
  return out
}

function decodeRedirects(raw: unknown): Record<string, UpstreamRedirect> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const parsed: Record<string, UpstreamRedirect> = {}
  for (const [host, target] of Object.entries(raw as Record<string, unknown>)) {
    if (!target || typeof target !== 'object') continue
    const t = target as Record<string, unknown>
    if (typeof t.host === 'string' && typeof t.port === 'number') {
      parsed[host] = { host: t.host, port: t.port, tls: typeof t.tls === 'boolean' ? t.tls : undefined }
    }
  }
  return parsed
}

/**
 * A registration ConfigMap: the worktree id from its label and the payload
 * from `registration.json`. `tool` and `projectSlug` are required — all
 * agent-credential injection is gated on the tool, and git-auth-failure
 * records are keyed by the owning project — so a registration without them
 * is dropped, which fails that worktree closed rather than half-open.
 */
export function decodeRegistration(
  cm: RawObject,
): { worktreeId: string; registration: WorktreeRegistration } | null {
  const worktreeId = cm.metadata?.labels?.[LABEL_WORKTREE_ID]
  if (!worktreeId) return null
  const o = parseJson(cm.data?.['registration.json'])
  if (!o) return null
  if (!Array.isArray(o.rules) || !Array.isArray(o.allowedHosts)) return null
  if (typeof o.tool !== 'string' || !o.tool) return null
  if (typeof o.projectSlug !== 'string' || !o.projectSlug) return null
  return {
    worktreeId,
    registration: {
      rules: o.rules as HostInjectionRule[],
      allowedHosts: (o.allowedHosts as unknown[]).filter((h): h is string => typeof h === 'string'),
      repoUrl: typeof o.repoUrl === 'string' && o.repoUrl ? o.repoUrl : undefined,
      tool: o.tool,
      projectSlug: o.projectSlug,
      upstreamRedirects: decodeRedirects(o.upstreamRedirects),
    },
  }
}

/** The refreshed-bundles Secret, in the credentials-file shape per key. */
export function decodeRefreshed(secret: RawObject): RefreshedBundles {
  const claude = decodeClaude(parseJson(secretString(secret, 'claude.json')))
  const codex = decodeCodex(parseJson(secretString(secret, 'codex.json')))
  return {
    ...(claude?.kind === 'oauth' ? { claude: claude.bundle } : {}),
    ...(codex?.kind === 'oauth' ? { codex: codex.bundle } : {}),
  }
}

/** The CA Secret's key and cert, or null when either is absent. */
export function decodeCa(secret: RawObject): CaMaterial | null {
  const keyPem = secretString(secret, 'ca.key')
  const certPem = secretString(secret, 'ca.pem')
  return keyPem && certPem ? { keyPem, certPem } : null
}

/** The state ConfigMap. Malformed entries are dropped, never guessed at. */
export function decodeState(cm: RawObject): ProxyState {
  const state: ProxyState = { blockedHosts: {}, gitAuthFailures: {} }
  const blocked = parseJson(cm.data?.['blocked-hosts.json'])
  if (blocked) {
    for (const [sid, hosts] of Object.entries(blocked)) {
      if (!Array.isArray(hosts)) continue
      const valid = hosts.filter((h): h is string => typeof h === 'string')
      if (valid.length > 0) state.blockedHosts[sid] = valid
    }
  }
  const failures = parseJson(cm.data?.['git-auth-failures.json'])
  if (failures) {
    for (const [slug, entries] of Object.entries(failures)) {
      if (!Array.isArray(entries)) continue
      const valid: Array<{ host: string } & GitAuthFailureRecord> = []
      for (const e of entries as unknown[]) {
        if (!e || typeof e !== 'object') continue
        const { host, status, atMs } = e as Record<string, unknown>
        if (typeof host !== 'string' || typeof status !== 'number' || typeof atMs !== 'number') continue
        valid.push({ host, status, atMs })
      }
      if (valid.length > 0) state.gitAuthFailures[slug] = valid
    }
  }
  return state
}

// ── Encoders (what the proxy writes) ───────────────────────────────────

function secretData(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')]),
  )
}

/**
 * The refreshed-bundles Secret's `data`, one credentials-file per key —
 * the shape the server's own loaders read, so adopting one is a plain save.
 * Only the keys given are encoded; a merge patch leaves the other alone.
 */
export function encodeRefreshed(bundles: RefreshedBundles): Record<string, string> {
  const savedAt = new Date().toISOString()
  const entries: Record<string, string> = {}
  if (bundles.claude) {
    entries['claude.json'] = JSON.stringify(
      { kind: 'oauth', savedAt, claudeAiOauth: bundles.claude }, null, 2) + '\n'
  }
  if (bundles.codex) {
    entries['codex.json'] = JSON.stringify(
      { kind: 'oauth', savedAt, codexOauth: bundles.codex }, null, 2) + '\n'
  }
  return secretData(entries)
}

/** The CA Secret's `data`: the key, the cert, and the combined trust bundle
 *  `{system roots} ∪ {CA}` nested containers replace their trust set with. */
export function encodeCa(ca: CaMaterial & { bundlePem: string }): Record<string, string> {
  return secretData({ 'ca.key': ca.keyPem, 'ca.pem': ca.certPem, 'ca-bundle.pem': ca.bundlePem })
}

/** The state ConfigMap's `data` — plain text, as ConfigMaps are. */
export function encodeState(state: ProxyState): Record<string, string> {
  return {
    'blocked-hosts.json': JSON.stringify(state.blockedHosts, null, 2) + '\n',
    'git-auth-failures.json': JSON.stringify(state.gitAuthFailures, null, 2) + '\n',
  }
}

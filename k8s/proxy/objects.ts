/**
 * Names, labels and codecs for the Kubernetes objects the proxy reads and
 * writes (docs/workspace-egress.md). The server writes the inputs (the
 * credentials Secret, a secrets Secret per project, a registration ConfigMap
 * per workspace); the proxy writes the outputs (refreshed OAuth bundles, the
 * CA, blocked-host and git-auth-failure records). Each object has one writer.
 *
 * Kept pure so tests can pin the shapes: a broken decoder fails silently
 * (a credential never arrives, or a workspace fails closed).
 *
 * Names and labels must match packages/server/src/drivers/k8s/substrate/
 * proxy-constants.ts (the proxy cannot import server code).
 */

/** Label naming which input an object is: `credentials`, `secrets` or
 *  `registration`. The server stamps it; the three informers select on it. */
export const LABEL_PROXY_INPUT = 'yaac.proxy-input'
/** Label naming which output an object is: `refreshed`, `ca` or `state`.
 *  The server pre-creates these, since RBAC cannot scope `create` by name. */
export const LABEL_PROXY_OUTPUT = 'yaac.proxy-output'
/** The workspace a registration ConfigMap belongs to (same key as
 *  pod-watch.ts). */
export const LABEL_WORKSPACE_ID = 'yaac.workspace-id'

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

/** opencode and pi keys, with the provider host the server resolved. */
export type ApiKeyCreds = { kind: 'api-key'; apiKey: string; apiHost: string }

/** One HTTPS token and the ids of the projects it is assigned to — a
 *  workspace is handed it only when its registration names one of them. */
export type HttpsCredentialEntry = { token: string; projects: string[] }

/** One project an ssh key is assigned to: the host its remote names, and the
 *  known_hosts line that project trusts for it. */
export type SshProjectGrant = { projectId: string; host: string; knownHostsEntry: string }

/** One ssh identity: the OpenSSH private key, its public line
 *  (`<type> <base64 blob> <comment>`; the agent protocol identifies keys by
 *  the blob) and the projects it is assigned to. */
export type SshCredentialEntry = { privateKey: string; publicKey: string; projects: SshProjectGrant[] }

/** An owner key. No `.`, since a Secret key's owner ends at its first one.
 *  Must match PROXY_OWNER_KEY_PATTERN in the server's proxy-constants.ts. */
const OWNER_KEY = /^[\w-]+$/

/** One owner's credentials, decoded. */
export type ProxyCredentials = {
  claude: ClaudeCreds | null
  codex: CodexCreds | null
  opencode: ApiKeyCreds | null
  pi: ApiKeyCreds | null
  git: HttpsCredentialEntry[]
  ssh: SshCredentialEntry[]
}

export const EMPTY_CREDENTIALS: ProxyCredentials = {
  claude: null, codex: null, opencode: null, pi: null, git: [], ssh: [],
}

/**
 * The credentials Secret, decoded: owner key -> that owner's credentials.
 * An owner key is opaque to the proxy; a registration names one, and its
 * workspace is served only from that owner's set.
 */
export type OwnerCredentials = Map<string, ProxyCredentials>

// ── Registration shapes ────────────────────────────────────────────────

/**
 * An injection as registered. Instead of a literal `value`, it may carry a
 * `secretRef` naming a value in the project's secrets Secret (plus an
 * optional header `prefix`, e.g. "Bearer "). The reference is resolved per
 * request, so registrations hold no secrets and rotations apply at once.
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
 * Test-only upstream redirect: when the proxy MITMs a hostname, forward the
 * decrypted request here instead (e.g. "api.anthropic.com" to a mock pod).
 * The client still sees TLS for the original host, and injection still runs.
 */
export type UpstreamRedirect = { host: string; port: number; tls?: boolean }

/** One workspace's registration — the payload of its ConfigMap. */
export type ProxyRegistration = {
  rules: HostInjectionRule[]
  /** Absent means block all — fail closed. */
  allowedHosts: string[]
  repoUrl?: string
  tool: string
  projectId: string
  /** The owner key whose credentials this workspace spends. Absent only on
   *  a registration written before owner keys (docs/legacy-compat-shims.md). */
  owner?: string
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
  /** workspaceId -> blocked hostnames */
  blockedHosts: Record<string, string[]>
  /** project id -> failures by host */
  gitAuthFailures: Record<string, Array<{ host: string } & GitAuthFailureRecord>>
}

export type RefreshedBundles = { claude?: ClaudeOAuthBundle; codex?: CodexOAuthBundle }

/** The refreshed Secret, decoded: owner key -> that owner's captures. */
export type OwnerRefreshedBundles = Map<string, RefreshedBundles>

export type CaMaterial = { keyPem: string; certPem: string }

/** The subset of a Secret / ConfigMap object the codecs read. */
export interface RawObject {
  metadata?: { name?: string; labels?: Record<string, string> }
  data?: Record<string, string>
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

function parseJsonArray(text: string | undefined): unknown[] {
  if (text === undefined) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
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
 * Decode an opencode or pi key. Without a host the key has nowhere it may
 * go, so it counts as unconfigured.
 */
function decodeApiKeyTool(o: Record<string, unknown> | null): ApiKeyCreds | null {
  if (!o) return null
  if (o.kind !== 'api-key' || typeof o.apiKey !== 'string' || !o.apiKey) return null
  if (typeof o.apiHost !== 'string' || !o.apiHost) return null
  return { kind: 'api-key', apiKey: o.apiKey, apiHost: o.apiHost }
}

/** The canonicalized base64 key blob (second field) of an OpenSSH public
 *  key line, or null when the line has none. */
export function publicKeyBlob(publicKey: string): string | null {
  const field = publicKey.trim().split(/\s+/)[1]
  if (!field) return null
  const canonical = Buffer.from(field, 'base64').toString('base64')
  return canonical === field ? canonical : null
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

function decodeGit(entries: unknown[]): HttpsCredentialEntry[] {
  const out: HttpsCredentialEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (!nonEmpty(e.token) || !Array.isArray(e.projects)) continue
    out.push({ token: e.token, projects: e.projects.filter(nonEmpty) })
  }
  return out
}

function decodeSshGrant(grant: unknown): SshProjectGrant | null {
  if (!grant || typeof grant !== 'object') return null
  const { projectId, host, knownHostsEntry } = grant as Record<string, unknown>
  return nonEmpty(projectId) && nonEmpty(host) && nonEmpty(knownHostsEntry) ? { projectId, host, knownHostsEntry } : null
}

/** Keys whose public line has no blob are dropped; the relay can't use them. */
function decodeSsh(entries: unknown[]): SshCredentialEntry[] {
  const out: SshCredentialEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (!nonEmpty(e.privateKey) || !nonEmpty(e.publicKey) || publicKeyBlob(e.publicKey) === null
      || !Array.isArray(e.projects)) continue
    const projects = e.projects.map(decodeSshGrant).filter((g): g is SshProjectGrant => g !== null)
    out.push({ privateKey: e.privateKey, publicKey: e.publicKey, projects })
  }
  return out
}

/**
 * The canonical base64 host keys of known_hosts lines (`hosts type key
 * [comment]`). A line with a marker is skipped: `@revoked` must never grant,
 * and a `@cert-authority` key is a CA's, never the host key a client binds.
 */
function knownHostKeyBlobs(knownHosts: string): string[] {
  const out: string[] = []
  for (const line of knownHosts.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields[0]?.startsWith('@')) continue
    const blob = publicKeyBlob(fields.slice(1).join(' '))
    if (blob !== null) out.push(blob)
  }
  return out
}

/**
 * What a workspace of `projectId` may sign with: each assigned key's blob
 * (publicKeyBlob) → the host keys of the hosts it is granted for there.
 * The agent's own `-h` constraint is the union over every grant of a key,
 * so the relay checks the bound host against this narrower set.
 */
export function sshGrantsForProject(ssh: SshCredentialEntry[], projectId: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const entry of ssh) {
    const blob = publicKeyBlob(entry.publicKey)
    if (blob === null) continue
    for (const grant of entry.projects) {
      if (grant.projectId !== projectId) continue
      let hostKeys = out.get(blob)
      if (!hostKeys) out.set(blob, hostKeys = new Set())
      for (const hostKey of knownHostKeyBlobs(grant.knownHostsEntry)) hostKeys.add(hostKey)
    }
  }
  return out
}

/**
 * Split a Secret's keys `<owner>.<file>.json` into each owner's files. Owner
 * keys hold no `.`, so the first one ends the owner. A bare file name (no
 * owner) is skipped.
 */
function filesByOwner(secret: RawObject): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  for (const key of Object.keys(secret.data ?? {})) {
    const dot = key.indexOf('.')
    if (dot <= 0 || !key.slice(dot + 1).includes('.') || !OWNER_KEY.test(key.slice(0, dot))) continue
    const owner = key.slice(0, dot)
    let files = out.get(owner)
    if (!files) out.set(owner, files = new Map<string, string>())
    files.set(key.slice(dot + 1), secretString(secret, key)!)
  }
  return out
}

/**
 * The credentials Secret: per owner, one key per tool's credentials file
 * (`<owner>.claude.json`, `.codex.json`, `.opencode.json`, `.pi.json`), plus
 * `<owner>.git-tokens.json` and `<owner>.ssh-keys.json`, JSON arrays of
 * project-scoped entries. A missing or malformed key means no credential of
 * that kind; a malformed entry is dropped on its own.
 */
export function decodeCredentials(secret: RawObject): OwnerCredentials {
  const out: OwnerCredentials = new Map()
  for (const [owner, files] of filesByOwner(secret)) {
    out.set(owner, {
      claude: decodeClaude(parseJson(files.get('claude.json'))),
      codex: decodeCodex(parseJson(files.get('codex.json'))),
      opencode: decodeApiKeyTool(parseJson(files.get('opencode.json'))),
      pi: decodeApiKeyTool(parseJson(files.get('pi.json'))),
      git: decodeGit(parseJsonArray(files.get('git-tokens.json'))),
      ssh: decodeSsh(parseJsonArray(files.get('ssh-keys.json'))),
    })
  }
  return out
}

/** A project's secrets Secret: `values.json` is `{ "<projectId>/<NAME>": value }`.
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
 * A registration ConfigMap: the workspace id from its label and the payload
 * from `registration.json`. A registration missing `tool` or `projectId`, or
 * with a malformed `owner`, is dropped, so that workspace fails closed.
 */
export function decodeRegistration(
  cm: RawObject,
): { workspaceId: string; registration: ProxyRegistration } | null {
  const workspaceId = cm.metadata?.labels?.[LABEL_WORKSPACE_ID]
  if (!workspaceId) return null
  const o = parseJson(cm.data?.['registration.json'])
  if (!o) return null
  if (!Array.isArray(o.rules) || !Array.isArray(o.allowedHosts)) return null
  if (typeof o.tool !== 'string' || !o.tool) return null
  if (typeof o.projectId !== 'string' || !o.projectId) return null
  // Absent only on a registration from before owner keys; present, it must
  // be a key the credentials Secret could hold.
  if (o.owner !== undefined && (typeof o.owner !== 'string' || !OWNER_KEY.test(o.owner))) return null
  return {
    workspaceId,
    registration: {
      rules: o.rules as HostInjectionRule[],
      allowedHosts: (o.allowedHosts as unknown[]).filter((h): h is string => typeof h === 'string'),
      repoUrl: typeof o.repoUrl === 'string' && o.repoUrl ? o.repoUrl : undefined,
      tool: o.tool,
      projectId: o.projectId,
      owner: o.owner,
      upstreamRedirects: decodeRedirects(o.upstreamRedirects),
    },
  }
}

function decodeRefreshedFiles(files: Map<string, string>): RefreshedBundles {
  const claude = decodeClaude(parseJson(files.get('claude.json')))
  const codex = decodeCodex(parseJson(files.get('codex.json')))
  return {
    ...(claude?.kind === 'oauth' ? { claude: claude.bundle } : {}),
    ...(codex?.kind === 'oauth' ? { codex: codex.bundle } : {}),
  }
}

/** The refreshed-bundles Secret: `<owner>.claude.json` and
 *  `<owner>.codex.json`, each in the credentials-file shape. */
export function decodeRefreshed(secret: RawObject): OwnerRefreshedBundles {
  const out: OwnerRefreshedBundles = new Map()
  for (const [owner, files] of filesByOwner(secret)) out.set(owner, decodeRefreshedFiles(files))
  return out
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
    for (const [projectId, entries] of Object.entries(failures)) {
      if (!Array.isArray(entries)) continue
      const valid: Array<{ host: string } & GitAuthFailureRecord> = []
      for (const e of entries as unknown[]) {
        if (!e || typeof e !== 'object') continue
        const { host, status, atMs } = e as Record<string, unknown>
        if (typeof host !== 'string' || typeof status !== 'number' || typeof atMs !== 'number') continue
        valid.push({ host, status, atMs })
      }
      if (valid.length > 0) state.gitAuthFailures[projectId] = valid
    }
  }
  return state
}

// ── Encoders ───────────────────────────────────────────────────────────

function secretData(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')]),
  )
}

/**
 * The refreshed-bundles Secret's `data`, one credentials file per owner and
 * tool, in the shape the server's loaders read. Only the given slots are
 * encoded, so a merge patch leaves every other owner and tool untouched.
 */
export function encodeRefreshed(bundles: OwnerRefreshedBundles): Record<string, string> {
  const savedAt = new Date().toISOString()
  const entries: Record<string, string> = {}
  for (const [owner, { claude, codex }] of bundles) {
    if (claude) {
      entries[`${owner}.claude.json`] = JSON.stringify(
        { kind: 'oauth', savedAt, claudeAiOauth: claude }, null, 2) + '\n'
    }
    if (codex) {
      entries[`${owner}.codex.json`] = JSON.stringify(
        { kind: 'oauth', savedAt, codexOauth: codex }, null, 2) + '\n'
    }
  }
  return secretData(entries)
}

/** The CA Secret's `data`: key, cert, and the system roots plus the CA as
 *  one trust bundle for nested containers. */
export function encodeCa(ca: CaMaterial & { bundlePem: string }): Record<string, string> {
  return secretData({ 'ca.key': ca.keyPem, 'ca.pem': ca.certPem, 'ca-bundle.pem': ca.bundlePem })
}

/** The state ConfigMap's `data`. */
export function encodeState(state: ProxyState): Record<string, string> {
  return {
    'blocked-hosts.json': JSON.stringify(state.blockedHosts, null, 2) + '\n',
    'git-auth-failures.json': JSON.stringify(state.gitAuthFailures, null, 2) + '\n',
  }
}

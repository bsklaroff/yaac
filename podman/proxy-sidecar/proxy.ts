/**
 * MITM proxy sidecar for agent session containers.
 *
 * - Generates a self-signed CA on startup (persisted to /data/)
 * - Accepts per-session rules and allowlists via HTTP API
 * - Handles CONNECT tunneling: MITMs TLS when rules match, tunnels otherwise
 * - Reads GitHub / Claude / Codex credentials directly from the host-mounted
 *   `/yaac-credentials/` directory at request time, so updates to tokens via
 *   `yaac auth update` flow into every running session without a restart.
 * - Swaps placeholder tokens for real Claude OAuth credentials and writes
 *   refreshed tokens back to the host-mounted credentials file.
 *
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import type { Duplex } from 'node:stream'
import forge from 'node-forge'

const PORT = process.env.PORT
const PROXY_AUTH_SECRET = process.env.PROXY_AUTH_SECRET
if (!PORT || !PROXY_AUTH_SECRET) {
  console.error('[proxy] PORT and PROXY_AUTH_SECRET environment variables are required')
  process.exit(1)
}
const DATA_DIR = '/data'

// Host-mounted credentials directory. The entire `~/.yaac/.credentials/`
// directory is bind-mounted RW so the proxy can read every service's
// credentials at request time and write refreshed Claude OAuth bundles back.
const CREDENTIALS_DIR = '/yaac-credentials'
const GITHUB_CREDS_FILE = path.join(CREDENTIALS_DIR, 'github.json')
const CLAUDE_CREDS_FILE = path.join(CREDENTIALS_DIR, 'claude.json')
const CODEX_CREDS_FILE = path.join(CREDENTIALS_DIR, 'codex.json')

const CLAUDE_TOKEN_URL_HOST = 'platform.claude.com'
const CLAUDE_TOKEN_URL_PATH = '/v1/oauth/token'
const ANTHROPIC_API_HOST = 'api.anthropic.com'
const GITHUB_HOSTS = new Set(['github.com', 'api.github.com'])
const OPENAI_API_HOST = 'api.openai.com'
const OPENAI_TOKEN_URL_HOST = 'auth.openai.com'
const OPENAI_TOKEN_URL_PATH = '/oauth/token'
const CODEX_DEFAULT_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000

// ── Types ──────────────────────────────────────────────────────────────

type CA = {
  key: forge.pki.rsa.PrivateKey
  cert: forge.pki.Certificate
  pem: string
}

type LeafEntry = { key: string; cert: string; expires: number }

type ClaudeOAuthBundle = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType?: string
}

type ClaudeCreds =
  | { kind: 'oauth'; bundle: ClaudeOAuthBundle }
  | { kind: 'api-key'; apiKey: string }

type CodexOAuthBundle = {
  accessToken: string
  refreshToken: string
  idTokenRawJwt: string
  expiresAt: number
  lastRefresh: string
  accountId?: string
}

type CodexCreds =
  | { kind: 'oauth'; bundle: CodexOAuthBundle }
  | { kind: 'api-key'; apiKey: string }

type GithubTokenEntry = { pattern: string; token: string }

type Injection =
  | { action: 'set_header'; name: string; value: string }
  | { action: 'replace_header'; name: string; value: string }
  | { action: 'remove_header'; name: string }
  | { action: 'replace_body_param'; name: string; value: string }

type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

type HostInjectionRule = InjectionRule & { hostPattern: string }

// ── CA Certificate Management ──────────────────────────────────────────

let ca: CA | null = null

const leafCache = new Map<string, LeafEntry>()

const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000
const LEAF_REFRESH_MS = 60 * 60 * 1000

function loadOrGenerateCA(): CA {
  const keyPath = path.join(DATA_DIR, 'ca.key')
  const certPath = path.join(DATA_DIR, 'ca.pem')

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const keyPem = fs.readFileSync(keyPath, 'utf8')
    const certPem = fs.readFileSync(certPath, 'utf8')
    const key = forge.pki.privateKeyFromPem(keyPem)
    const cert = forge.pki.certificateFromPem(certPem)
    console.log('[proxy] Loaded existing CA from disk')
    return { key, cert, pem: certPem }
  }

  console.log('[proxy] Generating new CA...')
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10)

  const attrs = [{ name: 'commonName', value: 'yaac Proxy CA' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  const certPem = forge.pki.certificateToPem(cert)

  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 })
  fs.writeFileSync(certPath, certPem)
  console.log('[proxy] CA generated and saved to disk')

  return { key: keys.privateKey, cert, pem: certPem }
}

function getLeafCert(hostname: string): { key: string; cert: string } {
  const cached = leafCache.get(hostname)
  const now = Date.now()
  if (cached && (cached.expires - LEAF_REFRESH_MS) > now) {
    return { key: cached.key, cert: cached.cert }
  }

  if (!ca) throw new Error('CA not initialized')

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  const serialBytes = crypto.randomBytes(16)
  serialBytes[0] &= 0x7f // clear high bit to ensure positive integer
  cert.serialNumber = serialBytes.toString('hex')
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(now + LEAF_VALIDITY_MS)

  cert.setSubject([{ name: 'commonName', value: hostname }])
  cert.setIssuer(ca.cert.subject.attributes)
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ])
  cert.sign(ca.key, forge.md.sha256.create())

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  const certPem = forge.pki.certificateToPem(cert)

  leafCache.set(hostname, { key: keyPem, cert: certPem, expires: now + LEAF_VALIDITY_MS })
  return { key: keyPem, cert: certPem }
}

// ── Credential Readers ─────────────────────────────────────────────────

/**
 * Parse the host-mounted claude.json. Returns either an OAuth bundle or an
 * api-key entry, depending on the file's `kind` field.
 */
function readClaudeCreds(): ClaudeCreds | null {
  try {
    const raw = fs.readFileSync(CLAUDE_CREDS_FILE, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'oauth' && o.claudeAiOauth && typeof o.claudeAiOauth === 'object') {
      const b = o.claudeAiOauth as Record<string, unknown>
      if (typeof b.accessToken === 'string' && typeof b.refreshToken === 'string'
        && typeof b.expiresAt === 'number' && Array.isArray(b.scopes)) {
        const bundle: ClaudeOAuthBundle = {
          accessToken: b.accessToken,
          refreshToken: b.refreshToken,
          expiresAt: b.expiresAt,
          scopes: b.scopes as string[],
          subscriptionType: typeof b.subscriptionType === 'string' ? b.subscriptionType : undefined,
        }
        return { kind: 'oauth', bundle }
      }
      return null
    }
    if (o.kind === 'api-key' && typeof o.apiKey === 'string' && o.apiKey) {
      return { kind: 'api-key', apiKey: o.apiKey }
    }
    return null
  } catch {
    return null
  }
}

function readClaudeOAuthBundle(): ClaudeOAuthBundle | null {
  const creds = readClaudeCreds()
  return creds && creds.kind === 'oauth' ? creds.bundle : null
}

function readCodexCreds(): CodexCreds | null {
  try {
    const raw = fs.readFileSync(CODEX_CREDS_FILE, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'oauth' && o.codexOauth && typeof o.codexOauth === 'object') {
      const b = o.codexOauth as Record<string, unknown>
      if (typeof b.accessToken === 'string' && b.accessToken
        && typeof b.refreshToken === 'string' && b.refreshToken
        && typeof b.idTokenRawJwt === 'string' && b.idTokenRawJwt
        && typeof b.expiresAt === 'number'
        && typeof b.lastRefresh === 'string') {
        const bundle: CodexOAuthBundle = {
          accessToken: b.accessToken,
          refreshToken: b.refreshToken,
          idTokenRawJwt: b.idTokenRawJwt,
          expiresAt: b.expiresAt,
          lastRefresh: b.lastRefresh,
          accountId: typeof b.accountId === 'string' ? b.accountId : undefined,
        }
        return { kind: 'oauth', bundle }
      }
      return null
    }
    if (o.kind === 'api-key' && typeof o.apiKey === 'string' && o.apiKey) {
      return { kind: 'api-key', apiKey: o.apiKey }
    }
    return null
  } catch {
    return null
  }
}

function readCodexOAuthBundle(): CodexOAuthBundle | null {
  const creds = readCodexCreds()
  return creds && creds.kind === 'oauth' ? creds.bundle : null
}

/** Decode a JWT's payload and return `exp` as unix epoch ms, or null. */
function decodeJwtExp(jwt: string): number | null {
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

function readGithubTokens(): GithubTokenEntry[] {
  try {
    const raw = fs.readFileSync(GITHUB_CREDS_FILE, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return []
    const o = parsed as Record<string, unknown>
    if (!Array.isArray(o.tokens)) return []
    const result: GithubTokenEntry[] = []
    for (const entry of o.tokens as unknown[]) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>
        if (typeof e.pattern === 'string' && typeof e.token === 'string' && e.token !== '') {
          result.push({ pattern: e.pattern, token: e.token })
        }
      }
    }
    return result
  } catch {
    return []
  }
}

/**
 * Mirrors `matchPattern` / `resolveTokenForUrl` from src/lib/project/credentials.ts.
 * Patterns: "*", "owner/*", "owner/repo".
 */
function matchGithubPattern(pattern: string, owner: string, repo: string): boolean {
  if (pattern === '*') return true
  const parts = pattern.split('/')
  if (parts.length !== 2) return false
  const [patOwner, patRepo] = parts
  if (patOwner !== owner) return false
  if (patRepo === '*') return true
  return patRepo === repo
}

/** Extract owner/repo from a GitHub remote URL. Returns null on failure. */
function parseRepoUrl(remoteUrl: string | undefined): { owner: string; repo: string } | null {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null
  try {
    const url = new URL(remoteUrl)
    const segments = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
    if (segments.length < 2 || !segments[0] || !segments[1]) return null
    return { owner: segments[0], repo: segments[1] }
  } catch {
    return null
  }
}

/** Resolve the GitHub token for a given repo URL using the on-disk token list. */
function resolveGithubToken(repoUrl: string | undefined): string | null {
  const tokens = readGithubTokens()
  if (tokens.length === 0) return null
  const parsed = parseRepoUrl(repoUrl)
  if (!parsed) {
    // No repo context — fall back to the first catch-all entry if present.
    const catchAll = tokens.find((t) => t.pattern === '*')
    return catchAll?.token ?? null
  }
  for (const entry of tokens) {
    if (matchGithubPattern(entry.pattern, parsed.owner, parsed.repo)) {
      return entry.token
    }
  }
  return null
}

/** Atomic write via rename — keeps the inode path valid for concurrent readers. */
function writeClaudeOAuthBundle(bundle: ClaudeOAuthBundle): void {
  const payload = {
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    claudeAiOauth: bundle,
  }
  const tmp = CLAUDE_CREDS_FILE + '.tmp-' + crypto.randomBytes(6).toString('hex')
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, CLAUDE_CREDS_FILE)
}

function writeCodexOAuthBundle(bundle: CodexOAuthBundle): void {
  const payload = {
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    codexOauth: bundle,
  }
  const tmp = CODEX_CREDS_FILE + '.tmp-' + crypto.randomBytes(6).toString('hex')
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, CODEX_CREDS_FILE)
}

// ── Secret Store ───────────────────────────────────────────────────────
//
// All per-tenant state is keyed by sessionId (the same credential the
// container sends in the Proxy-Authorization header). A session is
// registered once via PUT /sessions/:id with its full state payload and
// removed via DELETE /sessions/:id when the container is torn down.

/** sessionId -> injection rules */
const sessionRules = new Map<string, HostInjectionRule[]>()

/** sessionId -> allowed host patterns (absent means block all — fail closed) */
const sessionAllowedHosts = new Map<string, string[]>()

/** sessionId -> repo URL (drives GitHub token resolution against github.json) */
const sessionRepoUrl = new Map<string, string>()

/** sessionId -> active agent tool ('claude' | 'codex') */
const sessionTool = new Map<string, string>()

/** sessionId -> Set of blocked hostnames */
const blockedHostsBySession = new Map<string, Set<string>>()

// ── Injection Logic ────────────────────────────────────────────────────

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
  // Interior or multi-segment wildcard: match segment-by-segment
  const patternParts = pattern.split('.')
  const hostParts = hostname.split('.')
  if (patternParts.length !== hostParts.length) return false
  return patternParts.every((p, i) => p === '*' || p === hostParts[i])
}

function findRulesForHost(sessionId: string, hostname: string): HostInjectionRule[] {
  const rules = sessionRules.get(sessionId)
  if (!rules) return []
  return rules.filter((r) => hostMatches(hostname, r.hostPattern))
}

function isHostAllowed(sessionId: string | null, hostname: string): boolean {
  if (!sessionId) return false // no session = block by default (fail closed)
  const allowed = sessionAllowedHosts.get(sessionId)
  if (!allowed) return false // no allowlist registered = block by default (fail closed)
  if (allowed.length === 1 && allowed[0] === '*') return true
  return allowed.some((pattern) => hostMatches(hostname, pattern))
}

function recordBlockedHost(sessionId: string | null, hostname: string): void {
  if (!sessionId) return
  let hosts = blockedHostsBySession.get(sessionId)
  if (!hosts) {
    hosts = new Set()
    blockedHostsBySession.set(sessionId, hosts)
  }
  hosts.add(hostname)
}

function applyInjections(
  headers: http.OutgoingHttpHeaders,
  requestPath: string,
  rules: InjectionRule[],
): number {
  let count = 0
  for (const rule of rules) {
    if (!pathMatches(requestPath, rule.pathPattern)) continue
    for (const inj of rule.injections) {
      if (inj.action === 'replace_body_param') continue // handled separately
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

function collectBodyInjections(
  requestPath: string,
  rules: InjectionRule[],
): Array<{ name: string; value: string }> {
  const params: Array<{ name: string; value: string }> = []
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

function applyBodyInjections(
  bodyBuffer: Buffer,
  contentType: string | undefined,
  injections: Array<{ name: string; value: string }>,
): Buffer {
  const bodyStr = bodyBuffer.toString('utf8')
  const isJson = contentType && contentType.includes('application/json')

  if (isJson) {
    try {
      const parsed: unknown = JSON.parse(bodyStr)
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        for (const { name, value } of injections) {
          if (name in obj) {
            obj[name] = value
          }
        }
        return Buffer.from(JSON.stringify(obj), 'utf8')
      }
    } catch {
      // Not valid JSON — fall through to form-encoded
    }
  }

  // Default: application/x-www-form-urlencoded
  const params = new URLSearchParams(bodyStr)
  for (const { name, value } of injections) {
    if (params.has(name)) {
      params.set(name, value)
    }
  }
  return Buffer.from(params.toString(), 'utf8')
}

// ── Dynamic Auth (GitHub / Codex / Claude api-key) ─────────────────────

/**
 * Hosts the proxy always MITMs so it can inject agent-tool credentials
 * read from the mounted credentials dir. Rule-based / per-session MITM is
 * still applied on top of this set.
 */
function hostNeedsDynamicMitm(hostname: string): boolean {
  if (hostname === ANTHROPIC_API_HOST) return true
  if (hostname === CLAUDE_TOKEN_URL_HOST) return true
  if (GITHUB_HOSTS.has(hostname)) return true
  if (hostname === OPENAI_API_HOST) return true
  if (hostname === OPENAI_TOKEN_URL_HOST) return true
  return false
}

/**
 * Build a list of injection rules derived from the host-mounted credentials
 * dir, scoped to the current hostname. Reading on every request means
 * updates via `yaac auth update` propagate without needing to restart
 * containers. The rules slot into the same pipeline as statically-configured
 * rules — no separate mutation path.
 */
function buildDynamicRules(
  sessionId: string | null,
  hostname: string,
  claudeTokenBundle: ClaudeOAuthBundle | null,
  codexTokenBundle: CodexOAuthBundle | null,
): InjectionRule[] {
  if (!sessionId) return []
  const rules: InjectionRule[] = []

  if (GITHUB_HOSTS.has(hostname)) {
    const token = resolveGithubToken(sessionRepoUrl.get(sessionId))
    if (token) {
      const basic = 'Basic ' + Buffer.from(`x-access-token:${token}`).toString('base64')
      rules.push({
        pathPattern: '*',
        injections: [{ action: 'set_header', name: 'Authorization', value: basic }],
      })
    }
  }

  if (hostname === ANTHROPIC_API_HOST) {
    const creds = readClaudeCreds()
    if (creds && creds.kind === 'api-key') {
      rules.push({
        pathPattern: '*',
        injections: [{ action: 'set_header', name: 'x-api-key', value: creds.apiKey }],
      })
    } else if (creds && creds.kind === 'oauth') {
      // The container only ever sees the placeholder, so any outbound
      // Authorization header is ours to swap to the real Bearer token.
      rules.push({
        pathPattern: '*',
        injections: [{
          action: 'replace_header',
          name: 'Authorization',
          value: 'Bearer ' + creds.bundle.accessToken,
        }],
      })
    }
  }

  if (hostname === OPENAI_API_HOST && sessionTool.get(sessionId) === 'codex') {
    const creds = readCodexCreds()
    if (creds && creds.kind === 'api-key') {
      rules.push({
        pathPattern: '*',
        injections: [{
          action: 'set_header',
          name: 'Authorization',
          value: 'Bearer ' + creds.apiKey,
        }],
      })
    } else if (creds && creds.kind === 'oauth') {
      // Container sees a placeholder Bearer; swap it for the real access
      // token. `ChatGPT-Account-Id` is populated by Codex from the real
      // top-level `account_id` in the mounted auth.json, so it passes
      // through unchanged.
      rules.push({
        pathPattern: '*',
        injections: [{
          action: 'replace_header',
          name: 'Authorization',
          value: 'Bearer ' + creds.bundle.accessToken,
        }],
      })
    }
  }

  // Claude OAuth token endpoint: swap the placeholder refresh_token for the
  // real one. refresh_token grants have the key (so it gets swapped),
  // authorization_code grants don't (so it's a no-op).
  if (claudeTokenBundle) {
    rules.push({
      pathPattern: '*',
      injections: [{
        action: 'replace_body_param',
        name: 'refresh_token',
        value: claudeTokenBundle.refreshToken,
      }],
    })
  }

  // Codex OAuth token endpoint: same placeholder-swap shape.
  if (codexTokenBundle) {
    rules.push({
      pathPattern: '*',
      injections: [{
        action: 'replace_body_param',
        name: 'refresh_token',
        value: codexTokenBundle.refreshToken,
      }],
    })
  }

  return rules
}

// ── Claude OAuth Swap ──────────────────────────────────────────────────

/** Parse JSON body in a response, falling back to null for non-JSON. */
function tryParseJsonBody(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Decompress a response body based on its Content-Encoding. Returns null
 * for unknown encodings so the caller can pass the original bytes through
 * unchanged.
 */
function decodeBody(raw: Buffer, encoding: string | string[] | undefined): Buffer | null {
  if (!encoding) return raw
  const enc = Array.isArray(encoding) ? encoding[0].toLowerCase() : encoding.toLowerCase()
  if (enc === 'identity') return raw
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(raw)
  if (enc === 'br') return zlib.brotliDecompressSync(raw)
  if (enc === 'deflate') return zlib.inflateSync(raw)
  return null
}

/** Re-encode a buffer with the given Content-Encoding. */
function encodeBody(raw: Buffer, encoding: string | string[] | undefined): Buffer {
  if (!encoding) return raw
  const enc = Array.isArray(encoding) ? encoding[0].toLowerCase() : encoding.toLowerCase()
  if (enc === 'identity') return raw
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gzipSync(raw)
  if (enc === 'br') return zlib.brotliCompressSync(raw)
  if (enc === 'deflate') return zlib.deflateSync(raw)
  return raw
}

const PLACEHOLDER_ACCESS_TOKEN = 'yaac-ph-access'
const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'

type TokenResponseBody = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
  id_token?: unknown
}

/**
 * Peek at the inbound request body for a `refresh_token` field and return
 * whether it matches our placeholder sentinel. Used to gate response-level
 * token write-back so an unrelated `authorization_code` exchange that happens
 * to hit the same endpoint can't clobber the host bundle.
 *
 * Supports both JSON and form-encoded bodies. An empty / unparseable body
 * returns false — the caller treats that as "not our refresh" and passes
 * through.
 */
function bodyHasPlaceholderRefreshToken(body: Buffer, contentType: string | undefined): boolean {
  if (body.length === 0) return false
  const bodyStr = body.toString('utf8')
  const isJson = contentType && contentType.includes('application/json')
  if (isJson) {
    try {
      const parsed: unknown = JSON.parse(bodyStr)
      if (parsed && typeof parsed === 'object') {
        const rt = (parsed as Record<string, unknown>).refresh_token
        return rt === PLACEHOLDER_REFRESH_TOKEN
      }
    } catch {
      // fall through to form-encoded
    }
  }
  try {
    const params = new URLSearchParams(bodyStr)
    return params.get('refresh_token') === PLACEHOLDER_REFRESH_TOKEN
  } catch {
    return false
  }
}

/**
 * Rewrite an OAuth token response body so the real bearer access/refresh
 * tokens are replaced with placeholders. Other fields (`expires_in`,
 * `scope`, `id_token`) pass through unchanged — the container needs real
 * values for them.
 */
function rewriteTokenResponseBody(parsed: TokenResponseBody): TokenResponseBody {
  const rewritten: TokenResponseBody = { ...parsed }
  if (typeof rewritten.access_token === 'string') {
    rewritten.access_token = PLACEHOLDER_ACCESS_TOKEN
  }
  if (typeof rewritten.refresh_token === 'string') {
    rewritten.refresh_token = PLACEHOLDER_REFRESH_TOKEN
  }
  return rewritten
}

/**
 * Buffer a Claude token-endpoint response, persist any refreshed tokens to
 * the host-mounted credentials file, and forward a placeholder-rewritten
 * copy to the container. Upstream headers (including content-type and
 * content-encoding) are preserved so the container sees a response that
 * looks byte-for-byte identical to the real upstream apart from the token
 * values. Falls back to forwarding the raw upstream bytes when the encoding
 * is unknown, decoding fails, or the body isn't a recognizable success
 * response.
 */
function handleClaudeTokenResponse(
  upstreamRes: http.IncomingMessage,
  res: http.ServerResponse,
  claudeTokenBundle: ClaudeOAuthBundle,
): void {
  const chunks: Buffer[] = []
  upstreamRes.on('data', (c: Buffer) => chunks.push(c))
  upstreamRes.on('end', () => {
    const raw = Buffer.concat(chunks)
    const encoding = upstreamRes.headers['content-encoding']

    // Base outgoing headers: preserve everything from upstream, but drop
    // transfer-encoding since we always send a single buffer with a fixed
    // content-length.
    const outHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers }
    delete outHeaders['transfer-encoding']

    const statusCode = upstreamRes.statusCode ?? 200

    const passThrough = (): void => {
      outHeaders['content-length'] = String(raw.length)
      res.writeHead(statusCode, outHeaders)
      res.end(raw)
    }

    let decoded: Buffer | null
    try {
      decoded = decodeBody(raw, encoding)
    } catch (err) {
      console.error('[proxy] Failed to decode Claude token response body:', (err as Error).message)
      passThrough()
      return
    }
    if (!decoded) {
      // Unknown encoding — cannot safely rewrite.
      passThrough()
      return
    }

    const parsed = tryParseJsonBody(decoded)
    if (!parsed || typeof parsed !== 'object') {
      passThrough()
      return
    }
    const body = parsed as TokenResponseBody
    if (typeof body.access_token !== 'string') {
      // Not a success response — pass through unchanged.
      passThrough()
      return
    }
    // Success: capture refreshed tokens on the host.
    try {
      const fresh: ClaudeOAuthBundle = {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token
          ? body.refresh_token
          : claudeTokenBundle.refreshToken,
        expiresAt: typeof body.expires_in === 'number'
          ? Date.now() + body.expires_in * 1000
          : claudeTokenBundle.expiresAt,
        scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : claudeTokenBundle.scopes,
        subscriptionType: claudeTokenBundle.subscriptionType,
      }
      writeClaudeOAuthBundle(fresh)
      console.log('[proxy] Captured refreshed Claude OAuth tokens (expires in ' + Math.floor((fresh.expiresAt - Date.now()) / 1000) + 's)')
    } catch (err) {
      console.error('[proxy] Failed to persist refreshed Claude OAuth tokens:', (err as Error).message)
    }

    const rewritten = rewriteTokenResponseBody(body)
    const rewrittenJson = Buffer.from(JSON.stringify(rewritten), 'utf8')
    let outBody: Buffer
    try {
      outBody = encodeBody(rewrittenJson, encoding)
    } catch (err) {
      console.error('[proxy] Failed to re-encode Claude token response body:', (err as Error).message)
      outBody = rewrittenJson
      delete outHeaders['content-encoding']
    }
    outHeaders['content-length'] = String(outBody.length)
    res.writeHead(statusCode, outHeaders)
    res.end(outBody)
  })
}

/**
 * Same shape as `handleClaudeTokenResponse`, but for Codex's token endpoint.
 * Differences: response carries `id_token` instead of `expires_in`/`scope`;
 * expiry is derived from the new access_token's JWT `exp` claim; the real
 * `id_token` passes through to the container so Codex's display claims stay
 * fresh.
 */
function handleCodexTokenResponse(
  upstreamRes: http.IncomingMessage,
  res: http.ServerResponse,
  codexTokenBundle: CodexOAuthBundle,
): void {
  const chunks: Buffer[] = []
  upstreamRes.on('data', (c: Buffer) => chunks.push(c))
  upstreamRes.on('end', () => {
    const raw = Buffer.concat(chunks)
    const encoding = upstreamRes.headers['content-encoding']

    const outHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers }
    delete outHeaders['transfer-encoding']

    const statusCode = upstreamRes.statusCode ?? 200

    const passThrough = (): void => {
      outHeaders['content-length'] = String(raw.length)
      res.writeHead(statusCode, outHeaders)
      res.end(raw)
    }

    let decoded: Buffer | null
    try {
      decoded = decodeBody(raw, encoding)
    } catch (err) {
      console.error('[proxy] Failed to decode Codex token response body:', (err as Error).message)
      passThrough()
      return
    }
    if (!decoded) {
      passThrough()
      return
    }

    const parsed = tryParseJsonBody(decoded)
    if (!parsed || typeof parsed !== 'object') {
      passThrough()
      return
    }
    const body = parsed as TokenResponseBody
    if (typeof body.access_token !== 'string') {
      passThrough()
      return
    }
    try {
      const newIdToken = typeof body.id_token === 'string' && body.id_token
        ? body.id_token
        : codexTokenBundle.idTokenRawJwt
      const exp = decodeJwtExp(body.access_token)
      const fresh: CodexOAuthBundle = {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token
          ? body.refresh_token
          : codexTokenBundle.refreshToken,
        idTokenRawJwt: newIdToken,
        expiresAt: exp ?? (Date.now() + CODEX_DEFAULT_REFRESH_WINDOW_MS),
        lastRefresh: new Date().toISOString(),
        accountId: codexTokenBundle.accountId,
      }
      writeCodexOAuthBundle(fresh)
      console.log('[proxy] Captured refreshed Codex OAuth tokens (expires in ' + Math.floor((fresh.expiresAt - Date.now()) / 1000) + 's)')
    } catch (err) {
      console.error('[proxy] Failed to persist refreshed Codex OAuth tokens:', (err as Error).message)
    }

    const rewritten = rewriteTokenResponseBody(body)
    const rewrittenJson = Buffer.from(JSON.stringify(rewritten), 'utf8')
    let outBody: Buffer
    try {
      outBody = encodeBody(rewrittenJson, encoding)
    } catch (err) {
      console.error('[proxy] Failed to re-encode Codex token response body:', (err as Error).message)
      outBody = rewrittenJson
      delete outHeaders['content-encoding']
    }
    outHeaders['content-length'] = String(outBody.length)
    res.writeHead(statusCode, outHeaders)
    res.end(outBody)
  })
}

// ── Session ID Extraction ─────────────────────────────────────────────

function extractSessionId(proxyAuthHeader: string | string[] | undefined): string | null {
  if (!proxyAuthHeader) return null
  const header = Array.isArray(proxyAuthHeader) ? proxyAuthHeader[0] : proxyAuthHeader
  const match = /^Basic\s+(.+)$/i.exec(header)
  if (!match) return null
  const decoded = Buffer.from(match[1], 'base64').toString()
  const colonIdx = decoded.indexOf(':')
  if (colonIdx === -1) return decoded
  const password = decoded.slice(colonIdx + 1)
  return password || decoded.slice(0, colonIdx)
}

// ── MITM Handler ───────────────────────────────────────────────────────

function handleMitm(
  clientSocket: Duplex,
  hostname: string,
  port: string | undefined,
  sessionId: string | null,
  rules: HostInjectionRule[],
): void {
  if (!ca) throw new Error('CA not initialized')
  const leaf = getLeafCert(hostname)

  const tlsSocket = new tls.TLSSocket(clientSocket as net.Socket, {
    isServer: true,
    key: leaf.key,
    cert: leaf.cert + ca.pem,
  })

  const mitmServer = http.createServer((req, res) => {
    const reqPath = req.url ?? '/'

    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']

    // OAuth token endpoints need multi-step body capture + response rewrite:
    // swap placeholder refresh_token outbound, then capture real tokens +
    // swap placeholders inbound. Null when this isn't the token endpoint or
    // when no OAuth bundle is on disk (nothing to swap).
    const claudeTokenBundle =
      hostname === CLAUDE_TOKEN_URL_HOST && reqPath === CLAUDE_TOKEN_URL_PATH
        ? readClaudeOAuthBundle()
        : null
    const codexTokenBundle =
      hostname === OPENAI_TOKEN_URL_HOST && reqPath === OPENAI_TOKEN_URL_PATH
        ? readCodexOAuthBundle()
        : null

    // Dynamic rules (GitHub / Codex / Claude auth + OAuth refresh swap) are
    // derived from the host-mounted credentials dir on every request and
    // merged into the statically-configured rules so a single injection
    // pipeline handles both.
    const dynamicRules = buildDynamicRules(sessionId, hostname, claudeTokenBundle, codexTokenBundle)
    const allRules: InjectionRule[] = [...rules, ...dynamicRules]
    const injCount = applyInjections(headers, reqPath, allRules)
    const bodyInjections = collectBodyInjections(reqPath, allRules)

    const totalInj = injCount + bodyInjections.length
    if (totalInj > 0) {
      const dynSuffix = dynamicRules.length > 0 ? ` + dynamic(${dynamicRules.length})` : ''
      console.log(`[proxy] MITM ${req.method} https://${hostname}${reqPath} (${injCount} header + ${bodyInjections.length} body injections${dynSuffix})`)
    }

    function sendUpstream(body: Buffer | null, shouldCaptureTokenResponse: boolean): void {
      if (body !== null) {
        headers['content-length'] = String(body.length)
      }
      const upstream = https.request({
        hostname,
        port: parseInt(port ?? '', 10) || 443,
        path: reqPath,
        method: req.method,
        headers,
        rejectUnauthorized: true,
      }, (upstreamRes) => {
        if (claudeTokenBundle && shouldCaptureTokenResponse) {
          handleClaudeTokenResponse(upstreamRes, res, claudeTokenBundle)
        } else if (codexTokenBundle && shouldCaptureTokenResponse) {
          handleCodexTokenResponse(upstreamRes, res, codexTokenBundle)
        } else {
          res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
          upstreamRes.pipe(res)
        }
        upstreamRes.on('error', (err: Error) => {
          console.error('[proxy] Upstream response error for ' + hostname + reqPath + ':', err.message)
          if (!res.headersSent) res.writeHead(502)
          res.end(err.message)
        })
      })

      upstream.on('error', (err: Error) => {
        console.error(`[proxy] Upstream error for ${hostname}${reqPath}:`, err.message)
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' })
        }
        res.end(err.message)
      })

      if (body !== null) {
        upstream.end(body)
      } else {
        req.pipe(upstream)
      }
    }

    if (bodyInjections.length > 0) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const contentTypeHeader = headers['content-type']
        const contentType = typeof contentTypeHeader === 'string'
          ? contentTypeHeader
          : Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : undefined
        const inboundBody = Buffer.concat(chunks)
        // Only capture + persist token-endpoint responses when the inbound
        // request body carried our placeholder refresh_token. Otherwise an
        // unrelated authorization_code exchange through the same endpoint
        // would clobber the host OAuth bundle with wrong credentials.
        const shouldCaptureTokenResponse =
          (claudeTokenBundle !== null || codexTokenBundle !== null) &&
          bodyHasPlaceholderRefreshToken(inboundBody, contentType)
        const rawBody = applyBodyInjections(inboundBody, contentType, bodyInjections)
        sendUpstream(rawBody, shouldCaptureTokenResponse)
      })
    } else {
      sendUpstream(null, false)
    }
  })

  mitmServer.emit('connection', tlsSocket)

  tlsSocket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'ECONNRESET') {
      console.error(`[proxy] TLS error for ${hostname}:`, err.message)
    }
  })
}

// ── Tunnel Handler ─────────────────────────────────────────────────────

function handleTunnel(clientSocket: Duplex, hostname: string, port: string | undefined): void {
  const upstream = net.connect(parseInt(port ?? '', 10) || 443, hostname, () => {
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  })

  upstream.on('error', (err: Error) => {
    console.error(`[proxy] Tunnel error for ${hostname}:`, err.message)
    clientSocket.end()
  })

  clientSocket.on('error', () => {
    upstream.destroy()
  })
}

// ── API Request Handler ────────────────────────────────────────────────

function checkAuth(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization
  return auth === `Bearer ${PROXY_AUTH_SECRET}`
}

function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200)
    res.end('ok')
    return
  }

  if (req.method === 'GET' && req.url === '/ca.pem') {
    if (!ca) {
      res.writeHead(503)
      res.end('CA not ready')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/x-pem-file' })
    res.end(ca.pem)
    return
  }

  // Register or update all state for a session
  if (req.method === 'PUT' && req.url && /^\/sessions\/[^/]+$/.exec(req.url)) {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const sessionId = decodeURIComponent(req.url.slice('/sessions/'.length))
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(body)
        if (!parsed || typeof parsed !== 'object') {
          res.writeHead(400); res.end('Invalid body'); return
        }
        const o = parsed as Record<string, unknown>
        const rules = o.rules
        if (!Array.isArray(rules)) { res.writeHead(400); res.end('Invalid body: need rules array'); return }
        if (!Array.isArray(o.allowedHosts)) { res.writeHead(400); res.end('Invalid body: need allowedHosts array'); return }
        sessionRules.set(sessionId, rules as HostInjectionRule[])
        const allowedHosts = o.allowedHosts as string[]
        sessionAllowedHosts.set(sessionId, allowedHosts)
        if (typeof o.repoUrl === 'string' && o.repoUrl) {
          sessionRepoUrl.set(sessionId, o.repoUrl)
        } else {
          sessionRepoUrl.delete(sessionId)
        }
        if (typeof o.tool === 'string' && o.tool) {
          sessionTool.set(sessionId, o.tool)
        } else {
          sessionTool.delete(sessionId)
        }
        console.log(`[proxy] Registered session ${sessionId.slice(0, 8)}... (${rules.length} rules, ${allowedHosts.length} allowed host patterns)`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400); res.end(`Invalid JSON: ${(err as Error).message}`)
      }
    })
    return
  }

  // Remove all state for a session
  if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const sessionId = decodeURIComponent(req.url.slice('/sessions/'.length))
    const deleted = sessionRules.delete(sessionId)
    sessionAllowedHosts.delete(sessionId)
    sessionRepoUrl.delete(sessionId)
    sessionTool.delete(sessionId)
    blockedHostsBySession.delete(sessionId)
    console.log(`[proxy] Removed session ${sessionId.slice(0, 8)}... (found: ${deleted})`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted }))
    return
  }

  // Return blocked hosts for all sessions
  if (req.method === 'GET' && req.url === '/blocked-hosts') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const result: Record<string, string[]> = {}
    for (const [sid, hosts] of blockedHostsBySession) {
      if (hosts.size > 0) {
        result[sid] = [...hosts]
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }

  res.writeHead(404)
  res.end('Not found')
}

// ── Server ─────────────────────────────────────────────────────────────

ca = loadOrGenerateCA()

// ── HTTP Forward Proxy ────────────────────────────────────────────────

function isProxyRequest(req: http.IncomingMessage): boolean {
  return !!req.url && req.url.startsWith('http://')
}

// Security: token injection is deliberately NOT applied to plain HTTP requests.
// Injecting credentials over unencrypted connections would expose them to
// network observers. Only HTTPS CONNECT+MITM requests get token injection.
function handleHttpForward(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!req.url) {
    res.writeHead(400); res.end('Bad request'); return
  }
  const target = new URL(req.url)
  const sessionId = extractSessionId(req.headers['proxy-authorization'])

  if (!isHostAllowed(sessionId, target.hostname)) {
    console.log(`[proxy] BLOCKED HTTP forward to ${target.hostname} (not in allowlist)`)
    recordBlockedHost(sessionId, target.hostname)
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end(`Blocked by URL allowlist: ${target.hostname} is not in the allowed hosts`)
    return
  }

  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  delete headers['proxy-authorization']
  delete headers['proxy-connection']
  headers.host = target.host

  const upstream = http.request({
    hostname: target.hostname,
    port: parseInt(target.port, 10) || 80,
    path: target.pathname + target.search,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err: Error) => {
    console.error(`[proxy] HTTP forward error for ${req.url}:`, err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
    }
    res.end(err.message)
  })

  req.pipe(upstream)
}

// ── Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (isProxyRequest(req)) {
    handleHttpForward(req, res)
  } else {
    handleApiRequest(req, res)
  }
})

server.on('connect', (req: http.IncomingMessage, clientSocket: Duplex, head: Buffer) => {
  const [hostname, port] = (req.url ?? '').split(':')
  const sessionId = extractSessionId(req.headers['proxy-authorization'])

  clientSocket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'ECONNRESET') {
      console.error(`[proxy] Client socket error for ${hostname}:${port}:`, err.message)
    }
  })

  if (!isHostAllowed(sessionId, hostname)) {
    console.log(`[proxy] BLOCKED CONNECT to ${hostname}:${port} (not in allowlist)`)
    recordBlockedHost(sessionId, hostname)
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    clientSocket.end()
    return
  }

  const rules = sessionId ? findRulesForHost(sessionId, hostname) : []

  // Always MITM well-known tool-auth hosts so we can inject credentials
  // read from the host-mounted credentials dir, even when no per-session
  // rule-based injections apply.
  const needsDynMitm = hostNeedsDynamicMitm(hostname)

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

  if (head.length > 0) {
    clientSocket.unshift(head)
  }

  if (rules.length > 0 || needsDynMitm) {
    handleMitm(clientSocket, hostname, port, sessionId, rules)
  } else {
    handleTunnel(clientSocket, hostname, port)
  }
})

server.on('error', (err: Error) => {
  console.error('[proxy] Server error:', err)
})

server.listen(parseInt(PORT, 10), '0.0.0.0', () => {
  console.log(`[proxy] MITM proxy listening on port ${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('[proxy] Shutting down...')
  server.close(() => process.exit(0))
})

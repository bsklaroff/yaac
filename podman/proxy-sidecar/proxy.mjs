/**
 * MITM proxy sidecar for agent session containers.
 *
 * - Generates a self-signed CA on startup (persisted to /data/)
 * - Accepts project rules + session mappings via HTTP API
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

// ── CA Certificate Management ──────────────────────────────────────────

/** @type {{ key: forge.pki.PrivateKey, cert: forge.pki.Certificate, pem: string } | null} */
let ca = null

/** @type {Map<string, { key: string, cert: string, expires: number }>} */
const leafCache = new Map()

const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000
const LEAF_REFRESH_MS = 60 * 60 * 1000

function loadOrGenerateCA() {
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

function getLeafCert(hostname) {
  const cached = leafCache.get(hostname)
  const now = Date.now()
  if (cached && (cached.expires - LEAF_REFRESH_MS) > now) {
    return { key: cached.key, cert: cached.cert }
  }

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
 * @typedef {{accessToken: string, refreshToken: string, expiresAt: number, scopes: string[], subscriptionType?: string}} ClaudeOAuthBundle
 */

/**
 * Parse the host-mounted claude.json. Returns either an OAuth bundle or an
 * api-key entry, depending on the file's `kind` field.
 * @returns {{ kind: 'oauth', bundle: ClaudeOAuthBundle } | { kind: 'api-key', apiKey: string } | null}
 */
function readClaudeCreds() {
  try {
    const raw = fs.readFileSync(CLAUDE_CREDS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.kind === 'oauth' && parsed.claudeAiOauth) {
      const b = parsed.claudeAiOauth
      if (typeof b.accessToken === 'string' && typeof b.refreshToken === 'string'
        && typeof b.expiresAt === 'number' && Array.isArray(b.scopes)) {
        return { kind: 'oauth', bundle: b }
      }
      return null
    }
    if (parsed.kind === 'api-key' && typeof parsed.apiKey === 'string' && parsed.apiKey) {
      return { kind: 'api-key', apiKey: parsed.apiKey }
    }
    return null
  } catch {
    return null
  }
}

/** @returns {ClaudeOAuthBundle | null} */
function readClaudeOAuthBundle() {
  const creds = readClaudeCreds()
  return creds && creds.kind === 'oauth' ? creds.bundle : null
}

/** @returns {{ apiKey: string } | null} */
function readCodexCreds() {
  try {
    const raw = fs.readFileSync(CODEX_CREDS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.apiKey === 'string' && parsed.apiKey) {
      return { apiKey: parsed.apiKey }
    }
    return null
  } catch {
    return null
  }
}

/** @returns {Array<{ pattern: string, token: string }>} */
function readGithubTokens() {
  try {
    const raw = fs.readFileSync(GITHUB_CREDS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.tokens)) return []
    return parsed.tokens.filter((t) =>
      t && typeof t.pattern === 'string' && typeof t.token === 'string' && t.token !== '',
    )
  } catch {
    return []
  }
}

/**
 * Mirrors `matchPattern` / `resolveTokenForUrl` from src/lib/project/credentials.ts.
 * Patterns: "*", "owner/*", "owner/repo".
 */
function matchGithubPattern(pattern, owner, repo) {
  if (pattern === '*') return true
  const parts = pattern.split('/')
  if (parts.length !== 2) return false
  const [patOwner, patRepo] = parts
  if (patOwner !== owner) return false
  if (patRepo === '*') return true
  return patRepo === repo
}

/** Extract owner/repo from a GitHub remote URL. Returns null on failure. */
function parseRepoUrl(remoteUrl) {
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
function resolveGithubToken(repoUrl) {
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
/** @param {ClaudeOAuthBundle} bundle */
function writeClaudeOAuthBundle(bundle) {
  const payload = {
    kind: 'oauth',
    savedAt: new Date().toISOString(),
    claudeAiOauth: bundle,
  }
  const tmp = CLAUDE_CREDS_FILE + '.tmp-' + crypto.randomBytes(6).toString('hex')
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, CLAUDE_CREDS_FILE)
}

// ── Secret Store ───────────────────────────────────────────────────────

/** projectId -> injection rules */
/** @type {Map<string, Array<{ hostPattern: string, pathPattern: string, injections: Array<{ action: string, name: string, value?: string }> }>>} */
const projectRules = new Map()

/** sessionId -> projectId (sessionId is used as proxy-auth credential) */
/** @type {Map<string, string>} */
const sessionToProject = new Map()

/** projectId -> allowed host patterns (absent means block all — fail closed) */
/** @type {Map<string, string[]>} */
const projectAllowedHosts = new Map()

/** projectId -> repo URL (drives GitHub token resolution against github.json) */
/** @type {Map<string, string>} */
const projectRepoUrl = new Map()

/** projectId -> active agent tool ('claude' | 'codex') */
/** @type {Map<string, string>} */
const projectTool = new Map()

/** sessionId -> Set of blocked hostnames */
/** @type {Map<string, Set<string>>} */
const blockedHostsBySession = new Map()

// ── Injection Logic ────────────────────────────────────────────────────

function pathMatches(requestPath, pattern) {
  if (pattern === '/*' || pattern === '*') return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return requestPath === prefix || requestPath.startsWith(prefix + '/')
  }
  return requestPath === pattern
}

function hostMatches(hostname, pattern) {
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

function findRulesForHost(sessionId, hostname) {
  const projectId = sessionToProject.get(sessionId)
  if (!projectId) return []
  const rules = projectRules.get(projectId)
  if (!rules) return []
  return rules.filter((r) => hostMatches(hostname, r.hostPattern))
}

function isHostAllowed(sessionId, hostname) {
  const projectId = sessionId ? sessionToProject.get(sessionId) : undefined
  if (!projectId) return false // no session/project = block by default (fail closed)
  const allowed = projectAllowedHosts.get(projectId)
  if (!allowed) return false // no allowlist registered = block by default (fail closed)
  if (allowed.length === 1 && allowed[0] === '*') return true
  return allowed.some((pattern) => hostMatches(hostname, pattern))
}

function recordBlockedHost(sessionId, hostname) {
  if (!sessionId) return
  let hosts = blockedHostsBySession.get(sessionId)
  if (!hosts) {
    hosts = new Set()
    blockedHostsBySession.set(sessionId, hosts)
  }
  hosts.add(hostname)
}

function applyInjections(headers, requestPath, rules) {
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

function collectBodyInjections(requestPath, rules) {
  /** @type {Array<{ name: string, value: string }>} */
  const params = []
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

function applyBodyInjections(bodyBuffer, contentType, injections) {
  const bodyStr = bodyBuffer.toString('utf8')
  const isJson = contentType && contentType.includes('application/json')

  if (isJson) {
    try {
      const obj = JSON.parse(bodyStr)
      for (const { name, value } of injections) {
        if (name in obj) {
          obj[name] = value
        }
      }
      return Buffer.from(JSON.stringify(obj), 'utf8')
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
 * read from the mounted credentials dir. Rule-based / per-project MITM is
 * still applied on top of this set.
 */
function hostNeedsDynamicMitm(hostname) {
  if (hostname === ANTHROPIC_API_HOST) return true
  if (hostname === CLAUDE_TOKEN_URL_HOST) return true
  if (GITHUB_HOSTS.has(hostname)) return true
  if (hostname === OPENAI_API_HOST) return true
  return false
}

/**
 * Build a list of injection rules derived from the host-mounted credentials
 * dir, scoped to the current hostname. Reading on every request means
 * updates via `yaac auth update` propagate without needing to restart
 * containers. The rules slot into the same pipeline as statically-configured
 * rules — no separate mutation path.
 *
 * @param {string | null} sessionId
 * @param {string} hostname
 * @param {ClaudeOAuthBundle | null} claudeTokenBundle
 * @returns {InjectionRule[]}
 */
function buildDynamicRules(sessionId, hostname, claudeTokenBundle) {
  const projectId = sessionId ? sessionToProject.get(sessionId) : undefined
  if (!projectId) return []
  const rules = []

  if (GITHUB_HOSTS.has(hostname)) {
    const token = resolveGithubToken(projectRepoUrl.get(projectId))
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

  if (hostname === OPENAI_API_HOST && projectTool.get(projectId) === 'codex') {
    const creds = readCodexCreds()
    if (creds) {
      rules.push({
        pathPattern: '*',
        injections: [{
          action: 'set_header',
          name: 'Authorization',
          value: 'Bearer ' + creds.apiKey,
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

  return rules
}

// ── Claude OAuth Swap ──────────────────────────────────────────────────

/** Parse JSON body in a response, falling back to null for non-JSON. */
function tryParseJsonBody(buf) {
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
function decodeBody(raw, encoding) {
  if (!encoding) return raw
  const enc = encoding.toLowerCase()
  if (enc === 'identity') return raw
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(raw)
  if (enc === 'br') return zlib.brotliDecompressSync(raw)
  if (enc === 'deflate') return zlib.inflateSync(raw)
  return null
}

/** Re-encode a buffer with the given Content-Encoding. */
function encodeBody(raw, encoding) {
  if (!encoding) return raw
  const enc = encoding.toLowerCase()
  if (enc === 'identity') return raw
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gzipSync(raw)
  if (enc === 'br') return zlib.brotliCompressSync(raw)
  if (enc === 'deflate') return zlib.deflateSync(raw)
  return raw
}

const PLACEHOLDER_ACCESS_TOKEN = 'yaac-ph-access'
const PLACEHOLDER_REFRESH_TOKEN = 'yaac-ph-refresh'

/**
 * Rewrite a Claude OAuth token response body so that the real access/refresh
 * tokens are replaced with placeholders. `expires_in` / `scope` flow through
 * unchanged so Claude Code inside the container tracks the correct expiry.
 */
function rewriteTokenResponseBody(parsed) {
  const rewritten = { ...parsed }
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
 *
 * @param {import('node:http').IncomingMessage} upstreamRes
 * @param {import('node:http').ServerResponse} res
 * @param {ClaudeOAuthBundle} claudeTokenBundle
 */
function handleClaudeTokenResponse(upstreamRes, res, claudeTokenBundle) {
  const chunks = []
  upstreamRes.on('data', (c) => chunks.push(c))
  upstreamRes.on('end', () => {
    const raw = Buffer.concat(chunks)
    const encoding = upstreamRes.headers['content-encoding']

    // Base outgoing headers: preserve everything from upstream, but drop
    // transfer-encoding since we always send a single buffer with a fixed
    // content-length.
    const outHeaders = { ...upstreamRes.headers }
    delete outHeaders['transfer-encoding']

    const passThrough = () => {
      outHeaders['content-length'] = String(raw.length)
      res.writeHead(upstreamRes.statusCode, outHeaders)
      res.end(raw)
    }

    let decoded
    try {
      decoded = decodeBody(raw, encoding)
    } catch (err) {
      console.error('[proxy] Failed to decode Claude token response body:', err.message)
      passThrough()
      return
    }
    if (!decoded) {
      // Unknown encoding — cannot safely rewrite.
      passThrough()
      return
    }

    const parsed = tryParseJsonBody(decoded)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.access_token !== 'string') {
      // Not a success response — pass through unchanged.
      passThrough()
      return
    }
    // Success: capture refreshed tokens on the host.
    try {
      const fresh = {
        accessToken: parsed.access_token,
        refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token
          ? parsed.refresh_token
          : claudeTokenBundle.refreshToken,
        expiresAt: typeof parsed.expires_in === 'number'
          ? Date.now() + parsed.expires_in * 1000
          : claudeTokenBundle.expiresAt,
        scopes: typeof parsed.scope === 'string' ? parsed.scope.split(' ').filter(Boolean) : claudeTokenBundle.scopes,
        subscriptionType: claudeTokenBundle.subscriptionType,
      }
      writeClaudeOAuthBundle(fresh)
      console.log('[proxy] Captured refreshed Claude OAuth tokens (expires in ' + Math.floor((fresh.expiresAt - Date.now()) / 1000) + 's)')
    } catch (err) {
      console.error('[proxy] Failed to persist refreshed Claude OAuth tokens:', err.message)
    }

    const rewritten = rewriteTokenResponseBody(parsed)
    const rewrittenJson = Buffer.from(JSON.stringify(rewritten), 'utf8')
    let outBody
    try {
      outBody = encodeBody(rewrittenJson, encoding)
    } catch (err) {
      console.error('[proxy] Failed to re-encode Claude token response body:', err.message)
      outBody = rewrittenJson
      delete outHeaders['content-encoding']
    }
    outHeaders['content-length'] = String(outBody.length)
    res.writeHead(upstreamRes.statusCode, outHeaders)
    res.end(outBody)
  })
}

// ── Session ID Extraction ─────────────────────────────────────────────

function extractSessionId(proxyAuthHeader) {
  if (!proxyAuthHeader) return null
  const match = proxyAuthHeader.match(/^Basic\s+(.+)$/i)
  if (!match) return null
  const decoded = Buffer.from(match[1], 'base64').toString()
  const colonIdx = decoded.indexOf(':')
  if (colonIdx === -1) return decoded
  const password = decoded.slice(colonIdx + 1)
  return password || decoded.slice(0, colonIdx)
}

// ── MITM Handler ───────────────────────────────────────────────────────

function handleMitm(clientSocket, hostname, port, sessionId, rules) {
  const leaf = getLeafCert(hostname)

  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: leaf.key,
    cert: leaf.cert + ca.pem,
  })

  const mitmServer = http.createServer((req, res) => {
    const reqPath = req.url || '/'

    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']

    // Claude OAuth token endpoint needs multi-step body capture + response
    // rewrite: swap placeholder refresh_token outbound, then capture real
    // tokens + swap placeholders inbound. Null when this isn't the token
    // endpoint or when no OAuth bundle is on disk (nothing to swap).
    const claudeTokenBundle =
      hostname === CLAUDE_TOKEN_URL_HOST && reqPath === CLAUDE_TOKEN_URL_PATH
        ? readClaudeOAuthBundle()
        : null

    // Dynamic rules (GitHub / Codex / Claude auth + OAuth refresh swap) are
    // derived from the host-mounted credentials dir on every request and
    // merged into the statically-configured rules so a single injection
    // pipeline handles both.
    const dynamicRules = buildDynamicRules(sessionId, hostname, claudeTokenBundle)
    const allRules = rules.concat(dynamicRules)
    const injCount = applyInjections(headers, reqPath, allRules)
    const bodyInjections = collectBodyInjections(reqPath, allRules)

    const totalInj = injCount + bodyInjections.length
    if (totalInj > 0) {
      const dynSuffix = dynamicRules.length > 0 ? ` + dynamic(${dynamicRules.length})` : ''
      console.log(`[proxy] MITM ${req.method} https://${hostname}${reqPath} (${injCount} header + ${bodyInjections.length} body injections${dynSuffix})`)
    }

    function sendUpstream(body) {
      if (body !== null) {
        headers['content-length'] = String(body.length)
      }
      const upstream = https.request({
        hostname,
        port: parseInt(port, 10) || 443,
        path: reqPath,
        method: req.method,
        headers,
        rejectUnauthorized: true,
      }, (upstreamRes) => {
        if (claudeTokenBundle) {
          handleClaudeTokenResponse(upstreamRes, res, claudeTokenBundle)
        } else {
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
          upstreamRes.pipe(res)
        }
        upstreamRes.on('error', (err) => {
          console.error('[proxy] Upstream response error for ' + hostname + reqPath + ':', err.message)
          if (!res.headersSent) res.writeHead(502)
          res.end(err.message)
        })
      })

      upstream.on('error', (err) => {
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
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const rawBody = applyBodyInjections(
          Buffer.concat(chunks),
          headers['content-type'],
          bodyInjections,
        )
        sendUpstream(rawBody)
      })
    } else {
      sendUpstream(null)
    }
  })

  mitmServer.emit('connection', tlsSocket)

  tlsSocket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      console.error(`[proxy] TLS error for ${hostname}:`, err.message)
    }
  })
}

// ── Tunnel Handler ─────────────────────────────────────────────────────

function handleTunnel(clientSocket, hostname, port) {
  const upstream = net.connect(parseInt(port, 10) || 443, hostname, () => {
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  })

  upstream.on('error', (err) => {
    console.error(`[proxy] Tunnel error for ${hostname}:`, err.message)
    clientSocket.end()
  })

  clientSocket.on('error', () => {
    upstream.destroy()
  })
}

// ── API Request Handler ────────────────────────────────────────────────

function checkAuth(req) {
  const auth = req.headers.authorization
  return auth === `Bearer ${PROXY_AUTH_SECRET}`
}

function handleApiRequest(req, res) {
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

  // Register or update injection rules for a project
  if (req.method === 'PUT' && req.url?.match(/^\/projects\/[^/]+\/rules$/)) {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const projectId = decodeURIComponent(req.url.split('/')[2])
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const { rules, allowedHosts, repoUrl, tool } = JSON.parse(body)
        if (!Array.isArray(rules)) { res.writeHead(400); res.end('Invalid body: need rules array'); return }
        projectRules.set(projectId, rules)
        if (Array.isArray(allowedHosts)) {
          projectAllowedHosts.set(projectId, allowedHosts)
          console.log(`[proxy] Updated allowlist (${allowedHosts.length} patterns) for project ${projectId.slice(0, 8)}...`)
        } else {
          projectAllowedHosts.delete(projectId)
        }
        if (typeof repoUrl === 'string' && repoUrl) {
          projectRepoUrl.set(projectId, repoUrl)
        } else {
          projectRepoUrl.delete(projectId)
        }
        if (typeof tool === 'string' && tool) {
          projectTool.set(projectId, tool)
        } else {
          projectTool.delete(projectId)
        }
        console.log(`[proxy] Updated ${rules.length} rules for project ${projectId.slice(0, 8)}...`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400); res.end(`Invalid JSON: ${err.message}`)
      }
    })
    return
  }

  // Remove all rules for a project
  if (req.method === 'DELETE' && req.url?.match(/^\/projects\/[^/]+\/rules$/)) {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const projectId = decodeURIComponent(req.url.split('/')[2])
    const deleted = projectRules.delete(projectId)
    projectAllowedHosts.delete(projectId)
    projectRepoUrl.delete(projectId)
    projectTool.delete(projectId)
    console.log(`[proxy] Removed rules for project ${projectId.slice(0, 8)}... (found: ${deleted})`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted }))
    return
  }

  // Register a session → project mapping
  if (req.method === 'POST' && req.url === '/sessions') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const { sessionId, projectId } = JSON.parse(body)
        if (!sessionId || !projectId) { res.writeHead(400); res.end('Invalid body: need sessionId and projectId'); return }
        sessionToProject.set(sessionId, projectId)
        console.log(`[proxy] Registered session ${sessionId.slice(0, 8)}... → project ${projectId.slice(0, 8)}...`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400); res.end(`Invalid JSON: ${err.message}`)
      }
    })
    return
  }

  // Remove a session mapping
  if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const sessionId = decodeURIComponent(req.url.slice('/sessions/'.length))
    const deleted = sessionToProject.delete(sessionId)
    blockedHostsBySession.delete(sessionId)
    console.log(`[proxy] Removed session ${sessionId.slice(0, 8)}... (found: ${deleted})`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted }))
    return
  }

  // Return blocked hosts for all sessions
  if (req.method === 'GET' && req.url === '/blocked-hosts') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const result = {}
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

function isProxyRequest(req) {
  return req.url && req.url.startsWith('http://')
}

// Security: token injection is deliberately NOT applied to plain HTTP requests.
// Injecting credentials over unencrypted connections would expose them to
// network observers. Only HTTPS CONNECT+MITM requests get token injection.
function handleHttpForward(req, res) {
  const target = new URL(req.url)
  const sessionId = extractSessionId(req.headers['proxy-authorization'])

  if (!isHostAllowed(sessionId, target.hostname)) {
    console.log(`[proxy] BLOCKED HTTP forward to ${target.hostname} (not in allowlist)`)
    recordBlockedHost(sessionId, target.hostname)
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end(`Blocked by URL allowlist: ${target.hostname} is not in the allowed hosts`)
    return
  }

  const headers = { ...req.headers }
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
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err) => {
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

server.on('connect', (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(':')
  const sessionId = extractSessionId(req.headers['proxy-authorization'])

  clientSocket.on('error', (err) => {
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
  // read from the host-mounted credentials dir, even when no per-project
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

server.on('error', (err) => {
  console.error('[proxy] Server error:', err)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] MITM proxy listening on port ${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('[proxy] Shutting down...')
  server.close(() => process.exit(0))
})

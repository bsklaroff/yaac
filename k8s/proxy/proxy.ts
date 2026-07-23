/**
 * MITM proxy sidecar for agent session containers.
 *
 * - Generates a self-signed CA on startup (persisted to /data/)
 * - Accepts per-session rules and allowlists via HTTP API
 * - Writes per-session registrations and blocked-host state through to
 *   /data/ (a hostPath the server reads directly) and reloads both at
 *   boot, so a pod replacement never strands live sessions
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
import dgram from 'node:dgram'
import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import type { Duplex } from 'node:stream'
import forge from 'node-forge'
import { SocksClient } from 'socks'
import { SocksProxyAgent } from 'socks-proxy-agent'
import {
  isInternalUpstream,
  peekClientHelloSni,
  splitHostHeader,
} from './transparent'
import { parsePp2Header } from './pp2'
import { DNS_QTYPE_A, buildDnsResponse, isInternalName, parseDnsQuery } from './dns-stub'
import { PodSessionIndex, fetchPodIpBySessionId, fetchSessionByPodIp, parseVclusterAttribution, startPodWatch } from './pod-watch'
import {
  SPAWN_MAGIC_HOST,
  SPAWN_MAX_BODY_BYTES,
  SPAWN_PATH,
  SpawnQueue,
  validateSpawnRequest,
} from './spawn-queue'
import type { SpawnResult } from './spawn-queue'
import { SYSTEM_ROOTS_PATH, combineCaBundle } from './ca-bundle'
import { timingSafeStrEqual } from './secure-compare'
import { OPENCODE_PROVIDER_HOSTS, PI_PROVIDER_HOSTS } from './tool-providers.generated'
import {
  buildToolsReport,
  formatToolsReport,
  type AgentTool,
  type ToolCredsView,
} from './tools-report'

// Control-API listener (CA cert, registrations, ssh-agent keys). Renamed
// from PORT now that no session egress reaches it — it is purely the API.
const API_PORT = process.env.API_PORT
const PROXY_AUTH_SECRET = process.env.PROXY_AUTH_SECRET
// Transparent egress listeners: the node-local Cilium Envoy forwards
// redirected 443/80 here (PP2 identity, destination from TLS SNI / HTTP
// Host) and SSH CONNECTs to the tunnel listener (destination from the
// CONNECT line).
const TRANSPARENT_HTTPS_PORT = process.env.TRANSPARENT_HTTPS_PORT
const TRANSPARENT_HTTP_PORT = process.env.TRANSPARENT_HTTP_PORT
const TRANSPARENT_TUNNEL_PORT = process.env.TRANSPARENT_TUNNEL_PORT
// Stream relay: authenticated CONNECT from the yaac server into a session
// pod's streamd (docs/stream-relay.md).
const RELAY_PORT = process.env.RELAY_PORT
const POD_STREAM_PORT = process.env.POD_STREAM_PORT
if (!API_PORT || !PROXY_AUTH_SECRET || !TRANSPARENT_HTTPS_PORT || !TRANSPARENT_HTTP_PORT
  || !TRANSPARENT_TUNNEL_PORT || !RELAY_PORT || !POD_STREAM_PORT) {
  console.error('[proxy] API_PORT, PROXY_AUTH_SECRET, TRANSPARENT_HTTPS_PORT, '
    + 'TRANSPARENT_HTTP_PORT, TRANSPARENT_TUNNEL_PORT, RELAY_PORT and '
    + 'POD_STREAM_PORT environment variables are required')
  process.exit(1)
}
const DATA_DIR = '/data'
// UDP/53 DNS stub: session pods point their resolver here. Optional so
// non-cluster test runs can skip it.
const DNS_STUB_PORT = process.env.DNS_STUB_PORT
// Sinkhole answer for EXTERNAL names: decorative — Cilium redirects egress by
// port (443/80) and the proxy routes by SNI/Host, never by the dialed address.
const DNS_SINKHOLE_IPV4 = '198.18.0.1'
// Split-horizon DNS, top-level proxy only: forward `.cluster.local` names to
// the real cluster CoreDNS so pods learn live in-cluster ClusterIPs (what lets
// yaac stop pinning them). OFF for the nested (inner) proxy, which by design
// resolves NOTHING for real: its resolver is its own loopback stub (it has no
// route to the vcluster CoreDNS — see buildProxyDeploymentManifest's nested
// dnsConfig), it sinkholes every name, and its upstream dials chain to the
// outer proxy which resolves for real. Forwarding there would loop straight
// back into its own stub, and inner sessions have no in-cluster Service to
// resolve anyway (no inner registry — vcluster-in-vcluster is rejected).
const DNS_FORWARD_INTERNAL = process.env.DNS_FORWARD_INTERNAL === '1'

/**
 * Resolve an internal name's first IPv4 against the proxy's own configured
 * resolver (the cluster CoreDNS — the top-level proxy uses cluster-default
 * DNS). The caller only ever passes `.cluster.local` names (isInternalName),
 * which CoreDNS owns authoritatively and never forwards to its upstream/remote
 * resolver — that is what keeps the DNS-exfil channel closed. Returns null on
 * NXDOMAIN/NODATA/error (incl. resolve4's own c-ares timeout) so the caller
 * answers empty-NOERROR. Only A/IPv4 is handled: ClusterIPs are IPv4 and the
 * stub has only ever served A; a single address is returned.
 */
async function resolveInternalA(name: string): Promise<string | null> {
  try {
    const addrs = await dns.promises.resolve4(name)
    return addrs.length > 0 ? addrs[0] : null
  } catch {
    return null // NXDOMAIN / NODATA / SERVFAIL / timeout — answer empty-NOERROR
  }
}

// podIP → sessionId, kept fresh by watching the pods API with the proxy's
// read-only ServiceAccount. The transparent listeners resolve a connection's
// session from the source pod IP in the Envoy-stamped PROXY header.
const podIndex = new PodSessionIndex()

// podIP → OUTER sessionId for a vcluster's chained egress (yaac-in-yaac). The
// host server pushes this via PUT /vcluster-attribution: those source pods live
// in another namespace the pod-watch SA can't resolve to the owning session, so
// the server — which knows the mapping — supplies it. Full-replace each push.
const vclusterPodSession = new Map<string, string>()
// Last-applied attribution content, so the every-tick re-push logs only on change.
let lastVclusterAttributionKey = ''

interface ResolvedSession {
  sessionId: string
  /**
   * True when the source IP was attributed via the server-pushed vcluster
   * map rather than a directly-watched session pod. Spawn requests key on
   * this: nested workloads must spawn against their own (inner) yaac, so
   * the outer proxy refuses them.
   */
  viaVclusterAttribution: boolean
}

async function resolveSession(ip: string): Promise<ResolvedSession | undefined> {
  const cached = podIndex.resolve(ip)
  if (cached) return { sessionId: cached, viaVclusterAttribution: false }
  // Server-supplied attribution for a vcluster's chained egress (the pod-watch
  // can't see those cross-namespace source pods).
  const vc = vclusterPodSession.get(ip)
  if (vc) return { sessionId: vc, viaVclusterAttribution: true }
  // Cache-miss fallback: a new pod's first packet can beat its watch event.
  try {
    const fetched = await fetchSessionByPodIp(podIndex, ip)
    return fetched ? { sessionId: fetched, viaVclusterAttribution: false } : undefined
  } catch { return undefined }
}

// When USE_TOR=1, route every upstream connection through the Tor SOCKS
// listener started by entrypoint.sh on container loopback. socks5h://
// resolves DNS at the Tor exit so the proxy's hostname lookups don't
// leak to the container's resolver.
const USE_TOR = process.env.USE_TOR === '1'
const TOR_SOCKS_URL = 'socks5h://127.0.0.1:9050'
const torAgent = USE_TOR ? new SocksProxyAgent(TOR_SOCKS_URL) : null
const torProxy = { host: '127.0.0.1', port: 9050, type: 5 as const }

// How long to wait for Tor to build a circuit and open a tunnel stream before
// giving up. The `socks` library defaults to 30s; Tor's first circuit to a
// given destination can take longer, so use a higher fixed ceiling.
const TOR_TUNNEL_TIMEOUT_MS = 120_000

// Host-mounted credentials directory. The entire `~/.yaac/.credentials/`
// directory is bind-mounted RW so the proxy can read every service's
// credentials at request time and write refreshed Claude OAuth bundles back.
const CREDENTIALS_DIR = '/yaac-credentials'
const GITHUB_CREDS_FILE = path.join(CREDENTIALS_DIR, 'github.json')
const CLAUDE_CREDS_FILE = path.join(CREDENTIALS_DIR, 'claude.json')
const CODEX_CREDS_FILE = path.join(CREDENTIALS_DIR, 'codex.json')
const OPENCODE_CREDS_FILE = path.join(CREDENTIALS_DIR, 'opencode.json')
const PI_CREDS_FILE = path.join(CREDENTIALS_DIR, 'pi.json')
const PROXY_SECRETS_FILE = path.join(CREDENTIALS_DIR, 'proxy-secrets.json')

const CLAUDE_TOKEN_URL_HOST = 'platform.claude.com'
const CLAUDE_TOKEN_URL_PATH = '/v1/oauth/token'
const ANTHROPIC_API_HOST = 'api.anthropic.com'
const OPENAI_API_HOST = 'api.openai.com'
const OPENAI_TOKEN_URL_HOST = 'auth.openai.com'
const OPENAI_TOKEN_URL_PATH = '/oauth/token'
// Codex in ChatGPT auth mode routes inference to chatgpt.com/backend-api, not
// api.openai.com — so we must MITM it too and apply the same Authorization
// swap for codex sessions.
const CHATGPT_HOST = 'chatgpt.com'
const CODEX_DEFAULT_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000
// opencode and pi are api-key only. The proxy swaps the placeholder key for
// the real one on the chosen provider's host when the session is registered as
// that tool. The provider→host tables are code-generated from each tool's own
// registry (models.dev for opencode, the pi package for pi) — see
// ./tool-providers.generated and scripts/gen-tool-providers.ts. The credential
// records which provider; the swap targets that provider's host only. Which
// header carries the key (Authorization: Bearer vs x-api-key) varies by
// provider, so the swap substitutes the placeholder wherever it appears rather
// than assuming one header (see swapApiKeyHeader).

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

type OpencodeCreds = { kind: 'api-key'; apiKey: string; provider: string }

type PiCreds = { kind: 'api-key'; apiKey: string; provider: string }

// NOTE: keep in sync with packages/shared/src/credentials.ts and
// packages/server/src/features/projects/credentials.ts. The proxy bundles independently and can't
// import from src/. SSH entries live in the same file but are irrelevant to
// the proxy — the server uploads SSH keys directly via PUT /agent/keys, so we
// only parse out the HTTPS entries here.
type HttpsCredentialEntry = { pattern: string; token: string }

type ParsedPattern = { host: string; kind: 'any' | 'exact' | 'prefix'; path: string }

type Injection =
  | { action: 'set_header'; name: string; value: string }
  | { action: 'replace_header'; name: string; value: string }
  | { action: 'remove_header'; name: string }
  | { action: 'replace_body_param'; name: string; value: string }

/**
 * Injection as registered via PUT /sessions/:id. Instead of a literal
 * `value`, it may carry a `secretRef` naming an entry in the mounted
 * proxy-secrets credentials file (plus an optional header `prefix`, e.g.
 * "Bearer "). References keep registrations secret-free so they can be
 * persisted to /data; the real value is resolved per request from
 * `/yaac-credentials/proxy-secrets.json`, which also means rotation via
 * the server applies to live sessions immediately.
 */
type RegisteredInjection = {
  action: Injection['action']
  name: string
  value?: string
  secretRef?: string
  prefix?: string
}

type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

type HostInjectionRule = {
  hostPattern: string
  pathPattern: string
  injections: RegisteredInjection[]
}

/**
 * Per-session upstream redirect: when the client MITMs `hostname`, forward
 * the inner HTTP request to this target instead of the real upstream. Only
 * applied inside the MITM path — the client still sees a TLS handshake for
 * the original hostname, and credential-injection still runs before forward.
 * Test-only: lets e2e-cli route "api.anthropic.com" to a mock container on
 * the proxy network.
 */
type UpstreamRedirect = { host: string; port: number; tls?: boolean }

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
    // A CA minted before the SKI/AKI issuer-disambiguation fix carries no
    // subjectKeyIdentifier, so a verifier holding another identically-named
    // "yaac Proxy CA" (e.g. the outer proxy's CA, folded into a nested
    // session's combined trust bundle) can't tell which one signed a leaf and
    // hard-fails on the wrong key. Regenerate it so new leaves get a matching
    // AKI. See getLeafCert.
    if (cert.getExtension('subjectKeyIdentifier')) {
      console.log('[proxy] Loaded existing CA from disk')
      return { key, cert, pem: certPem }
    }
    console.log('[proxy] Existing CA lacks a subjectKeyIdentifier — regenerating')
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
    // SKI so a verifier can pick THIS CA over another identically-named
    // "yaac Proxy CA" (each proxy mints its own self-signed CA with the same
    // CN; a chained nested session trusts both). The leaf's AKI points here,
    // so selection is by key id, not bundle order. See getLeafCert.
    { name: 'subjectKeyIdentifier' },
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
    // AKI = the issuing CA's SKI, so a verifier holding several same-named
    // "yaac Proxy CA" roots (a nested session's combined bundle carries both
    // the inner and outer proxy CAs) selects the CA that actually signed this
    // leaf instead of trying them in name order and hard-failing on the wrong
    // key (OpenSSL does not retry the other candidate). See loadOrGenerateCA.
    {
      name: 'authorityKeyIdentifier',
      keyIdentifier: ca.cert.generateSubjectKeyIdentifier().getBytes(),
    },
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

function readOpencodeCreds(): OpencodeCreds | null {
  try {
    const raw = fs.readFileSync(OPENCODE_CREDS_FILE, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'api-key' && typeof o.apiKey === 'string' && o.apiKey) {
      // `provider` was added later — default to openrouter for files written
      // before it existed. Unknown providers resolve to no host below, so the
      // key is simply never swapped (fail-closed) rather than validated here.
      const provider = typeof o.provider === 'string' && o.provider ? o.provider : 'openrouter'
      return { kind: 'api-key', apiKey: o.apiKey, provider }
    }
    return null
  } catch {
    return null
  }
}

function readPiCreds(): PiCreds | null {
  try {
    const raw = fs.readFileSync(PI_CREDS_FILE, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (o.kind === 'api-key' && typeof o.apiKey === 'string' && o.apiKey) {
      const provider = typeof o.provider === 'string' && o.provider ? o.provider : 'openrouter'
      return { kind: 'api-key', apiKey: o.apiKey, provider }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Read the server-maintained envSecretProxy values (env var name -> secret)
 * from the mounted credentials dir. Written by session-create before each
 * registration; injection rules reference entries by key via `secretRef`.
 */
function readProxySecrets(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(PROXY_SECRETS_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    const secrets = (parsed as Record<string, unknown>).secrets
    if (!secrets || typeof secrets !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Resolve registration-time injections into concrete value injections.
 * The secrets file is read lazily (once per call, only when a rule
 * actually carries a secretRef). Injections whose reference doesn't
 * resolve are dropped — never inject an empty or placeholder credential.
 */
function resolveRegisteredRules(rules: HostInjectionRule[]): InjectionRule[] {
  let secrets: Record<string, string> | null = null
  const out: InjectionRule[] = []
  for (const rule of rules) {
    const injections: Injection[] = []
    for (const inj of rule.injections) {
      if (inj.action === 'remove_header') {
        injections.push({ action: 'remove_header', name: inj.name })
        continue
      }
      let value = inj.value
      if (typeof value !== 'string' && inj.secretRef) {
        secrets ??= readProxySecrets()
        const secret = secrets[inj.secretRef]
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

function isHostSegment(s: string): boolean {
  return s.includes('.') || s === 'localhost'
}

/** Read-time normalization of legacy entries — mirrors lib/project/credentials.ts. */
function normalizeLegacyPattern(pattern: string): string {
  if (pattern === '*') return 'github.com/*'
  const parts = pattern.split('/')
  if (parts.length === 2 && parts[0] && !isHostSegment(parts[0])) {
    return `github.com/${pattern}`
  }
  return pattern
}

function parsePattern(pattern: string): ParsedPattern | null {
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

function matchPattern(pattern: string, host: string, path: string): boolean {
  const p = parsePattern(pattern)
  if (!p) return false
  if (p.host !== host) return false
  if (p.kind === 'any') return true
  if (p.kind === 'exact') return path === p.path
  return path === p.path || path.startsWith(p.path + '/')
}

/** Parse a git remote URL. Accepts https:// and SCP-style only. */
function parseGitRemote(remoteUrl: string | undefined): {
  scheme: 'https' | 'ssh'
  host: string
  path: string
} | null {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null
  if (remoteUrl.startsWith('https://')) {
    try {
      const url = new URL(remoteUrl)
      const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '')
      if (!path) return null
      return { scheme: 'https', host: url.hostname, path }
    } catch {
      return null
    }
  }
  const m = /^(?:([\w._-]+)@)?([\w.-]+):(?!\/)(.+)$/.exec(remoteUrl)
  if (m) {
    const host = m[2]
    const path = m[3].replace(/\.git$/, '')
    if (!path) return null
    return { scheme: 'ssh', host, path }
  }
  return null
}

function readGitCredentials(): HttpsCredentialEntry[] {
  try {
    const raw = fs.readFileSync(GITHUB_CREDS_FILE, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return []
    const o = parsed as Record<string, unknown>
    if (!Array.isArray(o.tokens)) return []
    const result: HttpsCredentialEntry[] = []
    for (const entry of o.tokens as unknown[]) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const kind = e.kind ?? 'https'
      if (kind !== 'https') continue
      if (typeof e.pattern !== 'string' || typeof e.token !== 'string' || !e.token) continue
      const pattern = normalizeLegacyPattern(e.pattern)
      if (!parsePattern(pattern)) continue
      result.push({ pattern, token: e.token })
    }
    return result
  } catch {
    return []
  }
}

/**
 * Resolve the HTTPS credential for a session's repoUrl, returning the matched
 * token along with the (host, path) it matched on so callers can guard against
 * cross-host token leakage.
 */
function resolveHttpsCredentialForRepo(repoUrl: string | undefined): {
  token: string; host: string; path: string
} | null {
  const creds = readGitCredentials()
  if (creds.length === 0) return null
  const parsed = parseGitRemote(repoUrl)
  if (!parsed || parsed.scheme !== 'https') return null
  for (const entry of creds) {
    if (matchPattern(entry.pattern, parsed.host, parsed.path)) {
      return { token: entry.token, host: parsed.host, path: parsed.path }
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
// Per-tenant state is keyed by sessionId (the same credential the
// container sends in the Proxy-Authorization header), except git-auth
// failures, which are keyed by the session's project. A session is
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

/** sessionId -> owning project slug (scopes the git-auth-failure records) */
const sessionProject = new Map<string, string>()

/**
 * sessionId -> (hostname -> upstream redirect target). Test-only: redirects
 * the post-MITM upstream call to a mock while leaving TLS termination and
 * credential injection intact.
 */
const sessionUpstreamRedirects = new Map<string, Record<string, UpstreamRedirect>>()

/** sessionId -> Set of blocked hostnames */
const blockedHostsBySession = new Map<string, Set<string>>()

/**
 * projectSlug -> (hostname -> auth-failure record). Populated when an
 * upstream rejects a git smart-HTTP request that carried a yaac-injected
 * credential — i.e. the stored token itself is bad (expired/revoked),
 * not a missing allowlist entry. Keyed by project (resolved through the
 * requesting session's registration): the credential belongs to the
 * project's repo, so one bad token flags every session of the project,
 * and the record outlives the session that first hit it. Cleared per
 * host on the next successful injected git request from any of the
 * project's sessions, so the flag self-heals after `yaac auth update`.
 */
const gitAuthFailuresByProject = new Map<string, Map<string, GitAuthFailureRecord>>()

interface GitAuthFailureRecord {
  /** HTTP status the upstream returned (401 or 403). */
  status: number
  /** Epoch ms when the failure was first seen. */
  atMs: number
}

// ── State persistence (/data write-through) ────────────────────────────
//
// /data is a hostPath, so anything written here is directly readable by
// the server off the host filesystem — no HTTP round-trip. Blocked hosts
// are written through on change (they're plain hostnames, no secrets);
// session registrations are written through on PUT/DELETE so a replaced
// proxy pod reloads them at boot and self-heals without server help.
// Registrations are safe to persist because injection rules carry
// credential *references* (`secretRef`), never secret values — the values
// live in the mounted credentials dir and are resolved at injection time.

const BLOCKED_HOSTS_FILE = path.join(DATA_DIR, 'blocked-hosts.json')
const GIT_AUTH_FAILURES_FILE = path.join(DATA_DIR, 'git-auth-failures.json')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')

/**
 * Atomic write via tmp+rename so a concurrent host-side reader never sees
 * a torn file — same pattern as the OAuth bundle writers.
 */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = filePath + '.tmp-' + crypto.randomBytes(6).toString('hex')
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, filePath)
}

function persistBlockedHosts(): void {
  const result: Record<string, string[]> = {}
  for (const [sid, hosts] of blockedHostsBySession) {
    if (hosts.size > 0) result[sid] = [...hosts]
  }
  try {
    writeJsonAtomic(BLOCKED_HOSTS_FILE, result)
  } catch (err) {
    console.error('[proxy] Failed to persist blocked hosts:', (err as Error).message)
  }
}

function loadBlockedHosts(): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(BLOCKED_HOSTS_FILE, 'utf8'))
  } catch {
    return // first boot or unreadable — start empty
  }
  if (!parsed || typeof parsed !== 'object') return
  for (const [sid, hosts] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(hosts)) continue
    blockedHostsBySession.set(sid, new Set(hosts.filter((h) => typeof h === 'string')))
  }
  console.log(`[proxy] Loaded blocked hosts for ${blockedHostsBySession.size} session(s) from disk`)
}

function persistGitAuthFailures(): void {
  const result: Record<string, Array<{ host: string; status: number; atMs: number }>> = {}
  for (const [slug, byHost] of gitAuthFailuresByProject) {
    if (byHost.size === 0) continue
    result[slug] = [...byHost].map(([host, rec]) => ({ host, ...rec }))
  }
  try {
    writeJsonAtomic(GIT_AUTH_FAILURES_FILE, result)
  } catch (err) {
    console.error('[proxy] Failed to persist git auth failures:', (err as Error).message)
  }
}

function loadGitAuthFailures(): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(GIT_AUTH_FAILURES_FILE, 'utf8'))
  } catch {
    return // first boot or unreadable — start empty
  }
  if (!parsed || typeof parsed !== 'object') return
  for (const [slug, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    const byHost = new Map<string, GitAuthFailureRecord>()
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue
      const { host, status, atMs } = e as Record<string, unknown>
      if (typeof host !== 'string' || typeof status !== 'number' || typeof atMs !== 'number') continue
      byHost.set(host, { status, atMs })
    }
    if (byHost.size > 0) gitAuthFailuresByProject.set(slug, byHost)
  }
  console.log(`[proxy] Loaded git auth failures for ${gitAuthFailuresByProject.size} project(s) from disk`)
}

/**
 * Snapshot of everything PUT /sessions/:id registers. `upstreamRedirects`
 * is test-only state (see UpstreamRedirect) — persisting it is harmless
 * and keeps the snapshot a faithful copy of the registration.
 */
type PersistedSession = {
  rules: HostInjectionRule[]
  allowedHosts: string[]
  repoUrl?: string
  tool: string
  projectSlug: string
  upstreamRedirects?: Record<string, UpstreamRedirect>
}

function persistSessions(): void {
  const result: Record<string, PersistedSession> = {}
  for (const [sid, allowedHosts] of sessionAllowedHosts) {
    result[sid] = {
      rules: sessionRules.get(sid) ?? [],
      allowedHosts,
      repoUrl: sessionRepoUrl.get(sid),
      // Both validated as present by the PUT handler.
      tool: sessionTool.get(sid)!,
      projectSlug: sessionProject.get(sid)!,
      upstreamRedirects: sessionUpstreamRedirects.get(sid),
    }
  }
  try {
    writeJsonAtomic(SESSIONS_FILE, result)
  } catch (err) {
    console.error('[proxy] Failed to persist sessions:', (err as Error).message)
  }
}

function loadSessions(): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
  } catch {
    return // first boot or unreadable — start empty
  }
  if (!parsed || typeof parsed !== 'object') return
  for (const [sid, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as PersistedSession
    if (!Array.isArray(s.rules) || !Array.isArray(s.allowedHosts)) continue
    sessionRules.set(sid, s.rules)
    sessionAllowedHosts.set(sid, s.allowedHosts)
    if (s.repoUrl) sessionRepoUrl.set(sid, s.repoUrl)
    sessionTool.set(sid, s.tool)
    sessionProject.set(sid, s.projectSlug)
    if (s.upstreamRedirects) sessionUpstreamRedirects.set(sid, s.upstreamRedirects)
  }
  console.log(`[proxy] Loaded ${sessionAllowedHosts.size} session registration(s) from disk`)
}

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
  if (hosts.has(hostname)) return
  hosts.add(hostname)
  // Write-through only when the set actually grew — repeat blocks of the
  // same host are by far the common case and need no disk traffic.
  persistBlockedHosts()
}

/**
 * Git smart-HTTP endpoints: the ref advertisement
 * (GET <repo>/info/refs?service=git-upload-pack|git-receive-pack) and the
 * two POST RPC endpoints. Scoping the auth-failure signal to these keeps a
 * 401 from an unrelated API on the same host from raising the "git
 * credential is bad" flag.
 */
function isGitSmartHttpPath(requestPath: string): boolean {
  const [pathname, query = ''] = requestPath.split('?', 2)
  if (pathname.endsWith('/info/refs')) {
    const service = new URLSearchParams(query).get('service')
    return service === 'git-upload-pack' || service === 'git-receive-pack'
  }
  return pathname.endsWith('/git-upload-pack') || pathname.endsWith('/git-receive-pack')
}

/**
 * Track the upstream's verdict on a git smart-HTTP request that carried a
 * yaac-injected credential. A 401/403 means the stored token itself was
 * rejected (expired or revoked) — record it against the session's project
 * (write-through, like blocked hosts) so the server surfaces a loud
 * project-wide error. A later 2xx on the same host from any of the
 * project's sessions clears the record, so the flag self-heals once the
 * user runs `yaac auth update` and git is retried.
 */
function noteGitUpstreamStatus(
  sessionId: string,
  hostname: string,
  requestPath: string,
  status: number,
): void {
  if (!isGitSmartHttpPath(requestPath)) return
  const projectSlug = sessionProject.get(sessionId)
  if (!projectSlug) return // unregistered session — can't attribute
  const byHost = gitAuthFailuresByProject.get(projectSlug)
  if (status === 401 || status === 403) {
    if (byHost?.has(hostname)) return // repeat failure — no disk traffic
    console.log(`[proxy] GIT AUTH FAILED for ${hostname} (HTTP ${status}, project ${projectSlug})`)
    const hosts = byHost ?? new Map<string, GitAuthFailureRecord>()
    hosts.set(hostname, { status, atMs: Date.now() })
    gitAuthFailuresByProject.set(projectSlug, hosts)
    persistGitAuthFailures()
    return
  }
  if (status >= 200 && status < 300 && byHost?.delete(hostname)) {
    console.log(`[proxy] git auth recovered for ${hostname} (project ${projectSlug})`)
    persistGitAuthFailures()
  }
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
 * Hosts the proxy MITMs so it can inject agent-tool credentials read from
 * the mounted credentials dir, plus any HTTPS host for which the current
 * session has a matching git credential. SSH (port 22) is always tunneled,
 * never MITM'd. Rule-based per-session MITM is still applied on top of this.
 */
function hostNeedsDynamicMitm(sessionId: string | null, hostname: string, port: number): boolean {
  if (port === 22) return false
  if (hostname === ANTHROPIC_API_HOST) return true
  if (hostname === CLAUDE_TOKEN_URL_HOST) return true
  if (hostname === OPENAI_API_HOST) return true
  if (hostname === OPENAI_TOKEN_URL_HOST) return true
  if (hostname === CHATGPT_HOST) return true
  // opencode / pi: MITM the session's chosen provider host so the api-key swap
  // in buildDynamicRules can run. Matches that swap's gating exactly — only the
  // one host the registered tool's credential points at.
  const tool = sessionId ? sessionTool.get(sessionId) : undefined
  if (tool === 'opencode') {
    const creds = readOpencodeCreds()
    if (creds && hostname === OPENCODE_PROVIDER_HOSTS[creds.provider]) return true
  }
  if (tool === 'pi') {
    const creds = readPiCreds()
    if (creds && hostname === PI_PROVIDER_HOSTS[creds.provider]) return true
  }
  if (sessionId && sessionHasHttpsCredentialForHost(sessionId, hostname)) return true
  // gh CLI: MITM the GitHub API host so we can swap the placeholder GH_TOKEN
  // for the session's real git token (api.github.com is not the git remote
  // host, so the credential check above misses it).
  if (sessionId && resolveGithubApiTokenForSession(sessionId, hostname) !== null) return true
  return false
}

function sessionHasHttpsCredentialForHost(sessionId: string, hostname: string): boolean {
  const cred = resolveHttpsCredentialForRepo(sessionRepoUrl.get(sessionId))
  return cred?.host === hostname
}

/**
 * Map a git host to the API host the GitHub CLI (`gh`) talks to. Mirrors
 * ghApiHostForGitHost in packages/shared/src/credentials.ts — public GitHub's API is
 * api.github.com while the git remote is github.com.
 */
function ghApiHostForGitHost(host: string): string | null {
  if (host === 'github.com') return 'api.github.com'
  return null
}

/**
 * Resolve the GitHub token to inject for `gh` traffic to `hostname`: the
 * session's HTTPS git token, but only when `hostname` is the gh API host for
 * that credential's git host. The host gate keeps the token from leaking onto
 * unrelated MITM'd hosts.
 */
function resolveGithubApiTokenForSession(sessionId: string, hostname: string): string | null {
  const cred = resolveHttpsCredentialForRepo(sessionRepoUrl.get(sessionId))
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
 * Swap the api-key placeholder for the real key on an opencode/pi request,
 * wherever the sentinel appears. api-key-only tools send the key in whichever
 * header the provider's API expects — `x-api-key` for Anthropic-style
 * providers, `Authorization: Bearer` for the rest — so rather than tracking
 * the header per provider we substitute in place: the real key lands in the
 * same header the tool put the sentinel. A no-op when the request carries a
 * user-supplied key (no sentinel) rather than the placeholder.
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
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  if (!sessionId) return []
  const rules: InjectionRule[] = []

  // HTTPS git credential injection: only fires when the session's repoUrl
  // host matches the current MITM hostname. The host equality guard keeps a
  // token scoped to e.g. github.com from leaking into a request to
  // chatgpt.com (which is also MITM'd for other reasons).
  const httpsCred = resolveHttpsCredentialForRepo(sessionRepoUrl.get(sessionId))
  if (httpsCred && httpsCred.host === hostname) {
    const basic = 'Basic ' + Buffer.from(`x-access-token:${httpsCred.token}`).toString('base64')
    rules.push({
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: basic }],
    })
  }

  // GitHub CLI (`gh`) auth: the container's GH_TOKEN carries the placeholder.
  // gh sends it to the GitHub API host (api.github.com — REST + GraphQL) as
  // `Authorization: token <placeholder>` (or `Bearer`). Swap in the session's
  // real github.com HTTPS git token, preserving gh's auth scheme. Gated on the
  // session having a matching GitHub credential AND on the placeholder
  // sentinel, so traffic carrying a user-supplied token passes through.
  const ghApiToken = resolveGithubApiTokenForSession(sessionId, hostname)
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

  // Anthropic credential swap is gated on the session being registered for
  // tool=claude (matching the codex/opencode gates below — a session must
  // never be able to spend another tool's credential; every pod carries all
  // placeholder env vars so prewarmed spares can be retooled, and a retool
  // re-registers the session, moving this gate with it) and on the inbound
  // request carrying our placeholder sentinel. Requests that don't match
  // (e.g. a user manually passing their own API key through the proxy) pass
  // through unmodified — the proxy only rewrites traffic it knows it
  // originated the placeholder for.
  if (hostname === ANTHROPIC_API_HOST && sessionTool.get(sessionId) === 'claude') {
    const creds = readClaudeCreds()
    const incomingApiKey = headerValue(reqHeaders, 'x-api-key')
    const incomingAuth = headerValue(reqHeaders, 'authorization')
    if (creds && creds.kind === 'api-key' && incomingApiKey === PLACEHOLDER_API_KEY) {
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
          value: 'Bearer ' + creds.bundle.accessToken,
        }],
      })
    }
  }

  // Codex credential swap is gated on the inbound Authorization header
  // matching our placeholder sentinel — either the api-key sentinel (codex
  // reads OPENAI_API_KEY and sends `Bearer <key>`) or the OAuth access-token
  // sentinel from the mounted auth.json. Requests that don't match pass
  // through unmodified. `ChatGPT-Account-Id` is populated by Codex from the
  // real top-level `account_id` in the mounted auth.json, so it passes
  // through unchanged.
  if ((hostname === OPENAI_API_HOST || hostname === CHATGPT_HOST)
    && sessionTool.get(sessionId) === 'codex') {
    const creds = readCodexCreds()
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
          value: 'Bearer ' + creds.bundle.accessToken,
        }],
      })
    }
  }

  // opencode / pi credential swap. Both are api-key only: the container's env
  // carries the chosen provider's key var set to the placeholder, the tool
  // sends the placeholder to the provider's host, and the proxy substitutes
  // the real key here. Gated on the session's registered tool + the host
  // matching the credential's provider + the placeholder sentinel, so
  // unrelated traffic (or a user manually carrying their own key) passes
  // through untouched. Which header carries the key varies by provider
  // (x-api-key for Anthropic-style, Authorization: Bearer for the rest), so
  // swapApiKeyHeader substitutes wherever the sentinel appears.
  if (sessionTool.get(sessionId) === 'opencode') {
    const creds = readOpencodeCreds()
    if (creds && hostname === OPENCODE_PROVIDER_HOSTS[creds.provider]) {
      swapApiKeyHeader(rules, reqHeaders, creds.apiKey)
    }
  }
  if (sessionTool.get(sessionId) === 'pi') {
    const creds = readPiCreds()
    if (creds && hostname === PI_PROVIDER_HOSTS[creds.provider]) {
      swapApiKeyHeader(rules, reqHeaders, creds.apiKey)
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
const PLACEHOLDER_API_KEY = 'yaac-ph-api-key'
const PLACEHOLDER_GH_TOKEN = 'yaac-ph-gh-token'

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

// ── MITM Handler ───────────────────────────────────────────────────────

function handleMitm(
  clientSocket: Duplex,
  hostname: string,
  port: string | undefined,
  sessionId: string | null,
  rules: HostInjectionRule[],
  upstreamRedirect: UpstreamRedirect | null,
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
    // swap placeholders inbound. Null when this isn't the token endpoint,
    // when no OAuth bundle is on disk (nothing to swap), or when the session
    // isn't registered for the matching tool — only a claude session may
    // drive a claude token refresh (codex likewise), so one tool's session
    // can't rotate or exercise another tool's credential. (The host-side
    // tool sign-in flow never traverses the session proxy, so it's
    // unaffected.)
    const claudeTokenBundle =
      hostname === CLAUDE_TOKEN_URL_HOST && reqPath === CLAUDE_TOKEN_URL_PATH
      && sessionId !== null && sessionTool.get(sessionId) === 'claude'
        ? readClaudeOAuthBundle()
        : null
    const codexTokenBundle =
      hostname === OPENAI_TOKEN_URL_HOST && reqPath === OPENAI_TOKEN_URL_PATH
      && sessionId !== null && sessionTool.get(sessionId) === 'codex'
        ? readCodexOAuthBundle()
        : null

    // Dynamic rules (GitHub / Codex / Claude auth + OAuth refresh swap) are
    // derived from the host-mounted credentials dir on every request and
    // merged into the registered rules (secretRefs resolved per request,
    // same freshness semantics) so a single injection pipeline handles both.
    const dynamicRules = buildDynamicRules(
      sessionId, hostname, claudeTokenBundle, codexTokenBundle, req.headers,
    )
    const allRules: InjectionRule[] = [...resolveRegisteredRules(rules), ...dynamicRules]
    const injCount = applyInjections(headers, reqPath, allRules)
    const bodyInjections = collectBodyInjections(reqPath, allRules)

    // Watch the upstream's verdict when this request goes to the session's
    // git host with a yaac-injected credential (the same condition under
    // which buildDynamicRules added the git Authorization rule above) — a
    // 401/403 on a git endpoint means the stored token is bad.
    const gitCredInjected =
      sessionId !== null && sessionHasHttpsCredentialForHost(sessionId, hostname)

    const totalInj = injCount + bodyInjections.length
    if (totalInj > 0) {
      const dynSuffix = dynamicRules.length > 0 ? ` + dynamic(${dynamicRules.length})` : ''
      console.log(`[proxy] MITM ${req.method} https://${hostname}${reqPath} (${injCount} header + ${bodyInjections.length} body injections${dynSuffix})`)
    }

    function sendUpstream(body: Buffer | null, shouldCaptureTokenResponse: boolean): void {
      if (body !== null) {
        headers['content-length'] = String(body.length)
      }
      // Route to the redirect target when one is registered for this host.
      // Test-mode mocks serve plain HTTP, so tls defaults to false when
      // redirecting; the client still gets a real TLS handshake with the
      // proxy's leaf cert for `hostname`.
      const useHttp = upstreamRedirect !== null && upstreamRedirect.tls !== true
      const upstreamModule = useHttp ? http : https
      // Skip Tor when redirected to a loopback test mock — Tor refuses
      // loopback destinations.
      const useTorAgent = torAgent !== null && upstreamRedirect === null
      const upstream = upstreamModule.request({
        hostname: upstreamRedirect?.host ?? hostname,
        port: upstreamRedirect?.port ?? (parseInt(port ?? '', 10) || 443),
        path: reqPath,
        method: req.method,
        headers,
        ...(useHttp ? {} : { rejectUnauthorized: true }),
        ...(useTorAgent ? { agent: torAgent } : {}),
      }, (upstreamRes) => {
        if (gitCredInjected && sessionId !== null) {
          noteGitUpstreamStatus(sessionId, hostname, reqPath, upstreamRes.statusCode ?? 0)
        }
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

  // WebSocket upgrades (e.g. Codex's `transport="responses_websocket"` path
  // on chatgpt.com/backend-api/responses). Without an explicit 'upgrade'
  // handler, Node's http.Server buffers upgrade requests until the 15s
  // timeout — Codex retries 5x before falling back to HTTP. Open a TLS
  // upgrade request upstream, swap the Authorization header the same way
  // as regular requests, then pipe the two sockets raw.
  mitmServer.on('upgrade', (req: http.IncomingMessage, wsClientSocket: Duplex, head: Buffer) => {
    const reqPath = req.url ?? '/'
    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']

    const dynamicRules = buildDynamicRules(sessionId, hostname, null, null, req.headers)
    const allRules: InjectionRule[] = [...resolveRegisteredRules(rules), ...dynamicRules]
    const injCount = applyInjections(headers, reqPath, allRules)

    if (injCount > 0) {
      const dynSuffix = dynamicRules.length > 0 ? ` + dynamic(${dynamicRules.length})` : ''
      console.log(`[proxy] MITM UPGRADE wss://${hostname}${reqPath} (${injCount} header injections${dynSuffix})`)
    }

    // Same redirect handling as non-upgrade requests: route to the mock
    // when one is registered for this host. Mocks don't speak WS, so they
    // will return a plain 200 and the client will fall back to HTTP.
    const useHttp = upstreamRedirect !== null && upstreamRedirect.tls !== true
    const upstreamModule = useHttp ? http : https
    const useTorAgent = torAgent !== null && upstreamRedirect === null
    const upstreamReq = upstreamModule.request({
      hostname: upstreamRedirect?.host ?? hostname,
      port: upstreamRedirect?.port ?? (parseInt(port ?? '', 10) || 443),
      path: reqPath,
      method: req.method,
      headers,
      ...(useHttp ? {} : { rejectUnauthorized: true }),
      ...(useTorAgent ? { agent: torAgent } : {}),
    })

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`
      const lines = [statusLine]
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined) continue
        const values = Array.isArray(v) ? v : [v]
        for (const value of values) {
          lines.push(`${k}: ${value}`)
        }
      }
      wsClientSocket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upstreamHead.length > 0) wsClientSocket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)

      wsClientSocket.pipe(upstreamSocket)
      upstreamSocket.pipe(wsClientSocket)

      upstreamSocket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'ECONNRESET') {
          console.error(`[proxy] WS upstream socket error for ${hostname}:`, err.message)
        }
        wsClientSocket.destroy()
      })
      wsClientSocket.on('error', () => {
        upstreamSocket.destroy()
      })
    })

    upstreamReq.on('response', (upstreamRes) => {
      const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ''}`
      const lines = [statusLine]
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined) continue
        const values = Array.isArray(v) ? v : [v]
        for (const value of values) {
          lines.push(`${k}: ${value}`)
        }
      }
      wsClientSocket.write(lines.join('\r\n') + '\r\n\r\n')
      upstreamRes.pipe(wsClientSocket)
    })

    upstreamReq.on('error', (err: Error) => {
      console.error(`[proxy] WS upstream error for ${hostname}${reqPath}:`, err.message)
      wsClientSocket.destroy()
    })

    upstreamReq.end()
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
  const destPort = parseInt(port ?? '', 10) || 443

  // Tor refuses loopback/RFC1918 upstreams, and the transparent listeners
  // widened what can reach this path (any allowlisted SNI, including
  // in-cluster names in tests) — internal destinations go direct. Same
  // guard shape as the MITM path's redirect carve-out (sendUpstream).
  if (USE_TOR && !isInternalUpstream(hostname)) {
    void SocksClient.createConnection({
      proxy: torProxy,
      command: 'connect',
      destination: { host: hostname, port: destPort },
      timeout: TOR_TUNNEL_TIMEOUT_MS,
    }, (err, info) => {
      if (err || !info) {
        console.error(`[proxy] Tor tunnel error for ${hostname}:`, err?.message ?? 'no socket')
        clientSocket.end()
        return
      }
      const upstream = info.socket
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
      upstream.on('error', (uerr: Error) => {
        console.error(`[proxy] Tunnel error for ${hostname}:`, uerr.message)
        clientSocket.end()
      })
      clientSocket.on('error', () => { upstream.destroy() })
    })
    return
  }

  const upstream = net.connect(destPort, hostname, () => {
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

// ── Upstream Dispatch (shared by CONNECT + transparent listeners) ─────

/**
 * Authorize `hostname` for the session and hand the socket to the MITM
 * or tunnel path. The explicit CONNECT listener and the transparent
 * HTTPS listener share everything from the allowlist check onward; they
 * differ only in framing — CONNECT writes an HTTP response head
 * (`writeConnectOk`, and a 403 on block), while a transparent socket
 * carries raw TLS, so a block is a pre-handshake destroy.
 */
function dispatchToUpstream(
  clientSocket: Duplex,
  hostname: string,
  port: string | undefined,
  sessionId: string,
  opts: { writeConnectOk: boolean; head?: Buffer },
): void {
  // Hold the read side until handleMitm/handleTunnel attaches the pipe (which
  // resumes it). We connect upstream asynchronously, so without this the bytes
  // the client sends right after our 200 — the TLS ClientHello on a CONNECT
  // tunnel — land on a flowing socket with no consumer and are silently
  // dropped, stalling the handshake. The SNI peeker already pauses; this makes
  // the guarantee hold for every dispatch path.
  clientSocket.pause()

  // The spawn endpoint is HTTP-only (the transparent HTTP listener handles it
  // before the allowlist). A stray HTTPS/CONNECT attempt would otherwise land
  // in the blocked-hosts record and confuse the webapp badge — hint instead.
  if (hostname === SPAWN_MAGIC_HOST) {
    console.log(`[proxy] spawn magic host dialed on ${opts.writeConnectOk ? 'CONNECT' : 'HTTPS'} — use http://${SPAWN_MAGIC_HOST}${SPAWN_PATH}`)
    if (opts.writeConnectOk) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.end()
    } else {
      clientSocket.destroy()
    }
    return
  }

  if (!isHostAllowed(sessionId, hostname)) {
    const label = opts.writeConnectOk ? 'CONNECT' : 'transparent HTTPS'
    console.log(`[proxy] BLOCKED ${label} to ${hostname}:${port ?? '443'} (not in allowlist)`)
    recordBlockedHost(sessionId, hostname)
    if (opts.writeConnectOk) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.end()
    } else {
      clientSocket.destroy()
    }
    return
  }

  const rules = findRulesForHost(sessionId, hostname)

  // Always MITM well-known tool-auth hosts so we can inject credentials
  // read from the host-mounted credentials dir, even when no per-session
  // rule-based injections apply. Port-aware: SSH (22) always tunnels.
  const destPort = parseInt(port ?? '', 10) || 443
  const needsDynMitm = hostNeedsDynamicMitm(sessionId, hostname, destPort)

  // A registered redirect for this hostname forces MITM — without it, the
  // proxy would tunnel bytes unchanged and the redirect could never apply.
  const redirect = sessionUpstreamRedirects.get(sessionId)?.[hostname] ?? null

  if (opts.writeConnectOk) {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  }

  if (opts.head && opts.head.length > 0) {
    clientSocket.unshift(opts.head)
  }

  if (rules.length > 0 || needsDynMitm || redirect) {
    handleMitm(clientSocket, hostname, port, sessionId, rules, redirect)
  } else {
    handleTunnel(clientSocket, hostname, port)
  }
}

// ── API Request Handler ────────────────────────────────────────────────

function checkAuth(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization
  if (typeof auth !== 'string') return false
  return timingSafeStrEqual(auth, `Bearer ${PROXY_AUTH_SECRET}`)
}

function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === 'GET' && req.url === '/healthz') {
    if (USE_TOR && !fs.existsSync('/data/tor-ready')) {
      res.writeHead(503)
      res.end('tor not ready')
      return
    }
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

  // Combined trust bundle for nested containers: the image's public roots
  // PLUS the proxy MITM CA. The own-bundle tools in nested containers
  // (curl / requests / cargo / git-libcurl) point CURL_CA_BUNDLE & friends
  // at this superset, so they trust the proxy on intercepted hosts AND real
  // upstreams on tunnelled hosts. See k8s/proxy/ca-bundle.ts.
  if (req.method === 'GET' && req.url === '/ca-bundle.pem') {
    if (!ca) {
      res.writeHead(503)
      res.end('CA not ready')
      return
    }
    let roots = ''
    try {
      roots = fs.readFileSync(SYSTEM_ROOTS_PATH, 'utf8')
    } catch (err) {
      console.error(`[proxy] cannot read system roots at ${SYSTEM_ROOTS_PATH}: ${(err as Error).message}`)
      res.writeHead(500)
      res.end('system roots unavailable')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/x-pem-file' })
    res.end(combineCaBundle(roots, ca.pem))
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
        if (typeof o.tool !== 'string' || !o.tool) { res.writeHead(400); res.end('Invalid body: need tool'); return }
        if (typeof o.projectSlug !== 'string' || !o.projectSlug) { res.writeHead(400); res.end('Invalid body: need projectSlug'); return }
        sessionRules.set(sessionId, rules as HostInjectionRule[])
        const allowedHosts = o.allowedHosts as string[]
        sessionAllowedHosts.set(sessionId, allowedHosts)
        if (typeof o.repoUrl === 'string' && o.repoUrl) {
          sessionRepoUrl.set(sessionId, o.repoUrl)
        } else {
          sessionRepoUrl.delete(sessionId)
        }
        sessionTool.set(sessionId, o.tool)
        sessionProject.set(sessionId, o.projectSlug)
        if (o.upstreamRedirects && typeof o.upstreamRedirects === 'object') {
          const parsed: Record<string, UpstreamRedirect> = {}
          for (const [host, target] of Object.entries(o.upstreamRedirects as Record<string, unknown>)) {
            if (!target || typeof target !== 'object') continue
            const t = target as Record<string, unknown>
            if (typeof t.host === 'string' && typeof t.port === 'number') {
              parsed[host] = {
                host: t.host,
                port: t.port,
                tls: typeof t.tls === 'boolean' ? t.tls : undefined,
              }
            }
          }
          sessionUpstreamRedirects.set(sessionId, parsed)
        } else {
          sessionUpstreamRedirects.delete(sessionId)
        }
        // Write-through: registrations are secret-free (rules carry
        // secretRefs), so a replaced pod reloads them at boot and live
        // sessions keep working with zero server involvement.
        persistSessions()
        const redirectCount = sessionUpstreamRedirects.get(sessionId)
          ? Object.keys(sessionUpstreamRedirects.get(sessionId)!).length
          : 0
        const redirectSuffix = redirectCount > 0 ? `, ${redirectCount} upstream redirects` : ''
        console.log(`[proxy] Registered session ${sessionId.slice(0, 8)}... (${rules.length} rules, ${allowedHosts.length} allowed host patterns${redirectSuffix})`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400); res.end(`Invalid JSON: ${(err as Error).message}`)
      }
    })
    return
  }

  // Live-widen one session's allowlist (webapp "allow blocked host" action).
  // Appends the host to the in-memory allowlist so the next connect is
  // permitted immediately, and prunes it from the recorded blocked set so the
  // webapp badge clears. Write-through both: a replaced pod keeps the widened
  // allowlist for the session's lifetime, and the server reads the pruned
  // blocked-hosts file straight off /data.
  const allowHostMatch = req.method === 'POST' && req.url
    ? /^\/sessions\/([^/]+)\/allow-host$/.exec(req.url)
    : null
  if (allowHostMatch) {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    const sessionId = decodeURIComponent(allowHostMatch[1])
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(body)
        const host = parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>).host
          : undefined
        if (typeof host !== 'string' || !host) {
          res.writeHead(400); res.end('Invalid body: need host string'); return
        }
        const allowed = sessionAllowedHosts.get(sessionId)
        // Fail closed: only a registered session can be widened. The server
        // treats this 404 as a soft miss when fanning out over siblings.
        if (!allowed) { res.writeHead(404); res.end('Unknown session'); return }
        if (!allowed.includes(host)) {
          allowed.push(host)
          persistSessions()
        }
        const blocked = blockedHostsBySession.get(sessionId)
        if (blocked && blocked.delete(host)) persistBlockedHosts()
        console.log(`[proxy] Allowed ${host} for session ${sessionId.slice(0, 8)}...`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400); res.end(`Invalid JSON: ${(err as Error).message}`)
      }
    })
    return
  }

  // yaac-in-yaac attribution: the host server pushes a full `{ podIP:
  // outerSessionId }` map for every managed vcluster's pods, so chained egress
  // (the inner proxy's upstream dials + pre-opt-in synced pods) is attributed to
  // the owning OUTER session and judged against its allowlist. Not persisted —
  // pod IPs are ephemeral and the server re-pushes every tick; a replaced proxy
  // fail-closes on this traffic until the next push.
  if (req.method === 'PUT' && req.url === '/vcluster-attribution') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      const map = parseVclusterAttribution(body)
      if (!map) { res.writeHead(400); res.end('Invalid body: need {podIP: sessionId}'); return }
      const key = [...map.entries()].map(([ip, sid]) => `${ip}=${sid}`).sort().join(',')
      vclusterPodSession.clear()
      for (const [ip, sid] of map) vclusterPodSession.set(ip, sid)
      // The server re-pushes every tick (so the map survives a proxy restart);
      // only log when it actually changes, to keep the log quiet at steady state.
      if (key !== lastVclusterAttributionKey) {
        lastVclusterAttributionKey = key
        console.log(`[proxy] vcluster attribution updated (${map.size} pod IP(s))`)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }

  // List registered session ids. Diagnostic surface — e2e tests use it
  // to assert a replaced pod reloaded its registrations from /data.
  if (req.method === 'GET' && req.url === '/sessions') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([...sessionAllowedHosts.keys()]))
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
    sessionProject.delete(sessionId)
    sessionUpstreamRedirects.delete(sessionId)
    // Git-auth failures are deliberately NOT cleared here: they are keyed by
    // project, and a bad stored credential outlives any one session. The
    // record clears on the next successful git request from any of the
    // project's sessions.
    const hadBlockedHosts = blockedHostsBySession.delete(sessionId)
    persistSessions()
    if (hadBlockedHosts) persistBlockedHosts()
    console.log(`[proxy] Removed session ${sessionId.slice(0, 8)}... (found: ${deleted})`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, deleted }))
    return
  }

  // ssh-agent management. The server uploads keys here at startup and on
  // every `yaac auth update` SSH add/remove. Key bytes live only in the
  // agent's memory — never persisted to the proxy filesystem.
  if (req.method === 'PUT' && req.url === '/agent/keys') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      let parsed: { host?: unknown; keyPem?: unknown; knownHostsEntry?: unknown }
      try {
        parsed = JSON.parse(body) as typeof parsed
      } catch {
        res.writeHead(400); res.end('Invalid JSON'); return
      }
      if (typeof parsed.host !== 'string' || !parsed.host
        || typeof parsed.keyPem !== 'string' || !parsed.keyPem
        || typeof parsed.knownHostsEntry !== 'string' || !parsed.knownHostsEntry) {
        res.writeHead(400); res.end('Need {host, keyPem, knownHostsEntry}'); return
      }
      void sshAddKey(parsed.host, parsed.keyPem, parsed.knownHostsEntry).then(
        () => { res.writeHead(200); res.end('ok') },
        (err: Error) => { res.writeHead(400); res.end(err.message) },
      )
    })
    return
  }

  if (req.method === 'DELETE' && req.url === '/agent/keys') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    void sshClearAgent().then(
      () => { res.writeHead(200); res.end('ok') },
      (err: Error) => { res.writeHead(500); res.end(err.message) },
    )
    return
  }

  if (req.method === 'GET' && req.url === '/agent/keys') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    void sshListAgent().then(
      (rows) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rows))
      },
      (err: Error) => { res.writeHead(500); res.end(err.message) },
    )
    return
  }

  // In-session spawn requests: the server drains pending requests each
  // background tick (drain = claim, at-most-once) ...
  if (req.method === 'GET' && req.url === '/spawn/pending') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(spawnQueue.drain()))
    return
  }

  // ... and posts back results, which complete the held session responses.
  if (req.method === 'POST' && req.url === '/spawn/results') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400); res.end('Invalid JSON'); return
      }
      if (!Array.isArray(parsed)) { res.writeHead(400); res.end('Invalid body: need results array'); return }
      let completed = 0
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const r = item as Record<string, unknown>
        if (typeof r.requestId !== 'string' || typeof r.ok !== 'boolean') continue
        const result: SpawnResult = {
          requestId: r.requestId,
          ok: r.ok,
          sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
          error: typeof r.error === 'string' ? r.error : undefined,
        }
        if (spawnQueue.complete(result)) completed++
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ completed }))
    })
    return
  }

  res.writeHead(404)
  res.end('Not found')
}

// ── ssh-agent management ──────────────────────────────────────────────
//
// `ssh-add -h <host>` adds a destination constraint that binds the key to a
// single hostname. ssh-add encodes the host's *public* key fingerprint into
// that constraint, so it requires the host's pubkey to be available in a
// known_hosts file at the moment ssh-add runs. We keep the entries in an
// in-memory map keyed by host and rewrite the file before each ssh-add /
// ssh-add -D invocation; the agent itself stores the constraint, so the
// file's later contents don't matter.
//
// The file path is always passed explicitly via `-H`: ssh-add's default
// known_hosts lookup expands `~` through getpwuid(), NOT $HOME, and the
// proxy's runtime uid (the server's host uid, set by runAsUser) either maps
// to the image's `node` user — whose /home/node we never write — or to no
// passwd entry at all. Both make the default lookup fail with "No host keys
// found for destination".

// HOME (deployment) and SSH_AUTH_SOCK (entrypoint.sh) are required env the
// proxy is always launched with; a missing value means a broken
// deployment, so fail loudly at startup rather than silently fall back.
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`proxy: required env ${name} is not set`)
  return value
}

// $HOME/.ssh — a runtime-uid-writable mount the deployment points HOME at,
// because the proxy runs as the server's host uid, which need not own the
// image's /home/node. ssh-add never resolves this path itself; it gets it
// via -H (see above).
const SSH_HOME = path.join(requireEnv('HOME'), '.ssh')
const KNOWN_HOSTS_FILE = path.join(SSH_HOME, 'known_hosts')
const knownHostsByHost = new Map<string, string>()

// The proxy talks to the real agent socket directly (set by entrypoint.sh);
// session pods use the 0666 socat bridge alongside it.
const AGENT_SOCK = requireEnv('SSH_AUTH_SOCK')

function writeKnownHostsFile(): void {
  fs.mkdirSync(SSH_HOME, { recursive: true, mode: 0o700 })
  const lines = [...knownHostsByHost.values()].map((e) => e.trim()).filter(Boolean)
  fs.writeFileSync(KNOWN_HOSTS_FILE, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 })
}

function sshAddKey(host: string, keyPem: string, knownHostsEntry: string): Promise<void> {
  knownHostsByHost.set(host, knownHostsEntry)
  writeKnownHostsFile()
  return new Promise((resolve, reject) => {
    const child = spawn('ssh-add', ['-H', KNOWN_HOSTS_FILE, '-h', host, '-'], {
      env: {
        ...process.env,
        SSH_AUTH_SOCK: AGENT_SOCK,
        SSH_ASKPASS: '/bin/false',
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: 'none:0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ssh-add exited with code ${code ?? '?'}: ${stderr.trim()}`))
    })
    child.stdin.end(keyPem)
  })
}

function sshClearAgent(): Promise<void> {
  knownHostsByHost.clear()
  writeKnownHostsFile()
  return new Promise((resolve, reject) => {
    const child = spawn('ssh-add', ['-D'], {
      env: { ...process.env, SSH_AUTH_SOCK: AGENT_SOCK },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      // ssh-add -D exits 0 even when empty.
      if (code === 0) resolve()
      else reject(new Error(`ssh-add -D exited with code ${code ?? '?'}: ${stderr.trim()}`))
    })
  })
}

function sshListAgent(): Promise<Array<{ fingerprint: string; comment: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh-add', ['-l'], {
      env: { ...process.env, SSH_AUTH_SOCK: AGENT_SOCK },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      // Exit 1 = "The agent has no identities." — return empty.
      if (code !== 0 && code !== 1) {
        reject(new Error(`ssh-add -l exited with code ${code ?? '?'}`))
        return
      }
      const rows: Array<{ fingerprint: string; comment: string }> = []
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'The agent has no identities.') continue
        // Format: "<bits> <fingerprint> <comment> (<algo>)"
        const parts = trimmed.split(/\s+/)
        if (parts.length < 3) continue
        rows.push({ fingerprint: parts[1], comment: parts.slice(2, -1).join(' ') })
      }
      resolve(rows)
    })
  })
}

// ── Server ─────────────────────────────────────────────────────────────

ca = loadOrGenerateCA()
// Reload write-through state so a pod replacement (image upgrade, crash,
// eviction) doesn't 403 live sessions or lose their blocked-host history.
loadSessions()
loadBlockedHosts()
loadGitAuthFailures()

// ── Plain-HTTP Forward ────────────────────────────────────────────────

// Security: token injection is deliberately NOT applied to plain HTTP
// requests. Injecting credentials over unencrypted connections would
// expose them to network observers; only the HTTPS MITM path injects.
//
// Used only by the transparent HTTP listener (origin-form requests after
// the relay's PP2 preamble); identity is the verified relay token. The
// old absolute-form forward proxy on the control port is gone.
function forwardPlainHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  target: { hostname: string; port: number; path: string },
): void {
  if (!isHostAllowed(sessionId, target.hostname)) {
    console.log(`[proxy] BLOCKED HTTP forward to ${target.hostname} (not in allowlist)`)
    recordBlockedHost(sessionId, target.hostname)
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end(`Blocked by URL allowlist: ${target.hostname} is not in the allowed hosts`)
    return
  }

  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  delete headers['proxy-connection']

  // Same internal-destination guard as handleTunnel: Tor refuses
  // loopback/RFC1918 and can't resolve in-cluster names.
  const useTorAgent = torAgent !== null && !isInternalUpstream(target.hostname)
  const upstream = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    method: req.method,
    headers,
    ...(useTorAgent ? { agent: torAgent } : {}),
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err: Error) => {
    console.error(`[proxy] HTTP forward error for ${target.hostname}${target.path}:`, err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
    }
    res.end(err.message)
  })

  req.pipe(upstream)
}

// ── Server ─────────────────────────────────────────────────────────────

// :API_PORT serves only the server control API (CA cert, session
// registrations, ssh-agent keys). Session egress never reaches it — all of
// it (HTTP, HTTPS, SSH) rides the relay-fed transparent listeners, gated by
// the per-connection PP2 token.
const server = http.createServer((req, res) => {
  // The yaac server reaches this API through an exec+socat relay whose
  // setup costs an apiserver round trip per TCP connection. Its fetch
  // pool idles connections out after only 4s by default — shorter than
  // the ~5s background reconcile tick — so hint it to hold them for 60s
  // (undici honors the server's Keep-Alive timeout hint), letting one
  // relay serve many requests instead of a fresh kubectl exec per tick.
  res.setHeader('Keep-Alive', 'timeout=60')
  handleApiRequest(req, res)
})

// Outlive the hinted client pool: a server-side timeout below the
// client's would close pooled connections the client still trusts.
// headersTimeout must exceed keepAliveTimeout so an idle pooled
// connection isn't killed mid-reuse.
server.keepAliveTimeout = 75_000
server.headersTimeout = 80_000

server.on('error', (err: Error) => {
  console.error('[proxy] Server error:', err)
})

server.listen(parseInt(API_PORT, 10), '0.0.0.0', () => {
  console.log(`[proxy] control API listening on port ${API_PORT}${USE_TOR ? ' (Tor: enabled)' : ''}`)
})

// ── Transparent listeners ──────────────────────────────────────────────
//
// Session pods' outbound 443/80 (and the SSH tunnel sentinel) is
// redirected here at the cluster level by the Cilium CEC + CNP: the
// node-local Envoy forwards each connection wrapped in a PROXY protocol
// v2 header carrying the eBPF-verified source pod IP. Identity is that
// unspoofable source IP, resolved to a session via the pod-watch index
// (see resolveSessionBySourceIp). Destination comes from the TLS SNI
// (443) / HTTP Host (80) after the PP2 header is consumed. The listeners
// fail closed: no/invalid PP2, an unknown source pod, or (for HTTPS) an
// SNI-less ClientHello → destroy.

/** Cap on bytes buffered while waiting for a parseable ClientHello. */
const SNI_PEEK_MAX_BYTES = 64 * 1024
/** How long to wait for the ClientHello before dropping the socket. */
const SNI_PEEK_TIMEOUT_MS = 10_000
/** Cap + deadline for the PP2 preamble (it precedes any client byte). */
const PP2_MAX_BYTES = 4 * 1024
const PP2_TIMEOUT_MS = 10_000

/**
 * Consume the Envoy-stamped PROXY-protocol-v2 preamble on a freshly accepted
 * transparent socket, resolve the source pod IP it carries to a session id,
 * then hand that session id and the remaining stream to `next`. Any failure
 * destroys the socket — this is the fail-closed gate. Identity is the source
 * pod IP (Cilium sets it from eBPF-verified endpoint metadata, unspoofable);
 * the proxy-ingress CiliumNetworkPolicy ensures only the node Envoy can reach
 * these ports, so a session pod cannot dial in and forge a source.
 */
function resolveSessionBySourceIp(
  socket: net.Socket,
  label: string,
  next: (sessionId: string, leftover: Buffer, viaVclusterAttribution: boolean) => void,
): void {
  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'ECONNRESET') {
      console.error(`[proxy] Transparent ${label} socket error:`, err.message)
    }
  })

  const peer = socket.remoteAddress ?? '(unknown)'
  let buf = Buffer.alloc(0)
  const timer = setTimeout(() => {
    console.log(`[proxy] Transparent ${label} from ${peer}: no PROXY header within ${PP2_TIMEOUT_MS}ms`)
    socket.destroy()
  }, PP2_TIMEOUT_MS)

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    const res = parsePp2Header(buf)
    if (res.kind === 'need-more') {
      if (buf.length > PP2_MAX_BYTES) { clearTimeout(timer); socket.destroy() }
      return
    }
    clearTimeout(timer)
    socket.removeListener('data', onData)
    if (res.kind === 'invalid' || !res.srcIp) {
      console.log(`[proxy] BLOCKED transparent ${label} from ${peer}: no valid PROXY header`)
      socket.destroy()
      return
    }
    const srcIp = res.srcIp
    // Keep buffering bytes that arrive while we resolve the session async, so
    // none are lost between removing onData and `next` attaching its reader.
    let leftover = buf.subarray(res.bytesConsumed)
    const buffer = (chunk2: Buffer): void => { leftover = Buffer.concat([leftover, chunk2]) }
    socket.on('data', buffer)
    void resolveSession(srcIp).then((resolved) => {
      socket.removeListener('data', buffer)
      if (!resolved) {
        console.log(`[proxy] BLOCKED transparent ${label} from ${peer}: source ${srcIp} is not a known session pod`)
        socket.destroy()
        return
      }
      // Hand the post-header bytes to `next` directly (the HTTPS peeker / HTTP
      // path each unshift once at dispatch; a second unshift would not
      // reliably re-emit to a freshly-added 'data' listener).
      next(resolved.sessionId, leftover, resolved.viaVclusterAttribution)
    })
  }
  socket.on('data', onData)
}

/**
 * After the PP2 preamble: peek the ClientHello SNI without terminating
 * TLS, then dispatch to the shared MITM/tunnel path. `initial` is the
 * post-header leftover from resolveSessionBySourceIp (often the start of the
 * ClientHello). The single unshift at dispatch drives the real handshake
 * downstream.
 */
function peekSniAndDispatch(socket: net.Socket, sessionId: string, initial: Buffer): void {
  const peer = socket.remoteAddress ?? '(unknown)'
  let buf = initial
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    console.log(`[proxy] Transparent HTTPS from ${peer}: no ClientHello within ${SNI_PEEK_TIMEOUT_MS}ms`)
    socket.destroy()
  }, SNI_PEEK_TIMEOUT_MS)

  // Returns true once the SNI is resolved (or the socket is destroyed).
  const evaluate = (): boolean => {
    const peek = peekClientHelloSni(buf)
    if (peek.kind === 'need-more') {
      if (buf.length > SNI_PEEK_MAX_BYTES) { settled = true; clearTimeout(timer); socket.destroy() }
      return settled
    }
    settled = true
    clearTimeout(timer)
    socket.removeListener('data', onData)
    if (peek.kind !== 'found') {
      console.log(`[proxy] BLOCKED transparent HTTPS from ${peer}: no parseable SNI`)
      socket.destroy()
      return true
    }
    // Pause before unshift so the buffered ClientHello waits for the
    // downstream reader (the MITM TLSSocket, or the tunnel pipe) instead
    // of being emitted into a flowing socket with no listener — a
    // TLSSocket wrapped over a flowing socket drops the unshifted hello
    // and the handshake stalls.
    socket.pause()
    if (buf.length > 0) socket.unshift(buf)
    // Destination port is 443 by construction: only dport-443 traffic is
    // REDIRECTed to the relay's HTTPS upstream.
    dispatchToUpstream(socket, peek.serverName, '443', sessionId, { writeConnectOk: false })
    return true
  }

  function onData(chunk: Buffer): void {
    buf = Buffer.concat([buf, chunk])
    evaluate()
  }

  // The leftover may already contain the whole ClientHello.
  if (evaluate()) return
  socket.on('data', onData)
}

const transparentHttpsServer = net.createServer((socket) => {
  resolveSessionBySourceIp(socket, 'HTTPS', (sessionId, leftover) =>
    peekSniAndDispatch(socket, sessionId, leftover))
})

// Origin-form HTTP after the PP2 preamble: feed the post-header stream
// into an internal http.Server (the `emit('connection')` pattern handleMitm
// already uses) and carry the verified session id on the socket.
type IdentifiedSocket = net.Socket & { yaacSessionId?: string; yaacVclusterAttributed?: boolean }

// In-session spawn requests (see spawn-queue.ts). Held responses expire on a
// coarse sweep — precision doesn't matter, only that abandoned requests
// eventually 504 instead of leaking.
const spawnQueue = new SpawnQueue()
setInterval(() => { spawnQueue.expire() }, 5_000).unref()

/**
 * `POST http://yaac.internal/spawn` from inside a session: validate, then
 * hold the response open until the server drains the queue and posts the
 * result (or the TTL sweep 504s it). Runs BEFORE the allowlist — spawning
 * works in every session without registration and is never recorded as a
 * blocked host.
 */
function handleSpawnRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  viaVclusterAttribution: boolean,
): void {
  const respond = (status: number, body: string): void => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(body)
  }
  const url = new URL(req.url ?? '/', `http://${SPAWN_MAGIC_HOST}`)
  if (url.pathname !== SPAWN_PATH) { respond(404, 'Not found'); return }
  if (req.method !== 'POST') { respond(405, 'Method not allowed'); return }
  if (viaVclusterAttribution) {
    respond(403, 'spawn is not available to nested workloads via the outer proxy')
    return
  }
  const tool = url.searchParams.get('tool') ?? undefined
  const model = url.searchParams.get('model') ?? undefined

  const chunks: Buffer[] = []
  let received = 0
  let overflow = false
  req.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > SPAWN_MAX_BODY_BYTES) {
      if (!overflow) { overflow = true; respond(413, 'prompt too large') }
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (overflow) return
    const prompt = Buffer.concat(chunks).toString('utf8')
    const valid = validateSpawnRequest(prompt, tool, model)
    if (!valid.ok) { respond(valid.status, valid.error); return }
    // No-op the completer once the caller is gone; the entry still expires
    // off the queue on the normal TTL sweep.
    let gone = false
    res.on('close', () => { gone = true })
    const enqueued = spawnQueue.enqueue(
      { sessionId, prompt, tool, model },
      (status, body) => { if (!gone) respond(status, body) },
    )
    if (!enqueued.ok) { respond(enqueued.status, enqueued.error); return }
    console.log(`[proxy] spawn request from session ${sessionId.slice(0, 8)}... queued (${enqueued.requestId.slice(0, 8)}...)`)
  })
}

/**
 * `GET http://yaac.internal/tools` from inside a session (yaac-spawn --models):
 * report which agent tools have host credentials, their provider/host, and —
 * with `?models=1` — their accepted model ids from the baked catalog. Answered
 * synchronously from proxy-local state (mounted creds + the session's registered
 * tool); no server round-trip, no network fetch. Like /spawn it runs BEFORE the
 * allowlist and is attributed by source pod IP; it exposes tool/provider/model
 * names only, never credential material.
 */
function handleToolsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  viaVclusterAttribution: boolean,
): void {
  const respond = (status: number, contentType: string, body: string): void => {
    res.writeHead(status, { 'Content-Type': contentType })
    res.end(body)
  }
  if (req.method !== 'GET') { respond(405, 'text/plain; charset=utf-8', 'Method not allowed'); return }
  if (viaVclusterAttribution) {
    respond(403, 'text/plain; charset=utf-8', 'tools is not available to nested workloads via the outer proxy')
    return
  }
  const url = new URL(req.url ?? '/', `http://${SPAWN_MAGIC_HOST}`)
  const includeModels = url.searchParams.get('models') === '1'
  const asJson = url.searchParams.get('json') === '1'

  const view = (creds: { kind: 'oauth' | 'api-key'; provider?: string } | null): ToolCredsView =>
    creds ? { authed: true, kind: creds.kind, provider: creds.provider } : { authed: false }
  const creds: Record<AgentTool, ToolCredsView> = {
    claude: view(readClaudeCreds()),
    codex: view(readCodexCreds()),
    opencode: view(readOpencodeCreds()),
    pi: view(readPiCreds()),
  }
  const report = buildToolsReport({ currentTool: sessionTool.get(sessionId) ?? null, creds, includeModels })
  if (asJson) { respond(200, 'application/json; charset=utf-8', `${JSON.stringify(report, null, 2)}\n`); return }
  respond(200, 'text/plain; charset=utf-8', formatToolsReport(report))
}

const internalHttpServer = http.createServer((req, res) => {
  const socket = req.socket as IdentifiedSocket
  const sessionId = socket.yaacSessionId
  if (!sessionId) {
    // Unreachable: sockets reach this server only after token verification.
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('No identity'); return
  }
  // Requests arrive origin-form (`GET /path` + `Host:`), so the original
  // destination hostname rides the Host header. handleHttpForward's
  // absolute-form parsing does not apply; the forward core is shared.
  const hostHeader = req.headers.host
  const target = hostHeader !== undefined ? splitHostHeader(hostHeader, 80) : null
  if (target === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Missing or malformed Host header')
    return
  }
  if (target.hostname === SPAWN_MAGIC_HOST) {
    const pathname = (req.url ?? '/').split('?', 1)[0]
    if (pathname === '/tools') {
      handleToolsRequest(req, res, sessionId, socket.yaacVclusterAttributed === true)
      return
    }
    handleSpawnRequest(req, res, sessionId, socket.yaacVclusterAttributed === true)
    return
  }
  forwardPlainHttp(req, res, sessionId, {
    hostname: target.hostname,
    port: target.port,
    path: req.url ?? '/',
  })
})

const transparentHttpServer = net.createServer((socket) => {
  resolveSessionBySourceIp(socket, 'HTTP', (sessionId, leftover, viaVclusterAttribution) => {
    ;(socket as IdentifiedSocket).yaacSessionId = sessionId
    ;(socket as IdentifiedSocket).yaacVclusterAttributed = viaVclusterAttribution
    if (leftover.length > 0) socket.unshift(leftover)
    internalHttpServer.emit('connection', socket)
  })
})

/** Cap + deadline for the CONNECT request line on the tunnel listener. */
const CONNECT_MAX_BYTES = 8 * 1024
const CONNECT_TIMEOUT_MS = 10_000

/**
 * After the PP2 preamble on the tunnel listener: read the explicit
 * `CONNECT host:port` the relay forwarded from git's ncat, then hand off
 * to the shared dispatch with `writeConnectOk` so the 200 flows back
 * through the relay to ncat. SSH (port 22) tunnels; the allowlist still
 * applies, on the hostname ncat preserved.
 */
function readConnectAndDispatch(socket: net.Socket, sessionId: string, initial: Buffer): void {
  const peer = socket.remoteAddress ?? '(unknown)'
  let buf = initial
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    console.log(`[proxy] Transparent TUNNEL from ${peer}: no CONNECT within ${CONNECT_TIMEOUT_MS}ms`)
    socket.destroy()
  }, CONNECT_TIMEOUT_MS)

  const evaluate = (): boolean => {
    const end = buf.indexOf('\r\n\r\n')
    if (end === -1) {
      if (buf.length > CONNECT_MAX_BYTES) { settled = true; clearTimeout(timer); socket.destroy() }
      return settled
    }
    settled = true
    clearTimeout(timer)
    socket.removeListener('data', onData)
    const firstLine = buf.subarray(0, buf.indexOf('\r\n')).toString('utf8')
    const m = /^CONNECT\s+(\S+):(\d+)\s+HTTP\/\d/i.exec(firstLine)
    if (!m) {
      console.log(`[proxy] BLOCKED transparent TUNNEL from ${peer}: bad CONNECT line`)
      socket.destroy()
      return true
    }
    // Bytes past the request headers (normally none — ncat waits for 200).
    const rest = buf.subarray(end + 4)
    dispatchToUpstream(socket, m[1], m[2], sessionId, {
      writeConnectOk: true,
      head: rest.length > 0 ? rest : undefined,
    })
    return true
  }

  function onData(chunk: Buffer): void {
    buf = Buffer.concat([buf, chunk])
    evaluate()
  }

  if (evaluate()) return
  socket.on('data', onData)
}

const transparentTunnelServer = net.createServer((socket) => {
  resolveSessionBySourceIp(socket, 'TUNNEL', (sessionId, leftover) =>
    readConnectAndDispatch(socket, sessionId, leftover))
})

for (const [srv, portStr, label] of [
  [transparentHttpsServer, TRANSPARENT_HTTPS_PORT, 'HTTPS'],
  [transparentHttpServer, TRANSPARENT_HTTP_PORT, 'HTTP'],
  [transparentTunnelServer, TRANSPARENT_TUNNEL_PORT, 'TUNNEL'],
] as Array<[net.Server, string, string]>) {
  srv.on('error', (err: Error) => {
    console.error(`[proxy] Transparent ${label} server error:`, err)
  })
  srv.listen(parseInt(portStr, 10), '0.0.0.0', () => {
    console.log(`[proxy] Transparent ${label} listener on port ${portStr}`)
  })
}

// ── Stream relay (server ↔ session-pod streamd) ────────────────────────────
//
// A dumb authenticated CONNECT: the server dials in, sends ONE JSON auth
// line `{"token": <proxyAuthSecret>, "sessionId": <sid>}`, and the relay
// resolves the session's pod IP (pod-watch reverse index, labelSelector
// list on a miss) and splices the rest of the stream to
// `podIP:POD_STREAM_PORT` untouched — the streamd handshake, its reply,
// and the payload are end-to-end server↔streamd. Per-stream refusals
// (unknown session, pod dial failure) are ANSWERED with an error line
// before closing: the server treats a silent close as a dead transport
// and re-establishes its shared port-forward, so a stale session's probe
// must not masquerade as one. Only a bad auth line closes silently (no
// oracle for unauthenticated peers). An inner (vcluster) proxy runs this
// same code against its own apiserver, whose synced pods carry host pod
// IPs (syncer write-back), so nested streams need no extra branch.

const RELAY_HANDSHAKE_MAX_BYTES = 4 * 1024
const RELAY_HANDSHAKE_TIMEOUT_MS = 10_000

function handleRelayConnection(socket: net.Socket, podStreamPort: number): void {
  socket.on('error', () => { /* per-connection; close tears down the splice */ })
  let buf = Buffer.alloc(0)
  const timer = setTimeout(() => socket.destroy(), RELAY_HANDSHAKE_TIMEOUT_MS)

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    const nl = buf.indexOf(0x0a)
    if (nl < 0) {
      if (buf.length > RELAY_HANDSHAKE_MAX_BYTES) { clearTimeout(timer); socket.destroy() }
      return
    }
    socket.removeListener('data', onData)
    clearTimeout(timer)

    let params: { token?: unknown; sessionId?: unknown }
    try {
      params = JSON.parse(buf.subarray(0, nl).toString('utf8')) as typeof params
    } catch {
      socket.destroy()
      return
    }
    if (
      typeof params.token !== 'string' || typeof params.sessionId !== 'string'
      || !timingSafeStrEqual(params.token, PROXY_AUTH_SECRET!)
    ) {
      console.log('[proxy] BLOCKED relay dial: bad auth line')
      socket.destroy()
      return
    }
    const sessionId = params.sessionId

    // Keep buffering bytes (the pipelined streamd handshake) that arrive
    // before the splice starts — through BOTH async gaps: the pod-IP
    // resolve and the pod dial itself. The socket is in flowing mode (the
    // auth reader had a listener), and flowing data with no listener is
    // DISCARDED — dropping the listener before the dial lands would eat a
    // handshake tail that arrives in its own TCP segment, and the stream
    // would hang to its timeout instead of splicing.
    let leftover = buf.subarray(nl + 1)
    const buffer = (chunk2: Buffer): void => { leftover = Buffer.concat([leftover, chunk2]) }
    socket.on('data', buffer)
    // Answer refusals with a reply line (see the module comment): a
    // silent close reads as a dead transport server-side.
    const refuse = (error: string): void => {
      socket.end(JSON.stringify({ ok: false, error: `relay: ${error}` }) + '\n')
    }
    void (async () => {
      let ip = podIndex.resolveIp(sessionId)
      if (!ip) {
        try {
          ip = await fetchPodIpBySessionId(podIndex, sessionId)
        } catch (err) {
          console.error(`[proxy] relay pod lookup failed for ${sessionId.slice(0, 8)}...:`, (err as Error).message)
        }
      }
      if (socket.destroyed) return
      if (!ip) {
        console.log(`[proxy] BLOCKED relay dial: unknown session ${sessionId.slice(0, 8)}...`)
        refuse('unknown session')
        return
      }
      // allowHalfOpen so an EOF from either end passes through the splice
      // (pipe propagates the end()); the close handlers reap the pair.
      const target = net.connect({ port: podStreamPort, host: ip, allowHalfOpen: true })
      let spliced = false
      target.on('connect', () => {
        spliced = true
        socket.removeListener('data', buffer)
        if (leftover.length > 0) target.write(leftover)
        socket.pipe(target)
        target.pipe(socket)
      })
      target.on('error', (err: NodeJS.ErrnoException) => {
        // Pre-splice failure (streamd down / pod mid-teardown): answer it —
        // a conclusive per-stream refusal, not a transport problem.
        if (!spliced) refuse(`pod dial failed: ${err.code ?? err.message}`)
        else socket.destroy()
      })
      target.on('close', () => {
        if (spliced) socket.destroy()
      })
      socket.on('close', () => target.destroy())
    })()
  }
  socket.on('data', onData)
}

const relayServer = net.createServer(
  { allowHalfOpen: true },
  (socket) => handleRelayConnection(socket, parseInt(POD_STREAM_PORT, 10)),
)
relayServer.on('error', (err: Error) => {
  console.error('[proxy] Relay server error:', err)
})
relayServer.listen(parseInt(RELAY_PORT, 10), '0.0.0.0', () => {
  console.log(`[proxy] stream relay listener on port ${RELAY_PORT}`)
})

// ── DNS stub (UDP/53), split-horizon ───────────────────────────────────────
// Session pods resolve against the proxy. External names get the sinkhole;
// internal names (`*.svc`) are forwarded to cluster DNS on the top-level proxy
// (DNS_FORWARD_INTERNAL) so pods learn live ClusterIPs — no IP pinning.
const dnsServer = DNS_STUB_PORT ? dgram.createSocket('udp4') : null
if (dnsServer && DNS_STUB_PORT) {
  dnsServer.on('message', (msg, rinfo) => {
    const query = parseDnsQuery(msg)
    if (!query) return
    const reply = (ip: string | null): void => {
      dnsServer.send(buildDnsResponse(query, ip), rinfo.port, rinfo.address)
    }
    // External names (and every name on a non-forwarding proxy): sinkhole the
    // A answer; non-A falls through to empty-NOERROR inside buildDnsResponse.
    if (!DNS_FORWARD_INTERNAL || !isInternalName(query.name)) {
      reply(DNS_SINKHOLE_IPV4)
      return
    }
    // Internal name on the forwarding proxy: resolve A against cluster DNS;
    // non-A (e.g. AAAA) gets empty-NOERROR so the resolver falls through to A.
    if (query.qtype !== DNS_QTYPE_A) {
      reply(null)
      return
    }
    void resolveInternalA(query.name).then(reply)
  })
  dnsServer.on('error', (err) => console.error('[proxy] DNS stub error:', err))
  dnsServer.bind(parseInt(DNS_STUB_PORT, 10), () => {
    console.log(`[proxy] DNS stub listener on udp/${DNS_STUB_PORT}`
      + (DNS_FORWARD_INTERNAL ? ' (split-horizon: internal names → cluster DNS)' : ''))
  })
}

// ── Pod-watch (source IP → session) ────────────────────────────────────────
// Only in-cluster (a mounted SA). Local/test runs without it leave the index
// empty, so transparent connections fail closed — which is correct.
if (process.env.KUBERNETES_SERVICE_HOST) {
  void startPodWatch(podIndex).catch((err: Error) => {
    console.error('[proxy] pod-watch failed to start:', err.message)
    process.exit(1)
  })
} else {
  console.warn('[proxy] no KUBERNETES_SERVICE_HOST — pod-watch disabled (not in-cluster)')
}

process.on('SIGTERM', () => {
  console.log('[proxy] Shutting down...')
  transparentHttpsServer.close()
  transparentHttpServer.close()
  transparentTunnelServer.close()
  relayServer.close()
  dnsServer?.close()
  server.close(() => process.exit(0))
})

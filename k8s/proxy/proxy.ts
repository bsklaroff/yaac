/**
 * MITM proxy sidecar for agent session containers.
 *
 * Stateless: everything it needs arrives as Kubernetes objects it watches
 * (object-watch.ts) and everything it reports goes out as objects the
 * server watches — so a replaced pod restores itself from the informers'
 * initial lists and nothing here touches a volume that outlives the pod.
 *
 * - Serves the CA from the `yaac-proxy-ca` Secret, minting one into it the
 *   first time
 * - Takes per-worktree rules and allowlists from registration ConfigMaps,
 *   secret values from per-project Secrets, and the GitHub / Claude /
 *   Codex / opencode / pi credentials plus ssh keys from the credentials
 *   Secret, each live: a `yaac auth update` reaches every running worktree
 *   on its next request
 * - Handles CONNECT tunneling: MITMs TLS when rules match, tunnels otherwise
 * - Swaps placeholder tokens for real OAuth credentials and captures
 *   refreshed tokens into the `yaac-proxy-refreshed` Secret
 * - Records blocked hosts and rejected git credentials in the
 *   `yaac-proxy-state` ConfigMap
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
import {
  CA_SECRET_NAME,
  REFRESHED_SECRET_NAME,
  STATE_CONFIGMAP_NAME,
  decodeCa,
  decodeRefreshed,
  decodeState,
  encodeCa,
  encodeRefreshed,
  encodeState,
  sshKeyBlobsByProject,
  type ClaudeOAuthBundle,
  type CodexOAuthBundle,
  type GitAuthFailureRecord,
  type HostInjectionRule,
  type ProxyState,
  type UpstreamRedirect,
  type WorktreeRegistration,
} from './objects'
import {
  ProxyObjects,
  fetchRegistration,
  readOutputObject,
  startObjectWatch,
  writeCa,
  writeRefreshed,
  writeState,
} from './object-watch'
import { createAgentKeyLoader } from './agent-keys'
import { DNS_QTYPE_A, buildDnsResponse, isInternalName, parseDnsQuery } from './dns-stub'
import { PodWorktreeIndex, fetchPodIpByWorktreeId, fetchWorktreeByPodIp, startPodWatch } from './pod-watch'
import {
  LEGACY_SPAWN_PATH,
  MAMA_MAGIC_HOST,
  MAMA_MAX_BODY_BYTES,
  MAMA_PATH,
  MamaQueue,
  parseMamaEnvelope,
  validateMamaRequest,
} from './mama-queue'
import type { MamaResult } from './mama-queue'
import { SYSTEM_ROOTS_PATH, combineCaBundle } from './ca-bundle'
import { createSshAgentServer } from './ssh-agent-relay'
import { timingSafeStrEqual } from './secure-compare'
import { OPENCODE_PROVIDER_HOSTS, PI_PROVIDER_HOSTS } from './tool-providers.generated'
import {
  buildToolsReport,
  formatToolsReport,
  type AgentTool,
  type ToolCredsView,
} from './tools-report'

// Control-API listener: health, the change stream and the yaac-mama queue.
// Everything else the server tells the proxy travels as objects
// (object-watch.ts), so this is purely the request/response API.
const API_PORT = process.env.API_PORT
const PROXY_AUTH_SECRET = process.env.PROXY_AUTH_SECRET
// Transparent egress listeners: netd's node-local Envoy forwards
// redirected 443/80 here (PP2 identity, destination from TLS SNI / HTTP
// Host) and SSH CONNECTs to the tunnel listener (destination from the
// CONNECT line).
const TRANSPARENT_HTTPS_PORT = process.env.TRANSPARENT_HTTPS_PORT
const TRANSPARENT_HTTP_PORT = process.env.TRANSPARENT_HTTP_PORT
const TRANSPARENT_TUNNEL_PORT = process.env.TRANSPARENT_TUNNEL_PORT
// Stream relay: authenticated CONNECT from the yaac server into a worktree
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
// Pod-local scratch (an emptyDir): Tor's state and its readiness marker.
const DATA_DIR = '/data'
// UDP/53 DNS stub: worktree pods point their resolver here. Optional so
// non-cluster test runs can skip it.
const DNS_STUB_PORT = process.env.DNS_STUB_PORT
// TCP port carrying the ssh-agent protocol to entitled worktree pods (see
// ssh-agent-relay.ts). Optional for the same reason as the DNS stub: a
// non-cluster test run has no pod-watch to authenticate anyone with, so it
// simply doesn't listen.
const SSH_AGENT_PORT = process.env.SSH_AGENT_PORT
// Sinkhole answer for EXTERNAL names: decorative — netd redirects egress by
// port (443/80) and the proxy routes by SNI/Host, never by the dialed address.
const DNS_SINKHOLE_IPV4 = '198.18.0.1'
// Split-horizon DNS: forward `.cluster.local` names to the real cluster
// CoreDNS so pods learn live in-cluster ClusterIPs (what lets yaac stop
// pinning them).
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

// podIP → worktreeId, kept fresh by watching the pods API with the proxy's
// read-only ServiceAccount. The transparent listeners resolve a connection's
// worktree from the source pod IP in the Envoy-stamped PROXY header.
const podIndex = new PodWorktreeIndex()

async function resolveWorktree(ip: string): Promise<string | undefined> {
  let worktreeId = podIndex.resolve(ip)
  if (!worktreeId) {
    // Cache-miss fallback: a new pod's first packet can beat its watch event.
    try {
      worktreeId = await fetchWorktreeByPodIp(podIndex, ip) ?? undefined
    } catch { return undefined }
  }
  // Same race in the other direction — a Job created microseconds after
  // its registration ConfigMap — and the same cure.
  if (worktreeId && IN_CLUSTER && !objects.registration(worktreeId)) {
    try {
      await fetchRegistration(objects, worktreeId)
    } catch (err) {
      console.error(`[proxy] registration lookup failed for ${worktreeId.slice(0, 8)}...:`, (err as Error).message)
    }
  }
  return worktreeId
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

// Only in-cluster (a mounted SA) can the proxy watch its objects or the
// pods. A local/test run without it leaves every map empty, so transparent
// connections fail closed — which is correct.
const IN_CLUSTER = Boolean(process.env.KUBERNETES_SERVICE_HOST)

const CLAUDE_TOKEN_URL_HOST = 'platform.claude.com'
const CLAUDE_TOKEN_URL_PATH = '/v1/oauth/token'
const ANTHROPIC_API_HOST = 'api.anthropic.com'
const OPENAI_API_HOST = 'api.openai.com'
const OPENAI_TOKEN_URL_HOST = 'auth.openai.com'
const OPENAI_TOKEN_URL_PATH = '/oauth/token'
// Codex in ChatGPT auth mode routes inference to chatgpt.com/backend-api, not
// api.openai.com — so we must MITM it too and apply the same Authorization
// swap for codex worktrees.
const CHATGPT_HOST = 'chatgpt.com'
const CODEX_DEFAULT_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000
// opencode and pi are api-key only. The proxy swaps the placeholder key for
// the real one on the chosen provider's host when the worktree is registered as
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

type Injection =
  | { action: 'set_header'; name: string; value: string }
  | { action: 'replace_header'; name: string; value: string }
  | { action: 'remove_header'; name: string }
  | { action: 'replace_body_param'; name: string; value: string }

type InjectionRule = {
  pathPattern: string
  injections: Injection[]
}

// ── CA Certificate Management ──────────────────────────────────────────

let ca: CA | null = null

const leafCache = new Map<string, LeafEntry>()

const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000
const LEAF_REFRESH_MS = 60 * 60 * 1000

/**
 * The CA, from the `yaac-proxy-ca` Secret the server pre-created — minted
 * into it the first time, so every later pod (and every worktree pod's
 * mounted trust bundle) keeps the same root. The combined bundle
 * `{system roots} ∪ {CA}` is rewritten either way: the roots are the
 * image's, and an image upgrade may have refreshed them.
 *
 * Outside a cluster (a local run) there is no Secret: a fresh CA per
 * process, which is all a run without worktrees needs.
 */
async function loadOrGenerateCA(): Promise<CA> {
  let loaded: CA | null = null
  if (IN_CLUSTER) {
    const stored = decodeCa(await readOutputObject('secret', CA_SECRET_NAME))
    if (stored) {
      const key = forge.pki.privateKeyFromPem(stored.keyPem)
      const cert = forge.pki.certificateFromPem(stored.certPem)
      // A CA minted before the SKI/AKI issuer-disambiguation fix carries no
      // subjectKeyIdentifier, so a verifier holding another identically-named
      // "yaac Proxy CA" can't tell which one signed a leaf and hard-fails on
      // the wrong key. Regenerate it so new leaves get a matching AKI. See
      // getLeafCert.
      if (cert.getExtension('subjectKeyIdentifier')) {
        console.log('[proxy] Loaded existing CA')
        loaded = { key, cert, pem: stored.certPem }
      } else {
        console.log('[proxy] Existing CA lacks a subjectKeyIdentifier — regenerating')
      }
    }
  }
  const result = loaded ?? generateCA()
  if (IN_CLUSTER) {
    await writeCa(encodeCa({
      keyPem: forge.pki.privateKeyToPem(result.key),
      certPem: result.pem,
      bundlePem: combineCaBundle(fs.readFileSync(SYSTEM_ROOTS_PATH, 'utf8'), result.pem),
    }))
    console.log(`[proxy] CA ${loaded ? 'bundle refreshed in' : 'saved to'} ${CA_SECRET_NAME}`)
  }
  return result
}

function generateCA(): CA {
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
    // CN; a chained nested worktree trusts both). The leaf's AKI points here,
    // so selection is by key id, not bundle order. See getLeafCert.
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { key: keys.privateKey, cert, pem: forge.pki.certificateToPem(cert) }
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
    // "yaac Proxy CA" roots selects the CA that actually signed this leaf
    // instead of trying them in name order and hard-failing on the wrong
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

// ── The objects the proxy is told through ────────────────────────────
//
// Credentials, per-project secret values and per-worktree registrations
// all arrive over the informers in object-watch.ts and are read from these
// maps per request, which is what makes a `yaac auth update` or a secret
// edit live for every running worktree.

const objects = new ProxyObjects({
  loadSshKeys: (entries) => agentKeys.reload(entries),
  // A registration's allowlist widening (the webapp's allow-host click)
  // prunes the host from the blocked record so the badge clears.
  onRegistration: (worktreeId, registration) => {
    const blocked = blockedHostsByWorktree.get(worktreeId)
    if (!blocked) return
    if (registration === null) {
      blockedHostsByWorktree.delete(worktreeId)
      scheduleStateWrite()
      return
    }
    let pruned = false
    for (const host of blocked) {
      if (isHostAllowed(worktreeId, host)) {
        blocked.delete(host)
        pruned = true
      }
    }
    if (pruned) scheduleStateWrite()
  },
})

function registrationOf(worktreeId: string): WorktreeRegistration | undefined {
  return objects.registration(worktreeId)
}

/**
 * Resolve registration-time injections into concrete value injections.
 * Injections whose reference doesn't resolve are dropped — never inject an
 * empty or placeholder credential. A ref is only ever resolved within the
 * registration's own project: the server scopes every ref it writes, and
 * checking the scope here makes the writer's invariant the reader's too.
 */
function resolveRegisteredRules(rules: HostInjectionRule[], projectSlug: string | undefined): InjectionRule[] {
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
 * The HTTPS credential assigned to a worktree's project, with the host of
 * the worktree's registered https remote — the one host it may be sent to,
 * which every caller checks so a token cannot leak onto another MITM'd host.
 */
function resolveHttpsCredentialForWorktree(worktreeId: string): { token: string; host: string } | null {
  const registration = registrationOf(worktreeId)
  if (!registration) return null
  const entry = objects.credentials.git.find((e) => e.projects.includes(registration.projectSlug))
  if (!entry) return null
  const host = httpsRemoteHost(registration.repoUrl)
  return host ? { token: entry.token, host } : null
}

/**
 * A rotation captured from a worktree's refresh: durable the moment it is
 * captured — a codex refresh token is single-use, so the pod dying a
 * millisecond after the write must not lose it — and served from here
 * until the server adopts it and the credentials Secret carries it back.
 */
function captureRefreshed(bundles: { claude?: ClaudeOAuthBundle; codex?: CodexOAuthBundle }): void {
  objects.capture(bundles)
  if (!IN_CLUSTER) return
  writeRefreshed(encodeRefreshed(bundles)).catch((err: unknown) => {
    console.error(`[proxy] Failed to persist refreshed OAuth tokens to ${REFRESHED_SECRET_NAME}:`, String(err))
  })
}

// ── What only this process observes ─────────────────────────────────
//
// Per-tenant records are keyed by worktreeId, except git-auth failures,
// which are keyed by the worktree's project. Both are written to the
// `yaac-proxy-state` ConfigMap the server watches; the last pod's records
// are read back once at boot so a replacement keeps the badges it left.

/** worktreeId -> Set of blocked hostnames */
const blockedHostsByWorktree = new Map<string, Set<string>>()

/**
 * projectSlug -> (hostname -> auth-failure record). Populated when an
 * upstream rejects a git smart-HTTP request that carried a yaac-injected
 * credential — i.e. the stored token itself is bad (expired/revoked),
 * not a missing allowlist entry. Keyed by project (resolved through the
 * requesting worktree's registration): the credential belongs to the
 * project's repo, so one bad token flags every worktree of the project,
 * and the record outlives the worktree that first hit it. Cleared per
 * host on the next successful injected git request from any of the
 * project's worktrees, so the flag self-heals after `yaac auth update`.
 */
const gitAuthFailuresByProject = new Map<string, Map<string, GitAuthFailureRecord>>()

function currentState(): ProxyState {
  const state: ProxyState = { blockedHosts: {}, gitAuthFailures: {} }
  for (const [sid, hosts] of blockedHostsByWorktree) {
    if (hosts.size > 0) state.blockedHosts[sid] = [...hosts]
  }
  for (const [slug, byHost] of gitAuthFailuresByProject) {
    if (byHost.size === 0) continue
    state.gitAuthFailures[slug] = [...byHost].map(([host, rec]) => ({ host, ...rec }))
  }
  return state
}

function seedState(state: ProxyState): void {
  for (const [sid, hosts] of Object.entries(state.blockedHosts)) {
    blockedHostsByWorktree.set(sid, new Set(hosts))
  }
  for (const [slug, entries] of Object.entries(state.gitAuthFailures)) {
    gitAuthFailuresByProject.set(slug, new Map(entries.map(({ host, status, atMs }) => [host, { status, atMs }])))
  }
}

/** Debounce for the state write: a blocked-host burst is common. */
const STATE_WRITE_DEBOUNCE_MS = 250
/** Retry after a failed write; the next change also retries it. */
const STATE_WRITE_RETRY_MS = 5_000
let stateWriteTimer: NodeJS.Timeout | null = null

function scheduleStateWrite(delayMs = STATE_WRITE_DEBOUNCE_MS): void {
  if (!IN_CLUSTER || stateWriteTimer) return
  stateWriteTimer = setTimeout(() => {
    stateWriteTimer = null
    writeState(encodeState(currentState())).catch((err: unknown) => {
      console.error(`[proxy] Failed to write ${STATE_CONFIGMAP_NAME}:`, String(err))
      scheduleStateWrite(STATE_WRITE_RETRY_MS)
    })
  }, delayMs)
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

function findRulesForHost(worktreeId: string, hostname: string): HostInjectionRule[] {
  const rules = registrationOf(worktreeId)?.rules
  if (!rules) return []
  return rules.filter((r) => hostMatches(hostname, r.hostPattern))
}

function isHostAllowed(worktreeId: string | null, hostname: string): boolean {
  if (!worktreeId) return false // no worktree = block by default (fail closed)
  const allowed = registrationOf(worktreeId)?.allowedHosts
  if (!allowed) return false // no registration = block by default (fail closed)
  if (allowed.length === 1 && allowed[0] === '*') return true
  return allowed.some((pattern) => hostMatches(hostname, pattern))
}

function recordBlockedHost(worktreeId: string | null, hostname: string): void {
  if (!worktreeId) return
  let hosts = blockedHostsByWorktree.get(worktreeId)
  if (!hosts) {
    hosts = new Set()
    blockedHostsByWorktree.set(worktreeId, hosts)
  }
  if (hosts.has(hostname)) return
  hosts.add(hostname)
  // Only when the set actually grew — repeat blocks of the same host are by
  // far the common case and need no write.
  scheduleStateWrite()
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
 * rejected (expired or revoked) — record it against the worktree's project
 * (written like blocked hosts) so the server surfaces a loud project-wide
 * error. A later 2xx on the same host from any of the
 * project's worktrees clears the record, so the flag self-heals once the
 * user runs `yaac auth update` and git is retried.
 */
function noteGitUpstreamStatus(
  worktreeId: string,
  hostname: string,
  requestPath: string,
  status: number,
): void {
  if (!isGitSmartHttpPath(requestPath)) return
  const projectSlug = registrationOf(worktreeId)?.projectSlug
  if (!projectSlug) return // unregistered worktree — can't attribute
  const byHost = gitAuthFailuresByProject.get(projectSlug)
  if (status === 401 || status === 403) {
    if (byHost?.has(hostname)) return // repeat failure — nothing new to write
    console.log(`[proxy] GIT AUTH FAILED for ${hostname} (HTTP ${status}, project ${projectSlug})`)
    const hosts = byHost ?? new Map<string, GitAuthFailureRecord>()
    hosts.set(hostname, { status, atMs: Date.now() })
    gitAuthFailuresByProject.set(projectSlug, hosts)
    scheduleStateWrite()
    return
  }
  if (status >= 200 && status < 300 && byHost?.delete(hostname)) {
    console.log(`[proxy] git auth recovered for ${hostname} (project ${projectSlug})`)
    scheduleStateWrite()
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

/** One body-parameter substitution, resolved and ready to apply. */
type BodyParamSwap = { name: string; value: string }

function collectBodyInjections(
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

function applyBodyInjections(
  bodyBuffer: Buffer,
  contentType: string | undefined,
  injections: BodyParamSwap[],
): Buffer {
  const bodyStr = bodyBuffer.toString('utf8')
  const isJson = contentType && contentType.includes('application/json')

  if (isJson) {
    try {
      const parsed: unknown = JSON.parse(bodyStr)
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        for (const { name, value } of injections) {
          if (name in obj) obj[name] = value
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
    if (params.has(name)) params.set(name, value)
  }
  return Buffer.from(params.toString(), 'utf8')
}

// ── Dynamic Auth (GitHub / Codex / Claude api-key) ─────────────────────

/**
 * Hosts the proxy MITMs so it can inject agent-tool credentials, plus any
 * HTTPS host for which the current worktree has a matching git credential. SSH (port 22) is always tunneled,
 * never MITM'd. Rule-based per-worktree MITM is still applied on top of this.
 */
function hostNeedsDynamicMitm(worktreeId: string | null, hostname: string, port: number): boolean {
  if (port === 22) return false
  if (hostname === ANTHROPIC_API_HOST) return true
  if (hostname === CLAUDE_TOKEN_URL_HOST) return true
  if (hostname === OPENAI_API_HOST) return true
  if (hostname === OPENAI_TOKEN_URL_HOST) return true
  if (hostname === CHATGPT_HOST) return true
  // opencode / pi: MITM the worktree's chosen provider host so the api-key swap
  // in buildDynamicRules can run. Matches that swap's gating exactly — only the
  // one host the registered tool's credential points at.
  const tool = worktreeId ? registrationOf(worktreeId)?.tool : undefined
  if (tool === 'opencode') {
    const creds = objects.credentials.opencode
    if (creds && hostname === OPENCODE_PROVIDER_HOSTS[creds.provider]) return true
  }
  if (tool === 'pi') {
    const creds = objects.credentials.pi
    if (creds && hostname === PI_PROVIDER_HOSTS[creds.provider]) return true
  }
  if (worktreeId && worktreeHasHttpsCredentialForHost(worktreeId, hostname)) return true
  // gh CLI: MITM the GitHub API host so we can swap the placeholder GH_TOKEN
  // for the worktree's real git token (api.github.com is not the git remote
  // host, so the credential check above misses it).
  if (worktreeId && resolveGithubApiTokenForWorktree(worktreeId, hostname) !== null) return true
  return false
}

function worktreeHasHttpsCredentialForHost(worktreeId: string, hostname: string): boolean {
  const cred = resolveHttpsCredentialForWorktree(worktreeId)
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
 * worktree's HTTPS git token, but only when `hostname` is the gh API host for
 * that credential's git host. The host gate keeps the token from leaking onto
 * unrelated MITM'd hosts.
 */
function resolveGithubApiTokenForWorktree(worktreeId: string, hostname: string): string | null {
  const cred = resolveHttpsCredentialForWorktree(worktreeId)
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
 * Build a list of injection rules derived from the credentials Secret,
 * scoped to the current hostname. Reading the live view on every request
 * means updates via `yaac auth update` propagate without needing to restart
 * containers. The rules slot into the same pipeline as statically-configured
 * rules — no separate mutation path.
 */
function buildDynamicRules(
  worktreeId: string | null,
  hostname: string,
  claudeTokenBundle: ClaudeOAuthBundle | null,
  codexTokenBundle: CodexOAuthBundle | null,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  if (!worktreeId) return []
  const rules: InjectionRule[] = []

  // HTTPS git credential injection: only fires when the worktree's repoUrl
  // host matches the current MITM hostname. The host equality guard keeps a
  // token scoped to e.g. github.com from leaking into a request to
  // chatgpt.com (which is also MITM'd for other reasons).
  const httpsCred = resolveHttpsCredentialForWorktree(worktreeId)
  if (httpsCred && httpsCred.host === hostname) {
    const basic = 'Basic ' + Buffer.from(`x-access-token:${httpsCred.token}`).toString('base64')
    rules.push({
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: basic }],
    })
  }

  // GitHub CLI (`gh`) auth: the container's GH_TOKEN carries the placeholder.
  // gh sends it to the GitHub API host (api.github.com — REST + GraphQL) as
  // `Authorization: token <placeholder>` (or `Bearer`). Swap in the HTTPS git
  // token assigned to the worktree's project, preserving gh's auth scheme.
  // Gated on the worktree's https remote being on github.com AND on the placeholder
  // sentinel, so traffic carrying a user-supplied token passes through.
  const ghApiToken = resolveGithubApiTokenForWorktree(worktreeId, hostname)
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

  // Credential swaps are gated on the inbound request carrying our
  // placeholder sentinel, and on nothing else. Requests that don't match
  // (e.g. a user manually passing their own API key through the proxy) pass
  // through unmodified — the proxy only rewrites traffic it knows it
  // originated the placeholder for.
  //
  // There is deliberately no longer a per-tool gate here. A worktree is
  // tool-agnostic: it holds whatever agent sessions the user opens in it, in
  // any mix, so "the worktree's tool" is not a property that exists to gate
  // on. Every pod already carries every tool's placeholder env (spares are
  // retoolable), so the gate only ever decided which of those placeholders
  // resolved — and any agent in any worktree may now spend any credential the
  // host has signed in. That is a real widening, and the intended one.
  if (hostname === ANTHROPIC_API_HOST) {
    const creds = objects.credentials.claude
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
          // The captured rotation while it is newer than the pushed bundle.
          value: 'Bearer ' + (objects.claudeOAuthBundle() ?? creds.bundle).accessToken,
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

  // opencode / pi credential swap. Both are api-key only: the container's env
  // carries the chosen provider's key var set to the placeholder, the tool
  // sends the placeholder to the provider's host, and the proxy substitutes
  // the real key here. Gated on the worktree's registered tool + the host
  // matching the credential's provider + the placeholder sentinel, so
  // unrelated traffic (or a user manually carrying their own key) passes
  // through untouched. Which header carries the key varies by provider
  // (x-api-key for Anthropic-style, Authorization: Bearer for the rest), so
  // swapApiKeyHeader substitutes wherever the sentinel appears.
  {
    const creds = objects.credentials.opencode
    if (creds && hostname === OPENCODE_PROVIDER_HOSTS[creds.provider]) {
      swapApiKeyHeader(rules, reqHeaders, creds.apiKey)
    }
  }
  {
    const creds = objects.credentials.pi
    if (creds && hostname === PI_PROVIDER_HOSTS[creds.provider]) {
      swapApiKeyHeader(rules, reqHeaders, creds.apiKey)
    }
  }

  return rules
}

/**
 * The outbound half of an OAuth refresh: the real refresh token, to replace
 * the placeholder the workspace holds.
 *
 * Deliberately NOT a dynamic injection rule. The caller applies these only
 * when the request actually presented our placeholder, and that fact is not
 * known where rules are built — the body has not been read yet. Keeping the
 * swap out of the rule list keeps the generic injection pipeline generic and
 * unconditional, and leaves this endpoint's already-bespoke multi-step flow
 * (buffer body, swap outbound, capture response, rewrite inbound) owning the
 * one condition that is its own.
 *
 * At most one bundle is ever non-null: which is loaded is decided by the
 * hostname, and the two endpoints are different hosts.
 */
function oauthRefreshSwaps(
  claudeTokenBundle: ClaudeOAuthBundle | null,
  codexTokenBundle: CodexOAuthBundle | null,
): BodyParamSwap[] {
  const bundle = claudeTokenBundle ?? codexTokenBundle
  return bundle ? [{ name: 'refresh_token', value: bundle.refreshToken }] : []
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
 * Buffer a Claude token-endpoint response, capture any refreshed tokens
 * (captureRefreshed), and forward a placeholder-rewritten copy to the
 * container. Upstream headers (including content-type and
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
    // Success: capture the refreshed tokens.
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
      captureRefreshed({ claude: fresh })
      console.log('[proxy] Captured refreshed Claude OAuth tokens (expires in ' + Math.floor((fresh.expiresAt - Date.now()) / 1000) + 's)')
    } catch (err) {
      console.error('[proxy] Failed to capture refreshed Claude OAuth tokens:', (err as Error).message)
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
      captureRefreshed({ codex: fresh })
      console.log('[proxy] Captured refreshed Codex OAuth tokens (expires in ' + Math.floor((fresh.expiresAt - Date.now()) / 1000) + 's)')
    } catch (err) {
      console.error('[proxy] Failed to capture refreshed Codex OAuth tokens:', (err as Error).message)
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
  worktreeId: string | null,
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
    // swap placeholders inbound. Null when this isn't the token endpoint or
    // no OAuth bundle is held (nothing to swap). Not gated on the
    // worktree's tool: a worktree is tool-agnostic, so any agent in it may
    // drive any signed-in tool's refresh. (The host-side tool sign-in flow
    // never traverses the worktree proxy, so it's unaffected.)
    const claudeTokenBundle =
      hostname === CLAUDE_TOKEN_URL_HOST && reqPath === CLAUDE_TOKEN_URL_PATH
      && worktreeId !== null
        ? objects.claudeOAuthBundle()
        : null
    const codexTokenBundle =
      hostname === OPENAI_TOKEN_URL_HOST && reqPath === OPENAI_TOKEN_URL_PATH
      && worktreeId !== null
        ? objects.codexOAuthBundle()
        : null

    // Dynamic rules (GitHub / Codex / Claude auth + OAuth refresh swap) are
    // derived from the live credentials on every request and merged into
    // the registered rules (secretRefs resolved per request,
    // same freshness semantics) so a single injection pipeline handles both.
    const dynamicRules = buildDynamicRules(
      worktreeId, hostname, claudeTokenBundle, codexTokenBundle, req.headers,
    )
    const projectSlug = worktreeId ? registrationOf(worktreeId)?.projectSlug : undefined
    const allRules: InjectionRule[] = [...resolveRegisteredRules(rules, projectSlug), ...dynamicRules]
    const injCount = applyInjections(headers, reqPath, allRules)
    const bodyInjections = collectBodyInjections(reqPath, allRules)

    // Watch the upstream's verdict when this request goes to the worktree's
    // git host with a yaac-injected credential (the same condition under
    // which buildDynamicRules added the git Authorization rule above) — a
    // 401/403 on a git endpoint means the stored token is bad.
    const gitCredInjected =
      worktreeId !== null && worktreeHasHttpsCredentialForHost(worktreeId, hostname)

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
        if (gitCredInjected && worktreeId !== null) {
          noteGitUpstreamStatus(worktreeId, hostname, reqPath, upstreamRes.statusCode ?? 0)
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

    // Buffer the body when something will read or rewrite it: a registered
    // body rule, or a token endpoint we are mediating. The token case has to
    // be named explicitly — its swap is no longer a rule, so the rule list
    // alone would stop buffering the very requests the capture depends on.
    const mediatingTokenEndpoint = claudeTokenBundle !== null || codexTokenBundle !== null
    if (bodyInjections.length > 0 || mediatingTokenEndpoint) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const contentTypeHeader = headers['content-type']
        const contentType = typeof contentTypeHeader === 'string'
          ? contentTypeHeader
          : Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : undefined
        const inboundBody = Buffer.concat(chunks)

        // One fact, gating both halves of the refresh. The request presented
        // the placeholder we issued, so it is one of our workspaces' own
        // refreshes: swap the real token in on the way out, and capture the
        // rotation on the way back.
        //
        // Anything else travels as itself. That matters in both directions.
        // Injecting into a request that never held our placeholder would
        // rotate the account's credential on behalf of whatever process sent
        // it — any pod can reach this endpoint — while the capture declined
        // to record the replacement, leaving the host store holding a token
        // the rotation had already spent and every workspace on it signed
        // out. And capturing a response we did not cause would clobber the
        // stored bundle with credentials from an unrelated
        // authorization_code exchange through the same endpoint.
        const oursToRefresh = mediatingTokenEndpoint
          && bodyHasPlaceholderRefreshToken(inboundBody, contentType)
        const swaps = oursToRefresh
          ? oauthRefreshSwaps(claudeTokenBundle, codexTokenBundle)
          : []
        const rawBody = applyBodyInjections(
          inboundBody, contentType, [...bodyInjections, ...swaps],
        )
        sendUpstream(rawBody, oursToRefresh)
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

    const dynamicRules = buildDynamicRules(worktreeId, hostname, null, null, req.headers)
    const projectSlug = worktreeId ? registrationOf(worktreeId)?.projectSlug : undefined
    const allRules: InjectionRule[] = [...resolveRegisteredRules(rules, projectSlug), ...dynamicRules]
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
 * Authorize `hostname` for the worktree and hand the socket to the MITM
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
  worktreeId: string,
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
  if (hostname === MAMA_MAGIC_HOST) {
    console.log(`[proxy] yaac magic host dialed on ${opts.writeConnectOk ? 'CONNECT' : 'HTTPS'} — use http://${MAMA_MAGIC_HOST}${MAMA_PATH}`)
    if (opts.writeConnectOk) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.end()
    } else {
      clientSocket.destroy()
    }
    return
  }

  if (!isHostAllowed(worktreeId, hostname)) {
    const label = opts.writeConnectOk ? 'CONNECT' : 'transparent HTTPS'
    console.log(`[proxy] BLOCKED ${label} to ${hostname}:${port ?? '443'} (not in allowlist)`)
    recordBlockedHost(worktreeId, hostname)
    if (opts.writeConnectOk) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.end()
    } else {
      clientSocket.destroy()
    }
    return
  }

  const rules = findRulesForHost(worktreeId, hostname)

  // Always MITM well-known tool-auth hosts so we can inject credentials,
  // even when no per-worktree rule-based injections apply. Port-aware:
  // SSH (22) always tunnels.
  const destPort = parseInt(port ?? '', 10) || 443
  const needsDynMitm = hostNeedsDynamicMitm(worktreeId, hostname, destPort)

  // A registered redirect for this hostname forces MITM — without it, the
  // proxy would tunnel bytes unchanged and the redirect could never apply.
  const redirect: UpstreamRedirect | null =
    registrationOf(worktreeId)?.upstreamRedirects?.[hostname] ?? null

  if (opts.writeConnectOk) {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  }

  if (opts.head && opts.head.length > 0) {
    clientSocket.unshift(opts.head)
  }

  if (rules.length > 0 || needsDynMitm || redirect) {
    handleMitm(clientSocket, hostname, port, worktreeId, rules, redirect)
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

// ── Event stream ───────────────────────────────────────────────────────

/**
 * Open `GET /events` responses. The server holds one; the Set tolerates a
 * second (a reconnect racing its predecessor's close).
 *
 * The proxy cannot dial the server — it is an in-cluster pod and the server
 * is a host process with no in-cluster address — so the change signal rides
 * the connection the server already holds open to us.
 */
const eventSubscribers = new Set<http.ServerResponse>()

/** How often to write a ping, so a peer can detect a dead tunnel by read
 *  timeout rather than waiting on TCP. */
const EVENT_PING_MS = 15_000

/**
 * Tell every subscriber that `type` changed — deliberately WITHOUT the
 * payload: the queue is drained over its own claim protocol, so the signal
 * only means "look now". A dropped connection costs a reconnect, never a
 * lost update, because the reconnecting server drains anyway. Everything
 * else the proxy observes travels as objects the server watches.
 */
function emitProxyEvent(type: 'mama' | 'ping'): void {
  if (eventSubscribers.size === 0) return
  const line = JSON.stringify({ type }) + '\n'
  for (const res of eventSubscribers) {
    try {
      res.write(line)
    } catch {
      eventSubscribers.delete(res)
    }
  }
}

setInterval(() => emitProxyEvent('ping'), EVENT_PING_MS).unref()

function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === 'GET' && req.url === '/healthz') {
    if (USE_TOR && !fs.existsSync(path.join(DATA_DIR, 'tor-ready'))) {
      res.writeHead(503)
      res.end('tor not ready')
      return
    }
    // Not Ready until every input object's initial list has landed: a pod
    // serving before that would fail every worktree closed for want of a
    // registration it simply has not been told yet.
    if (IN_CLUSTER && !objects.ready()) {
      res.writeHead(503)
      res.end('objects not loaded')
      return
    }
    res.writeHead(200)
    res.end('ok')
    return
  }

  // The change stream the server subscribes to for the one thing it has to
  // be woken for: a queued in-worktree `yaac-mama` request. Held open; one
  // NDJSON line per change, plus periodic pings.
  if (req.method === 'GET' && req.url === '/events') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    // Flush the headers so the subscriber knows it is attached before the
    // first change rather than at the first write.
    res.flushHeaders()
    eventSubscribers.add(res)
    const drop = (): void => { eventSubscribers.delete(res) }
    res.on('close', drop)
    res.on('error', drop)
    return
  }

  // In-worktree yaac-mama requests: the server drains pending requests when
  // the `mama` event above wakes it (drain = claim, at-most-once) ...
  if (req.method === 'GET' && req.url === '/cmd/pending') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mamaQueue.drain()))
    return
  }

  // ... and posts back results, which complete the held worktree responses.
  if (req.method === 'POST' && req.url === '/cmd/results') {
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
        const result: MamaResult = {
          requestId: r.requestId,
          ok: r.ok,
          output: typeof r.output === 'string' ? r.output : undefined,
          error: typeof r.error === 'string' ? r.error : undefined,
        }
        if (mamaQueue.complete(result)) completed++
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ completed }))
    })
    return
  }

  res.writeHead(404)
  res.end('Not found')
}

// ── ssh-agent identities ──────────────────────────────────────────────
//
// Loaded from the credentials Secret's `ssh-keys.json` by the credentials
// handler (agent-keys.ts). Key bytes live only in the agent's memory; which
// worktrees may use each one is the relay's per-project scoping below.

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
// via -H (see agent-keys.ts).
const KNOWN_HOSTS_FILE = path.join(requireEnv('HOME'), '.ssh', 'known_hosts')

// The pod-local agent socket (created by entrypoint.sh under $HOME). The
// proxy talks to it directly; worktree pods reach it through the
// SSH_AGENT_PORT listener, which splices to this same path.
const AGENT_SOCK = requireEnv('SSH_AUTH_SOCK')

const agentKeys = createAgentKeyLoader({ agentSock: AGENT_SOCK, knownHostsFile: KNOWN_HOSTS_FILE })

// ── Server ─────────────────────────────────────────────────────────────

ca = await loadOrGenerateCA()
if (IN_CLUSTER) {
  // What the last pod left: its blocked-host and git-auth records (so a
  // replacement keeps the badges), and any rotation it captured that the
  // server has not echoed back yet (so the newer token keeps being served).
  seedState(decodeState(await readOutputObject('configmap', STATE_CONFIGMAP_NAME)))
  objects.capture(decodeRefreshed(await readOutputObject('secret', REFRESHED_SECRET_NAME)))
}

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
  worktreeId: string,
  target: { hostname: string; port: number; path: string },
): void {
  if (!isHostAllowed(worktreeId, target.hostname)) {
    console.log(`[proxy] BLOCKED HTTP forward to ${target.hostname} (not in allowlist)`)
    recordBlockedHost(worktreeId, target.hostname)
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

// :API_PORT serves only the server control API (health, the change stream,
// the yaac-mama queue). Worktree egress never reaches it — all of it (HTTP,
// HTTPS, SSH) rides the relay-fed transparent listeners, gated by the
// per-connection PP2 token.
const server = http.createServer((req, res) => {
  // Hint the server's fetch pool to hold connections for 60s (undici
  // honors the server's Keep-Alive timeout hint) rather than its 4s idle
  // default, so the queue drains ride one connection.
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
// Worktree pods' outbound 443/80 (and the SSH tunnel sentinel) is
// redirected here by netd's per-pod nat DNAT at the pod's veth peer: the
// node-local Envoy forwards each connection wrapped in a PROXY protocol
// v2 header carrying the connection's real source pod IP. Identity is that
// source IP, resolved to a worktree via the pod-watch index
// (see resolveWorktreeBySourceIp). Destination comes from the TLS SNI
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
 * transparent socket, resolve the source pod IP it carries to a worktree id,
 * then hand that worktree id and the remaining stream to `next`. Any failure
 * destroys the socket — this is the fail-closed gate. Identity is the source
 * pod IP, which netd's Envoy stamps from the connection's real peer address
 * (unforgeable: the redirect is keyed on the arrival veth, and neither a
 * gVisor guest nor a Felix-policed runc pod can spoof its source). The
 * proxy-ingress NetworkPolicy admits these ports from the node CIDRs only, so
 * a worktree pod cannot dial in and forge a source.
 */
function resolveWorktreeBySourceIp(
  socket: net.Socket,
  label: string,
  next: (worktreeId: string, leftover: Buffer) => void,
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
    // Keep buffering bytes that arrive while we resolve the worktree async, so
    // none are lost between removing onData and `next` attaching its reader.
    let leftover = buf.subarray(res.bytesConsumed)
    const buffer = (chunk2: Buffer): void => { leftover = Buffer.concat([leftover, chunk2]) }
    socket.on('data', buffer)
    void resolveWorktree(srcIp).then((worktreeId) => {
      socket.removeListener('data', buffer)
      if (!worktreeId) {
        console.log(`[proxy] BLOCKED transparent ${label} from ${peer}: source ${srcIp} is not a known worktree pod`)
        socket.destroy()
        return
      }
      // Hand the post-header bytes to `next` directly (the HTTPS peeker / HTTP
      // path each unshift once at dispatch; a second unshift would not
      // reliably re-emit to a freshly-added 'data' listener).
      next(worktreeId, leftover)
    })
  }
  socket.on('data', onData)
}

/**
 * After the PP2 preamble: peek the ClientHello SNI without terminating
 * TLS, then dispatch to the shared MITM/tunnel path. `initial` is the
 * post-header leftover from resolveWorktreeBySourceIp (often the start of the
 * ClientHello). The single unshift at dispatch drives the real handshake
 * downstream.
 */
function peekSniAndDispatch(socket: net.Socket, worktreeId: string, initial: Buffer): void {
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
    dispatchToUpstream(socket, peek.serverName, '443', worktreeId, { writeConnectOk: false })
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
  resolveWorktreeBySourceIp(socket, 'HTTPS', (worktreeId, leftover) =>
    peekSniAndDispatch(socket, worktreeId, leftover))
})

// Origin-form HTTP after the PP2 preamble: feed the post-header stream
// into an internal http.Server (the `emit('connection')` pattern handleMitm
// already uses) and carry the verified worktree id on the socket.
type IdentifiedSocket = net.Socket & { yaacWorktreeId?: string }

// In-worktree yaac-mama requests (see mama-queue.ts). Held responses expire
// on a coarse sweep — precision doesn't matter, only that abandoned requests
// eventually 504 instead of leaking.
const mamaQueue = new MamaQueue()
setInterval(() => { mamaQueue.expire() }, 5_000).unref()

/**
 * `POST http://yaac.internal/cmd?command=<name>&<opts>` from inside a
 * worktree: validate the envelope's shape, then hold the response open until
 * the server drains the queue and posts the result (or the TTL sweep 504s
 * it). Runs BEFORE the allowlist — a worktree can always reach its own
 * server, without registration and never recorded as a blocked host.
 *
 * `POST /spawn` is the same thing from a worktree whose mounted script
 * predates named commands: it carries the prompt as the body and `tool` /
 * `model` as query params, which is exactly a `create`
 * (docs/legacy-compat-shims.md).
 */
function handleMamaRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  worktreeId: string,
): void {
  const url = new URL(req.url ?? '/', `http://${MAMA_MAGIC_HOST}`)
  const legacy = url.pathname === LEGACY_SPAWN_PATH
  // The queue writes the completed reply itself (see `MamaReplyShape`); this
  // is for everything refused before it ever gets there, in the shape that
  // caller's script can read.
  const respond = (status: number, body: string): void => {
    if (legacy || status === 404 || status === 405) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(body)
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(status === 200 ? JSON.stringify({ output: body }) : JSON.stringify({ error: body }))
  }
  if (url.pathname !== MAMA_PATH && !legacy) { respond(404, 'Not found'); return }
  if (req.method !== 'POST') { respond(405, 'Method not allowed'); return }
  const chunks: Buffer[] = []
  let received = 0
  let overflow = false
  req.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > MAMA_MAX_BODY_BYTES) {
      if (!overflow) { overflow = true; respond(413, 'argument too large') }
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (overflow) return
    const raw = Buffer.concat(chunks).toString('utf8')

    // The envelope arrives as JSON, which is the one shape both substrates
    // send (worktree-bin/yaac-mama). A legacy /spawn call predates it: the
    // prompt IS the body and `tool`/`model` ride the query string, which is
    // exactly a `create` (docs/legacy-compat-shims.md).
    let command: string
    let args: Record<string, string>
    let body: string
    if (legacy) {
      command = 'create'
      args = {}
      for (const [name, value] of url.searchParams) args[name] = value
      body = raw
    } else {
      const parsed = parseMamaEnvelope(raw)
      if (!parsed) { respond(400, 'invalid request envelope'); return }
      ;({ command, args, body } = parsed)
    }

    const valid = validateMamaRequest(command, args, body)
    if (!valid.ok) { respond(valid.status, valid.error); return }
    // No-op the completer once the caller is gone; the entry still expires
    // off the queue on the normal TTL sweep.
    let gone = false
    res.on('close', () => { gone = true })
    const enqueued = mamaQueue.enqueue(
      { worktreeId, command, args, body, reply: legacy ? 'text' : 'json' },
      // The queue has already shaped this reply for the caller's script, so
      // it is written through verbatim rather than through `respond`.
      (status, text) => {
        if (gone) return
        res.writeHead(status, {
          'Content-Type': legacy
            ? 'text/plain; charset=utf-8'
            : 'application/json; charset=utf-8',
        })
        res.end(text)
      },
    )
    if (!enqueued.ok) { respond(enqueued.status, enqueued.error); return }
    console.log(`[proxy] ${command} request from worktree ${worktreeId.slice(0, 8)}... queued (${enqueued.requestId.slice(0, 8)}...)`)
    // The caller's response is held until the server drains and answers, so
    // the drain is worth waking immediately rather than at the next resync.
    emitProxyEvent('mama')
  })
}

/**
 * `GET http://yaac.internal/tools` from inside a worktree — the endpoint
 * `yaac-spawn --models` asked, kept for worktrees whose mounted script
 * predates the command envelope (docs/legacy-compat-shims.md). `yaac-mama
 * models` is answered by the SERVER instead, from its own credentials.
 * report which agent tools have host credentials, their provider/host, and —
 * with `?models=1` — their accepted model ids from the baked catalog. Answered
 * synchronously from proxy-local state (the credentials Secret's view + the
 * worktree's registered tool); no server round-trip, no network fetch. Like /spawn it runs BEFORE the
 * allowlist and is attributed by source pod IP; it exposes tool/provider/model
 * names only, never credential material.
 */
function handleToolsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  worktreeId: string,
): void {
  const respond = (status: number, contentType: string, body: string): void => {
    res.writeHead(status, { 'Content-Type': contentType })
    res.end(body)
  }
  if (req.method !== 'GET') { respond(405, 'text/plain; charset=utf-8', 'Method not allowed'); return }
  const url = new URL(req.url ?? '/', `http://${MAMA_MAGIC_HOST}`)
  const includeModels = url.searchParams.get('models') === '1'
  const asJson = url.searchParams.get('json') === '1'

  const view = (creds: { kind: 'oauth' | 'api-key'; provider?: string } | null): ToolCredsView =>
    creds ? { authed: true, kind: creds.kind, provider: creds.provider } : { authed: false }
  const creds: Record<AgentTool, ToolCredsView> = {
    claude: view(objects.credentials.claude),
    codex: view(objects.credentials.codex),
    opencode: view(objects.credentials.opencode),
    pi: view(objects.credentials.pi),
  }
  const report = buildToolsReport({ currentTool: registrationOf(worktreeId)?.tool ?? null, creds, includeModels })
  if (asJson) { respond(200, 'application/json; charset=utf-8', `${JSON.stringify(report, null, 2)}\n`); return }
  respond(200, 'text/plain; charset=utf-8', formatToolsReport(report))
}

const internalHttpServer = http.createServer((req, res) => {
  const socket = req.socket as IdentifiedSocket
  const worktreeId = socket.yaacWorktreeId
  if (!worktreeId) {
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
  if (target.hostname === MAMA_MAGIC_HOST) {
    const pathname = (req.url ?? '/').split('?', 1)[0]
    if (pathname === '/tools') {
      handleToolsRequest(req, res, worktreeId)
      return
    }
    handleMamaRequest(req, res, worktreeId)
    return
  }
  forwardPlainHttp(req, res, worktreeId, {
    hostname: target.hostname,
    port: target.port,
    path: req.url ?? '/',
  })
})

const transparentHttpServer = net.createServer((socket) => {
  resolveWorktreeBySourceIp(socket, 'HTTP', (worktreeId, leftover) => {
    ;(socket as IdentifiedSocket).yaacWorktreeId = worktreeId
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
function readConnectAndDispatch(socket: net.Socket, worktreeId: string, initial: Buffer): void {
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
    dispatchToUpstream(socket, m[1], m[2], worktreeId, {
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
  resolveWorktreeBySourceIp(socket, 'TUNNEL', (worktreeId, leftover) =>
    readConnectAndDispatch(socket, worktreeId, leftover))
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

// ── Stream relay (server ↔ worktree-pod streamd) ────────────────────────────
//
// A dumb authenticated CONNECT: the server dials in, sends ONE JSON auth
// line `{"token": <proxyAuthSecret>, "worktreeId": <sid>}`, and the relay
// resolves the worktree's pod IP (pod-watch reverse index, labelSelector
// list on a miss) and splices the rest of the stream to
// `podIP:POD_STREAM_PORT` untouched — the streamd handshake, its reply,
// and the payload are end-to-end server↔streamd. Per-stream failures
// (unknown worktree, pod dial failure or timeout) are ANSWERED with an
// error line before closing: the server treats a silent close as a dead
// transport and re-establishes its shared port-forward, so a stale
// worktree's probe must not masquerade as one — and nothing before the
// splice may hang instead, which is what the pre-splice deadline below
// enforces. Only a bad auth line closes silently (no oracle for
// unauthenticated peers).

const RELAY_HANDSHAKE_MAX_BYTES = 4 * 1024
/**
 * Budget for every phase before the splice — the auth line, the pod-IP
 * resolve, then the pod dial (which re-arms it on the target socket, the
 * only handle that can also reap a hung connect). No phase may hang
 * instead of answering: a worktree pod whose ingress policy hasn't
 * admitted this proxy yet DROPS the SYN, so an unbounded `net.connect`
 * sits out the OS retry series (~130s) holding both sockets, with the
 * server waiting out its own deadline and learning nothing about which
 * of the two — this pod, or the shared transport — is the problem.
 *
 * Generous on purpose: an in-cluster pod dial is milliseconds, and the
 * only slow leg is an apiserver list behind a pod-index miss, which
 * should be allowed to finish rather than refused out from under a
 * stream that would have worked. It stays under the server's 15s stream
 * dial deadline so the refusal is what that caller sees.
 */
const RELAY_PRESPLICE_TIMEOUT_MS = 6_000

function handleRelayConnection(socket: net.Socket, podStreamPort: number): void {
  socket.on('error', () => { /* per-connection; close tears down the splice */ })
  // Both legs of the splice go Nagle-free: what rides this relay is terminal
  // output and keystrokes, already coalesced by the batchers at each end, so
  // holding a small write back to look for a companion only adds delay.
  socket.setNoDelay(true)
  let buf = Buffer.alloc(0)
  // Before the auth line there is nothing we may say (no oracle for
  // unauthenticated peers), so expiry is a silent destroy until it lands.
  let authed = false
  // Answer refusals with a reply line (see the module comment): a silent
  // close reads as a dead transport server-side. Idempotent — the deadline
  // and a failed dial can both land on it. A declaration, not a const, so
  // it and the deadline below can name each other.
  function refuse(error: string): void {
    clearTimeout(deadline)
    if (socket.destroyed || socket.writableEnded) return
    socket.end(JSON.stringify({ ok: false, error: `relay: ${error}` }) + '\n')
  }
  const deadline = setTimeout(() => {
    if (authed) refuse('timed out resolving the worktree pod')
    else socket.destroy()
  }, RELAY_PRESPLICE_TIMEOUT_MS)

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])
    const nl = buf.indexOf(0x0a)
    if (nl < 0) {
      if (buf.length > RELAY_HANDSHAKE_MAX_BYTES) { clearTimeout(deadline); socket.destroy() }
      return
    }
    socket.removeListener('data', onData)

    let params: { token?: unknown; worktreeId?: unknown }
    try {
      params = JSON.parse(buf.subarray(0, nl).toString('utf8')) as typeof params
    } catch {
      clearTimeout(deadline)
      socket.destroy()
      return
    }
    const dialled = params.worktreeId
    if (
      typeof params.token !== 'string' || typeof dialled !== 'string'
      || !timingSafeStrEqual(params.token, PROXY_AUTH_SECRET!)
    ) {
      console.log('[proxy] BLOCKED relay dial: bad auth line')
      clearTimeout(deadline)
      socket.destroy()
      return
    }
    authed = true
    const worktreeId = dialled

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
    void (async () => {
      let ip = podIndex.resolveIp(worktreeId)
      if (!ip) {
        try {
          ip = await fetchPodIpByWorktreeId(podIndex, worktreeId)
        } catch (err) {
          console.error(`[proxy] relay pod lookup failed for ${worktreeId.slice(0, 8)}...:`, (err as Error).message)
        }
      }
      // `writableEnded` as well as `destroyed`: a refusal (the deadline
      // firing mid-resolve) only ends this socket, and stays undestroyed
      // until the peer closes — a resolve landing in that window would
      // otherwise dial the pod anyway and splice into an ended socket.
      if (socket.destroyed || socket.writableEnded) return
      if (!ip) {
        console.log(`[proxy] BLOCKED relay dial: unknown worktree ${worktreeId.slice(0, 8)}...`)
        refuse('unknown worktree')
        return
      }
      // allowHalfOpen so an EOF from either end passes through the splice
      // (pipe propagates the end()); the close handlers reap the pair.
      const target = net.connect({ port: podStreamPort, host: ip, allowHalfOpen: true })
      target.setNoDelay(true)
      // The dial leg's share of the deadline moves onto the target socket,
      // which is the only handle that can also reap it: a dropped SYN would
      // otherwise sit out the OS retry series holding both sockets open.
      // Destroying it lands on the error handler below, so a hung dial
      // refuses exactly like a failed one.
      clearTimeout(deadline)
      target.setTimeout(RELAY_PRESPLICE_TIMEOUT_MS, () => {
        target.destroy(Object.assign(new Error('pod dial timeout'), { code: 'ETIMEDOUT' }))
      })
      let spliced = false
      target.on('connect', () => {
        spliced = true
        target.setTimeout(0) // an idle spliced stream must not trip it
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

// ── ssh-agent forwarding (worktree pod → this pod's agent) ──────────────────
//
// The transport that replaced the hostPath socket the proxy and worktree pods
// used to share: a worktree pod's local forwarder splices its SSH_AUTH_SOCK
// UNIX socket to this listener, which relays to the agent. Identity is the
// source pod IP (pod-watch), entitlement is the worktree's registered SSH
// remote, and the keys it sees are its project's — see ssh-agent-relay.ts
// for the full gate. The relay asks per message, so the answer is read off
// the live credentials and registration every time.
function allowedKeysFor(worktreeId: string): Set<string> {
  const slug = registrationOf(worktreeId)?.projectSlug
  return (slug ? sshKeyBlobsByProject(objects.credentials.ssh).get(slug) : undefined) ?? new Set()
}
const sshAgentServer = SSH_AGENT_PORT
  ? createSshAgentServer({
    agentSock: AGENT_SOCK,
    resolveWorktree,
    repoUrlFor: (worktreeId) => registrationOf(worktreeId)?.repoUrl,
    allowedKeysFor,
  })
  : null
if (sshAgentServer && SSH_AGENT_PORT) {
  sshAgentServer.on('error', (err: Error) => {
    console.error('[proxy] ssh-agent server error:', err)
  })
  sshAgentServer.listen(parseInt(SSH_AGENT_PORT, 10), '0.0.0.0', () => {
    console.log(`[proxy] ssh-agent listener on port ${SSH_AGENT_PORT}`)
  })
}

// ── DNS stub (UDP/53), split-horizon ───────────────────────────────────────
// Worktree pods resolve against the proxy. External names get the sinkhole;
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

// ── The watches (source IP → worktree; the objects) ───────────────────────
// Only in-cluster (a mounted SA). Local/test runs without it leave every
// map empty, so transparent connections fail closed — which is correct.
if (IN_CLUSTER) {
  try {
    startPodWatch(podIndex)
    startObjectWatch(objects)
  } catch (err) {
    console.error('[proxy] watches failed to start:', (err as Error).message)
    process.exit(1)
  }
} else {
  console.warn('[proxy] no KUBERNETES_SERVICE_HOST — watches disabled (not in-cluster)')
}

process.on('SIGTERM', () => {
  console.log('[proxy] Shutting down...')
  transparentHttpsServer.close()
  transparentHttpServer.close()
  transparentTunnelServer.close()
  relayServer.close()
  sshAgentServer?.close()
  dnsServer?.close()
  server.close(() => process.exit(0))
})

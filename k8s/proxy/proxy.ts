/**
 * MITM egress proxy for workspace pods (see docs/workspace-egress.md).
 *
 * Stateless: its inputs arrive as Kubernetes objects it watches
 * (object-watch.ts) and its outputs are objects the server watches, so a
 * replaced pod restores itself from the informers' initial lists.
 *
 * - Serves the CA from the `yaac-proxy-ca` Secret, minting it the first time.
 * - Reads per-workspace rules and allowlists from registration ConfigMaps,
 *   secret values from per-project Secrets, and tool credentials plus ssh
 *   keys from the credentials Secret. Changes apply on the next request.
 * - MITMs TLS when rules match a host, and tunnels it otherwise.
 * - Swaps placeholder tokens for real OAuth credentials and saves refreshed
 *   tokens to the `yaac-proxy-refreshed` Secret.
 * - Records blocked hosts and rejected git credentials in the
 *   `yaac-proxy-state` ConfigMap.
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
  type RefreshedBundles,
  type UpstreamRedirect,
  type ProxyRegistration,
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
import { PodWorkspaceIndex, fetchPodIpByWorkspaceId, fetchWorkspaceByPodIp, startPodWatch } from './pod-watch'
import {
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
import { RefreshFlights } from './refresh-flight'
import { LiveTunnels } from './live-tunnels'
import { OPENCODE_PROVIDER_HOSTS, PI_PROVIDER_HOSTS } from './tool-providers.generated'

// Control API: health, the change stream and the yaac-mama queue. All other
// input from the server arrives as objects (object-watch.ts).
const API_PORT = process.env.API_PORT
const PROXY_AUTH_SECRET = process.env.PROXY_AUTH_SECRET
// Transparent egress listeners. netd's Envoy forwards redirected 443/80
// here with a PP2 header (destination from SNI / Host), and SSH CONNECTs to
// the tunnel listener.
const TRANSPARENT_HTTPS_PORT = process.env.TRANSPARENT_HTTPS_PORT
const TRANSPARENT_HTTP_PORT = process.env.TRANSPARENT_HTTP_PORT
const TRANSPARENT_TUNNEL_PORT = process.env.TRANSPARENT_TUNNEL_PORT
// Stream relay from the yaac server into a workspace pod's streamd
// (docs/stream-relay.md).
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
// UDP/53 DNS stub for workspace pods (see dns-stub.ts). Optional, so
// non-cluster test runs can skip it.
const DNS_STUB_PORT = process.env.DNS_STUB_PORT
// ssh-agent relay port for workspace pods (see ssh-agent-relay.ts).
// Optional, since a non-cluster test run has no pod watch to authenticate
// callers with.
const SSH_AGENT_PORT = process.env.SSH_AGENT_PORT
// Answer for external names. The address is never dialed through; see
// dns-stub.ts.
const DNS_SINKHOLE_IPV4 = '198.18.0.1'
// Resolve `.cluster.local` names against the cluster DNS (see dns-stub.ts).
const DNS_FORWARD_INTERNAL = process.env.DNS_FORWARD_INTERNAL === '1'

/**
 * Resolve an internal name's first IPv4 address via the proxy's own resolver
 * (the cluster DNS). Callers pass only names that pass isInternalName.
 * Returns null on any failure, so the caller answers with an empty NOERROR.
 */
async function resolveInternalA(name: string): Promise<string | null> {
  try {
    const addrs = await dns.promises.resolve4(name)
    return addrs.length > 0 ? addrs[0] : null
  } catch {
    return null
  }
}

// Pod IP to workspace id, kept current by a pod watch. The transparent
// listeners look up the source IP from the PP2 header here.
const podIndex = new PodWorkspaceIndex()

/**
 * The workspace a pod IP belongs to. Falls back to a direct lookup when a new
 * pod's first connection beats its watch event, and likewise fetches a
 * registration ConfigMap the watch has not delivered yet.
 */
async function resolveWorkspace(ip: string): Promise<string | undefined> {
  let workspaceId = podIndex.resolve(ip)
  if (!workspaceId) {
    try {
      workspaceId = await fetchWorkspaceByPodIp(podIndex, ip) ?? undefined
    } catch { return undefined }
  }
  if (workspaceId && IN_CLUSTER && !objects.registration(workspaceId)) {
    try {
      await fetchRegistration(objects, workspaceId)
    } catch (err) {
      console.error(`[proxy] registration lookup failed for ${workspaceId.slice(0, 8)}...:`, (err as Error).message)
    }
  }
  return workspaceId
}

// USE_TOR=1 routes every upstream connection through the Tor SOCKS listener
// entrypoint.sh starts. socks5h:// resolves DNS at the Tor exit, so lookups
// do not leak to the local resolver.
const USE_TOR = process.env.USE_TOR === '1'
const TOR_SOCKS_URL = 'socks5h://127.0.0.1:9050'
const torAgent = USE_TOR ? new SocksProxyAgent(TOR_SOCKS_URL) : null
const torProxy = { host: '127.0.0.1', port: 9050, type: 5 as const }

// Tor's first circuit to a destination can take longer than the `socks`
// library's 30s default.
const TOR_TUNNEL_TIMEOUT_MS = 120_000

// Only in-cluster can the proxy watch its objects and pods. Outside a
// cluster every map stays empty, so transparent connections fail closed.
const IN_CLUSTER = Boolean(process.env.KUBERNETES_SERVICE_HOST)

const CLAUDE_TOKEN_URL_HOST = 'platform.claude.com'
const CLAUDE_TOKEN_URL_PATH = '/v1/oauth/token'
const ANTHROPIC_API_HOST = 'api.anthropic.com'
// claude's claude.ai MCP connectors use the same OAuth bearer here. Without
// the swap, the placeholder gets a 401 and claude forces a refresh on every
// start.
const CLAUDE_MCP_PROXY_HOST = 'mcp-proxy.anthropic.com'
const OPENAI_API_HOST = 'api.openai.com'
const OPENAI_TOKEN_URL_HOST = 'auth.openai.com'
const OPENAI_TOKEN_URL_PATH = '/oauth/token'
// Codex in ChatGPT auth mode sends inference to chatgpt.com/backend-api, so
// that host gets the same Authorization swap.
const CHATGPT_HOST = 'chatgpt.com'
const CODEX_DEFAULT_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000
// How long a refresh may sit idle upstream before it is abandoned. Callers
// are answered much sooner (refresh-flight.ts); this only stops a dead
// upstream from holding the flight open forever.
const TOKEN_REFRESH_HARD_TIMEOUT_MS = 5 * 60_000
// opencode and pi use API keys only. The proxy swaps the placeholder key for
// the real one on the credential's provider host, from tables generated by
// scripts/gen-tool-providers.ts (tool-providers.generated.ts).

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
 * Load the CA from the `yaac-proxy-ca` Secret, minting it the first time so
 * later pods keep the same root. The combined trust bundle is rewritten every
 * time, since an image upgrade may change the system roots.
 *
 * Outside a cluster there is no Secret, so each process mints a fresh CA.
 */
async function loadOrGenerateCA(): Promise<CA> {
  let result: CA | null = null
  if (IN_CLUSTER) {
    const stored = decodeCa(await readOutputObject('secret', CA_SECRET_NAME))
    if (stored) {
      const key = forge.pki.privateKeyFromPem(stored.keyPem)
      const cert = forge.pki.certificateFromPem(stored.certPem)
      // A CA minted by an older proxy may lack the SKI or critical
      // basicConstraints that generateCA sets. Re-sign it over the same key,
      // so processes that loaded the old cert still verify new leaves.
      const bc = cert.getExtension('basicConstraints') as { critical?: boolean } | undefined
      if (cert.getExtension('subjectKeyIdentifier') && bc?.critical) {
        console.log('[proxy] Loaded existing CA')
        result = { key, cert, pem: stored.certPem }
      } else {
        console.log('[proxy] Existing CA predates the current extensions — re-signing over its key')
        result = generateCA({ privateKey: key, publicKey: cert.publicKey as forge.pki.rsa.PublicKey })
      }
    }
  }
  result ??= generateCA()
  if (IN_CLUSTER) {
    await writeCa(encodeCa({
      keyPem: forge.pki.privateKeyToPem(result.key),
      certPem: result.pem,
      bundlePem: combineCaBundle(fs.readFileSync(SYSTEM_ROOTS_PATH, 'utf8'), result.pem),
    }))
    console.log(`[proxy] CA saved to ${CA_SECRET_NAME}`)
  }
  return result
}

/** A random positive 128-bit serial. A re-signed CA must not reuse its old
 *  issuer+serial pair, which NSS rejects. */
function randomSerial(): string {
  const bytes = crypto.randomBytes(16)
  bytes[0] &= 0x7f // positive
  return bytes.toString('hex')
}

function generateCA(keys = forge.pki.rsa.generateKeyPair(2048)): CA {
  console.log('[proxy] Generating CA...')
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomSerial()
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10)

  const attrs = [{ name: 'commonName', value: 'yaac Proxy CA' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    // RFC 5280 requires critical; Python 3.13+ rejects the chain otherwise.
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    // Every proxy's CA has the same CN, and a nested workspace trusts more
    // than one. The SKI, matched by each leaf's AKI, tells them apart.
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
  cert.serialNumber = randomSerial()
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(now + LEAF_VALIDITY_MS)

  cert.setSubject([{ name: 'commonName', value: hostname }])
  cert.setIssuer(ca.cert.subject.attributes)
  cert.setExtensions([
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    // Points at the issuing CA's SKI. OpenSSL picks one of several same-named
    // CAs and does not retry another, so it must pick the right one.
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

// ── Watched objects ──────────────────────────────────────────────────
//
// Credentials, project secrets and workspace registrations arrive through
// object-watch.ts and are read per request, so edits apply immediately.

const objects = new ProxyObjects({
  loadSshKeys: (entries) => agentKeys.reload(entries),
  // Drop tunnels the new registration no longer admits, and clear
  // newly allowed hosts from the blocked record.
  onRegistration: (workspaceId, registration) => {
    const dropped = liveTunnels.revoke(workspaceId, registration && ((host) => admissionFor(workspaceId, host)))
    if (dropped.length > 0) {
      console.log(`[proxy] dropped ${dropped.length} tunnel(s) of ${workspaceId.slice(0, 8)}... `
        + `the registration no longer admits: ${[...new Set(dropped)].join(', ')}`)
    }
    const blocked = blockedHostsByWorkspace.get(workspaceId)
    if (!blocked) return
    if (registration === null) {
      blockedHostsByWorkspace.delete(workspaceId)
      scheduleStateWrite()
      return
    }
    let pruned = false
    for (const host of blocked) {
      if (isHostAllowed(workspaceId, host)) {
        blocked.delete(host)
        pruned = true
      }
    }
    if (pruned) scheduleStateWrite()
  },
})

function registrationOf(workspaceId: string): ProxyRegistration | undefined {
  return objects.registration(workspaceId)
}

const liveTunnels = new LiveTunnels()

/**
 * The rules and redirect a connection to `hostname` is accepted under, as a
 * comparable string, or null when the host is not allowed.
 */
function admissionFor(workspaceId: string, hostname: string): string | null {
  if (!isHostAllowed(workspaceId, hostname)) return null
  return JSON.stringify([
    findRulesForHost(workspaceId, hostname),
    registrationOf(workspaceId)?.upstreamRedirects?.[hostname] ?? null,
  ])
}

/**
 * Resolve a registration's injections into concrete values. An injection
 * whose secret ref does not resolve is dropped rather than sent empty. Refs
 * resolve only within the registration's own project.
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
 * The HTTPS credential assigned to a workspace's project, with the host of
 * its https remote. Callers send the token only to that host.
 */
function resolveHttpsCredentialForWorkspace(workspaceId: string): { token: string; host: string } | null {
  const registration = registrationOf(workspaceId)
  if (!registration) return null
  const entry = objects.credentials.git.find((e) => e.projects.includes(registration.projectSlug))
  if (!entry) return null
  const host = httpsRemoteHost(registration.repoUrl)
  return host ? { token: entry.token, host } : null
}

/**
 * Record a token rotation from a workspace's refresh. It is served from
 * memory at once and written to the refreshed Secret, retrying until it
 * lands. A single writer always sends the newest capture, so the Secret can
 * never end up holding an already-spent refresh token.
 */
let unwrittenRefreshed: RefreshedBundles | null = null
let refreshedWriter: Promise<void> | null = null
function captureRefreshed(bundles: RefreshedBundles): void {
  objects.capture(bundles)
  if (!IN_CLUSTER) return
  unwrittenRefreshed = { ...unwrittenRefreshed, ...bundles }
  refreshedWriter ??= writeRefreshedUntilLanded().finally(() => { refreshedWriter = null })
}

async function writeRefreshedUntilLanded(): Promise<void> {
  let backoffMs = 1_000
  while (unwrittenRefreshed) {
    const batch = unwrittenRefreshed
    try {
      await writeRefreshed(encodeRefreshed(batch))
      // A capture during the write replaced the batch; go round for it.
      if (unwrittenRefreshed === batch) unwrittenRefreshed = null
      backoffMs = 1_000
    } catch (err) {
      console.error(`[proxy] Failed to persist refreshed OAuth tokens to ${REFRESHED_SECRET_NAME}, retrying:`, String(err))
      await new Promise((r) => setTimeout(r, backoffMs))
      backoffMs = Math.min(backoffMs * 2, 60_000)
    }
  }
}

// ── Observed state ───────────────────────────────────────────────────
//
// Blocked hosts (per workspace) and git auth failures (per project) are
// written to the `yaac-proxy-state` ConfigMap the server watches, and read
// back at boot so a replacement pod keeps them.

const blockedHostsByWorkspace = new Map<string, Set<string>>()

/**
 * projectSlug -> hostname -> auth failure. Keyed by project because the
 * credential is the project's. See noteGitUpstreamStatus.
 */
const gitAuthFailuresByProject = new Map<string, Map<string, GitAuthFailureRecord>>()

function currentState(): ProxyState {
  const state: ProxyState = { blockedHosts: {}, gitAuthFailures: {} }
  for (const [sid, hosts] of blockedHostsByWorkspace) {
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
    blockedHostsByWorkspace.set(sid, new Set(hosts))
  }
  for (const [slug, entries] of Object.entries(state.gitAuthFailures)) {
    gitAuthFailuresByProject.set(slug, new Map(entries.map(({ host, status, atMs }) => [host, { status, atMs }])))
  }
}

/** Debounce for the state write, since blocked hosts come in bursts. */
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
  // Other wildcards match label by label.
  const patternParts = pattern.split('.')
  const hostParts = hostname.split('.')
  if (patternParts.length !== hostParts.length) return false
  return patternParts.every((p, i) => p === '*' || p === hostParts[i])
}

function findRulesForHost(workspaceId: string, hostname: string): HostInjectionRule[] {
  const rules = registrationOf(workspaceId)?.rules
  if (!rules) return []
  return rules.filter((r) => hostMatches(hostname, r.hostPattern))
}

function isHostAllowed(workspaceId: string | null, hostname: string): boolean {
  if (!workspaceId) return false
  const allowed = registrationOf(workspaceId)?.allowedHosts
  if (!allowed) return false
  if (allowed.length === 1 && allowed[0] === '*') return true
  return allowed.some((pattern) => hostMatches(hostname, pattern))
}

function recordBlockedHost(workspaceId: string | null, hostname: string): void {
  if (!workspaceId) return
  let hosts = blockedHostsByWorkspace.get(workspaceId)
  if (!hosts) {
    hosts = new Set()
    blockedHostsByWorkspace.set(workspaceId, hosts)
  }
  if (hosts.has(hostname)) return
  hosts.add(hostname)
  scheduleStateWrite()
}

/**
 * True for git smart-HTTP endpoints (`info/refs` and the upload/receive-pack
 * RPCs), so a 401 from another API on the same host does not flag the git
 * credential.
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
 * Record the upstream's answer to a git request that carried an injected
 * credential. A 401/403 means the stored token was rejected, so it is
 * recorded against the project for the server to surface. A later 2xx on the
 * same host clears it, e.g. after `yaac auth update`.
 */
function noteGitUpstreamStatus(
  workspaceId: string,
  hostname: string,
  requestPath: string,
  status: number,
): void {
  if (!isGitSmartHttpPath(requestPath)) return
  const projectSlug = registrationOf(workspaceId)?.projectSlug
  if (!projectSlug) return
  const byHost = gitAuthFailuresByProject.get(projectSlug)
  if (status === 401 || status === 403) {
    if (byHost?.has(hostname)) return
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
      // Not valid JSON: treat as form-encoded.
    }
  }

  const params = new URLSearchParams(bodyStr)
  for (const { name, value } of injections) {
    if (params.has(name)) params.set(name, value)
  }
  return Buffer.from(params.toString(), 'utf8')
}

// ── Dynamic Auth (GitHub / Codex / Claude api-key) ─────────────────────

/**
 * True for hosts the proxy MITMs to inject tool or git credentials,
 * independent of the workspace's registered rules. Port 22 is never MITM'd.
 */
function hostNeedsDynamicMitm(workspaceId: string | null, hostname: string, port: number): boolean {
  if (port === 22) return false
  if (hostname === ANTHROPIC_API_HOST || hostname === CLAUDE_MCP_PROXY_HOST) return true
  if (hostname === CLAUDE_TOKEN_URL_HOST) return true
  if (hostname === OPENAI_API_HOST) return true
  if (hostname === OPENAI_TOKEN_URL_HOST) return true
  if (hostname === CHATGPT_HOST) return true
  // opencode / pi: only the provider host the credential points at, and
  // only for a workspace running that tool.
  const tool = workspaceId ? registrationOf(workspaceId)?.tool : undefined
  if (tool === 'opencode') {
    const creds = objects.credentials.opencode
    if (creds && hostname === OPENCODE_PROVIDER_HOSTS[creds.provider]) return true
  }
  if (tool === 'pi') {
    const creds = objects.credentials.pi
    if (creds && hostname === PI_PROVIDER_HOSTS[creds.provider]) return true
  }
  if (workspaceId && workspaceHasHttpsCredentialForHost(workspaceId, hostname)) return true
  // gh CLI talks to api.github.com, not the git remote host.
  if (workspaceId && resolveGithubApiTokenForWorkspace(workspaceId, hostname) !== null) return true
  return false
}

function workspaceHasHttpsCredentialForHost(workspaceId: string, hostname: string): boolean {
  const cred = resolveHttpsCredentialForWorkspace(workspaceId)
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
function resolveGithubApiTokenForWorkspace(workspaceId: string, hostname: string): string | null {
  const cred = resolveHttpsCredentialForWorkspace(workspaceId)
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
function buildDynamicRules(
  workspaceId: string | null,
  hostname: string,
  reqHeaders: http.IncomingHttpHeaders,
): InjectionRule[] {
  if (!workspaceId) return []
  const rules: InjectionRule[] = []

  // Git token, only to the workspace's https remote host.
  const httpsCred = resolveHttpsCredentialForWorkspace(workspaceId)
  if (httpsCred && httpsCred.host === hostname) {
    const basic = 'Basic ' + Buffer.from(`x-access-token:${httpsCred.token}`).toString('base64')
    rules.push({
      pathPattern: '*',
      injections: [{ action: 'set_header', name: 'Authorization', value: basic }],
    })
  }

  // gh sends GH_TOKEN's placeholder as `token <ph>` or `Bearer <ph>`; swap
  // in the project's git token and keep gh's scheme.
  const ghApiToken = resolveGithubApiTokenForWorkspace(workspaceId, hostname)
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

// ── Claude OAuth Swap ──────────────────────────────────────────────────

/** Parse a JSON body, or null if it is not JSON. */
function tryParseJsonBody(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Decompress a body by its Content-Encoding, or null for an unknown encoding
 * so the caller can pass the bytes through.
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
 * True if a JSON or form-encoded request body's `refresh_token` is the
 * placeholder. Only such requests get their response captured, so another
 * exchange on the same endpoint (e.g. `authorization_code`) cannot overwrite
 * the stored credential.
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
      // Not JSON: try form-encoded.
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
 * Replace the real access and refresh tokens in an OAuth token response with
 * placeholders. Other fields pass through, since the tool needs them.
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
 * The OAuth credential a token-endpoint request would spend, tagged with its
 * tool, which decides how a rotation is captured.
 */
type RefreshTool = 'claude' | 'codex'
type HeldBundle =
  | { tool: 'claude'; bundle: ClaudeOAuthBundle }
  | { tool: 'codex'; bundle: CodexOAuthBundle }

function heldBundle(tool: RefreshTool): HeldBundle | null {
  if (tool === 'claude') {
    const bundle = objects.claudeOAuthBundle()
    return bundle ? { tool, bundle } : null
  }
  const bundle = objects.codexOAuthBundle()
  return bundle ? { tool, bundle } : null
}

/** The bundle a successful token response rotated `held` into. */
function rotationFrom(held: HeldBundle, body: TokenResponseBody & { access_token: string }): RefreshedBundles {
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token
    ? body.refresh_token
    : held.bundle.refreshToken
  if (held.tool === 'claude') {
    return {
      claude: {
        accessToken: body.access_token,
        refreshToken,
        expiresAt: typeof body.expires_in === 'number'
          ? Date.now() + body.expires_in * 1000
          : held.bundle.expiresAt,
        scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : held.bundle.scopes,
        subscriptionType: held.bundle.subscriptionType,
      },
    }
  }
  // Codex's response carries `id_token` rather than `expires_in`/`scope`;
  // expiry comes from the new access token's own JWT.
  return {
    codex: {
      accessToken: body.access_token,
      refreshToken,
      idTokenRawJwt: typeof body.id_token === 'string' && body.id_token ? body.id_token : held.bundle.idTokenRawJwt,
      expiresAt: decodeJwtExp(body.access_token) ?? (Date.now() + CODEX_DEFAULT_REFRESH_WINDOW_MS),
      lastRefresh: new Date().toISOString(),
      accountId: held.bundle.accountId,
    },
  }
}

/** A fully read token-endpoint reply, sent to the request that drove the
 *  refresh and to every request that joined it. */
type TokenReply = {
  status: number
  headers: http.OutgoingHttpHeaders
  body: Buffer
  /** The refresh token upstream rotated the credential to (the body then
   *  carries placeholders), or null when it did not rotate it. */
  rotatedTo: string | null
}

function errorReply(status: number, message: string): TokenReply {
  return { status, headers: { 'content-type': 'text/plain' }, body: Buffer.from(message), rotatedTo: null }
}

function writeTokenReply(res: http.ServerResponse, reply: TokenReply): void {
  res.writeHead(reply.status, { ...reply.headers, 'content-length': String(reply.body.length) })
  res.end(reply.body)
}

/**
 * Buffer a token-endpoint response, capture the rotation it carries, and
 * return a copy with placeholders in place of the real tokens. A response
 * that is not a decodable success passes through unchanged.
 */
function collectTokenReply(
  upstreamRes: http.IncomingMessage,
  held: HeldBundle,
  done: (reply: TokenReply) => void,
): void {
  const chunks: Buffer[] = []
  upstreamRes.on('data', (c: Buffer) => chunks.push(c))
  upstreamRes.on('end', () => {
    const raw = Buffer.concat(chunks)
    const encoding = upstreamRes.headers['content-encoding']
    // Sent as one buffer with a fixed length, so no chunked framing.
    const headers: http.OutgoingHttpHeaders = { ...upstreamRes.headers }
    delete headers['transfer-encoding']
    const status = upstreamRes.statusCode ?? 200
    const passThrough = (): void => { done({ status, headers, body: raw, rotatedTo: null }) }

    let decoded: Buffer | null
    try {
      decoded = decodeBody(raw, encoding)
    } catch (err) {
      console.error(`[proxy] Failed to decode ${held.tool} token response body:`, (err as Error).message)
      passThrough()
      return
    }
    if (!decoded) {
      passThrough()
      return
    }
    const parsed = tryParseJsonBody(decoded) as TokenResponseBody | null
    if (!parsed || typeof parsed !== 'object' || typeof parsed.access_token !== 'string') {
      passThrough()
      return
    }
    const body = parsed as TokenResponseBody & { access_token: string }
    const rotation = rotationFrom(held, body)
    const fresh = (rotation.claude ?? rotation.codex)!
    captureRefreshed(rotation)
    console.log(`[proxy] Captured refreshed ${held.tool} OAuth tokens (expires in ${Math.floor((fresh.expiresAt - Date.now()) / 1000)}s)`)

    const rewrittenJson = Buffer.from(JSON.stringify(rewriteTokenResponseBody(body)), 'utf8')
    let out: Buffer
    try {
      out = encodeBody(rewrittenJson, encoding)
    } catch (err) {
      console.error(`[proxy] Failed to re-encode ${held.tool} token response body:`, (err as Error).message)
      out = rewrittenJson
      delete headers['content-encoding']
    }
    done({ status, headers, body: out, rotatedTo: fresh.refreshToken })
  })
}

/** Refreshes serialized per credential (see refresh-flight.ts). */
const refreshFlights = new RefreshFlights<TokenReply>(
  (reply) => reply.rotatedTo,
  () => errorReply(504, 'token refresh is taking too long upstream'),
)

// ── MITM Handler ───────────────────────────────────────────────────────

function handleMitm(
  clientSocket: Duplex,
  hostname: string,
  port: string | undefined,
  workspaceId: string | null,
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

    // An OAuth token-endpoint request: swap the real refresh token in on the
    // way out, then capture the rotation and swap placeholders back in.
    const tokenTool: RefreshTool | null = workspaceId === null ? null
      : hostname === CLAUDE_TOKEN_URL_HOST && reqPath === CLAUDE_TOKEN_URL_PATH ? 'claude'
        : hostname === OPENAI_TOKEN_URL_HOST && reqPath === OPENAI_TOKEN_URL_PATH ? 'codex'
          : null
    const heldAtArrival = tokenTool ? heldBundle(tokenTool) : null

    const dynamicRules = buildDynamicRules(workspaceId, hostname, req.headers)
    const projectSlug = workspaceId ? registrationOf(workspaceId)?.projectSlug : undefined
    const allRules: InjectionRule[] = [...resolveRegisteredRules(rules, projectSlug), ...dynamicRules]
    const injCount = applyInjections(headers, reqPath, allRules)
    const bodyInjections = collectBodyInjections(reqPath, allRules)

    // Same condition under which buildDynamicRules injects the git token.
    const gitCredInjected =
      workspaceId !== null && workspaceHasHttpsCredentialForHost(workspaceId, hostname)

    const totalInj = injCount + bodyInjections.length
    if (totalInj > 0) {
      const dynSuffix = dynamicRules.length > 0 ? ` + dynamic(${dynamicRules.length})` : ''
      console.log(`[proxy] MITM ${req.method} https://${hostname}${reqPath} (${injCount} header + ${bodyInjections.length} body injections${dynSuffix})`)
    }

    /** `refresh` set means this request is a mediated refresh of `held`:
     *  its response is collected for `done` instead of streamed to `res`. */
    function sendUpstream(
      body: Buffer | null,
      refresh: { held: HeldBundle; done: (reply: TokenReply) => void } | null,
    ): void {
      if (body !== null) {
        headers['content-length'] = String(body.length)
      }
      // A registered redirect (a test mock) is plain HTTP unless it says
      // otherwise. Tor refuses the loopback mocks, so skip it for them.
      const useHttp = upstreamRedirect !== null && upstreamRedirect.tls !== true
      const upstreamModule = useHttp ? http : https
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
        if (gitCredInjected && workspaceId !== null) {
          noteGitUpstreamStatus(workspaceId, hostname, reqPath, upstreamRes.statusCode ?? 0)
        }
        if (refresh) {
          collectTokenReply(upstreamRes, refresh.held, refresh.done)
        } else {
          res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
          upstreamRes.pipe(res)
        }
        upstreamRes.on('error', (err: Error) => {
          console.error('[proxy] Upstream response error for ' + hostname + reqPath + ':', err.message)
          if (refresh) {
            refresh.done(errorReply(502, err.message))
            return
          }
          if (!res.headersSent) res.writeHead(502)
          res.end(err.message)
        })
      })

      upstream.on('error', (err: Error) => {
        console.error(`[proxy] Upstream error for ${hostname}${reqPath}:`, err.message)
        if (refresh) {
          refresh.done(errorReply(502, err.message))
          return
        }
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' })
        }
        res.end(err.message)
      })
      // The destroy surfaces as the error above, releasing the flight.
      if (refresh) {
        upstream.setTimeout(TOKEN_REFRESH_HARD_TIMEOUT_MS, () => {
          upstream.destroy(new Error('token refresh timed out'))
        })
      }

      if (body !== null) {
        upstream.end(body)
      } else {
        req.pipe(upstream)
      }
    }

    // Buffer the body when a body rule or a token refresh needs to read it.
    if (bodyInjections.length > 0 || heldAtArrival) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const contentTypeHeader = headers['content-type']
        const contentType = typeof contentTypeHeader === 'string'
          ? contentTypeHeader
          : Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : undefined
        const inboundBody = Buffer.concat(chunks)

        // Only a request carrying the placeholder refresh token is one of our
        // refreshes. Anything else passes through untouched in both
        // directions, so we never spend the real token for an unknown sender
        // or store tokens from an unrelated exchange.
        if (tokenTool && heldAtArrival && bodyHasPlaceholderRefreshToken(inboundBody, contentType)) {
          // A flight may have rotated the credential while the body was read.
          const held = heldBundle(tokenTool) ?? heldAtArrival
          refreshFlights.run(tokenTool, held.bundle.refreshToken, () => new Promise<TokenReply>((done) => {
            const swap: BodyParamSwap = { name: 'refresh_token', value: held.bundle.refreshToken }
            sendUpstream(applyBodyInjections(inboundBody, contentType, [...bodyInjections, swap]), { held, done })
          })).then(
            (reply) => { writeTokenReply(res, reply) },
            (err: unknown) => { writeTokenReply(res, errorReply(502, String(err))) },
          )
          return
        }
        sendUpstream(applyBodyInjections(inboundBody, contentType, bodyInjections), null)
      })
    } else {
      sendUpstream(null, null)
    }
  })

  // WebSocket upgrades (e.g. Codex's responses websocket). Without this
  // handler Node stalls upgrades until a timeout. Headers get the same
  // injections as plain requests, then the sockets are piped raw.
  mitmServer.on('upgrade', (req: http.IncomingMessage, wsClientSocket: Duplex, head: Buffer) => {
    const reqPath = req.url ?? '/'
    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']

    const dynamicRules = buildDynamicRules(workspaceId, hostname, req.headers)
    const projectSlug = workspaceId ? registrationOf(workspaceId)?.projectSlug : undefined
    const allRules: InjectionRule[] = [...resolveRegisteredRules(rules, projectSlug), ...dynamicRules]
    const injCount = applyInjections(headers, reqPath, allRules)

    if (injCount > 0) {
      const dynSuffix = dynamicRules.length > 0 ? ` + dynamic(${dynamicRules.length})` : ''
      console.log(`[proxy] MITM UPGRADE wss://${hostname}${reqPath} (${injCount} header injections${dynSuffix})`)
    }

    // Redirects as in sendUpstream. Mocks do not speak WS, so the client
    // gets a plain response and falls back to HTTP.
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
      wsClientSocket.on('close', () => {
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

  // Tor refuses loopback and private upstreams, so internal destinations
  // go direct.
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
      clientSocket.on('close', () => { upstream.destroy() })
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

  clientSocket.on('close', () => {
    upstream.destroy()
  })
}

// ── Upstream Dispatch (shared by CONNECT + transparent listeners) ─────

/**
 * Check `hostname` against the workspace's allowlist and hand the socket to
 * the MITM or tunnel path. With `writeConnectOk` (a CONNECT tunnel) the
 * client gets an HTTP 200 or 403; a transparent TLS socket is destroyed when
 * blocked.
 *
 * MITM applies when the workspace has rules for the host, the proxy injects
 * credentials there, or a redirect is registered for it.
 */
function dispatchToUpstream(
  clientSocket: Duplex,
  hostname: string,
  port: string | undefined,
  workspaceId: string,
  opts: { writeConnectOk: boolean; head?: Buffer },
): void {
  // The client hung up during the workspace lookup.
  if (clientSocket.destroyed) return

  // Upstream connects asynchronously. Pause so bytes sent right after the 200
  // (the ClientHello) wait for the pipe instead of being dropped.
  clientSocket.pause()

  // yaac-mama is HTTP-only. Refuse other attempts without recording the
  // magic host as blocked.
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

  const admission = admissionFor(workspaceId, hostname)
  if (admission === null) {
    const label = opts.writeConnectOk ? 'CONNECT' : 'transparent HTTPS'
    console.log(`[proxy] BLOCKED ${label} to ${hostname}:${port ?? '443'} (not in allowlist)`)
    recordBlockedHost(workspaceId, hostname)
    if (opts.writeConnectOk) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.end()
    } else {
      clientSocket.destroy()
    }
    return
  }

  liveTunnels.add(workspaceId, clientSocket, hostname, admission)
  const rules = findRulesForHost(workspaceId, hostname)

  const destPort = parseInt(port ?? '', 10) || 443
  const needsDynMitm = hostNeedsDynamicMitm(workspaceId, hostname, destPort)

  const redirect: UpstreamRedirect | null =
    registrationOf(workspaceId)?.upstreamRedirects?.[hostname] ?? null

  if (opts.writeConnectOk) {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  }

  if (opts.head && opts.head.length > 0) {
    clientSocket.unshift(opts.head)
  }

  if (rules.length > 0 || needsDynMitm || redirect) {
    handleMitm(clientSocket, hostname, port, workspaceId, rules, redirect)
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
 * Open `GET /events` responses. The server normally holds one; a reconnect
 * can briefly overlap its predecessor.
 */
const eventSubscribers = new Set<http.ServerResponse>()

/** How often to write a ping, so a peer can detect a dead tunnel by read
 *  timeout rather than waiting on TCP. */
const EVENT_PING_MS = 15_000

/**
 * Tell every subscriber that `type` changed. The event carries no payload:
 * it only means "drain the queue now", so a dropped connection loses
 * nothing, because the server drains again on reconnect.
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
    // Not ready until the watched objects have loaded, or every workspace
    // would be refused for lack of a registration.
    if (IN_CLUSTER && !objects.ready()) {
      res.writeHead(503)
      res.end('objects not loaded')
      return
    }
    res.writeHead(200)
    res.end('ok')
    return
  }

  // Long-lived NDJSON stream that wakes the server for queued yaac-mama
  // requests, plus periodic pings.
  if (req.method === 'GET' && req.url === '/events') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    // Flush now so the subscriber knows it is attached.
    res.flushHeaders()
    eventSubscribers.add(res)
    const drop = (): void => { eventSubscribers.delete(res) }
    res.on('close', drop)
    res.on('error', drop)
    return
  }

  // yaac-mama: the server claims pending requests (at most once) when woken
  // by the `mama` event ...
  if (req.method === 'GET' && req.url === '/cmd/pending') {
    if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(mamaQueue.drain()))
    return
  }

  // ... and posts results back, completing the held workspace requests.
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
// Keys are loaded into the agent by agent-keys.ts and live only in its
// memory. Which workspaces may use each one is decided by the relay.

/** Read env the deployment always sets; throw if it is missing. */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`proxy: required env ${name} is not set`)
  return value
}

// HOME is a writable mount, since the proxy's uid need not own /home/node.
// ssh-add is given this path with -H (see agent-keys.ts).
const KNOWN_HOSTS_FILE = path.join(requireEnv('HOME'), '.ssh', 'known_hosts')

// Created by entrypoint.sh. Workspace pods reach it via SSH_AGENT_PORT.
const AGENT_SOCK = requireEnv('SSH_AUTH_SOCK')

const agentKeys = createAgentKeyLoader({ agentSock: AGENT_SOCK, knownHostsFile: KNOWN_HOSTS_FILE })

// ── Server ─────────────────────────────────────────────────────────────

ca = await loadOrGenerateCA()
if (IN_CLUSTER) {
  // Restore what the previous pod left: its observed state, and any token
  // rotation the server has not picked up yet.
  seedState(decodeState(await readOutputObject('configmap', STATE_CONFIGMAP_NAME)))
  objects.capture(decodeRefreshed(await readOutputObject('secret', REFRESHED_SECRET_NAME)))
}

// ── Plain-HTTP Forward ────────────────────────────────────────────────

/**
 * Forward a plain-HTTP request from the transparent HTTP listener. No
 * credentials are ever injected here, since they would travel unencrypted.
 */
function forwardPlainHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
  target: { hostname: string; port: number; path: string },
): void {
  const admission = admissionFor(workspaceId, target.hostname)
  if (admission === null) {
    console.log(`[proxy] BLOCKED HTTP forward to ${target.hostname} (not in allowlist)`)
    recordBlockedHost(workspaceId, target.hostname)
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end(`Blocked by URL allowlist: ${target.hostname} is not in the allowed hosts`)
    return
  }

  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  delete headers['proxy-connection']

  // Internal destinations skip Tor, as in handleTunnel.
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

  // Track both halves: the request body can still be streaming after an
  // early response closes. Either half cut short aborts the upstream.
  liveTunnels.add(workspaceId, req, target.hostname, admission)
  liveTunnels.add(workspaceId, res, target.hostname, admission)
  req.once('close', () => { if (!req.complete) upstream.destroy() })
  res.once('close', () => { if (!res.writableFinished) upstream.destroy() })
  req.pipe(upstream)
}

// ── Server ─────────────────────────────────────────────────────────────

// The control API. Workspace egress never reaches it; it arrives on the
// transparent listeners below.
const server = http.createServer((req, res) => {
  // Ask the server's undici pool to keep connections for 60s instead of 4s.
  res.setHeader('Keep-Alive', 'timeout=60')
  handleApiRequest(req, res)
})

// Longer than the client's pool timeout, so we never close a connection it
// still reuses. headersTimeout must exceed keepAliveTimeout.
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
// netd redirects workspace pods' outbound 443/80 and SSH tunnels to netd's
// Envoy, which forwards each connection here behind a PP2 header carrying
// the source pod IP. That IP identifies the workspace; the destination
// comes from the SNI or Host header. The listeners fail closed: a missing
// or invalid PP2 header, an unknown pod, or an SNI-less ClientHello drops
// the connection. See docs/workspace-egress.md.

/** Cap on bytes buffered while waiting for a parseable ClientHello. */
const SNI_PEEK_MAX_BYTES = 64 * 1024
/** How long to wait for the ClientHello before dropping the socket. */
const SNI_PEEK_TIMEOUT_MS = 10_000
/** Size cap and deadline for the PP2 header. */
const PP2_MAX_BYTES = 4 * 1024
const PP2_TIMEOUT_MS = 10_000

/**
 * Read the PP2 header on a new transparent socket, map its source pod IP to
 * a workspace, and pass the workspace id and remaining bytes to `next`. Any
 * failure destroys the socket.
 *
 * The source IP is trustworthy: Envoy takes it from the real peer address,
 * pods cannot spoof their source, and the proxy's ingress policy admits these
 * ports only from node CIDRs, so a pod cannot dial in with a forged header.
 */
function resolveWorkspaceBySourceIp(
  socket: net.Socket,
  label: string,
  next: (workspaceId: string, leftover: Buffer) => void,
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
    // Keep bytes that arrive during the async lookup.
    let leftover = buf.subarray(res.bytesConsumed)
    const buffer = (chunk2: Buffer): void => { leftover = Buffer.concat([leftover, chunk2]) }
    socket.on('data', buffer)
    void resolveWorkspace(srcIp).then((workspaceId) => {
      socket.removeListener('data', buffer)
      if (!workspaceId) {
        console.log(`[proxy] BLOCKED transparent ${label} from ${peer}: source ${srcIp} is not a known workspace pod`)
        socket.destroy()
        return
      }
      // Passed directly, not unshifted: each `next` unshifts once itself, and
      // a second unshift does not reliably reach a new 'data' listener.
      next(workspaceId, leftover)
    })
  }
  socket.on('data', onData)
}

/**
 * Read the SNI from the ClientHello without terminating TLS, then dispatch.
 * `initial` holds bytes already read after the PP2 header.
 */
function peekSniAndDispatch(socket: net.Socket, workspaceId: string, initial: Buffer): void {
  const peer = socket.remoteAddress ?? '(unknown)'
  let buf = initial
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    console.log(`[proxy] Transparent HTTPS from ${peer}: no ClientHello within ${SNI_PEEK_TIMEOUT_MS}ms`)
    socket.destroy()
  }, SNI_PEEK_TIMEOUT_MS)

  // True once settled (dispatched or destroyed).
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
    // Pause first, or the unshifted ClientHello is emitted before the MITM
    // TLSSocket or tunnel pipe is attached, and the handshake stalls.
    socket.pause()
    if (buf.length > 0) socket.unshift(buf)
    // Only port-443 traffic is redirected to this listener.
    dispatchToUpstream(socket, peek.serverName, '443', workspaceId, { writeConnectOk: false })
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
  resolveWorkspaceBySourceIp(socket, 'HTTPS', (workspaceId, leftover) =>
    peekSniAndDispatch(socket, workspaceId, leftover))
})

// The transparent HTTP listener hands sockets to an internal http.Server,
// carrying the resolved workspace id on the socket.
type IdentifiedSocket = net.Socket & { yaacWorkspaceId?: string }

// yaac-mama requests (see mama-queue.ts). A coarse sweep expires abandoned
// requests with a 504.
const mamaQueue = new MamaQueue()
setInterval(() => { mamaQueue.expire() }, 5_000).unref()

/**
 * Handle a yaac-mama `POST` from a workspace: validate the envelope, then
 * hold the response until the server posts the result or the sweep expires
 * it. Runs before the allowlist check, so it always works.
 */
function handleMamaRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
): void {
  const url = new URL(req.url ?? '/', `http://${MAMA_MAGIC_HOST}`)
  // For refusals before the request is queued.
  const respond = (status: number, body: string): void => {
    if (status === 404 || status === 405) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(body)
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(status === 200 ? JSON.stringify({ output: body }) : JSON.stringify({ error: body }))
  }
  if (url.pathname !== MAMA_PATH) { respond(404, 'Not found'); return }
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

    const parsed = parseMamaEnvelope(raw)
    if (!parsed) { respond(400, 'invalid request envelope'); return }
    const { command, args, body } = parsed

    const valid = validateMamaRequest(command, args, body)
    if (!valid.ok) { respond(valid.status, valid.error); return }
    let gone = false
    res.on('close', () => { gone = true })
    const enqueued = mamaQueue.enqueue(
      { workspaceId, command, args, body },
      // Already shaped by the queue, so written verbatim.
      (status, text) => {
        if (gone) return
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(text)
      },
    )
    if (!enqueued.ok) { respond(enqueued.status, enqueued.error); return }
    console.log(`[proxy] ${command} request from workspace ${workspaceId.slice(0, 8)}... queued (${enqueued.requestId.slice(0, 8)}...)`)
    emitProxyEvent('mama')
  })
}

const internalHttpServer = http.createServer((req, res) => {
  const socket = req.socket as IdentifiedSocket
  const workspaceId = socket.yaacWorkspaceId
  if (!workspaceId) {
    // Unreachable: sockets arrive here only with a resolved workspace.
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('No identity'); return
  }
  // Origin-form requests: the destination is in the Host header.
  const hostHeader = req.headers.host
  const target = hostHeader !== undefined ? splitHostHeader(hostHeader, 80) : null
  if (target === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Missing or malformed Host header')
    return
  }
  if (target.hostname === MAMA_MAGIC_HOST) {
    handleMamaRequest(req, res, workspaceId)
    return
  }
  forwardPlainHttp(req, res, workspaceId, {
    hostname: target.hostname,
    port: target.port,
    path: req.url ?? '/',
  })
})

const transparentHttpServer = net.createServer((socket) => {
  resolveWorkspaceBySourceIp(socket, 'HTTP', (workspaceId, leftover) => {
    ;(socket as IdentifiedSocket).yaacWorkspaceId = workspaceId
    if (leftover.length > 0) socket.unshift(leftover)
    internalHttpServer.emit('connection', socket)
  })
})

/** Size cap and deadline for the tunnel listener's CONNECT request. */
const CONNECT_MAX_BYTES = 8 * 1024
const CONNECT_TIMEOUT_MS = 10_000

/**
 * Read the `CONNECT host:port` that ssh's ncat proxy command sends, then
 * dispatch it like a CONNECT tunnel. The allowlist applies to that host.
 */
function readConnectAndDispatch(socket: net.Socket, workspaceId: string, initial: Buffer): void {
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
    // Normally empty, since ncat waits for the 200.
    const rest = buf.subarray(end + 4)
    dispatchToUpstream(socket, m[1], m[2], workspaceId, {
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
  resolveWorkspaceBySourceIp(socket, 'TUNNEL', (workspaceId, leftover) =>
    readConnectAndDispatch(socket, workspaceId, leftover))
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

// ── Stream relay (server to workspace streamd) ────────────────────────────
//
// The server sends one JSON auth line, `{token, workspaceId}`; the relay
// dials that workspace's pod at POD_STREAM_PORT and splices the rest of the
// stream through untouched. Per-stream failures get an `{ok:false}` line,
// since the server reads a silent close as a dead peer. Only a bad auth line
// closes silently. See docs/stream-relay.md.

const RELAY_HANDSHAKE_MAX_BYTES = 4 * 1024
/**
 * Deadline for everything before the splice: auth line, pod IP lookup, and
 * pod dial. A pod whose ingress policy does not yet admit the proxy drops the
 * SYN, and an unbounded dial would hang for minutes. Generous enough for an
 * apiserver lookup, but under the server's 15s dial deadline so the server
 * sees the refusal.
 */
const RELAY_PRESPLICE_TIMEOUT_MS = 6_000

function handleRelayConnection(socket: net.Socket, podStreamPort: number): void {
  socket.on('error', () => { /* per-connection; close tears down the splice */ })
  // Traffic is already batched at each end, so Nagle only adds delay.
  socket.setNoDelay(true)
  let buf = Buffer.alloc(0)
  // Until authenticated, a timeout closes silently.
  let authed = false
  // Idempotent: the deadline and a failed dial can both call it.
  function refuse(error: string): void {
    clearTimeout(deadline)
    if (socket.destroyed || socket.writableEnded) return
    socket.end(JSON.stringify({ ok: false, error: `relay: ${error}` }) + '\n')
  }
  const deadline = setTimeout(() => {
    if (authed) refuse('timed out resolving the workspace pod')
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

    let params: { token?: unknown; workspaceId?: unknown }
    try {
      params = JSON.parse(buf.subarray(0, nl).toString('utf8')) as typeof params
    } catch {
      clearTimeout(deadline)
      socket.destroy()
      return
    }
    const dialled = params.workspaceId
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
    const workspaceId = dialled

    // Buffer bytes (the pipelined streamd handshake) until the splice. The
    // socket is flowing, so data with no listener would be discarded.
    let leftover = buf.subarray(nl + 1)
    const buffer = (chunk2: Buffer): void => { leftover = Buffer.concat([leftover, chunk2]) }
    socket.on('data', buffer)
    void (async () => {
      let ip = podIndex.resolveIp(workspaceId)
      if (!ip) {
        try {
          ip = await fetchPodIpByWorkspaceId(podIndex, workspaceId)
        } catch (err) {
          console.error(`[proxy] relay pod lookup failed for ${workspaceId.slice(0, 8)}...:`, (err as Error).message)
        }
      }
      // A refusal only ends the socket, so check `writableEnded` too.
      if (socket.destroyed || socket.writableEnded) return
      if (!ip) {
        console.log(`[proxy] BLOCKED relay dial: unknown workspace ${workspaceId.slice(0, 8)}...`)
        refuse('unknown workspace')
        return
      }
      // allowHalfOpen lets an EOF from either end pass through the splice.
      const target = net.connect({ port: podStreamPort, host: ip, allowHalfOpen: true })
      target.setNoDelay(true)
      // The dial gets its own timeout on the target socket, the only handle
      // that can abort a hung connect. It lands in the error handler, so a
      // hung dial is refused like a failed one.
      clearTimeout(deadline)
      target.setTimeout(RELAY_PRESPLICE_TIMEOUT_MS, () => {
        target.destroy(Object.assign(new Error('pod dial timeout'), { code: 'ETIMEDOUT' }))
      })
      let spliced = false
      target.on('connect', () => {
        spliced = true
        target.setTimeout(0)
        socket.removeListener('data', buffer)
        if (leftover.length > 0) target.write(leftover)
        socket.pipe(target)
        target.pipe(socket)
      })
      target.on('error', (err: NodeJS.ErrnoException) => {
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

// ── ssh-agent forwarding (workspace pod to this pod's agent) ─────────────────
//
// A workspace pod's forwarder splices its SSH_AUTH_SOCK to this listener,
// which relays to the agent, exposing only the project's keys. See
// ssh-agent-relay.ts for the checks.

/** Key blobs the workspace's project may use, read live per message. */
function allowedKeysFor(workspaceId: string): Set<string> {
  const slug = registrationOf(workspaceId)?.projectSlug
  return (slug ? sshKeyBlobsByProject(objects.credentials.ssh).get(slug) : undefined) ?? new Set()
}
const sshAgentServer = SSH_AGENT_PORT
  ? createSshAgentServer({
    agentSock: AGENT_SOCK,
    resolveWorkspace,
    repoUrlFor: (workspaceId) => registrationOf(workspaceId)?.repoUrl,
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
// See dns-stub.ts. Internal names are resolved only with DNS_FORWARD_INTERNAL.
const dnsServer = DNS_STUB_PORT ? dgram.createSocket('udp4') : null
if (dnsServer && DNS_STUB_PORT) {
  dnsServer.on('message', (msg, rinfo) => {
    const query = parseDnsQuery(msg)
    if (!query) return
    const reply = (ip: string | null): void => {
      dnsServer.send(buildDnsResponse(query, ip), rinfo.port, rinfo.address)
    }
    if (!DNS_FORWARD_INTERNAL || !isInternalName(query.name)) {
      reply(DNS_SINKHOLE_IPV4)
      return
    }
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

// ── Watches (pods and input objects), in-cluster only ──────────────────────
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

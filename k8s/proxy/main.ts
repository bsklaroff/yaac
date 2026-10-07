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
 *
 * This module reads the environment and runs the listeners; what they do
 * with a connection lives in importable modules (mitm.ts, injection.ts,
 * oauth-swap.ts, observed-state.ts).
 */

import http from 'node:http'
import net from 'node:net'
import dgram from 'node:dgram'
import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import forge from 'node-forge'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { isInternalUpstream, peekClientHelloSni, splitHostHeader } from './transparent'
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
  type OwnerRefreshedBundles,
  type RefreshedBundles,
  type UpstreamRedirect,
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
import { SYSTEM_ROOTS_PATH, combineCaBundle } from './ca-bundle'
import { createSshAgentServer } from './ssh-agent-relay'
import { timingSafeStrEqual } from './secure-compare'
import { RefreshFlights } from './refresh-flight'
import { LiveTunnels } from './live-tunnels'
import { findRulesForHost, hostNeedsDynamicMitm, isHostAllowed } from './injection'
import { errorReply, type TokenReply } from './oauth-swap'
import { ObservedState } from './observed-state'
import { generateCA, handleMitm, handleTunnel, type CA, type MitmContext } from './mitm'

// Control API: the health probe. All input from the server arrives as
// objects (object-watch.ts).
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
// UDP/53 DNS stub (see dns-stub.ts) and ssh-agent relay
// (see ssh-agent-relay.ts) for workspace pods.
const DNS_STUB_PORT = process.env.DNS_STUB_PORT
const SSH_AGENT_PORT = process.env.SSH_AGENT_PORT
// The server's yaac-mama listener, which workspaces' calls are relayed to.
const MAMA_RELAY_URL = process.env.MAMA_RELAY_URL
if (!API_PORT || !PROXY_AUTH_SECRET || !TRANSPARENT_HTTPS_PORT || !TRANSPARENT_HTTP_PORT
  || !TRANSPARENT_TUNNEL_PORT || !RELAY_PORT || !POD_STREAM_PORT || !DNS_STUB_PORT || !SSH_AGENT_PORT
  || !MAMA_RELAY_URL) {
  console.error('[proxy] API_PORT, PROXY_AUTH_SECRET, TRANSPARENT_HTTPS_PORT, '
    + 'TRANSPARENT_HTTP_PORT, TRANSPARENT_TUNNEL_PORT, RELAY_PORT, POD_STREAM_PORT, '
    + 'DNS_STUB_PORT, SSH_AGENT_PORT and MAMA_RELAY_URL environment variables are required')
  process.exit(1)
}

/**
 * Hostname and path the in-workspace `yaac-mama` script POSTs to. It reaches
 * the transparent HTTP listener like any external name, and the proxy routes
 * on the Host header. Keep in sync with workspace-bin/yaac-mama.
 */
const MAMA_MAGIC_HOST = 'yaac.internal'
const MAMA_PATH = '/api/workspace/mama'
/**
 * Where a yaac-mama script from before the relay POSTs the same envelope.
 * Legacy compat: see docs/legacy-compat-shims.md.
 */
const LEGACY_MAMA_PATH = '/cmd'
/**
 * How long a relayed call may wait on the server before the caller gets a
 * 504. Under the script's `--max-time`, so that 504 is what the caller sees.
 */
const MAMA_RELAY_TIMEOUT_MS = 240_000
// Pod-local scratch (an emptyDir): Tor's state and its readiness marker.
const DATA_DIR = '/data'
// Answer for external names. The address is never dialed through; see
// dns-stub.ts.
const DNS_SINKHOLE_IPV4 = '198.18.0.1'

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
  if (workspaceId && !objects.registration(workspaceId)) {
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
const torAgent = USE_TOR ? new SocksProxyAgent('socks5h://127.0.0.1:9050') : null

// ── CA ─────────────────────────────────────────────────────────────────

/**
 * Load the CA from the `yaac-proxy-ca` Secret, minting it the first time so
 * later pods keep the same root. The combined trust bundle is rewritten every
 * time, since an image upgrade may change the system roots.
 */
async function loadOrGenerateCA(): Promise<CA> {
  const stored = decodeCa(await readOutputObject('secret', CA_SECRET_NAME))
  if (stored) console.log('[proxy] Loaded existing CA')
  const result = stored
    ? {
      key: forge.pki.privateKeyFromPem(stored.keyPem),
      cert: forge.pki.certificateFromPem(stored.certPem),
      pem: stored.certPem,
    }
    : generateCA()
  await writeCa(encodeCa({
    keyPem: forge.pki.privateKeyToPem(result.key),
    certPem: result.pem,
    bundlePem: combineCaBundle(fs.readFileSync(SYSTEM_ROOTS_PATH, 'utf8'), result.pem),
  }))
  console.log(`[proxy] CA saved to ${CA_SECRET_NAME}`)
  return result
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
    observed.pruneBlocked(workspaceId, registration && ((host) => isHostAllowed(objects, workspaceId, host)))
  },
})

const liveTunnels = new LiveTunnels()

/**
 * The rules and redirect a connection to `hostname` is accepted under, as a
 * comparable string, or null when the host is not allowed.
 */
function admissionFor(workspaceId: string, hostname: string): string | null {
  if (!isHostAllowed(objects, workspaceId, hostname)) return null
  return JSON.stringify([
    findRulesForHost(objects, workspaceId, hostname),
    objects.registration(workspaceId)?.upstreamRedirects?.[hostname] ?? null,
  ])
}

/**
 * Record a token rotation from a refresh in one of `owner`'s workspaces. It
 * is served from memory at once and written to that owner's slots in the
 * refreshed Secret, retrying until it lands. A single writer always sends
 * the newest capture, so the Secret can never end up holding an
 * already-spent refresh token.
 */
let unwrittenRefreshed: OwnerRefreshedBundles | null = null
let refreshedWriter: Promise<void> | null = null
function captureRefreshed(owner: string, bundles: RefreshedBundles): void {
  objects.capture(owner, bundles)
  unwrittenRefreshed = new Map(unwrittenRefreshed)
  unwrittenRefreshed.set(owner, { ...unwrittenRefreshed.get(owner), ...bundles })
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

// Blocked hosts and rejected git credentials, reported to the server.
const observed = new ObservedState((state) => writeState(encodeState(state)))

/** Refreshes serialized per credential (see refresh-flight.ts). */
const refreshFlights = new RefreshFlights<TokenReply>(
  (reply) => reply.rotatedTo,
  () => errorReply(504, 'token refresh is taking too long upstream'),
)

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
    observed.recordBlockedHost(workspaceId, hostname)
    if (opts.writeConnectOk) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.end()
    } else {
      clientSocket.destroy()
    }
    return
  }

  liveTunnels.add(workspaceId, clientSocket, hostname, admission)
  const rules = findRulesForHost(objects, workspaceId, hostname)

  const destPort = parseInt(port ?? '', 10) || 443
  const needsDynMitm = hostNeedsDynamicMitm(objects, workspaceId, hostname, destPort)

  const redirect: UpstreamRedirect | null =
    objects.registration(workspaceId)?.upstreamRedirects?.[hostname] ?? null

  if (opts.writeConnectOk) {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  }

  if (opts.head && opts.head.length > 0) {
    clientSocket.unshift(opts.head)
  }

  if (rules.length > 0 || needsDynMitm || redirect) {
    handleMitm(mitmContext, clientSocket, hostname, port, workspaceId, rules, redirect)
  } else {
    handleTunnel(clientSocket, hostname, port, USE_TOR)
  }
}

// ── API Request Handler ────────────────────────────────────────────────

function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === 'GET' && req.url === '/healthz') {
    if (USE_TOR && !fs.existsSync(path.join(DATA_DIR, 'tor-ready'))) {
      res.writeHead(503)
      res.end('tor not ready')
      return
    }
    // Not ready until the watched objects have loaded, or every workspace
    // would be refused for lack of a registration.
    if (!objects.ready()) {
      res.writeHead(503)
      res.end('objects not loaded')
      return
    }
    res.writeHead(200)
    res.end('ok')
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

const mitmContext: MitmContext = {
  ca: await loadOrGenerateCA(),
  objects,
  torAgent,
  refreshFlights,
  captureRefreshed,
  noteGitUpstreamStatus: (workspaceId, hostname, requestPath, status) => observed.noteGitUpstreamStatus(
    objects.registration(workspaceId)?.projectId, hostname, requestPath, status),
}
// Restore what the previous pod left: its observed state, and any token
// rotation the server has not picked up yet.
observed.seed(decodeState(await readOutputObject('configmap', STATE_CONFIGMAP_NAME)))
for (const [owner, bundles] of decodeRefreshed(await readOutputObject('secret', REFRESHED_SECRET_NAME))) {
  objects.capture(owner, bundles)
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
    observed.recordBlockedHost(workspaceId, target.hostname)
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
const server = http.createServer(handleApiRequest)

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

/**
 * Relay a yaac-mama call to the server's mama listener, naming the workspace
 * the source pod IP resolved to and authenticating as the proxy. Runs before
 * the allowlist check, so it always works.
 */
function relayMamaRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
): void {
  if (req.url !== MAMA_PATH && req.url !== LEGACY_MAMA_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end(`yaac-mama answers at http://${MAMA_MAGIC_HOST}${MAMA_PATH}`)
    return
  }
  const headers: http.OutgoingHttpHeaders = {
    'authorization': `Bearer ${PROXY_AUTH_SECRET}`,
    'x-yaac-workspace-id': workspaceId,
  }
  for (const name of ['content-type', 'content-length']) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name]
  }
  const upstream = http.request(MAMA_RELAY_URL!, { method: req.method, headers }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
    upstreamRes.pipe(res)
  })
  let timedOut = false
  upstream.setTimeout(MAMA_RELAY_TIMEOUT_MS, () => {
    timedOut = true
    upstream.destroy(new Error('timed out'))
  })
  upstream.on('error', (err: Error) => {
    console.error(`[proxy] yaac-mama relay for ${workspaceId.slice(0, 8)}... failed:`, err.message)
    if (!res.headersSent) res.writeHead(timedOut ? 504 : 502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: timedOut
        ? 'the yaac server took this request but never answered; it MAY have run, so check '
          + '`yaac-mama list` before retrying'
        : `cannot reach the yaac server: ${err.message}`,
    }))
  })
  req.pipe(upstream)
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
    relayMamaRequest(req, res, workspaceId)
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

const sshAgentServer = createSshAgentServer({
  agentSock: AGENT_SOCK,
  resolveWorkspace,
  repoUrlFor: (workspaceId) => objects.registration(workspaceId)?.repoUrl,
  // Read live per message.
  grantsFor: (workspaceId) => objects.sshGrants(workspaceId),
})
sshAgentServer.on('error', (err: Error) => {
  console.error('[proxy] ssh-agent server error:', err)
})
sshAgentServer.listen(parseInt(SSH_AGENT_PORT, 10), '0.0.0.0', () => {
  console.log(`[proxy] ssh-agent listener on port ${SSH_AGENT_PORT}`)
})

// ── DNS stub (UDP/53), split-horizon ───────────────────────────────────────
// See dns-stub.ts: internal names resolve against the cluster DNS, every
// other name gets the sinkhole address.
const dnsServer = dgram.createSocket('udp4')
dnsServer.on('message', (msg, rinfo) => {
  const query = parseDnsQuery(msg)
  if (!query) return
  const reply = (ip: string | null): void => {
    dnsServer.send(buildDnsResponse(query, ip), rinfo.port, rinfo.address)
  }
  if (!isInternalName(query.name)) {
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
  console.log(`[proxy] DNS stub listener on udp/${DNS_STUB_PORT}`)
})

// ── Watches (pods and input objects) ───────────────────────────────────────
try {
  startPodWatch(podIndex)
  startObjectWatch(objects)
} catch (err) {
  console.error('[proxy] watches failed to start:', (err as Error).message)
  process.exit(1)
}

process.on('SIGTERM', () => {
  console.log('[proxy] Shutting down...')
  transparentHttpsServer.close()
  transparentHttpServer.close()
  transparentTunnelServer.close()
  relayServer.close()
  sshAgentServer.close()
  dnsServer.close()
  server.close(() => process.exit(0))
})

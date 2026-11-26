/**
 * MITM egress proxy for workspace pods (see docs/workspace-egress.md).
 *
 * Stateless: its inputs arrive as Kubernetes objects it watches
 * (object-watch.ts) and its outputs are objects the server watches, so a
 * replaced pod restores itself from the informers' initial lists.
 *
 * - Serves the CA from the `yaac-proxy-ca` Secret, minting it the first time.
 * - Reads per-workspace rules and allowlists from registration ConfigMaps,
 *   secret values from per-project Secrets, and tool credentials plus git
 *   tokens and ssh keys from the credentials Secret. Changes apply on the
 *   next request.
 * - MITMs TLS when rules match a host, and tunnels it otherwise.
 * - Ends ssh sessions to a project's git hosts itself, logging in with the
 *   key of the repo each one names (ssh-session.ts).
 * - Refuses a non-public destination unless an exact allowlist entry names
 *   it, and every IPv6 destination (upstream.ts).
 * - Swaps placeholder tokens for real OAuth credentials and saves refreshed
 *   tokens to the `yaac-proxy-refreshed` Secret.
 * - Records blocked hosts and rejected git credentials in the
 *   `yaac-proxy-state` ConfigMap.
 *
 * This module reads the environment and runs the listeners; what they do
 * with a connection lives in importable modules (dispatch.ts, upstream.ts,
 * mitm.ts, injection.ts, repo-grants.ts, ssh-session.ts, oauth-swap.ts,
 * observed-state.ts).
 */

import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import forge from 'node-forge'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { peekClientHelloSni, splitHostHeader } from './transparent'
import {
  CA_SECRET_NAME,
  REFRESHED_SECRET_NAME,
  STATE_CONFIGMAP_NAME,
  decodeCa,
  decodeRefreshed,
  decodeSshHostKey,
  decodeState,
  encodeCa,
  encodeRefreshed,
  encodeState,
  type OwnerRefreshedBundles,
  type RefreshedBundles,
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
import { handleSocketIngress } from './socket-ingress'
import { inClusterClient } from './k8s-client'
import { MAIN_REGISTRY_NAMESPACE } from './upstream'
import { SYSTEM_ROOTS_PATH, combineCaBundle } from './ca-bundle'
import { RefreshFlights } from './refresh-flight'
import { LiveTunnels } from './live-tunnels'
import { admissionFor, isHostAllowed } from './injection'
import { errorReply, type TokenReply } from './oauth-swap'
import { ObservedState } from './observed-state'
import { generateCA, type CA } from './mitm'
import { generateSshHostKey } from './ssh-session'
import { dispatchToUpstream, forwardPlainHttp, type DispatchContext } from './dispatch'
import { MAMA_MAGIC_HOST, MAMA_PATH, relayHeaders, relayTarget } from './yaac-relay'

// Control API: the health probe. All input from the server arrives as
// objects (object-watch.ts).
const API_PORT = process.env.API_PORT
const PROXY_AUTH_SECRET = process.env.PROXY_AUTH_SECRET
// netd's relay carries every sandbox connection here (socket-ingress.ts).
const SOCKET_EGRESS_PORT = process.env.SOCKET_EGRESS_PORT
// The server's yaac-mama listener, which workspaces' calls are relayed to.
const MAMA_RELAY_URL = process.env.MAMA_RELAY_URL
if (!API_PORT || !PROXY_AUTH_SECRET || !SOCKET_EGRESS_PORT || !MAMA_RELAY_URL) {
  console.error('[proxy] API_PORT, PROXY_AUTH_SECRET, SOCKET_EGRESS_PORT and MAMA_RELAY_URL '
    + 'environment variables are required')
  process.exit(1)
}

/**
 * How long a relayed call may wait on the server before the caller gets a
 * 504. Under the script's `--max-time`, so that 504 is what the caller sees.
 */
const MAMA_RELAY_TIMEOUT_MS = 240_000
// Pod-local scratch (an emptyDir): Tor's state and its readiness marker.
const DATA_DIR = '/data'

// Whether an id is a build's or a site release's, from its registration.
const isBuild = (id: string): boolean => objects.registration(id)?.build === true
const isRelease = (id: string): boolean => objects.registration(id)?.release === true

// USE_TOR=1 routes every upstream connection through the Tor SOCKS listener
// entrypoint.sh starts. socks5h:// resolves DNS at the Tor exit, so lookups
// do not leak to the local resolver.
const USE_TOR = process.env.USE_TOR === '1'
const torAgent = USE_TOR ? new SocksProxyAgent('socks5h://127.0.0.1:9050') : null

// ── CA ─────────────────────────────────────────────────────────────────

/**
 * Load the CA and the ssh host key from the `yaac-proxy-ca` Secret, minting
 * each the first time so later pods keep the same root and the same host
 * key. The combined trust bundle is rewritten every time, since an image
 * upgrade may change the system roots.
 */
async function loadOrGenerateCA(): Promise<{ ca: CA; sshHostKey: string }> {
  const secret = await readOutputObject('secret', CA_SECRET_NAME)
  const stored = decodeCa(secret)
  const sshHostKey = decodeSshHostKey(secret) ?? generateSshHostKey()
  if (stored) console.log('[proxy] Loaded existing CA')
  const result = stored
    ? {
      key: crypto.createPrivateKey(stored.keyPem),
      cert: forge.pki.certificateFromPem(stored.certPem),
      pem: stored.certPem,
    }
    : generateCA()
  await writeCa(encodeCa({
    keyPem: result.key.export({ type: 'pkcs1', format: 'pem' }) as string,
    certPem: result.pem,
    bundlePem: combineCaBundle(fs.readFileSync(SYSTEM_ROOTS_PATH, 'utf8'), result.pem),
    sshHostKey,
  }))
  console.log(`[proxy] CA saved to ${CA_SECRET_NAME}`)
  return { ca: result, sshHostKey: sshHostKey.privateKey }
}

// ── Watched objects ──────────────────────────────────────────────────
//
// Credentials, project secrets and workspace registrations arrive through
// object-watch.ts and are read per request, so edits apply immediately.

const objects = new ProxyObjects({
  // Drop tunnels the new registration no longer admits, and clear
  // newly allowed hosts from the blocked record.
  onRegistration: (workspaceId, registration) => {
    const dropped = liveTunnels.revoke(workspaceId, registration && ((host) => admissionFor(objects, workspaceId, host)))
    if (dropped.length > 0) {
      console.log(`[proxy] dropped ${dropped.length} tunnel(s) of ${workspaceId.slice(0, 8)}... `
        + `the registration no longer admits: ${[...new Set(dropped)].join(', ')}`)
    }
    observed.pruneBlocked(workspaceId, registration && ((host) => isHostAllowed(objects, workspaceId, host)))
  },
})

const liveTunnels = new LiveTunnels()

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

// ── Server ─────────────────────────────────────────────────────────────

const dispatchContext: DispatchContext = {
  ...await loadOrGenerateCA(),
  objects,
  torAgent,
  refreshFlights,
  captureRefreshed,
  noteGitUpstreamStatus: (workspaceId, hostname, requestPath, status) => observed.noteGitUpstreamStatus(
    objects.registration(workspaceId)?.projectId, hostname, requestPath, status),
  liveTunnels,
  recordBlockedHost: (workspaceId, hostname) => observed.recordBlockedHost(workspaceId, hostname),
  isBuild,
  installNamespaces: [inClusterClient().namespace, MAIN_REGISTRY_NAMESPACE],
  lookup: (hostname) => dns.promises.lookup(hostname, { all: true, family: 4 }),
}
// Restore what the previous pod left: its observed state, and any token
// rotation the server has not picked up yet.
observed.seed(decodeState(await readOutputObject('configmap', STATE_CONFIGMAP_NAME)))
for (const [owner, bundles] of decodeRefreshed(await readOutputObject('secret', REFRESHED_SECRET_NAME))) {
  objects.capture(owner, bundles)
}

// ── Server ─────────────────────────────────────────────────────────────

// The control API. Sandbox egress never reaches it; it arrives on the
// socket ingress port below.
const server = http.createServer(handleApiRequest)

server.on('error', (err: Error) => {
  console.error('[proxy] Server error:', err)
})

server.listen(parseInt(API_PORT, 10), '0.0.0.0', () => {
  console.log(`[proxy] control API listening on port ${API_PORT}${USE_TOR ? ' (Tor: enabled)' : ''}`)
})

// ── Socket ingress ─────────────────────────────────────────────────────────
//
// netd's relay carries each sandbox connection to SOCKET_EGRESS_PORT behind
// a header naming the sandbox and the address it dialed (socket-ingress.ts).
// The handlers below fail closed: an SNI-less ClientHello, a malformed
// CONNECT or a missing Host header drops the connection or refuses the
// request. See docs/workspace-egress.md.

/** Cap on bytes buffered while waiting for a parseable ClientHello. */
const SNI_PEEK_MAX_BYTES = 64 * 1024
/** How long to wait for the ClientHello before dropping the socket. */
const SNI_PEEK_TIMEOUT_MS = 10_000

/**
 * Read the SNI from the ClientHello without terminating TLS, then dispatch.
 * `initial` holds bytes already read after the relay's header.
 */
function peekSniAndDispatch(socket: net.Socket, workspaceId: string, initial: Buffer): void {
  const peer = socket.remoteAddress ?? '(unknown)'
  let buf = initial
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    console.log(`[proxy] TLS from ${peer}: no ClientHello within ${SNI_PEEK_TIMEOUT_MS}ms`)
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
      console.log(`[proxy] BLOCKED TLS from ${peer}: no parseable SNI`)
      socket.destroy()
      return true
    }
    // Pause first, or the unshifted ClientHello is emitted before the MITM
    // TLSSocket or tunnel pipe is attached, and the handshake stalls.
    socket.pause()
    if (buf.length > 0) socket.unshift(buf)
    // Only connections to port 443 come here (socket-ingress.ts).
    void dispatchToUpstream(dispatchContext, socket, peek.serverName, '443', workspaceId, { writeConnectOk: false })
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

// Plain-HTTP connections go to an internal http.Server, carrying the
// sandbox's id on the socket.
type IdentifiedSocket = net.Socket & { yaacWorkspaceId?: string }

/**
 * Relay a workspace's call to `yaac.internal` (yaac-mama, or a hosted git
 * remote) to the server's mama listener, naming the workspace the relay's
 * header did and authenticating as the proxy. Runs before the allowlist
 * check, so it always works.
 */
function relayMamaRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
): void {
  // A public site's release faces the internet, so it never reaches the
  // server at all (docs/public-sites.md); the server refuses it too. Nor
  // does an image build, whose RUN steps are no workspace.
  if (isRelease(workspaceId) || isBuild(workspaceId)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end(isBuild(workspaceId)
      ? 'an image build may not call yaac'
      : 'a public site\'s release may not call yaac')
    return
  }
  const target = relayTarget(req.url ?? '/', MAMA_RELAY_URL!)
  if (target === null) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end(`yaac-mama answers at http://${MAMA_MAGIC_HOST}${MAMA_PATH}`)
    return
  }
  const headers = relayHeaders(req.headers, workspaceId, PROXY_AUTH_SECRET!)
  const upstream = http.request(target, { method: req.method, headers }, (upstreamRes) => {
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

// No cap on a request's total time, so a long upload (a push to a hosted
// remote, docs/hosted-projects.md) is not cut at Node's five-minute default.
const internalHttpServer = http.createServer({ requestTimeout: 0 }, (req, res) => {
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
  void forwardPlainHttp(dispatchContext, req, res, workspaceId, {
    hostname: target.hostname,
    port: target.port,
    path: req.url ?? '/',
  })
})

/** Size cap and deadline for the tunnel listener's CONNECT request. */
const CONNECT_MAX_BYTES = 8 * 1024
const CONNECT_TIMEOUT_MS = 10_000

/**
 * Read the `CONNECT host:port` that ssh's ncat proxy command sends, then
 * dispatch it like a CONNECT tunnel. The allowlist applies to that host,
 * and an ssh session to a host the project has an ssh repo on ends here
 * (dispatch.ts).
 */
function readConnectAndDispatch(socket: net.Socket, workspaceId: string, initial: Buffer): void {
  const peer = socket.remoteAddress ?? '(unknown)'
  let buf = initial
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    console.log(`[proxy] TUNNEL from ${peer}: no CONNECT within ${CONNECT_TIMEOUT_MS}ms`)
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
      console.log(`[proxy] BLOCKED TUNNEL from ${peer}: bad CONNECT line`)
      socket.destroy()
      return true
    }
    // Normally empty, since ncat waits for the 200.
    const rest = buf.subarray(end + 4)
    void dispatchToUpstream(dispatchContext, socket, m[1], m[2], workspaceId, {
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

const socketIngressServer = net.createServer((socket) => handleSocketIngress(socket, {
  secret: PROXY_AUTH_SECRET,
  registered: async (id) => {
    if (objects.registration(id)) return true
    try {
      return (await fetchRegistration(objects, id)) !== undefined
    } catch (err) {
      console.error(`[proxy] registration lookup failed for ${id.slice(0, 8)}...:`, (err as Error).message)
      return false
    }
  },
  handlers: {
    tls: (s, id, leftover) => peekSniAndDispatch(s, id, leftover),
    tunnel: (s, id, leftover) => readConnectAndDispatch(s, id, leftover),
    http: (s, id, leftover) => {
      ;(s as IdentifiedSocket).yaacWorkspaceId = id
      if (leftover.length > 0) s.unshift(leftover)
      internalHttpServer.emit('connection', s)
    },
  },
}))
socketIngressServer.on('error', (err: Error) => {
  console.error('[proxy] socket ingress server error:', err)
})
socketIngressServer.listen(parseInt(SOCKET_EGRESS_PORT, 10), '0.0.0.0', () => {
  console.log(`[proxy] socket ingress listener on port ${SOCKET_EGRESS_PORT}`)
})

// ── Watches (input objects) ────────────────────────────────────────────────
try {
  startObjectWatch(objects)
} catch (err) {
  console.error('[proxy] watches failed to start:', (err as Error).message)
  process.exit(1)
}

process.on('SIGTERM', () => {
  console.log('[proxy] Shutting down...')
  socketIngressServer.close()
  server.close(() => process.exit(0))
})

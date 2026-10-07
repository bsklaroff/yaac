/**
 * The two ways a workspace's TLS connection leaves the proxy: MITM'd, when
 * the proxy injects credentials into it or redirects it, or tunneled
 * untouched (docs/workspace-egress.md). The proxy's CA signs a leaf
 * certificate per MITM'd host.
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import type { Duplex } from 'node:stream'
import forge from 'node-forge'
import { SocksClient } from 'socks'
import type { ProxyObjects } from './object-watch'
import type { HostInjectionRule, RefreshedBundles, UpstreamRedirect } from './objects'
import type { RefreshFlights } from './refresh-flight'
import { isInternalUpstream } from './transparent'
import {
  CLAUDE_TOKEN_URL_HOST,
  CLAUDE_TOKEN_URL_PATH,
  OPENAI_TOKEN_URL_HOST,
  OPENAI_TOKEN_URL_PATH,
  applyBodyInjections,
  applyInjections,
  bodyHasPlaceholderRefreshToken,
  buildDynamicRules,
  collectBodyInjections,
  resolveRegisteredRules,
  workspaceHasHttpsCredentialForHost,
  type BodyParamSwap,
} from './injection'
import {
  collectTokenReply,
  errorReply,
  heldBundle,
  writeTokenReply,
  type HeldBundle,
  type RefreshTool,
  type TokenReply,
} from './oauth-swap'

/** What a MITM'd connection reads and reports through. */
export interface MitmContext {
  ca: CA
  objects: ProxyObjects
  /** Routes upstream dials through Tor; null dials direct. */
  torAgent: http.Agent | null
  /** Refreshes serialized per credential (see refresh-flight.ts). */
  refreshFlights: RefreshFlights<TokenReply>
  /** Record a rotation captured from a workspace of `owner`. */
  captureRefreshed: (owner: string, bundles: RefreshedBundles) => void
  noteGitUpstreamStatus: (workspaceId: string, hostname: string, requestPath: string, status: number) => void
}

export type CA = {
  key: forge.pki.rsa.PrivateKey
  cert: forge.pki.Certificate
  pem: string
}

type LeafEntry = { key: string; cert: string; expires: number }

const leafCache = new Map<string, LeafEntry>()

const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000
const LEAF_REFRESH_MS = 60 * 60 * 1000

// How long a refresh may sit idle upstream before it is abandoned. Callers
// are answered much sooner (refresh-flight.ts); this only stops a dead
// upstream from holding the flight open forever.
const TOKEN_REFRESH_HARD_TIMEOUT_MS = 5 * 60_000

// Tor's SOCKS listener (entrypoint.sh). Its first circuit to a destination
// can take longer than the `socks` library's 30s default.
const TOR_PROXY = { host: '127.0.0.1', port: 9050, type: 5 as const }
const TOR_TUNNEL_TIMEOUT_MS = 120_000

/** A random positive 128-bit serial, so no two certs share an issuer+serial
 *  pair, which NSS rejects. */
function randomSerial(): string {
  const bytes = crypto.randomBytes(16)
  bytes[0] &= 0x7f // positive
  return bytes.toString('hex')
}

export function generateCA(): CA {
  const keys = forge.pki.rsa.generateKeyPair(2048)
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

/** A leaf certificate for `hostname` signed by `ca`, cached until near
 *  expiry. */
function leafCert(ca: CA, hostname: string): { key: string; cert: string } {
  const cached = leafCache.get(hostname)
  const now = Date.now()
  if (cached && (cached.expires - LEAF_REFRESH_MS) > now) {
    return { key: cached.key, cert: cached.cert }
  }

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

export function handleMitm(
  ctx: MitmContext,
  clientSocket: Duplex,
  hostname: string,
  port: string | undefined,
  workspaceId: string,
  rules: HostInjectionRule[],
  upstreamRedirect: UpstreamRedirect | null,
): void {
  const { ca, objects } = ctx
  const leaf = leafCert(ca, hostname)

  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: leaf.key,
    cert: leaf.cert + ca.pem,
  })

  /**
   * The outbound headers for a request, with every header injection applied,
   * and the body injections its rules hold (applied once the body is read).
   * An upgrade carries no body, so `withBody` false leaves those out.
   */
  function prepare(req: http.IncomingMessage, label: string, withBody: boolean): {
    path: string
    headers: http.OutgoingHttpHeaders
    bodyInjections: BodyParamSwap[]
  } {
    const reqPath = req.url ?? '/'
    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const dynamicRules = buildDynamicRules(objects, workspaceId, hostname, req.headers)
    const projectId = objects.registration(workspaceId)?.projectId
    const allRules = [...resolveRegisteredRules(objects, rules, projectId), ...dynamicRules]
    const headerCount = applyInjections(headers, reqPath, allRules)
    const bodyInjections = withBody ? collectBodyInjections(reqPath, allRules) : []
    if (headerCount + bodyInjections.length > 0) {
      const dynSuffix = dynamicRules.length > 0 ? ` + dynamic(${dynamicRules.length})` : ''
      console.log(`[proxy] MITM ${label}${hostname}${reqPath} `
        + `(${headerCount} header + ${bodyInjections.length} body injections${dynSuffix})`)
    }
    return { path: reqPath, headers, bodyInjections }
  }

  // A registered redirect (a test mock) is plain HTTP unless it says
  // otherwise. Tor refuses the loopback mocks, so skip it for them.
  const useHttp = upstreamRedirect !== null && upstreamRedirect.tls !== true
  function openUpstream(
    req: http.IncomingMessage,
    reqPath: string,
    headers: http.OutgoingHttpHeaders,
  ): http.ClientRequest {
    return (useHttp ? http : https).request({
      hostname: upstreamRedirect?.host ?? hostname,
      port: upstreamRedirect?.port ?? (parseInt(port ?? '', 10) || 443),
      path: reqPath,
      method: req.method,
      headers,
      ...(ctx.torAgent !== null && upstreamRedirect === null ? { agent: ctx.torAgent } : {}),
    })
  }

  const mitmServer = http.createServer((req, res) => {
    const { path: reqPath, headers, bodyInjections } = prepare(req, `${req.method} https://`, true)

    // An OAuth token-endpoint request: swap the real refresh token in on the
    // way out, then capture the rotation and swap placeholders back in.
    const tokenTool: RefreshTool | null =
      hostname === CLAUDE_TOKEN_URL_HOST && reqPath === CLAUDE_TOKEN_URL_PATH ? 'claude'
        : hostname === OPENAI_TOKEN_URL_HOST && reqPath === OPENAI_TOKEN_URL_PATH ? 'codex'
          : null
    // The credential a refresh spends is the workspace owner's, and its
    // rotation is captured back to that owner only.
    const owner = objects.ownerOf(workspaceId)
    const heldAtArrival = tokenTool && owner !== undefined ? heldBundle(objects, owner, tokenTool) : null

    // Same condition under which buildDynamicRules injects the git token.
    const gitCredInjected = workspaceHasHttpsCredentialForHost(objects, workspaceId, hostname)

    /** `refresh` set means this request is a mediated refresh of `held`:
     *  its response is collected for `done` instead of streamed to `res`. */
    function sendUpstream(
      body: Buffer | null,
      refresh: { owner: string; held: HeldBundle; done: (reply: TokenReply) => void } | null,
    ): void {
      if (body !== null) {
        headers['content-length'] = String(body.length)
      }
      const fail = (err: Error): void => {
        if (refresh) {
          refresh.done(errorReply(502, err.message))
          return
        }
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' })
        res.end(err.message)
      }
      const upstream = openUpstream(req, reqPath, headers)
      upstream.on('response', (upstreamRes) => {
        if (gitCredInjected) {
          ctx.noteGitUpstreamStatus(workspaceId, hostname, reqPath, upstreamRes.statusCode ?? 0)
        }
        if (refresh) {
          collectTokenReply(upstreamRes, refresh.held, (b) => { ctx.captureRefreshed(refresh.owner, b) }, refresh.done)
        } else {
          res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
          upstreamRes.pipe(res)
        }
        upstreamRes.on('error', (err: Error) => {
          console.error(`[proxy] Upstream response error for ${hostname}${reqPath}:`, err.message)
          fail(err)
        })
      })
      upstream.on('error', (err: Error) => {
        console.error(`[proxy] Upstream error for ${hostname}${reqPath}:`, err.message)
        fail(err)
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
    if (bodyInjections.length === 0 && !heldAtArrival) {
      sendUpstream(null, null)
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const contentTypeHeader = headers['content-type']
      const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader
        : Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : undefined
      const inboundBody = Buffer.concat(chunks)

      // Only a request carrying the placeholder refresh token is one of our
      // refreshes. Anything else passes through untouched in both
      // directions, so we never spend the real token for an unknown sender
      // or store tokens from an unrelated exchange.
      if (tokenTool && owner !== undefined && heldAtArrival
        && bodyHasPlaceholderRefreshToken(inboundBody, contentType)) {
        // A flight may have rotated the credential while the body was read.
        const held = heldBundle(objects, owner, tokenTool) ?? heldAtArrival
        const flight = `${owner}/${tokenTool}`
        ctx.refreshFlights.run(flight, held.bundle.refreshToken, () => new Promise<TokenReply>((done) => {
          const swap: BodyParamSwap = { name: 'refresh_token', value: held.bundle.refreshToken }
          sendUpstream(applyBodyInjections(inboundBody, contentType, [...bodyInjections, swap]), { owner, held, done })
        })).then(
          (reply) => { writeTokenReply(res, reply) },
          (err: unknown) => { writeTokenReply(res, errorReply(502, String(err))) },
        )
        return
      }
      sendUpstream(applyBodyInjections(inboundBody, contentType, bodyInjections), null)
    })
  })

  // WebSocket upgrades (e.g. Codex's responses websocket). Without this
  // handler Node stalls upgrades until a timeout. Headers get the same
  // injections as plain requests, then the sockets are piped raw. Mocks do
  // not speak WS, so behind a redirect the client gets a plain response and
  // falls back to HTTP.
  mitmServer.on('upgrade', (req: http.IncomingMessage, wsClientSocket: Duplex, head: Buffer) => {
    const { path: reqPath, headers } = prepare(req, 'UPGRADE wss://', false)
    const upstreamReq = openUpstream(req, reqPath, headers)

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      wsClientSocket.write(responseHead(upstreamRes))
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
      wsClientSocket.write(responseHead(upstreamRes))
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

/** An upstream response's status line and headers, as raw HTTP/1.1. */
function responseHead(res: http.IncomingMessage): string {
  const lines = [`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}`]
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`)
  }
  return lines.join('\r\n') + '\r\n\r\n'
}

export function handleTunnel(clientSocket: Duplex, hostname: string, port: string | undefined, useTor: boolean): void {
  const destPort = parseInt(port ?? '', 10) || 443
  const splice = (upstream: net.Socket): void => {
    upstream.on('error', (err: Error) => {
      console.error(`[proxy] Tunnel error for ${hostname}:`, err.message)
      clientSocket.end()
    })
    clientSocket.on('close', () => { upstream.destroy() })
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  }

  // Tor refuses loopback and private upstreams, so internal destinations
  // go direct.
  if (!useTor || isInternalUpstream(hostname)) {
    splice(net.connect(destPort, hostname))
    return
  }
  void SocksClient.createConnection({
    proxy: TOR_PROXY,
    command: 'connect',
    destination: { host: hostname, port: destPort },
    timeout: TOR_TUNNEL_TIMEOUT_MS,
  }, (err, info) => {
    if (err || !info) {
      console.error(`[proxy] Tor tunnel error for ${hostname}:`, err?.message ?? 'no socket')
      clientSocket.end()
      return
    }
    splice(info.socket)
  })
}

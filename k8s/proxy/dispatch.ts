/**
 * Where a workspace's connection goes once the transparent listeners know
 * its workspace and destination: checked against the allowlist and the
 * non-public guard (upstream.ts), then MITM'd, tunneled, or (plain HTTP)
 * forwarded. Every upstream dial a workspace can steer passes through here.
 */

import http from 'node:http'
import type { LookupAddress } from 'node:dns'
import type { Duplex } from 'node:stream'
import { admissionFor, findRulesForHost, hostNeedsDynamicMitm, isHostNamedExactly } from './injection'
import type { LiveTunnels } from './live-tunnels'
import { handleMitm, handleTunnel, type MitmContext } from './mitm'
import {
  UpstreamRefused,
  dialOptions,
  failFastIfNonPublic,
  isInternalUpstream,
  resolveUpstream,
  upstreamHost,
  type DirectUpstream,
} from './upstream'
import { MAMA_MAGIC_HOST, MAMA_PATH } from './yaac-relay'

export interface DispatchContext extends MitmContext {
  liveTunnels: LiveTunnels
  recordBlockedHost: (workspaceId: string, hostname: string) => void
  /** Every IPv4 address of a name (dns.lookup); stubbed by tests. */
  lookup: (hostname: string) => Promise<LookupAddress[]>
}

/**
 * The checked addresses for a direct dial to `hostname`, or null for one
 * Tor carries: Tor resolves at the exit, off the cluster's network, and
 * resolving here would leak the name to the local resolver.
 */
function directUpstream(ctx: DispatchContext, workspaceId: string, hostname: string): Promise<DirectUpstream | null> {
  if (ctx.torAgent !== null && !isInternalUpstream(hostname)) return Promise.resolve(null)
  return resolveUpstream(hostname, isHostNamedExactly(ctx.objects, workspaceId, hostname), ctx.lookup)
}

const STATUS_TEXT: Record<number, string> = { 403: 'Forbidden', 502: 'Bad Gateway' }

/**
 * Check `requested` against the workspace's allowlist and the guard, and
 * hand the socket to the MITM or tunnel path. With `writeConnectOk` (a
 * CONNECT tunnel) the client gets an HTTP 200, or a 403 or 502 with the
 * reason; a refused transparent TLS socket is destroyed. A tunnel's 200
 * waits for upstream to connect, so a dial that fails is answered too.
 *
 * MITM applies when the workspace has rules for the host, the proxy injects
 * credentials there, or a redirect is registered for it. A redirect's
 * target is named by the server, not the workspace, so it is not checked.
 */
export async function dispatchToUpstream(
  ctx: DispatchContext,
  clientSocket: Duplex,
  requested: string,
  port: string | undefined,
  workspaceId: string,
  opts: { writeConnectOk: boolean; head?: Buffer },
): Promise<void> {
  // The client hung up during the workspace lookup.
  if (clientSocket.destroyed) return

  // Upstream connects asynchronously. Pause so bytes sent right after the 200
  // (the ClientHello) wait for the pipe instead of being dropped.
  clientSocket.pause()

  const label = opts.writeConnectOk ? 'CONNECT' : 'transparent HTTPS'
  const refuse = (status: number, reason: string): void => {
    if (opts.writeConnectOk) {
      clientSocket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Type: text/plain\r\n\r\n${reason}\n`)
    } else {
      clientSocket.destroy()
    }
  }

  let hostname: string
  try {
    hostname = upstreamHost(requested)
  } catch (err) {
    console.log(`[proxy] REFUSED ${label} to ${requested}: ${(err as Error).message}`)
    refuse(403, (err as Error).message)
    return
  }

  // yaac-mama is HTTP-only. Refuse other attempts without recording the
  // magic host as blocked.
  if (hostname === MAMA_MAGIC_HOST) {
    console.log(`[proxy] yaac magic host dialed on ${label} — use http://${MAMA_MAGIC_HOST}${MAMA_PATH}`)
    refuse(403, `use http://${MAMA_MAGIC_HOST}${MAMA_PATH}`)
    return
  }

  const admission = admissionFor(ctx.objects, workspaceId, hostname)
  if (admission === null) {
    console.log(`[proxy] BLOCKED ${label} to ${hostname}:${port ?? '443'} (not in allowlist)`)
    ctx.recordBlockedHost(workspaceId, hostname)
    refuse(403, `${hostname} is not in the allowed hosts`)
    return
  }
  // Tracked before the lookup, so a registration change meanwhile drops it.
  ctx.liveTunnels.add(workspaceId, clientSocket, hostname, admission)

  const redirect = ctx.objects.registration(workspaceId)?.upstreamRedirects?.[hostname] ?? null
  let direct: DirectUpstream | null = null
  if (redirect === null) {
    try {
      direct = await directUpstream(ctx, workspaceId, hostname)
    } catch (err) {
      const reason = (err as Error).message
      console.log(`[proxy] REFUSED ${label} to ${hostname}:${port ?? '443'}: ${reason}`)
      refuse(err instanceof UpstreamRefused ? 403 : 502, reason)
      return
    }
    if (clientSocket.destroyed) return
  }

  const rules = findRulesForHost(ctx.objects, workspaceId, hostname)
  const destPort = parseInt(port ?? '', 10) || 443
  const needsDynMitm = hostNeedsDynamicMitm(ctx.objects, workspaceId, hostname, destPort)

  const mitm = rules.length > 0 || needsDynMitm || redirect !== null
  if (mitm && opts.writeConnectOk) {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  }

  if (opts.head && opts.head.length > 0) {
    clientSocket.unshift(opts.head)
  }

  if (mitm) {
    handleMitm(ctx, clientSocket, hostname, port, workspaceId, rules, redirect, direct)
  } else {
    handleTunnel(clientSocket, hostname, port, direct, opts.writeConnectOk)
  }
}

/**
 * Forward a plain-HTTP request from the transparent HTTP listener. No
 * credentials are ever injected here, since they would travel unencrypted.
 */
export async function forwardPlainHttp(
  ctx: DispatchContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaceId: string,
  target: { hostname: string; port: number; path: string },
): Promise<void> {
  const refuse = (status: number, reason: string): void => {
    console.log(`[proxy] REFUSED HTTP forward to ${target.hostname}: ${reason}`)
    res.writeHead(status, { 'Content-Type': 'text/plain' })
    res.end(reason)
  }
  let hostname: string
  try {
    hostname = upstreamHost(target.hostname)
  } catch (err) {
    refuse(403, (err as Error).message)
    return
  }
  const admission = admissionFor(ctx.objects, workspaceId, hostname)
  if (admission === null) {
    console.log(`[proxy] BLOCKED HTTP forward to ${hostname} (not in allowlist)`)
    ctx.recordBlockedHost(workspaceId, hostname)
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end(`Blocked by URL allowlist: ${hostname} is not in the allowed hosts`)
    return
  }
  // Track both halves: the request body can still be streaming after an
  // early response closes. Tracked before the lookup, so a registration
  // change meanwhile drops them.
  ctx.liveTunnels.add(workspaceId, req, hostname, admission)
  ctx.liveTunnels.add(workspaceId, res, hostname, admission)

  let direct: DirectUpstream | null
  try {
    direct = await directUpstream(ctx, workspaceId, hostname)
  } catch (err) {
    refuse(err instanceof UpstreamRefused ? 403 : 502, (err as Error).message)
    return
  }
  // The client hung up, or a registration change dropped it, meanwhile.
  if (req.destroyed || res.destroyed) return

  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  delete headers['proxy-connection']

  const upstream = http.request({
    hostname,
    port: target.port,
    path: target.path,
    method: req.method,
    headers,
    ...(direct !== null ? dialOptions(direct) : { agent: ctx.torAgent ?? undefined }),
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
    upstreamRes.pipe(res)
  })
  if (direct !== null) upstream.once('socket', (socket) => failFastIfNonPublic(socket, hostname, direct))

  upstream.on('error', (err: Error) => {
    console.error(`[proxy] HTTP forward error for ${hostname}${target.path}:`, err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
    }
    res.end(err.message)
  })

  // Either half cut short aborts the upstream.
  req.once('close', () => { if (!req.complete) upstream.destroy() })
  res.once('close', () => { if (!res.writableFinished) upstream.destroy() })
  req.pipe(upstream)
}

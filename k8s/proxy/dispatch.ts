/**
 * Where a workspace's connection goes once the socket ingress handlers know
 * its workspace and destination: checked against the allowlist and the
 * non-public guard (upstream.ts), then MITM'd, tunneled, ended here as an
 * ssh session, or (plain HTTP) forwarded. Every upstream dial a workspace
 * can steer passes through here.
 */

import http from 'node:http'
import net from 'node:net'
import type { LookupAddress } from 'node:dns'
import type { Duplex } from 'node:stream'
import { admissionFor, findRulesForHost, hostNeedsDynamicMitm, isHostNamedExactly } from './injection'
import type { LiveTunnels } from './live-tunnels'
import type { UpstreamRedirect } from './objects'
import { dialUpstream, handleMitm, handleTunnel, type MitmContext } from './mitm'
import { hasSshGrantOnHost, sshAccessAt } from './repo-grants'
import { serveSshSession } from './ssh-session'
import {
  UpstreamRefused,
  dialOptions,
  failFastIfNonPublic,
  isInstallServiceName,
  isInternalUpstream,
  resolveUpstream,
  upstreamHost,
  type DirectUpstream,
} from './upstream'
import { MAMA_MAGIC_HOST, MAMA_PATH } from './yaac-relay'

export interface DispatchContext extends MitmContext {
  liveTunnels: LiveTunnels
  recordBlockedHost: (workspaceId: string, hostname: string) => void
  /** Whether an id is an image build's. */
  isBuild: (id: string) => boolean
  /** The namespaces whose Services only `clusterServices` reaches: the
   *  install's own and the main registry's (`isInstallServiceName`). */
  installNamespaces: string[]
  /** Every IPv4 address of a name (dns.lookup); stubbed by tests. */
  lookup: (hostname: string) => Promise<LookupAddress[]>
  /** The proxy's private ssh host key (ssh-session.ts). */
  sshHostKey: string
}

/**
 * The checked addresses for a direct dial to `hostname`, or null for
 * one Tor carries: Tor resolves at the exit, off the cluster's network,
 * and resolving here would leak the name to the local resolver.
 */
function directUpstream(
  ctx: DispatchContext, workspaceId: string, hostname: string, port: number,
): Promise<DirectUpstream | null> {
  if (isInstallServiceName(hostname, ctx.installNamespaces)) {
    return Promise.reject(new UpstreamRefused(`${hostname} names one of the install's own services, `
      + 'which a workspace reaches only where the server hands it one'))
  }
  if (ctx.torAgent !== null && !isInternalUpstream(hostname)) return Promise.resolve(null)
  return resolveUpstream(hostname, port, isHostNamedExactly(ctx.objects, workspaceId, hostname), ctx.lookup)
}

const STATUS_TEXT: Record<number, string> = { 403: 'Forbidden', 502: 'Bad Gateway' }

const SSH_PORT = 22

/** Dial a registered redirect's target, which the server named. */
function dialRedirect(redirect: UpstreamRedirect): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(redirect.port, redirect.host)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socket)
    })
  })
}

/**
 * Check `requested` against the workspace's allowlist and the guard, and
 * hand the socket to the MITM or tunnel path. With `writeConnectOk` (a
 * CONNECT tunnel) the client gets an HTTP 200, or a 403 or 502 with the
 * reason; a refused TLS socket is destroyed. A tunnel's 200
 * waits for upstream to connect, so a dial that fails is answered too.
 *
 * MITM applies when the workspace has rules for the host, the proxy injects
 * credentials there, or a redirect is registered for it. A redirect's
 * target is named by the server, not the workspace, so it is not checked.
 *
 * A connection to the ssh port of a host the workspace's project has an ssh
 * repo on is neither: the proxy ends the ssh session itself and logs in to
 * the host, or to a redirect registered for it, with that repo's key
 * (ssh-session.ts).
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

  const label = opts.writeConnectOk ? 'CONNECT' : 'TLS'
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

  const admitted = admissionFor(ctx.objects, workspaceId, hostname)
  if (admitted === null) {
    console.log(`[proxy] BLOCKED ${label} to ${hostname}:${port ?? '443'} (not in allowlist)`)
    ctx.recordBlockedHost(workspaceId, hostname)
    refuse(403, `${hostname} is not in the allowed hosts`)
    return
  }
  // Tracked before the lookup, so a registration change meanwhile drops it.
  ctx.liveTunnels.add(workspaceId, clientSocket, hostname, admitted)

  // A build gets the project's allowlist and nothing more: every host is a
  // plain tunnel, so no credential is injected and nothing needs the proxy
  // CA inside its RUN steps (docs/image-builds.md "Build egress").
  const build = ctx.isBuild(workspaceId)

  const destPort = parseInt(port ?? '', 10) || 443
  const redirect = build ? null : ctx.objects.registration(workspaceId)?.upstreamRedirects?.[hostname] ?? null
  let direct: DirectUpstream | null = null
  if (redirect === null) {
    try {
      direct = await directUpstream(ctx, workspaceId, hostname, destPort)
    } catch (err) {
      const reason = (err as Error).message
      console.log(`[proxy] REFUSED ${label} to ${hostname}:${port ?? '443'}: ${reason}`)
      refuse(err instanceof UpstreamRefused ? 403 : 502, reason)
      return
    }
    if (clientSocket.destroyed) return
  }

  if (!build && destPort === SSH_PORT && hasSshGrantOnHost(ctx.objects, workspaceId, hostname)) {
    if (opts.writeConnectOk) clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (opts.head && opts.head.length > 0) clientSocket.unshift(opts.head)
    serveSshSession({
      client: clientSocket,
      hostKey: ctx.sshHostKey,
      hostname,
      accessAt: (repoPath) => sshAccessAt(ctx.objects, workspaceId, hostname, repoPath),
      dial: () => (redirect !== null ? dialRedirect(redirect) : dialUpstream(hostname, SSH_PORT, direct)),
    })
    return
  }

  const rules = build ? [] : findRulesForHost(ctx.objects, workspaceId, hostname)
  const needsDynMitm = !build && hostNeedsDynamicMitm(ctx.objects, workspaceId, hostname, destPort)

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
 * Forward a plain-HTTP request. No credentials are ever injected here, since
 * they would travel unencrypted. A destination in the registration's
 * `clusterServices` was named by the server, so it skips the allowlist and
 * the guard.
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
  if (ctx.objects.registration(workspaceId)?.clusterServices?.includes(`${hostname}:${String(target.port)}`)) {
    forward(req, res, hostname, target, {})
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
    direct = await directUpstream(ctx, workspaceId, hostname, target.port)
  } catch (err) {
    refuse(err instanceof UpstreamRefused ? 403 : 502, (err as Error).message)
    return
  }
  // The client hung up, or a registration change dropped it, meanwhile.
  if (req.destroyed || res.destroyed) return
  forward(req, res, hostname, target,
    direct !== null ? dialOptions(direct) : { agent: ctx.torAgent ?? undefined }, direct)
}

/**
 * Send `req` on to `hostname`, with `dial` choosing how the connection is
 * made, and relay the answer. `direct`, when given, is the guard's checked
 * dial, whose non-public connect fails fast.
 */
function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hostname: string,
  target: { port: number; path: string },
  dial: Pick<http.RequestOptions, 'lookup' | 'agent'>,
  direct: DirectUpstream | null = null,
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  delete headers['proxy-connection']

  const upstream = http.request({
    hostname,
    port: target.port,
    path: target.path,
    method: req.method,
    headers,
    ...dial,
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

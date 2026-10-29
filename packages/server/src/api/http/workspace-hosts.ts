import type { Server } from 'node:http'
import type net from 'node:net'
import { answerAndClose, readRequestHead } from '@yaac/shared/port-tunnel'
import { parseWorkspaceHost } from '@yaac/shared/workspace-hosts'
import { workspaceDriver } from '#drivers/driver'
import { cameThroughServe } from '#api/http/web-auth'
import type { AccessMode } from '@yaac/shared/types'

/**
 * Workspace hostnames on the server's own listener
 * (docs/workspace-hostnames.md). Each new connection's first request head
 * is read before the HTTP server sees it: one whose `Host` names a
 * workspace port (`<port>.<id8>.localhost`) is spliced to that port through
 * `dialPort`, byte for byte, so keep-alive, WebSocket upgrades and HMR need
 * no proxying; any other goes on to the HTTP server untouched. A workspace
 * name never reaches the API, whatever happens to it here.
 *
 * Only a `local` install's own machine is served: that caller is the owner
 * of every workspace, and could reach the ports anyway (the workspace's own
 * listeners under containerless, a forwarder under k8s). Anyone else needs
 * the identified tunnel (`/forward/attach`), which a remote client's
 * forwarder routes these names into.
 */
export function routeWorkspaceHosts(
  server: Server,
  access: () => AccessMode | { refused: string } | undefined,
): void {
  const handlers = server.listeners('connection') as Array<(socket: net.Socket) => void>
  server.removeAllListeners('connection')
  server.on('connection', (socket: net.Socket) => {
    void readRequestHead(socket).then((header) => {
      if (!header) return
      const name = parseWorkspaceHost(header('host') ?? '')
      if (name) {
        void splice(socket, name, access() === 'local' && !cameThroughServe(header))
        return
      }
      for (const handle of handlers) handle.call(server, socket)
      socket.resume()
    })
  })
}

async function splice(
  socket: net.Socket,
  { port, idPrefix }: { port: number; idPrefix: string },
  admitted: boolean,
): Promise<void> {
  if (!admitted) {
    answerAndClose(socket, 403, 'workspace hostnames are served only on the machine of a local install; '
      + 'from anywhere else, `yaac forward` or the desktop app routes them (docs/workspace-hostnames.md)')
    return
  }
  const driver = workspaceDriver()
  const matches = (await driver.list())
    .filter((w) => w.running && !w.prewarmed && w.workspaceId.startsWith(idPrefix))
  if (matches.length !== 1) {
    answerAndClose(socket, 404, matches.length === 0
      ? `no running workspace ${idPrefix} on this server`
      : `${idPrefix} names more than one workspace`)
    return
  }
  let upstream
  try {
    upstream = await driver.dialPort(matches[0].workspaceId, port)
  } catch (err) {
    answerAndClose(socket, 502, `workspace ${idPrefix} port ${String(port)}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  if (socket.destroyed) {
    upstream.on('error', () => { /* nothing reads it */ })
    upstream.destroy()
    return
  }
  // No half-close: either side ending closes both, as the tunnel does.
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.pipe(socket)
  socket.pipe(upstream)
}

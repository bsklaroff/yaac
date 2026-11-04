/**
 * Workspace hostnames (docs/workspace-hostnames.md): `<port>.<id8>.localhost`
 * names one port of one workspace. Every `*.localhost` name resolves to
 * loopback, so a router on this machine's loopback reaches it: the server's
 * own listener when it runs here, else a remote client's forwarder at
 * `WORKSPACE_HOSTS_PORT`. Pure, so the webapp can build the links too.
 *
 * The workspace is its own label so that it is the registrable domain: a
 * workspace's ports are same-site with each other and cross-site with every
 * other workspace and with the yaac server.
 */

/** Where a remote client's forwarder routes the names, just below the
 *  server's default port range. */
export const WORKSPACE_HOSTS_PORT = 8786

/** How much of the workspace id a name carries. */
const ID_PREFIX_LENGTH = 8

/** A workspace name in a `Host` header, port optional. */
const HOST = /^(\d{1,5})\.([0-9a-f]{8})\.localhost\.?(?::\d{1,5})?$/

export function workspaceHostname(workspaceId: string, port: number): string {
  return `${String(port)}.${workspaceId.slice(0, ID_PREFIX_LENGTH)}.localhost`
}

/** The URL of a workspace port, routed at `routerPort` on this machine. */
export function workspaceHostUrl(workspaceId: string, port: number, routerPort: number): string {
  return `http://${workspaceHostname(workspaceId, port)}:${String(routerPort)}/`
}

/** The workspace port a `Host` header names, or null if it names none. */
export function parseWorkspaceHost(host: string): { port: number; idPrefix: string } | null {
  const match = HOST.exec(host.toLowerCase())
  if (!match) return null
  const port = Number(match[1])
  return port >= 1 && port <= 65535 ? { port, idPrefix: match[2] } : null
}

/**
 * Whether `host` names a port of workspace `workspaceId`. A yaac server
 * running inside that workspace is what such a name reaches when the
 * workspace's dev server is yaac itself, so that server takes the name as
 * addressed to it (docs/workspace-hostnames.md). Its Host check admits the
 * name on the strength of browsers resolving it to loopback themselves, so
 * the absolute form with a trailing dot, the one a browser is most likely
 * to hand to the system resolver, is not this workspace's name
 * (docs/remote-hosting.md "Security model").
 */
export function namesWorkspace(host: string, workspaceId: string | undefined): boolean {
  return workspaceId !== undefined
    && !host.split(':')[0].endsWith('.')
    && parseWorkspaceHost(host)?.idPrefix === workspaceId.slice(0, ID_PREFIX_LENGTH).toLowerCase()
}

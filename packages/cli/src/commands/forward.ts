import { api } from '#commands/api'
import { resolveServerTarget } from '@yaac/shared/server-api'
import { startEventsMonitor } from '@yaac/shared/events'
import { createForwardSet, serverNeedsForwarder, snapshotForwards } from '@yaac/shared/port-tunnel-set'
import type { DriverKind } from '@yaac/shared/types'
import type { ForwardSpec } from '@yaac/shared/port-tunnel'

/**
 * `yaac forward`: bind the workspace ports the server offers on this machine
 * and tunnel each connection back over `/forward/attach`, so the web app's
 * `127.0.0.1:<port>` links work. The server cannot bind them itself: under
 * `k8s` it is a pod, and a remote server is on another machine. The desktop
 * app does the same from its tray; this is for headless machines. See
 * docs/port-forward-tunnel.md.
 *
 * The server's offer is followed over `/events`, so ports that come and go
 * while this runs are picked up.
 */

export interface ForwardOptions {
  /**
   * `container` or `container:host`, repeatable. Replaces what the server
   * offers: for a port it does not know about, or a different local port.
   */
  port?: string[]
  /** What to bind. Loopback unless you mean to serve the network. */
  bind?: string
}

/** Parse `-p 3000` / `-p 3000:13000` into a spec for `session`. */
function parsePortOption(raw: string, session: string): ForwardSpec {
  const [containerRaw, hostRaw] = raw.split(':')
  const containerPort = Number(containerRaw)
  const hostPort = hostRaw === undefined ? containerPort : Number(hostRaw)
  for (const [what, value] of [['container', containerPort], ['host', hostPort]] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`--port ${raw}: ${what} port must be an integer between 1 and 65535`)
    }
  }
  return { session, containerPort, hostPort }
}

/**
 * Refuse to forward against a containerless server on this machine. Its
 * workspaces already bind the host ports themselves, so every bind here
 * would either fail against the dev server or steal the port from one that
 * has not started yet (see `serverNeedsForwarder`).
 *
 * An explicit `--bind` skips the check: it is for publishing the ports on
 * another interface of the server's own host. The driver comes from the
 * auth-exempt `/health` route; if that request fails, the check is skipped
 * and the next API call reports the error.
 */
async function refuseLocalContainerlessForward(baseUrl: string, bind: string | undefined): Promise<void> {
  if (bind !== undefined) return
  let driver: DriverKind | undefined
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return
    driver = (await res.json() as { driver?: DriverKind | null }).driver ?? undefined
  } catch {
    return
  }
  if (driver === undefined || serverNeedsForwarder(driver, baseUrl)) return
  throw new Error(
    'this server runs the containerless driver on this machine, where a '
    + 'workspace\'s processes bind the host ports themselves — the ports are '
    + 'already reachable here and there is nothing to tunnel.\n'
    + '    `yaac workspace list` shows what each one is listening on; from '
    + 'another machine `yaac forward` tunnels them, and `--bind <addr>` '
    + 'publishes them on another interface of this one '
    + '(docs/port-forward-tunnel.md).',
  )
}

export async function forward(
  session: string | undefined,
  options: ForwardOptions = {},
): Promise<void> {
  if (options.port?.length && session === undefined) {
    throw new Error('--port names a session\'s port, so a session has to be named too')
  }
  const target = await resolveServerTarget()
  // Checked before resolving the session, so a bad id against a local
  // containerless server gets this error rather than "session not found".
  await refuseLocalContainerlessForward(target.baseUrl, options.bind)
  // Resolved by the server so prefixes and names work, and an unknown
  // session fails now instead of forwarding nothing forever.
  const workspaceId = session === undefined
    ? undefined
    : (await api.workspace[':id'].$get({ param: { id: session } })).workspaceId
  const explicit = options.port?.length
    ? options.port.map((raw) => parsePortOption(raw, workspaceId ?? ''))
    : undefined

  const set = createForwardSet(
    { baseUrl: target.baseUrl },
    {
      bindHost: options.bind,
      onChange: (spec, state) => {
        const arrow = `${options.bind ?? '127.0.0.1'}:${spec.hostPort} -> ${spec.session.slice(0, 8)}:${spec.containerPort}`
        console.log(state === 'up' ? `forwarding ${arrow}` : `dropped ${arrow}`)
      },
      onBindError: (spec, message) => {
        console.error(`cannot bind port ${spec.hostPort}: ${message}`)
      },
      onConnectionError: (message) => {
        console.error(`connection failed: ${message}`)
      },
    },
  )

  // Explicit ports are bound once and never re-read; the server may not
  // know about a port whose dev server has not started yet.
  if (explicit) {
    await set.reconcile(explicit)
    if (set.live().length === 0) {
      set.close()
      throw new Error('no port could be bound')
    }
  }

  let stop = (): void => { /* replaced below */ }
  const done = new Promise<void>((resolve) => {
    stop = () => {
      set.close()
      resolve()
    }
  })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  if (!explicit) {
    // A dropped connection reconnects and keeps the live forwards meanwhile.
    const events = startEventsMonitor({
      resolveTarget: () => Promise.resolve(target),
      onSnapshot: (snapshot) => void set.reconcile(snapshotForwards(snapshot, workspaceId)),
    })
    void done.then(() => events.stop())
  }

  console.log('Forwarding. Press Ctrl-C to stop.')
  await done
}

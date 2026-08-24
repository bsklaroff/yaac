import { api } from '#commands/api'
import { resolveServerTarget } from '@yaac/shared/server-api'
import { createForwardSet } from '@yaac/shared/port-tunnel-set'
import type { ForwardSpec } from '@yaac/shared/port-tunnel'

/**
 * `yaac forward` — hold the listeners the server cannot.
 *
 * A worktree's ports are offered by the server (`forwardedPorts` on the
 * worktree list) but bound by a client: under `k8s` the server is a pod,
 * so a port it bound would be on the pod's loopback and reachable from
 * nowhere the user is. This command is that client — it binds what the
 * server says is on offer and tunnels each connection back over
 * `/forward/attach`, which makes the webapp's `127.0.0.1:<port>` links
 * true for as long as it runs. The desktop app does the same thing
 * resident in its tray; this is the one you run on a headless box.
 *
 * It follows the server rather than snapshotting it: a session created,
 * stopped, or granted a new port while this runs is picked up on the next
 * poll. Polling rather than `/events` because the CLI has no other reason
 * to hold that stream open, and a few seconds' latency on a port coming up
 * is invisible next to the dev server that has to boot behind it.
 */

export interface ForwardOptions {
  /** `container` or `container:host`, repeatable. Overrides what the
   *  server offers — for a port it does not know about, or one you want
   *  on a different local port. */
  port?: string[]
  /** What to bind. Loopback unless you mean to serve the network. */
  bind?: string
}

const POLL_MS = 3_000

/** Parse `-p 3000` / `-p 3000:13000` into a spec for `session`. */
export function parsePortOption(raw: string, session: string): ForwardSpec {
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

/** What the server currently offers, as specs — every running session's,
 *  or one session's when `only` names a resolved worktree id. */
async function offeredForwards(only: string | undefined): Promise<ForwardSpec[]> {
  const { worktrees } = await api.worktree.list.$get({ query: {} })
  const specs: ForwardSpec[] = []
  for (const w of worktrees) {
    if (only !== undefined && w.worktreeId !== only) continue
    for (const { containerPort, hostPort } of w.forwardedPorts) {
      specs.push({ session: w.worktreeId, containerPort, hostPort })
    }
  }
  return specs
}

/**
 * Refuse to forward against a containerless server.
 *
 * There is nothing to forward there and no way to do it: a workspace's own
 * processes bind the host ports, so what the server offers is the identity
 * mapping over ports something is ALREADY listening on. Binding them fails
 * on this machine (the dev server holds them) and, against a remote
 * containerless server, succeeds only to have every tunnelled connection
 * die — that driver's `dialPort` is a refusal. Left alone it is a retry
 * loop printing a bind error every poll, forever.
 *
 * `/health` is auth-exempt and already reports the driver, which is what
 * makes this one request rather than a new mechanism. A server that does
 * not answer, or answers without the field, is left alone: an unreachable
 * server is the next call's error to report, not this one's.
 */
async function refuseContainerlessForward(baseUrl: string): Promise<void> {
  let driver: string | undefined
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return
    driver = (await res.json() as { driver?: string | null }).driver ?? undefined
  } catch {
    return
  }
  if (driver !== 'containerless') return
  throw new Error(
    'this install runs the containerless driver, where a worktree\'s processes '
    + 'bind the host ports themselves — the ports are already reachable and '
    + 'there is nothing to tunnel.\n'
    + '    `yaac worktree list` shows what each one is listening on '
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
  // Before the session is resolved: whether this install can be forwarded
  // at all is a fact about the SERVER, and naming a live session would not
  // change the answer. Asking about the session first would answer a
  // containerless install with "session not found" for a bad id — the
  // wrong objection to the wrong thing.
  await refuseContainerlessForward(target.baseUrl)
  // Resolved once, server-side, so an id prefix or a name means here what
  // it means everywhere else — and so a session that does not exist is an
  // error now rather than an empty forward set that never fills.
  const worktreeId = session === undefined
    ? undefined
    : (await api.worktree[':id'].$get({ param: { id: session } })).worktreeId
  const explicit = options.port?.length
    ? options.port.map((raw) => parsePortOption(raw, worktreeId ?? ''))
    : undefined

  const set = createForwardSet(
    { baseUrl: target.baseUrl, secret: target.secret },
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

  // An explicit set is exactly what was asked for and never re-read: the
  // user named these ports, so a server that has not heard of one is not a
  // reason to stop offering it (a dev server that has not booted yet is
  // the ordinary case).
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
    const poll = async (): Promise<void> => {
      try {
        await set.reconcile(await offeredForwards(worktreeId))
      } catch (err) {
        // A server that blinked is not a reason to drop live forwards —
        // the next tick re-reads it.
        console.error(`cannot read the session list: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    void done.then(() => clearInterval(timer))
  }

  console.log('Forwarding. Press Ctrl-C to stop.')
  await done
}

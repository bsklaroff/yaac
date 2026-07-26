/**
 * Reading Envoy's own view of its listeners, over the admin unix socket.
 *
 * This is the gate between "netd wrote a config file" and "packets may be
 * pointed at it". A successful atomic rename is not an acknowledgement:
 * Envoy still has to parse the document and BIND the sockets, and a bind
 * can fail — most plausibly because a coexisting install's Envoy already
 * holds the trio. Without this check netd would install DNAT rules aiming
 * at a port its Envoy never got, and (worse) report Ready while doing it.
 *
 * Two signals from one `/config_dump`, and it matters which does what:
 *
 *  - `ListenersConfigDump.version_info` — the version of the LDS document
 *    Envoy last APPLIED. This is the acknowledgement: it tracks the file,
 *    so seeing our own version here proves Envoy read and accepted exactly
 *    what netd wrote.
 *  - `dynamic_listeners[].active_state.listener.address` — the ports
 *    actually bound, which is what a DNAT rule needs to be true.
 *
 * A per-listener `active_state.version_info` is deliberately NOT the
 * acknowledgement, and this is the subtle part: Envoy updates filter
 * chains IN PLACE, and an in-place update does not restamp the listener's
 * version — it keeps the version the listener was created at, forever.
 * Gating on it therefore passes exactly once (when the listeners are
 * first created) and then times out on every subsequent pod change, which
 * presents as netd going NotReady while the datapath keeps working.
 * Verified against Envoy 1.34: adding a source prefix to a filter chain
 * moved `ListenersConfigDump.version_info` and left every listener's
 * `active_state.version_info` untouched.
 *
 * `error_state` is still read per listener: a rejected update reports the
 * version it failed at, which turns a bind collision into a specific log
 * line instead of a timeout.
 *
 * Parsing is pure and separately tested; the socket call and the retry
 * loop take their I/O as parameters.
 */

import http from 'node:http'

/** One dynamic listener as Envoy reports it. */
export interface ListenerState {
  name: string
  /** Ports the active config binds. */
  ports: number[]
  /** version_info of the last REJECTED update, if any. */
  errorVersion: string | null
  errorDetails: string | null
}

/** What `/config_dump` says about the listener subsystem. */
export interface EnvoyListenerView {
  /** version_info of the LDS document Envoy last applied, if any. */
  appliedVersion: string | null
  listeners: ListenerState[]
}

interface RawSocketAddress { port_value?: number }
interface RawListener { address?: { socket_address?: RawSocketAddress } }
interface RawDynamicListener {
  name?: string
  active_state?: { listener?: RawListener }
  error_state?: { version_info?: string; details?: string }
}
interface RawListenersDump {
  '@type'?: string
  version_info?: string
  dynamic_listeners?: RawDynamicListener[]
}

/**
 * Parse a `/config_dump` body. Anything unrecognized is dropped rather
 * than guessed at: the gate's job is to WITHHOLD readiness on doubt, so a
 * dump it cannot read must look like "not ready yet".
 */
export function parseListenerView(body: string): EnvoyListenerView {
  const empty: EnvoyListenerView = { appliedVersion: null, listeners: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return empty
  }
  const configs = (parsed as { configs?: unknown[] })?.configs
  if (!Array.isArray(configs)) return empty
  const dump = (configs as RawListenersDump[])
    .find((config) => (config?.['@type'] ?? '').includes('ListenersConfigDump'))
  if (!dump) return empty

  const listeners: ListenerState[] = []
  for (const raw of dump.dynamic_listeners ?? []) {
    if (!raw?.name) continue
    const port = raw.active_state?.listener?.address?.socket_address?.port_value
    listeners.push({
      name: raw.name,
      ports: typeof port === 'number' ? [port] : [],
      errorVersion: raw.error_state?.version_info ?? null,
      errorDetails: raw.error_state?.details ?? null,
    })
  }
  return { appliedVersion: dump.version_info ?? null, listeners }
}

export interface ExpectedListeners {
  names: string[]
  /** The version_info netd stamped on the document it just wrote. */
  version: string
  /** Ports the trio must be bound on. */
  ports: number[]
}

export interface GateStatus {
  ready: boolean
  /** Expected listeners Envoy has explicitly REJECTED at this version. */
  rejected: string[]
  /** Why the gate is not ready yet, for the timeout message. */
  pending: string[]
}

/**
 * Compare what Envoy reports against what netd wrote.
 *
 * Ready needs both halves: Envoy applied THIS document version, and every
 * expected listener is bound on a trio port. The version alone would pass
 * while a listener sits unbound; the ports alone would pass on a stale
 * config that still happens to hold the sockets.
 *
 * A listener carrying an `error_state` at this version can never become
 * ready, and that distinction is what lets the caller fail fast on a bind
 * collision instead of burning the whole timeout.
 */
export function listenerGateStatus(
  view: EnvoyListenerView,
  expected: ExpectedListeners,
): GateStatus {
  const byName = new Map(view.listeners.map((state) => [state.name, state]))
  const rejected = expected.names.filter((name) => byName.get(name)?.errorVersion === expected.version)
  if (rejected.length > 0) return { ready: false, rejected, pending: [] }

  const pending: string[] = []
  if (view.appliedVersion !== expected.version) {
    pending.push(`lds version ${view.appliedVersion ?? 'none'} != ${expected.version}`)
  }
  for (const name of expected.names) {
    const state = byName.get(name)
    if (!state) pending.push(`${name} absent`)
    else if (!state.ports.some((port) => expected.ports.includes(port))) {
      pending.push(`${name} not bound on ${expected.ports.join('/')}`)
    }
  }
  return { ready: pending.length === 0, rejected: [], pending }
}

/** Envoy rejected the config outright — the trio is unusable as chosen. */
export class ListenerRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ListenerRejectedError'
  }
}

/** Envoy has not acknowledged in time; it may still be starting. */
export class ListenerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ListenerTimeoutError'
  }
}

export interface WaitForListenersDeps {
  expected: ExpectedListeners
  /** Fetch the config dump; a rejection reads as "not up yet". */
  dump: () => Promise<string>
  sleep: (ms: number) => Promise<void>
  attempts: number
  pollMs: number
}

/**
 * Block until Envoy is serving `expected`, or explain why it never will.
 *
 * Throws rather than returning a status: every caller treats a
 * non-acknowledged listener as a failed reconcile (no DNAT rules, no
 * readiness marker), so a thrown error keeps that decision in one place.
 */
export async function waitForListeners(deps: WaitForListenersDeps): Promise<void> {
  if (deps.expected.names.length === 0) return
  let status: GateStatus = { ready: false, rejected: [], pending: ['not yet polled'] }
  for (let attempt = 0; attempt < deps.attempts; attempt++) {
    if (attempt > 0) await deps.sleep(deps.pollMs)
    const view = parseListenerView(await deps.dump().catch(() => ''))
    status = listenerGateStatus(view, deps.expected)
    if (status.ready) return
    if (status.rejected.length > 0) {
      const details = view.listeners
        .filter((state) => status.rejected.includes(state.name) && state.errorDetails)
        .map((state) => `${state.name}: ${state.errorDetails!}`)
        .join('; ')
      throw new ListenerRejectedError(
        `Envoy rejected ${status.rejected.length} listener(s) — ${details || 'no details'}`,
      )
    }
  }
  throw new ListenerTimeoutError(
    `Envoy did not acknowledge config ${deps.expected.version} within `
    + `${deps.attempts * deps.pollMs}ms (${status.pending.join('; ')})`,
  )
}

/** GET a path from Envoy's admin unix socket. */
export function adminGet(socketPath: string, urlPath: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => { resolve(body) })
    })
    req.on('timeout', () => { req.destroy(new Error(`admin ${urlPath} timed out`)) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * The whole dump, not `?resource=dynamic_listeners`: the filtered form
 * returns the listener entries WITHOUT the enclosing ListenersConfigDump,
 * which is where the applied LDS version lives.
 */
export const CONFIG_DUMP_PATH = '/config_dump'

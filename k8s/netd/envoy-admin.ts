/**
 * Checks, via Envoy's admin unix socket, that Envoy has applied the config
 * netd wrote and bound its listeners, before netd points DNAT rules at
 * them. Writing the file is not enough: Envoy may fail to bind, e.g. when
 * another install's Envoy holds the same ports.
 *
 * From one `/config_dump`:
 *  - `ListenersConfigDump.version_info` is the LDS version Envoy last
 *    applied; matching netd's version means Envoy accepted the file.
 *  - `dynamic_listeners[].active_state.listener.address` gives the ports
 *    actually bound.
 *  - `error_state` reports a rejected update, so a bind collision fails
 *    fast with a clear message instead of timing out.
 *
 * The per-listener `active_state.version_info` is not used: Envoy updates
 * filter chains in place without restamping it, so it keeps the version
 * the listener was created at (checked against Envoy 1.34).
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
 * Parse a `/config_dump` body. Anything unrecognized is dropped, so an
 * unreadable dump reads as "not ready yet".
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
 * Compare what Envoy reports against what netd wrote. Ready requires both
 * that Envoy applied this exact version and that every expected listener
 * is bound on a trio port. Listeners with an `error_state` at this version
 * are reported as rejected so the caller can fail fast.
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
 * Wait until Envoy is serving `expected`. Throws ListenerRejectedError or
 * ListenerTimeoutError otherwise; callers treat either as a failed
 * reconcile.
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
 * The unfiltered dump: `?resource=dynamic_listeners` omits the enclosing
 * ListenersConfigDump, which holds the applied LDS version.
 */
export const CONFIG_DUMP_PATH = '/config_dump'

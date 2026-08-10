import type net from 'node:net'
import { type PodInfo, isPrewarmed, relayDial } from '#platform/k8s'
import { getWorktreePorts } from './port-forwarders'
import { notifyWorktreeListChanged } from '#notify'
import { serverLog } from '#log'

/**
 * Detected in-pod listeners, per worktree: streamd's `ports` stream pushes
 * the pod's localhost-reachable LISTEN set (one JSON line on connect, on
 * every change, and as a periodic keepalive), and this module holds the
 * result in memory — the source of the snapshot's `unforwardedPorts`.
 * There is no server-side poll: the per-worktree watcher just keeps one
 * relay stream open, mirroring (in miniature) the status watcher's
 * lifecycle — informer-driven sync, respawn with backoff, and a silence
 * deadline standing in for its heartbeat.
 *
 * The detected set is agent-controlled state (the agent can bind any
 * port, and can even replace streamd wholesale — it holds the pod's own
 * stream token), so everything read from the stream is re-validated and
 * bounded here, and the surfaced set is filtered fail-closed: yaac's
 * in-pod infra range is hidden, sensitive well-known ports are never
 * offered one-click, and the count is capped.
 */

/** Well-known ports never offered for one-click forwarding — exposing
 *  them is a step toward RCE (node --inspect) or data exposure (DBs). */
export const SENSITIVE_PORTS: ReadonlySet<number> = new Set([
  22, // sshd
  2375, 2376, // docker daemon
  3306, // mysql
  5432, // postgres
  6379, // redis
  9229, 9230, // node --inspect
  11211, // memcached
  27017, // mongodb
])

/** yaac's in-pod infra port range (streamd 10300, relay 10260, …) —
 *  fail closed: anything here is hidden, not surfaced. */
const INFRA_PORT_MIN = 10250
const INFRA_PORT_MAX = 10350

/** Cap on ports surfaced per worktree — a hostile listener flood shows a
 *  bounded badge, not an unbounded snapshot. */
const MAX_SURFACED_PORTS = 10

/** Cap on ports stored per worktree from a single push. */
const MAX_DETECTED_PORTS = 100

/** Line-buffer cap for the ports stream (each line is a small JSON set). */
const LINE_MAX_BYTES = 64 * 1024

/** Retry cadence for a pod whose streamd predates the `ports` kind — the
 *  refusal is permanent for that pod's lifetime, so hammering the 60s
 *  backoff cap just fills the log. Kept finite (not a stop) so a streamd
 *  self-heal onto a newer image is eventually picked up. */
const UNSUPPORTED_KIND_RETRY_MS = 10 * 60_000

const detected = new Map<string, number[]>()
const dismissed = new Map<string, Set<number>>()

/** Test-only: drop all detector state. */
export function _resetPortDetectorForTests(): void {
  detected.clear()
  dismissed.clear()
}

/** Whether a detected port may be offered for forwarding at all. */
export function isForwardablePort(port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  if (SENSITIVE_PORTS.has(port)) return false
  if (port >= INFRA_PORT_MIN && port <= INFRA_PORT_MAX) return false
  return true
}

/** Test-only: seed a worktree's detected set directly. */
export function _setDetectedPortsForTests(worktreeId: string, ports: number[]): void {
  detected.set(worktreeId, ports)
}

/**
 * The ports the webapp should offer to forward for a worktree: detected
 * listeners minus already-forwarded container ports, user-dismissed
 * ports, and the sensitive/infra exclusions — capped, ascending. Feeds
 * `unforwardedPorts` on the worktree snapshot.
 */
export function getUnforwardedPorts(worktreeId: string): number[] {
  const raw = detected.get(worktreeId)
  if (!raw?.length) return []
  const forwarded = new Set(getWorktreePorts(worktreeId).map((p) => p.containerPort))
  const hidden = dismissed.get(worktreeId)
  return raw
    .filter((p) => isForwardablePort(p) && !forwarded.has(p) && !hidden?.has(p))
    .slice(0, MAX_SURFACED_PORTS)
}

/**
 * Hide a detected port for this worktree (in-memory — resets with the
 * server, and clears when the worktree goes away). Unlike allow-host,
 * "never forward this" is a legitimate lasting choice, so the badge
 * needs a way to stop offering. Only currently-surfaced ports can be
 * dismissed (returns false otherwise) — anything else would let an
 * arbitrary-port dismissal grow the set for worktrees the sync cleanup
 * never tracked.
 */
export function dismissWorktreePort(worktreeId: string, port: number): boolean {
  if (!getUnforwardedPorts(worktreeId).includes(port)) return false
  let set = dismissed.get(worktreeId)
  if (!set) {
    set = new Set()
    dismissed.set(worktreeId, set)
  }
  set.add(port)
  // Self-clears the popover row: the dismissal only exists here, so this is
  // the only place that can announce it.
  notifyWorktreeListChanged()
  return true
}

/** Validate + normalize one pushed ports payload (agent-influenced). */
function normalizePorts(value: unknown): number[] | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { ports?: unknown }).ports)) {
    return null
  }
  const ports = (value as { ports: unknown[] }).ports
    .filter((p): p is number => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535)
  return [...new Set(ports)].sort((a, b) => a - b).slice(0, MAX_DETECTED_PORTS)
}

export interface PortDetectorDeps {
  /** Injected for tests — replaces the real relay `ports`-stream dial. */
  dialPorts?: (worktreeId: string) => Promise<net.Socket>
  /** First respawn delay after a stream death; doubles to the max. */
  respawnDelayMs?: number
  maxRespawnDelayMs?: number
  /** Tear down a stream this long after its last line (streamd keepalives
   *  every 30s, so silence means the stream is wedged). */
  silenceTimeoutMs?: number
  log?: (msg: string) => void
}

function dialRelayPorts(worktreeId: string): Promise<net.Socket> {
  return relayDial(worktreeId, { kind: 'ports' })
}

class WorktreePortsWatcher {
  private sock: net.Socket | null = null
  private stopped = false
  private generation = 0
  private backoffMs: number
  private respawnTimer: NodeJS.Timeout | null = null
  private silenceTimer: NodeJS.Timeout | null = null

  private readonly dialPorts: (worktreeId: string) => Promise<net.Socket>
  private readonly respawnDelayMs: number
  private readonly maxRespawnDelayMs: number
  private readonly silenceTimeoutMs: number
  private readonly log: (msg: string) => void

  constructor(
    readonly worktreeId: string,
    private readonly onPorts: (ports: number[]) => void,
    deps: PortDetectorDeps = {},
  ) {
    this.dialPorts = deps.dialPorts ?? dialRelayPorts
    this.respawnDelayMs = deps.respawnDelayMs ?? 1_000
    this.maxRespawnDelayMs = deps.maxRespawnDelayMs ?? 60_000
    this.silenceTimeoutMs = deps.silenceTimeoutMs ?? 75_000
    this.log = deps.log ?? serverLog
    this.backoffMs = this.respawnDelayMs
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    this.respawnTimer = null
    this.teardownStream()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const generation = ++this.generation
    let socket: net.Socket
    try {
      socket = await this.dialPorts(this.worktreeId)
    } catch (err) {
      if (this.stopped || generation !== this.generation) return
      this.log(`[server] port-detector ${this.worktreeId.slice(0, 8)}: dial failed: ${String(err)}`)
      // A streamd predating the `ports` kind refuses the handshake with
      // "unknown kind" — permanent for this pod, so retry only rarely.
      if (String(err).includes('unknown kind')) this.backoffMs = UNSUPPORTED_KIND_RETRY_MS
      this.scheduleRespawn()
      return
    }
    if (this.stopped || generation !== this.generation) {
      socket.destroy()
      return
    }
    this.sock = socket
    this.resetSilenceTimer(generation)

    let buf = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      if (generation !== this.generation || this.stopped) return
      this.resetSilenceTimer(generation)
      buf = Buffer.concat([buf, chunk])
      let nl = buf.indexOf(0x0a)
      while (nl >= 0) {
        const line = buf.subarray(0, nl).toString('utf8')
        buf = buf.subarray(nl + 1)
        let payload: unknown
        try {
          payload = JSON.parse(line)
        } catch {
          this.onStreamDown(generation, 'malformed ports line')
          return
        }
        const ports = normalizePorts(payload)
        if (ports) {
          // A valid line proves the stream healthy end to end.
          this.backoffMs = this.respawnDelayMs
          this.onPorts(ports)
        }
        nl = buf.indexOf(0x0a)
      }
      if (buf.length > LINE_MAX_BYTES) this.onStreamDown(generation, 'oversized ports line')
    })
    socket.on('error', () => { /* 'close' follows */ })
    socket.on('close', () => this.onStreamDown(generation, 'stream closed'))
    socket.resume()
  }

  private resetSilenceTimer(generation: number): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(
      () => this.onStreamDown(generation, `no push for ${this.silenceTimeoutMs}ms`),
      this.silenceTimeoutMs,
    )
  }

  /** Idempotent per stream generation. Detection stays sticky across a
   *  stream gap — a proxy restart must not flap the badge. */
  private onStreamDown(generation: number, reason: string): void {
    if (generation !== this.generation || this.stopped) return
    this.generation++
    this.log(`[server] port-detector ${this.worktreeId.slice(0, 8)}: ${reason}`)
    this.teardownStream()
    this.scheduleRespawn()
  }

  private teardownStream(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = null
    this.sock?.destroy()
    this.sock = null
  }

  private scheduleRespawn(): void {
    if (this.stopped || this.respawnTimer) return
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      void this.connect()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxRespawnDelayMs)
  }
}

/**
 * Keeps one ports stream per running, non-prewarmed worktree pod, synced
 * from informer pod deltas exactly like the StatusWatcherManager it sits
 * next to. `onChange` fires when any worktree's detected set actually
 * changes, so the events hub can push a fresh snapshot.
 */
export class PortDetectorManager {
  private readonly watchers = new Map<string, WorktreePortsWatcher>()

  constructor(
    private readonly onChange: () => void,
    private readonly deps: PortDetectorDeps = {},
  ) {}

  get size(): number {
    return this.watchers.size
  }

  sync(pods: PodInfo[]): void {
    const wanted = new Set<string>()
    for (const p of pods) {
      if (!p.running || !p.worktreeId || isPrewarmed(p)) continue
      wanted.add(p.worktreeId)
    }
    for (const [worktreeId, watcher] of this.watchers) {
      if (wanted.has(worktreeId)) continue
      watcher.stop()
      this.watchers.delete(worktreeId)
      const hadPorts = (detected.get(worktreeId)?.length ?? 0) > 0
      detected.delete(worktreeId)
      dismissed.delete(worktreeId)
      if (hadPorts) this.onChange()
    }
    for (const worktreeId of wanted) {
      if (this.watchers.has(worktreeId)) continue
      const watcher = new WorktreePortsWatcher(worktreeId, (ports) => {
        const prev = detected.get(worktreeId)
        if (prev && prev.length === ports.length && prev.every((p, i) => p === ports[i])) return
        detected.set(worktreeId, ports)
        this.onChange()
      }, this.deps)
      watcher.start()
      this.watchers.set(worktreeId, watcher)
    }
  }

  stopAll(): void {
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
    detected.clear()
    dismissed.clear()
  }
}

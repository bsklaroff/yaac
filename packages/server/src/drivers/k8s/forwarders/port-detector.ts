import type net from 'node:net'
import { type PodInfo, isPrewarmed, relayDial } from '#drivers/k8s/substrate'
import { getWorkspacePorts } from './port-forwarders'
import { notifyWorkspaceListChanged } from '#notify'
import { serverLog } from '#log'
import { MAX_SURFACED_PORTS, isForwardablePort } from '#lib/port-policy'

/**
 * Detected in-pod listeners, per workspace: streamd's `ports` stream pushes
 * the pod's localhost-reachable LISTEN set (one JSON line on connect, on
 * every change, and as a periodic keepalive), and this module holds the
 * result in memory — the source of the snapshot's `unforwardedPorts`.
 * There is no server-side poll: the per-workspace watcher just keeps one
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

/** Cap on ports stored per workspace from a single push. */
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

/** Test-only: seed a workspace's detected set directly. */
export function _setDetectedPortsForTests(workspaceId: string, ports: number[]): void {
  detected.set(workspaceId, ports)
}

/**
 * The ports the webapp should offer to forward for a workspace: detected
 * listeners minus already-forwarded container ports, user-dismissed
 * ports, and the sensitive/infra exclusions — capped, ascending. Feeds
 * `unforwardedPorts` on the workspace snapshot.
 */
export function getUnforwardedPorts(workspaceId: string): number[] {
  const raw = detected.get(workspaceId)
  if (!raw?.length) return []
  const forwarded = new Set(getWorkspacePorts(workspaceId).map((p) => p.containerPort))
  const hidden = dismissed.get(workspaceId)
  return raw
    .filter((p) => isForwardablePort(p) && !forwarded.has(p) && !hidden?.has(p))
    .slice(0, MAX_SURFACED_PORTS)
}

/** Whether a port is a listener the workspace's detector has seen and the
 *  policy would surface — forwarded, dismissed or not. */
export function isDetectedPort(workspaceId: string, port: number): boolean {
  return isForwardablePort(port) && (detected.get(workspaceId)?.includes(port) ?? false)
}

/**
 * Hide a detected port for this workspace (in-memory — resets with the
 * server, and clears when the workspace goes away). Unlike allow-host,
 * "never forward this" is a legitimate lasting choice, so the badge
 * needs a way to stop offering. Only currently-surfaced ports can be
 * dismissed (returns false otherwise) — anything else would let an
 * arbitrary-port dismissal grow the set for workspaces the sync cleanup
 * never tracked.
 */
export function dismissWorkspacePort(workspaceId: string, port: number): boolean {
  if (!getUnforwardedPorts(workspaceId).includes(port)) return false
  let set = dismissed.get(workspaceId)
  if (!set) {
    set = new Set()
    dismissed.set(workspaceId, set)
  }
  set.add(port)
  // Self-clears the popover row: the dismissal only exists here, so this is
  // the only place that can announce it.
  notifyWorkspaceListChanged()
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
  dialPorts?: (workspaceId: string) => Promise<net.Socket>
  /** First respawn delay after a stream death; doubles to the max. */
  respawnDelayMs?: number
  maxRespawnDelayMs?: number
  /** Tear down a stream this long after its last line (streamd keepalives
   *  every 30s, so silence means the stream is wedged). */
  silenceTimeoutMs?: number
  log?: (msg: string) => void
}

function dialRelayPorts(workspaceId: string): Promise<net.Socket> {
  return relayDial(workspaceId, { kind: 'ports' })
}

class WorkspacePortsWatcher {
  private sock: net.Socket | null = null
  private stopped = false
  private generation = 0
  private backoffMs: number
  private respawnTimer: NodeJS.Timeout | null = null
  private silenceTimer: NodeJS.Timeout | null = null

  private readonly dialPorts: (workspaceId: string) => Promise<net.Socket>
  private readonly respawnDelayMs: number
  private readonly maxRespawnDelayMs: number
  private readonly silenceTimeoutMs: number
  private readonly log: (msg: string) => void

  constructor(
    readonly workspaceId: string,
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
      socket = await this.dialPorts(this.workspaceId)
    } catch (err) {
      if (this.stopped || generation !== this.generation) return
      this.log(`[server] port-detector ${this.workspaceId.slice(0, 8)}: dial failed: ${String(err)}`)
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
    this.log(`[server] port-detector ${this.workspaceId.slice(0, 8)}: ${reason}`)
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
 * Keeps one ports stream per running, non-prewarmed workspace pod, synced
 * from informer pod deltas exactly like the StatusWatcherManager it sits
 * next to. `onChange` fires when any workspace's detected set actually
 * changes, so the events hub can push a fresh snapshot.
 */
export class PortDetectorManager {
  private readonly watchers = new Map<string, WorkspacePortsWatcher>()

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
      if (!p.running || !p.workspaceId || isPrewarmed(p)) continue
      wanted.add(p.workspaceId)
    }
    for (const [workspaceId, watcher] of this.watchers) {
      if (wanted.has(workspaceId)) continue
      watcher.stop()
      this.watchers.delete(workspaceId)
      const hadPorts = (detected.get(workspaceId)?.length ?? 0) > 0
      detected.delete(workspaceId)
      dismissed.delete(workspaceId)
      if (hadPorts) this.onChange()
    }
    for (const workspaceId of wanted) {
      if (this.watchers.has(workspaceId)) continue
      const watcher = new WorkspacePortsWatcher(workspaceId, (ports) => {
        const prev = detected.get(workspaceId)
        if (prev && prev.length === ports.length && prev.every((p, i) => p === ports[i])) return
        detected.set(workspaceId, ports)
        this.onChange()
      }, this.deps)
      watcher.start()
      this.watchers.set(workspaceId, watcher)
    }
  }

  stopAll(): void {
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
    detected.clear()
    dismissed.clear()
  }
}

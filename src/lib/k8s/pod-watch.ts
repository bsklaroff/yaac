import { spawn } from 'node:child_process'
import { z } from 'zod'
import { k8sNamespace } from '@/lib/k8s/kubectl'
import {
  listSessionPods,
  mapSessionPodItem,
  sessionPodItemSchema,
  sessionPodSelector,
  type SessionPod,
} from '@/lib/k8s/pods'
import { daemonLog } from '@/daemon/log'

/**
 * Push-fed session-pod cache: one long-lived
 * `kubectl get pods --watch --output-watch-events -o json` child whose
 * events keep an in-memory pod map current, so pod lifecycle changes
 * surface in milliseconds instead of at the next 5s reconcile tick.
 *
 * Standard informer shape: watch for latency, relist for truth. The
 * cache is re-seeded from a full `listSessionPods` on every (re)spawn
 * and again every `relistIntervalMs`, which bounds the lifetime of any
 * ghost row from an event lost while the watch was down (kubectl exits
 * when the apiserver closes the watch — that's routine, not an error).
 * The 5s background loop lists pods itself and is unaffected either way.
 */

/** kubectl emits one of these per line with --output-watch-events. */
const watchEventSchema = z.object({
  type: z.string(),
  object: z.unknown(),
})

/**
 * Incremental parser for kubectl's newline-delimited JSON event stream.
 * Feed raw stdout chunks; complete JSON values are surfaced via
 * `onValue`. A value that spans lines (kubectl currently emits compact
 * single-line events, but that's not contractual) is accumulated until
 * it parses; `maxBuffer` guards against unbounded garbage.
 */
export function createJsonStreamParser(
  onValue: (value: unknown) => void,
  maxBuffer = 8 * 1024 * 1024,
): { push(chunk: string): void } {
  let pending = ''
  let candidate = ''
  return {
    push(chunk: string): void {
      pending += chunk
      for (;;) {
        const nl = pending.indexOf('\n')
        if (nl === -1) break
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        candidate = candidate === '' ? line : `${candidate}\n${line}`
        if (candidate.trim() === '') {
          candidate = ''
          continue
        }
        try {
          const value: unknown = JSON.parse(candidate)
          candidate = ''
          onValue(value)
        } catch {
          if (candidate.length > maxBuffer) candidate = ''
        }
      }
      if (pending.length > maxBuffer) pending = ''
    },
  }
}

/**
 * Minimal child-process surface the watcher needs — lets tests inject a
 * fake without dragging in real process semantics.
 */
export interface WatchChild {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null
  on(event: 'exit' | 'error', cb: (...args: unknown[]) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export interface PodWatcherDeps {
  /** Injected for tests — replaces the real kubectl spawn. */
  spawnWatch?: () => WatchChild
  /** Injected for tests — replaces the real listSessionPods seed. */
  listPods?: () => Promise<SessionPod[]>
  /** Full relist cadence bounding ghost-row lifetime. Default 60s. */
  relistIntervalMs?: number
  /** First respawn delay after a child exit; doubles to the max. */
  restartDelayMs?: number
  maxRestartDelayMs?: number
  log?: (msg: string) => void
}

function spawnKubectlWatch(): WatchChild {
  return spawn('kubectl', [
    'get', 'pods', '-n', k8sNamespace(), '-l', sessionPodSelector(),
    '--watch', '--output-watch-events', '-o', 'json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
}

export class PodWatcher {
  private readonly pods = new Map<string, SessionPod>()
  private listener: (() => void) | null = null
  private child: WatchChild | null = null
  private childSpawnedAtMs = 0
  private stopped = false
  private restartTimer: NodeJS.Timeout | null = null
  private relistTimer: NodeJS.Timeout | null = null
  private backoffMs: number

  private readonly spawnWatch: () => WatchChild
  private readonly listPods: () => Promise<SessionPod[]>
  private readonly relistIntervalMs: number
  private readonly restartDelayMs: number
  private readonly maxRestartDelayMs: number
  private readonly log: (msg: string) => void

  constructor(deps: PodWatcherDeps = {}) {
    this.spawnWatch = deps.spawnWatch ?? spawnKubectlWatch
    this.listPods = deps.listPods ?? (() => listSessionPods())
    this.relistIntervalMs = deps.relistIntervalMs ?? 60_000
    this.restartDelayMs = deps.restartDelayMs ?? 1_000
    this.maxRestartDelayMs = deps.maxRestartDelayMs ?? 30_000
    this.log = deps.log ?? daemonLog
    this.backoffMs = this.restartDelayMs
  }

  /** Register the change handler (single listener, last one wins). */
  onChange(fn: () => void): void {
    this.listener = fn
  }

  /** Current pod set, optionally filtered to one project. */
  getPods(projectFilter?: string): SessionPod[] {
    const all = [...this.pods.values()]
    return projectFilter ? all.filter((p) => p.projectSlug === projectFilter) : all
  }

  start(): void {
    this.stopped = false
    void this.cycle()
    this.relistTimer = setInterval(() => void this.seed(), this.relistIntervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.relistTimer) clearInterval(this.relistTimer)
    this.restartTimer = null
    this.relistTimer = null
    this.child?.kill('SIGTERM')
    this.child = null
  }

  private notify(): void {
    try {
      this.listener?.()
    } catch (err) {
      this.log(`[daemon] pod-watch: change listener failed: ${String(err)}`)
    }
  }

  /** Replace the cache with a fresh full list; notify if anything differs. */
  private async seed(): Promise<void> {
    let fresh: SessionPod[]
    try {
      fresh = await this.listPods()
    } catch (err) {
      // Cluster hiccup — keep the current cache; the next relist retries.
      this.log(`[daemon] pod-watch: relist failed: ${String(err)}`)
      return
    }
    if (this.stopped) return
    const next = new Map(fresh.map((p) => [p.podName, p] as const))
    const changed = next.size !== this.pods.size
      || [...next.entries()].some(([name, pod]) =>
        JSON.stringify(this.pods.get(name)) !== JSON.stringify(pod))
    this.pods.clear()
    for (const [name, pod] of next) this.pods.set(name, pod)
    if (changed) this.notify()
  }

  private applyEvent(value: unknown): void {
    const event = watchEventSchema.safeParse(value)
    if (!event.success) return
    const item = sessionPodItemSchema.safeParse(event.data.object)
    if (!item.success) return
    const pod = mapSessionPodItem(item.data)
    if (event.data.type === 'DELETED') {
      if (this.pods.delete(pod.podName)) this.notify()
      return
    }
    if (event.data.type !== 'ADDED' && event.data.type !== 'MODIFIED') return
    const prev = this.pods.get(pod.podName)
    this.pods.set(pod.podName, pod)
    if (JSON.stringify(prev) !== JSON.stringify(pod)) this.notify()
  }

  private async cycle(): Promise<void> {
    await this.seed()
    if (this.stopped) return

    let child: WatchChild
    try {
      child = this.spawnWatch()
    } catch (err) {
      this.log(`[daemon] pod-watch: spawn failed: ${String(err)}`)
      this.scheduleRestart()
      return
    }
    this.child = child
    this.childSpawnedAtMs = Date.now()

    const parser = createJsonStreamParser((value) => this.applyEvent(value))
    child.stdout?.on('data', (chunk) => parser.push(chunk.toString()))
    let stderrTail = ''
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-500)
    })
    child.on('error', (err) => {
      this.log(`[daemon] pod-watch: child error: ${String(err)}`)
    })
    child.on('exit', () => {
      if (this.stopped) return
      this.child = null
      // A watch the apiserver closed after a long life is routine —
      // reset the backoff so the respawn is immediate-ish. Rapid exits
      // (bad kubeconfig, unreachable cluster) back off up to the max.
      if (Date.now() - this.childSpawnedAtMs >= 60_000) this.backoffMs = this.restartDelayMs
      if (stderrTail.trim()) {
        this.log(`[daemon] pod-watch: watch exited: ${stderrTail.trim()}`)
      }
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.cycle()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxRestartDelayMs)
  }
}

/**
 * Daemon-set singleton so the display path (`listActiveSessions`) can
 * read the push-fed cache without threading the watcher through every
 * call site. Null outside the daemon (unit tests, direct lib use) —
 * callers fall back to a one-shot `listSessionPods`.
 */
let activePodWatcher: PodWatcher | null = null

export function setActivePodWatcher(watcher: PodWatcher | null): void {
  activePodWatcher = watcher
}

export function getActivePodWatcher(): PodWatcher | null {
  return activePodWatcher
}

/**
 * Per-session port detector. Watches a session pod's listening TCP sockets
 * (via a single long-lived `kubectl exec` that cats /proc/net/tcp[6] in a
 * loop) and, when a dev server the agent started begins listening on a
 * loopback/any address, reserves a host port, starts a relay forwarder into
 * the pod, HTTP-probes it, and — if it speaks HTTP — registers it as a
 * `detected` forward so it flows into the webapp snapshot and the frontend
 * can auto-open an embedded preview.
 *
 * This is the dynamic counterpart to the static `portForward` config handled
 * by `port-forwarders.ts`; the detector reuses that registry so a single
 * teardown (`stopSessionForwarders`) closes the loop and every relay it made.
 */

import { spawn } from 'node:child_process'
import { streamExecArgs } from '@/lib/k8s/exec'
import { kubectlRelay, reserveAvailablePort, startPortForwarders } from '@/lib/container/port'
import {
  addDetectedForwarder,
  hasForwardedPort,
  hasSessionDetector,
  removeDetectedForwarder,
  setSessionDetector,
} from '@/lib/session/port-forwarders'
import type { PortMapping } from '@/shared/types'

/** Marker the in-pod loop prints after each /proc dump so the daemon can
 *  frame one poll's worth of output. Unlikely to appear in /proc data. */
const POLL_MARKER = '__YAAC_POLL_END__'

/** Seconds the in-pod loop sleeps between /proc dumps. */
const POLL_INTERVAL_SECONDS = 2

/** The in-pod command: dump both IPv4 and IPv6 socket tables, print the
 *  marker, sleep, repeat. `2>/dev/null` tolerates a missing tcp6 file. */
const POLL_SCRIPT =
  'while true; do cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; '
  + `printf '\\n${POLL_MARKER}\\n'; sleep ${POLL_INTERVAL_SECONDS}; done`

/** TCP state code for LISTEN in /proc/net/tcp (hex). */
const TCP_LISTEN = '0A'

/** Backoff bounds for respawning the poll exec if it dies unexpectedly. */
const RESPAWN_BASE_MS = 1000
const RESPAWN_MAX_MS = 5000

/**
 * Whether a /proc/net/tcp[6] local-address hex is a loopback or any-address
 * bind — i.e. reachable from inside the pod via `localhost`, which is how the
 * relay (`nc localhost <port>`) connects. IPv4 addresses are 8 hex chars
 * (little-endian bytes, so the first octet is the last hex pair); IPv6 are 32.
 * Servers bound to a specific non-loopback IP aren't reachable via localhost
 * and are skipped.
 */
function isLoopbackOrAny(ipHex: string): boolean {
  if (ipHex.length === 8) {
    // IPv4: 00000000 = 0.0.0.0 (any); first octet 127 (0x7F) = loopback.
    return ipHex === '00000000' || ipHex.slice(6, 8).toUpperCase() === '7F'
  }
  if (ipHex.length === 32) {
    // IPv6: all zeros = :: (any); this exact pattern = ::1 (loopback).
    if (ipHex === '0'.repeat(32)) return true
    if (ipHex.toUpperCase() === '00000000000000000000000001000000') return true
    // v4-mapped (::ffff:a.b.c.d): last 8 hex are the embedded v4 address in
    // the same layout; classify that when the ffff marker is present.
    if (ipHex.slice(16, 24).toUpperCase() === 'FFFF0000') {
      return isLoopbackOrAny(ipHex.slice(24, 32))
    }
    return false
  }
  return false
}

/**
 * Parse the LISTEN ports bound to loopback/any from one /proc/net/tcp[6]
 * dump. Returns a sorted, de-duplicated list.
 */
export function parseListenPorts(procText: string): number[] {
  const ports = new Set<number>()
  for (const rawLine of procText.split('\n')) {
    const cols = rawLine.trim().split(/\s+/)
    // A data row is `<sl>: <local> <rem> <st> …`; the header row's 4th column
    // is the literal "st", which fails the LISTEN check below.
    if (cols.length < 4) continue
    if (cols[3] !== TCP_LISTEN) continue
    const [ipHex, portHex] = cols[1].split(':')
    if (!ipHex || !portHex) continue
    if (!isLoopbackOrAny(ipHex)) continue
    const port = parseInt(portHex, 16)
    if (Number.isFinite(port) && port > 0) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/** Added/removed ports between two listen sets. */
export function diffPorts(
  prev: readonly number[],
  next: readonly number[],
): { added: number[]; removed: number[] } {
  const prevSet = new Set(prev)
  const nextSet = new Set(next)
  return {
    added: next.filter((p) => !prevSet.has(p)),
    removed: prev.filter((p) => !nextSet.has(p)),
  }
}

/**
 * Whether a container port is worth trying to preview. Privileged ports
 * (≤1024) are pod infrastructure; the HTTP probe filters the rest, so this
 * stays deliberately permissive.
 */
export function isCandidatePort(containerPort: number): boolean {
  return containerPort > 1024 && containerPort <= 65535
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Probe whether a host port speaks HTTP. Any HTTP response — even 404/500 —
 * counts; a non-HTTP listener (a database, a bare websocket) makes fetch throw
 * a parse/connection error. Retries cover a dev server that has bound its port
 * but is still compiling its first response.
 */
export async function probeHttp(
  url: string,
  opts: {
    retries?: number
    delayMs?: number
    timeoutMs?: number
    fetchImpl?: typeof fetch
    sleepImpl?: (ms: number) => Promise<void>
  } = {},
): Promise<boolean> {
  const { retries = 6, delayMs = 400, timeoutMs = 1500, fetchImpl = fetch, sleepImpl = sleep } = opts
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' })
      clearTimeout(timer)
      if (res && typeof res.status === 'number') return true
    } catch {
      clearTimeout(timer)
      // Connection refused/reset, timeout, or a non-HTTP reply that failed to
      // parse — all mean "not (yet) an HTTP server"; retry.
    }
    if (attempt < retries - 1) await sleepImpl(delayMs)
  }
  return false
}

/** A running in-pod poll loop the detector reads from. */
export interface PollProcess {
  onData: (cb: (chunk: string) => void) => void
  onExit: (cb: () => void) => void
  kill: () => void
}

/** Side-effecting seams, injected so the loop logic can be unit-tested. */
export interface PortDetectorDeps {
  spawnPoll: (jobName: string) => PollProcess
  openForward: (jobName: string, containerPort: number) => Promise<{ hostPort: number; stop: () => void }>
  probe: (hostPort: number) => Promise<boolean>
  isForwarded: (sessionId: string, containerPort: number) => boolean
  addForward: (sessionId: string, mapping: PortMapping, stop: () => void) => void
  removeForward: (sessionId: string, containerPort: number) => void
  schedule: (fn: () => void, ms: number) => { cancel: () => void }
}

function defaultDeps(): PortDetectorDeps {
  return {
    spawnPoll: (jobName) => {
      const child = spawn('kubectl', streamExecArgs(jobName, ['sh', '-c', POLL_SCRIPT]), {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return {
        onData: (cb) => child.stdout?.on('data', (d: Buffer) => cb(d.toString('utf8'))),
        onExit: (cb) => child.on('close', cb),
        kill: () => child.kill(),
      }
    },
    openForward: async (jobName, containerPort) => {
      // Reserve starting at the container port so the host port mirrors it
      // when free (localhost:5173 → localhost:5173), falling forward on clash.
      const reserved = await reserveAvailablePort(containerPort, containerPort)
      const stop = startPortForwarders(kubectlRelay(jobName), [reserved])
      return { hostPort: reserved.hostPort, stop }
    },
    probe: (hostPort) => probeHttp(`http://127.0.0.1:${hostPort}/`),
    isForwarded: hasForwardedPort,
    addForward: addDetectedForwarder,
    removeForward: removeDetectedForwarder,
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(t) }
    },
  }
}

/**
 * Start watching a session pod for dev servers. Returns a `stop()` that ends
 * the loop and cancels any pending respawn; the relays it created are torn
 * down by the forwarder registry. Deps are injectable for tests.
 */
export function startPortDetector(
  sessionId: string,
  jobName: string,
  deps: PortDetectorDeps = defaultDeps(),
): () => void {
  let stopped = false
  let child: PollProcess | null = null
  let pending: { cancel: () => void } | null = null
  let buffer = ''
  let respawns = 0

  // Latest known listen set — classify() re-checks this after its async probe
  // so a server that vanished mid-probe is never registered.
  let latestListening = new Set<number>()
  // Container ports this detector currently owns a forward for.
  const mine = new Set<number>()
  // Ports being classified right now (probe in flight).
  const inFlight = new Set<number>()
  // Ports probed and found non-HTTP; skipped until they stop listening.
  const dismissed = new Set<number>()

  async function classify(containerPort: number): Promise<void> {
    inFlight.add(containerPort)
    try {
      const fwd = await deps.openForward(jobName, containerPort)
      let ok = false
      try {
        ok = await deps.probe(fwd.hostPort)
      } catch {
        ok = false
      }
      // Only keep it if it spoke HTTP, we're still running, and the pod is
      // still listening on it (it may have died during the probe).
      if (ok && !stopped && latestListening.has(containerPort) && !deps.isForwarded(sessionId, containerPort)) {
        deps.addForward(sessionId, { containerPort, hostPort: fwd.hostPort }, fwd.stop)
        mine.add(containerPort)
      } else {
        if (!ok) dismissed.add(containerPort)
        fwd.stop()
      }
    } catch {
      // Reserve/relay failed — leave it un-dismissed so a later poll retries.
    } finally {
      inFlight.delete(containerPort)
    }
  }

  function reconcile(listening: number[]): void {
    latestListening = new Set(listening)

    // Drop forwards + dismissals for ports that are no longer listening, so a
    // server restart on the same port is re-detected from scratch.
    for (const cp of [...mine]) {
      if (!latestListening.has(cp)) {
        deps.removeForward(sessionId, cp)
        mine.delete(cp)
      }
    }
    for (const cp of [...dismissed]) {
      if (!latestListening.has(cp)) dismissed.delete(cp)
    }

    for (const cp of listening) {
      if (mine.has(cp) || inFlight.has(cp) || dismissed.has(cp)) continue
      if (!isCandidatePort(cp)) continue
      if (deps.isForwarded(sessionId, cp)) continue // covered by static config
      void classify(cp)
    }
  }

  function consume(chunk: string): void {
    buffer += chunk
    let idx = buffer.indexOf(POLL_MARKER)
    while (idx !== -1) {
      const snapshot = buffer.slice(0, idx)
      buffer = buffer.slice(idx + POLL_MARKER.length)
      respawns = 0 // healthy data resets the backoff
      reconcile(parseListenPorts(snapshot))
      idx = buffer.indexOf(POLL_MARKER)
    }
  }

  function spawnLoop(): void {
    if (stopped) return
    buffer = ''
    child = deps.spawnPoll(jobName)
    child.onData(consume)
    child.onExit(() => {
      child = null
      if (stopped) return
      const delay = Math.min(RESPAWN_BASE_MS * 2 ** respawns, RESPAWN_MAX_MS)
      respawns++
      pending = deps.schedule(spawnLoop, delay)
    })
  }

  spawnLoop()

  return () => {
    stopped = true
    pending?.cancel()
    pending = null
    try { child?.kill() } catch { /* already gone */ }
    child = null
  }
}

/**
 * Start a detector for a session if one isn't already running, registering
 * its teardown with the forwarder registry so session teardown stops it.
 * Idempotent — safe to call from both session-create and the restore pass.
 */
export function ensureSessionDetector(
  sessionId: string,
  jobName: string,
  deps?: PortDetectorDeps,
): void {
  if (hasSessionDetector(sessionId)) return
  const stop = startPortDetector(sessionId, jobName, deps)
  setSessionDetector(sessionId, stop)
}

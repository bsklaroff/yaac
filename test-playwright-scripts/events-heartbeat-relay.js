/*
 * Verifies the `/events` heartbeat in `startEventsMonitor`
 * (packages/shared/src/events.ts) over a connection that dies silently, the
 * way one held across a laptop sleep does. Each monitor dials through a TCP
 * relay that can be switched to black-hole mode: it stops forwarding bytes
 * in both directions without closing anything, so neither end is told.
 *
 * Two monitors run side by side:
 *  - A follows the real server registered in ~/.yaac-client/server.json
 *    (default http://127.0.0.1:8787, override with YAAC_URL), so the ping is
 *    answered by the server's own `ws`.
 *  - B follows a stub `/events` server and feeds a forward set, as
 *    `yaac forward` does. The stub starts offering a port while the relay is
 *    black-holed, and the check is that the port binds once it recovers.
 *
 * Checks, in order:
 *  1. Healthy: over HEALTHY_MS (default 60s) each relay sees one connection.
 *  2. Black hole for BLACKHOLE_MS (default 45s): each client drops its
 *     connection within 2 heartbeats (30s), and drops the reconnects that
 *     hang in the black hole too.
 *  3. Recovery: A gets a fresh snapshot and B binds the offered port, within
 *     ~2 heartbeats plus the reconnect delay.
 *  4. Healthy again for SETTLE_MS (default 180s): no further connections.
 *
 * Needs a running server (`yaac server start`). Run from the repo root:
 *   pnpm exec tsx test-playwright-scripts/events-heartbeat-relay.js
 */
import net from 'node:net'
import http from 'node:http'
import { createRequire } from 'node:module'
import { startEventsMonitor, EVENTS_HEARTBEAT_MS } from '../packages/shared/src/events.ts'
import { createForwardSet, snapshotForwards } from '../packages/shared/src/port-tunnel-set.ts'

const { WebSocketServer } = createRequire(new URL('../packages/shared/package.json', import.meta.url))('ws')

const HEALTHY_MS = Number(process.env.HEALTHY_MS ?? 60_000)
const BLACKHOLE_MS = Number(process.env.BLACKHOLE_MS ?? 45_000)
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 180_000)
const SERVER = new URL(process.env.YAAC_URL ?? 'http://127.0.0.1:8787')
const FORWARD_PORT = 47_123

const t0 = Date.now()
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (ok, msg) => {
  log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) failed = true
}

/** A TCP relay to host:port whose `blackhole` flag drops bytes silently. */
async function startRelay(name, host, port) {
  const relay = { name, blackhole: false, accepted: [], closed: [] }
  const server = net.createServer((client) => {
    const n = relay.accepted.length + 1
    relay.accepted.push(Date.now())
    log(`${name}: connection #${n} accepted${relay.blackhole ? ' (black-holed)' : ''}`)
    const up = net.connect(port, host)
    client.on('data', (d) => { if (!relay.blackhole) up.write(d) })
    up.on('data', (d) => { if (!relay.blackhole) client.write(d) })
    const end = (who) => () => {
      if (client.destroyed && up.destroyed) return
      relay.closed.push(Date.now())
      log(`${name}: connection #${n} closed by ${who}`)
      client.destroy()
      up.destroy()
    }
    client.on('close', end('client'))
    client.on('error', () => {})
    up.on('close', end('server'))
    up.on('error', () => {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  relay.port = server.address().port
  return relay
}

/** A stub `/events` server whose snapshot lists `forwardedPorts`. */
async function startStub() {
  const stub = { ports: [] }
  const server = http.createServer((_req, res) => res.writeHead(404).end())
  const wss = new WebSocketServer({ server, path: '/api/events' })
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'snapshot',
      data: { workspaces: [{ workspaceId: 'stub-workspace', forwardedPorts: stub.ports }] },
    }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  stub.port = server.address().port
  return stub
}

const canConnect = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1')
  s.on('connect', () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
})

const relayA = await startRelay('A', SERVER.hostname, Number(SERVER.port))
const stub = await startStub()
const relayB = await startRelay('B', '127.0.0.1', stub.port)

let lastSnapshotA = 0
const monitorA = startEventsMonitor({
  resolveTarget: async () => ({ baseUrl: `http://127.0.0.1:${relayA.port}` }),
  onSnapshot: (s) => {
    lastSnapshotA = Date.now()
    log(`A: snapshot (${s.workspaces.length} workspaces)`)
  },
})
const set = createForwardSet({ baseUrl: `http://127.0.0.1:${stub.port}` }, {
  onChange: (f, state) => log(`B: forward ${f.localPort} ${state}`),
  onBindError: (spec, message) => log(`B: cannot bind ${spec.hostPort}: ${message}`),
})
const monitorB = startEventsMonitor({
  resolveTarget: async () => ({ baseUrl: `http://127.0.0.1:${relayB.port}` }),
  onSnapshot: (s) => {
    log(`B: snapshot (${snapshotForwards(s).length} forwards)`)
    void set.reconcile(snapshotForwards(s))
  },
})

log(`heartbeat ${EVENTS_HEARTBEAT_MS}ms; healthy for ${HEALTHY_MS}ms`)
await sleep(HEALTHY_MS)
check(lastSnapshotA > 0, 'A received a snapshot from the real server')
for (const r of [relayA, relayB]) check(r.accepted.length === 1, `${r.name}: healthy connection kept (${r.accepted.length} opened)`)

const holeAt = Date.now()
const closedBefore = { A: relayA.closed.length, B: relayB.closed.length }
relayA.blackhole = relayB.blackhole = true
stub.ports = [{ containerPort: 3000, hostPort: FORWARD_PORT }]
log(`black hole on; stub now offers port ${FORWARD_PORT}`)
await sleep(BLACKHOLE_MS)
for (const r of [relayA, relayB]) {
  const firstClose = r.closed[closedBefore[r.name]]
  check(firstClose !== undefined && firstClose - holeAt <= 2 * EVENTS_HEARTBEAT_MS + 1000,
    `${r.name}: dead connection dropped after ${firstClose ? ((firstClose - holeAt) / 1000).toFixed(1) : '-'}s`)
}

const recoverAt = Date.now()
relayA.blackhole = relayB.blackhole = false
log('black hole off')
const deadline = recoverAt + 2 * EVENTS_HEARTBEAT_MS + 5000
while (Date.now() < deadline && !(lastSnapshotA > recoverAt && await canConnect(FORWARD_PORT))) await sleep(500)
check(lastSnapshotA > recoverAt, `A: fresh snapshot after recovery (${((lastSnapshotA - recoverAt) / 1000).toFixed(1)}s)`)
check(await canConnect(FORWARD_PORT), `B: port ${FORWARD_PORT} offered during the outage is bound`)

const settled = { A: relayA.accepted.length, B: relayB.accepted.length }
log(`settling for ${SETTLE_MS}ms`)
await sleep(SETTLE_MS)
for (const r of [relayA, relayB]) {
  check(r.accepted.length === settled[r.name], `${r.name}: no churn while healthy (${r.accepted.length - settled[r.name]} new)`)
}

monitorA.stop()
monitorB.stop()
set.close()
log(failed ? 'FAILED' : 'all checks passed')
process.exit(failed ? 1 : 0)

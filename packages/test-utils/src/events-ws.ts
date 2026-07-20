/**
 * Test-side client for the server's `/events` WebSocket — the snapshot
 * stream the webapp sidebar hydrates from. E2e suites use it to assert on
 * exactly what a browser would render (provisioning rows, session lists)
 * while a create/spawn/restart is in flight.
 */
import WebSocket from 'ws'
import type { ServerSnapshot } from '@yaac/shared/types'

export interface SnapshotWatch {
  ws: WebSocket
  opened: Promise<void>
  latest: () => ServerSnapshot | null
}

/** Collect every `snapshot` frame off a persistent WS, exposing the latest. */
export function collectSnapshots(port: number, secret: string): SnapshotWatch {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, {
    headers: { authorization: `Bearer ${secret}` },
  })
  let latest: ServerSnapshot | null = null
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    const parsed = JSON.parse(buf.toString('utf8')) as { type: string; data: ServerSnapshot }
    if (parsed.type === 'snapshot') latest = parsed.data
  })
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, opened, latest: () => latest }
}

/** Open a WS and resolve the first `snapshot` frame's data (what a connecting
 *  or reloading browser hydrates from). */
export async function firstSnapshot(port: number, secret: string): Promise<ServerSnapshot> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events`, {
    headers: { authorization: `Bearer ${secret}` },
  })
  try {
    return await new Promise<ServerSnapshot>((resolve, reject) => {
      ws.once('error', reject)
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        const parsed = JSON.parse(buf.toString('utf8')) as { type: string; data: ServerSnapshot }
        if (parsed.type === 'snapshot') resolve(parsed.data)
      })
    })
  } finally {
    ws.close()
  }
}

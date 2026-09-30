/**
 * Test client for the server's `/events` WebSocket, the snapshot stream the
 * webapp renders from.
 */
import WebSocket from 'ws'
import type { ServerSnapshot } from '@yaac/shared/types'

export interface SnapshotWatch {
  ws: WebSocket
  opened: Promise<void>
  latest: () => ServerSnapshot | null
}

/** Collect every `snapshot` frame off a persistent WS, exposing the latest. */
export function collectSnapshots(port: number): SnapshotWatch {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`)
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

/** Open a WS and resolve the first `snapshot` frame's data. */
export async function firstSnapshot(port: number): Promise<ServerSnapshot> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`)
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

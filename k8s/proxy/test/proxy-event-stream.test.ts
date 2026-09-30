import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Tests for the proxy's `GET /events` change stream, mirrored from
 * k8s/proxy/proxy.ts (which can't be imported) and driven through a real
 * http.Server.
 *
 * The stream only wakes the server for a queued `yaac-mama` request.
 * Events carry no payload, so a dropped stream costs a reconnect, never a
 * lost update.
 */

const SECRET = 'test-secret'

const eventSubscribers = new Set<http.ServerResponse>()

function checkAuth(req: http.IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${SECRET}`
}

function emitProxyEvent(type: 'mama' | 'ping'): void {
  if (eventSubscribers.size === 0) return
  const line = JSON.stringify({ type }) + '\n'
  for (const res of eventSubscribers) {
    try {
      res.write(line)
    } catch {
      eventSubscribers.delete(res)
    }
  }
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!checkAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return }
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  res.flushHeaders()
  eventSubscribers.add(res)
  const drop = (): void => { eventSubscribers.delete(res) }
  res.on('close', drop)
  res.on('error', drop)
}

let server: http.Server
let baseUrl: string

beforeEach(async () => {
  eventSubscribers.clear()
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/events') { handleEvents(req, res); return }
    res.writeHead(404)
    res.end('Not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const res of eventSubscribers) res.end()
  eventSubscribers.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Subscribe, and return a reader that yields one decoded line at a time. */
async function subscribe(auth = `Bearer ${SECRET}`): Promise<{
  status: number
  nextLine: () => Promise<string>
  close: () => void
}> {
  const ctrl = new AbortController()
  const res = await fetch(`${baseUrl}/events`, {
    headers: { Authorization: auth },
    signal: ctrl.signal,
  })
  const reader = res.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const nextLine = async (): Promise<string> => {
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim()) return line.trim()
        continue
      }
      const chunk = await reader!.read()
      if (chunk.done) throw new Error('stream ended')
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return { status: res.status, nextLine, close: () => ctrl.abort() }
}

/** Wait for the server to register the just-opened subscription. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20 && eventSubscribers.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('GET /events', () => {
  it('rejects a request without the auth secret', async () => {
    const res = await fetch(`${baseUrl}/events`, { headers: { Authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
    await res.text()
    expect(eventSubscribers.size).toBe(0)
  })

  // One line per change, in order, carrying only the type.
  it('streams one contentless line per change', async () => {
    const sub = await subscribe()
    expect(sub.status).toBe(200)
    await settle()

    emitProxyEvent('mama')
    expect(JSON.parse(await sub.nextLine())).toEqual({ type: 'mama' })

    emitProxyEvent('mama')
    expect(JSON.parse(await sub.nextLine())).toEqual({ type: 'mama' })

    sub.close()
  })

  // The ping lets a peer tell a quiet stream from a dead one.
  it('writes pings so silence is distinguishable from a dead tunnel', async () => {
    const sub = await subscribe()
    await settle()
    emitProxyEvent('ping')
    expect(JSON.parse(await sub.nextLine())).toEqual({ type: 'ping' })
    sub.close()
  })

  it('fans out to every subscriber', async () => {
    const a = await subscribe()
    const b = await subscribe()
    for (let i = 0; i < 20 && eventSubscribers.size < 2; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(eventSubscribers.size).toBe(2)

    emitProxyEvent('mama')
    expect(JSON.parse(await a.nextLine())).toEqual({ type: 'mama' })
    expect(JSON.parse(await b.nextLine())).toEqual({ type: 'mama' })

    a.close()
    b.close()
  })

  it('drops a subscriber when its connection closes', async () => {
    const sub = await subscribe()
    await settle()
    expect(eventSubscribers.size).toBe(1)

    sub.close()
    for (let i = 0; i < 50 && eventSubscribers.size > 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(eventSubscribers.size).toBe(0)
  })

  it('is a no-op with nothing subscribed', () => {
    expect(() => emitProxyEvent('mama')).not.toThrow()
  })
})

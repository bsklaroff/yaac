import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { connectAuthAgent, type AuthAgentConnection } from '#connection'
import type { AgentOp, AgentReport } from '@yaac/shared/auth-agent-protocol'

/**
 * The daemon's socket, against a stand-in for the server's
 * /api/agent/sign-in that sends ops and records reports. The browser coming
 * back from the vendor is a plain fetch to the loopback port.
 */

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

async function serverAndDaemon(): Promise<{ sock: WebSocket; reports: AgentReport[]; send: (op: AgentOp) => void }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => wss.once('listening', resolve))
  const { port } = wss.address() as AddressInfo
  const connected = new Promise<WebSocket>((resolve) => wss.once('connection', resolve))
  const daemon: AuthAgentConnection = connectAuthAgent({ baseUrl: `http://127.0.0.1:${port}`, log: () => {} })
  cleanups.push(() => { daemon.stop(); wss.close() })
  const sock = await connected
  const reports: AgentReport[] = []
  sock.on('message', (d: Buffer) => reports.push(JSON.parse(d.toString()) as AgentReport))
  return { sock, reports, send: (op) => sock.send(JSON.stringify(op)) }
}

const authorize = (port: number, state: string): string =>
  `https://vendor.example/authorize?${new URLSearchParams({ redirect_uri: `http://127.0.0.1:${port}/callback`, state })}`

describe('connectAuthAgent', () => {
  it('listens where the server says, says it is listening, and reports the code the browser brings back', async () => {
    const { reports, send } = await serverAndDaemon()
    const port = await freePort()
    send({ op: 'listen', id: 'f1', url: authorize(port, 'st') })
    // It says so once the port is held, so the browser can go there at once.
    await vi.waitFor(() => { expect(reports).toEqual([{ op: 'listening', id: 'f1' }]) })
    expect((await fetch(`http://127.0.0.1:${port}/callback?code=c1&state=st`)).status).toBe(200)
    await vi.waitFor(() => { expect(reports.at(-1)).toEqual({ op: 'callback', id: 'f1', code: 'c1', state: 'st' }) })
  })

  it('reports a port it cannot take, and stops listening when cancelled or disconnected', async () => {
    const { sock, reports, send } = await serverAndDaemon()
    const taken = net.createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => taken.close())
    send({ op: 'listen', id: 'busy', url: authorize((taken.address() as AddressInfo).port, 'x') })
    await vi.waitFor(() => { expect(reports[0]).toMatchObject({ op: 'listen-failed', id: 'busy', error: expect.stringMatching(/in use/) as unknown }) })

    const cancelled = await freePort()
    send({ op: 'listen', id: 'f2', url: authorize(cancelled, 'y') })
    await vi.waitFor(async () => { expect((await fetch(`http://127.0.0.1:${cancelled}/nope`)).status).toBe(404) })
    send({ op: 'cancel', id: 'f2' })
    await vi.waitFor(async () => { await expect(fetch(`http://127.0.0.1:${cancelled}/nope`)).rejects.toThrow() })

    const dropped = await freePort()
    send({ op: 'listen', id: 'f3', url: authorize(dropped, 'z') })
    await vi.waitFor(async () => { expect((await fetch(`http://127.0.0.1:${dropped}/nope`)).status).toBe(404) })
    sock.terminate()
    await vi.waitFor(async () => { await expect(fetch(`http://127.0.0.1:${dropped}/nope`)).rejects.toThrow() })
  })
})

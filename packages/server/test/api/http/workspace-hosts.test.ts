import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { routeWorkspaceHosts } from '#api/http/workspace-hosts'
import { handleFixture, installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'
import type { AccessMode } from '@yaac/shared/types'

/**
 * Workspace hostnames on the server's own listener, against a real HTTP
 * server standing in for the API and a real dev server the fake driver's
 * `dialPort` connects to, as the containerless driver's does.
 */

const ID = 'ab12cd34-1e83-4dd0-80f1-735294d5d2bb'
let api: http.Server
let dev: http.Server
let devPort: number
let mode: AccessMode = 'local'
const dialed: Array<[string, number]> = []

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as net.AddressInfo).port)
  }))
}

/** One request to the router with this Host, on a fresh connection. */
function get(host: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: (api.address() as net.AddressInfo).port, path: '/page', agent: false,
      headers: { host, ...headers },
    }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString('utf8') })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  dev = http.createServer((req, res) => res.end(`dev ${req.headers.host ?? ''} ${req.url ?? ''}`))
  // Echo an upgrade's first bytes back, as an HMR socket would carry them.
  dev.on('upgrade', (_req, socket: net.Socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk: Buffer) => socket.write(chunk))
    socket.on('end', () => socket.end())
  })
  devPort = await listen(dev)
  api = http.createServer((_req, res) => res.end('api'))
  routeWorkspaceHosts(api, () => mode)
  await listen(api)
})

afterAll(async () => {
  resetWorkspaceDriver()
  for (const server of [api, dev]) {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})

beforeEach(() => {
  mode = 'local'
  dialed.length = 0
  installFakeWorkspaceDriver({
    list: () => Promise.resolve([
      handleFixture({ workspaceId: ID }),
      handleFixture({ workspaceId: 'ab12cd34-ffff-4000-8000-000000000000', running: false }),
      handleFixture({ workspaceId: 'ab12cd34-eeee-4000-8000-000000000000', prewarmed: true }),
    ]),
    dialPort: (workspaceId, port) => {
      dialed.push([workspaceId, port])
      if (port !== 3000) return Promise.reject(new Error(`port ${String(port)} is not one this workspace is listening on`))
      return new Promise((resolve) => {
        const socket = net.connect(devPort, '127.0.0.1', () => resolve(socket))
        socket.pause()
      })
    },
  })
})

describe('routeWorkspaceHosts', () => {
  it('splices a workspace hostname to its port, Host untouched, and hands every other host to the server', async () => {
    expect(await get('localhost:8787')).toEqual({ status: 200, body: 'api' })
    expect(dialed).toEqual([])

    // Only the running, claimed workspace answers to the prefix.
    expect(await get('3000.ab12cd34.localhost:8787')).toEqual({ status: 200, body: 'dev 3000.ab12cd34.localhost:8787 /page' })
    expect(dialed).toEqual([[ID, 3000]])
  })

  it('carries a whole connection to the one port: keep-alive requests and an upgrade', async () => {
    const socket = net.connect((api.address() as net.AddressInfo).port, '127.0.0.1')
    const host = '3000.ab12cd34.localhost'
    let got = ''
    socket.on('data', (c: Buffer) => { got += c.toString('utf8') })
    const until = async (text: string): Promise<void> => {
      for (let i = 0; i < 200 && !got.includes(text); i++) await new Promise((r) => setTimeout(r, 10))
      expect(got).toContain(text)
    }
    socket.write(`GET /one HTTP/1.1\r\nHost: ${host}\r\n\r\n`)
    await until('/one')
    socket.write(`GET /hmr HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`)
    await until('101 Switching Protocols')
    socket.write('ping')
    await until('ping')
    socket.destroy()
    expect(dialed).toHaveLength(1)
  })

  it('answers a name it cannot serve itself, never handing it to the API', async () => {
    const unknown = await get('3000.00000000.localhost')
    expect(unknown.status).toBe(404)
    expect(unknown.body).toContain('no running workspace 00000000')
    const silent = await get('5173.ab12cd34.localhost')
    expect(silent.status).toBe(502)
    expect(silent.body).toContain('not one this workspace')
    // Through tailscale serve, or on a tailnet install, only the identified
    // tunnel reaches a workspace port.
    expect((await get('3000.ab12cd34.localhost', { 'x-forwarded-for': '100.64.0.1' })).status).toBe(403)
    mode = 'tailnet'
    expect((await get('3000.ab12cd34.localhost')).status).toBe(403)
    expect(dialed).toEqual([[ID, 5173]])
  })
})

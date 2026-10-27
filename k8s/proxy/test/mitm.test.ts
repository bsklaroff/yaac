import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { ProxyObjects } from 'yaac-proxy-sidecar/object-watch'
import { LABEL_WORKSPACE_ID, type RefreshedBundles } from 'yaac-proxy-sidecar/objects'
import { PLACEHOLDER_ACCESS_TOKEN, PLACEHOLDER_REFRESH_TOKEN } from 'yaac-proxy-sidecar/injection'
import { RefreshFlights } from 'yaac-proxy-sidecar/refresh-flight'
import { errorReply, type TokenReply } from 'yaac-proxy-sidecar/oauth-swap'
import { generateCA, handleMitm, type MitmContext } from 'yaac-proxy-sidecar/mitm'

/**
 * A MITM'd claude token refresh, end to end: a TLS client speaks to
 * `handleMitm`, whose upstream is redirected to a plain-HTTP mock standing
 * in for platform.claude.com.
 */

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64')

let upstreamBodies: Array<Record<string, unknown>>
let captured: Array<{ owner: string; bundles: RefreshedBundles }>
/** One MITM listener per workspace: `wa` is alice's, `wb` bob's. */
const mitmPorts: Record<string, number> = {}
let ctx: MitmContext
const servers: net.Server[] = []

beforeAll(async () => {
  const upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      upstreamBodies.push(JSON.parse(body) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }))
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  servers.push(upstream)

  const objects = new ProxyObjects({ loadSshKeys: () => Promise.resolve(), log: () => {} })
  await objects.applyCredentials({
    metadata: { name: 'yaac-proxy-credentials' },
    data: Object.fromEntries(['alice', 'bob'].map((owner) => [`${owner}.claude.json`, b64({
      kind: 'oauth',
      claudeAiOauth: { accessToken: `${owner}-access`, refreshToken: `${owner}-refresh`, expiresAt: 1, scopes: [] },
    })])),
  })
  for (const [ws, owner] of [['wa', 'alice'], ['wb', 'bob']]) {
    objects.applyRegistration({
      metadata: { name: `yaac-proxy-reg-${ws}`, labels: { [LABEL_WORKSPACE_ID]: ws } },
      data: { 'registration.json': JSON.stringify({ rules: [], allowedHosts: ['*'], tool: 'claude', projectId: 'demo', owner }) },
    })
  }
  ctx = {
    ca: generateCA(),
    objects,
    torAgent: null,
    refreshFlights: new RefreshFlights<TokenReply>((r) => r.rotatedTo, () => errorReply(504, 'slow')),
    captureRefreshed: (owner, bundles) => { captured.push({ owner, bundles }); objects.capture(owner, bundles) },
    noteGitUpstreamStatus: () => {},
  }
  const redirect = { host: '127.0.0.1', port: (upstream.address() as AddressInfo).port }
  for (const ws of ['wa', 'wb']) {
    const mitm = net.createServer((socket) => {
      handleMitm(ctx, socket, 'platform.claude.com', '443', ws, [], redirect, null)
    })
    await new Promise<void>((r) => mitm.listen(0, '127.0.0.1', r))
    servers.push(mitm)
    mitmPorts[ws] = (mitm.address() as AddressInfo).port
  }
}, 60_000)

afterAll(() => {
  keepAlive.destroy()
  for (const s of servers) s.close()
})

/** POST a refresh grant through the MITM, as claude would. */
function refresh(refreshToken: string, workspaceId = 'wa'): Promise<Record<string, unknown>> {
  upstreamBodies = []
  captured = []
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port: mitmPorts[workspaceId],
      servername: 'platform.claude.com',
      ca: ctx.ca.pem,
      method: 'POST',
      path: '/v1/oauth/token',
      headers: { 'host': 'platform.claude.com', 'content-type': 'application/json' },
    }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => { resolve(JSON.parse(body) as Record<string, unknown>) })
    })
    req.on('error', reject)
    req.end(JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }))
  })
}

/** Alice's MITM over one kept-alive connection, so every request after the first rides it. */
const keepAlive = new https.Agent({ keepAlive: true, maxSockets: 1 })

/** A request through `keepAlive` (an upgrade when `upgrade`); resolves with its status and whether it reused the connection. */
function send(path: string, host: string, upgrade = false): Promise<{ status: number; reused: boolean }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port: mitmPorts.wa,
      // Pinned, or Node would take the SNI from the Host header.
      servername: 'platform.claude.com',
      ca: ctx.ca.pem,
      agent: keepAlive,
      method: upgrade ? 'GET' : 'POST',
      path,
      headers: upgrade
        ? { host, connection: 'Upgrade', upgrade: 'websocket' }
        : { host, 'content-type': 'application/json' },
    }, (res) => {
      res.resume()
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }) })
    })
    req.on('error', reject)
    req.end(upgrade ? undefined : '{}')
  })
}

describe('handleMitm', () => {
  it('refuses every request on a connection that names another host than the connection\'s', async () => {
    // Credentials are chosen for platform.claude.com; a Host header or an
    // absolute-form target naming a CDN neighbor must not carry them there,
    // on the connection's first request or any later one.
    upstreamBodies = []
    const results = []
    for (const [path, host, upgrade] of [
      ['/v1/oauth/token', 'platform.claude.com', false],
      ['/v1/oauth/token', 'evil.example', false],
      ['https://evil.example/v1/oauth/token', 'platform.claude.com', false],
      // The same host, with its case, port or trailing dot spelled otherwise.
      ['/v1/oauth/token', 'Platform.Claude.com.:443', false],
      ['/ws', 'evil.example', true],
      ['wss://evil.example/ws', 'platform.claude.com', true],
    ] as const) {
      results.push(await send(path, host, upgrade))
    }
    expect(results.map((r) => r.status)).toEqual([200, 421, 421, 200, 421, 421])
    expect(results.slice(1, 5).every((r) => r.reused)).toBe(true)
    expect(upstreamBodies).toHaveLength(2)
  }, 60_000)

  it('spends the real refresh token only for the placeholder, and captures that rotation', async () => {
    // A refresh token the proxy did not hand out travels as itself, and
    // its answer is neither captured nor rewritten.
    const foreign = await refresh('someone-elses-token')
    expect(upstreamBodies[0].refresh_token).toBe('someone-elses-token')
    expect(captured).toEqual([])
    expect(foreign.refresh_token).toBe('new-refresh')

    const ours = await refresh(PLACEHOLDER_REFRESH_TOKEN)
    expect(upstreamBodies[0].refresh_token).toBe('alice-refresh')
    expect(captured).toHaveLength(1)
    expect(captured[0].owner).toBe('alice')
    expect(captured[0].bundles.claude).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' })
    expect(ours).toMatchObject({ access_token: PLACEHOLDER_ACCESS_TOKEN, refresh_token: PLACEHOLDER_REFRESH_TOKEN })
  }, 60_000)

  it('spends and writes back the refreshing workspace owner\'s credential only', async () => {
    // Alice's rotation moments ago is no answer for bob: his refresh is its
    // own flight, spending his own token.
    await refresh(PLACEHOLDER_REFRESH_TOKEN, 'wb')
    expect(upstreamBodies[0].refresh_token).toBe('bob-refresh')
    expect(captured.map((c) => c.owner)).toEqual(['bob'])
    expect(ctx.objects.claudeOAuthBundle('bob')).toMatchObject({ accessToken: 'new-access' })
    expect(ctx.objects.claudeOAuthBundle('alice')).toMatchObject({ refreshToken: 'new-refresh' })
  }, 60_000)
})

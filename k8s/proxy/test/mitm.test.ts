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
let captured: RefreshedBundles[]
let mitmPort: number
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
    data: { 'claude.json': b64({
      kind: 'oauth',
      claudeAiOauth: { accessToken: 'real-access', refreshToken: 'real-refresh', expiresAt: 1, scopes: [] },
    }) },
  })
  objects.applyRegistration({
    metadata: { name: 'yaac-proxy-reg-ws', labels: { [LABEL_WORKSPACE_ID]: 'ws' } },
    data: { 'registration.json': JSON.stringify({ rules: [], allowedHosts: ['*'], tool: 'claude', projectId: 'demo' }) },
  })
  ctx = {
    ca: generateCA(),
    objects,
    torAgent: null,
    refreshFlights: new RefreshFlights<TokenReply>((r) => r.rotatedTo, () => errorReply(504, 'slow')),
    captureRefreshed: (b) => { captured.push(b); objects.capture(b) },
    noteGitUpstreamStatus: () => {},
  }
  const redirect = { host: '127.0.0.1', port: (upstream.address() as AddressInfo).port }
  const mitm = net.createServer((socket) => {
    handleMitm(ctx, socket, 'platform.claude.com', '443', 'ws', [], redirect)
  })
  await new Promise<void>((r) => mitm.listen(0, '127.0.0.1', r))
  servers.push(mitm)
  mitmPort = (mitm.address() as AddressInfo).port
}, 60_000)

afterAll(() => { for (const s of servers) s.close() })

/** POST a refresh grant through the MITM, as claude would. */
function refresh(refreshToken: string): Promise<Record<string, unknown>> {
  upstreamBodies = []
  captured = []
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port: mitmPort,
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

describe('handleMitm', () => {
  it('spends the real refresh token only for the placeholder, and captures that rotation', async () => {
    // A refresh token the proxy did not hand out travels as itself, and
    // its answer is neither captured nor rewritten.
    const foreign = await refresh('someone-elses-token')
    expect(upstreamBodies[0].refresh_token).toBe('someone-elses-token')
    expect(captured).toEqual([])
    expect(foreign.refresh_token).toBe('new-refresh')

    const ours = await refresh(PLACEHOLDER_REFRESH_TOKEN)
    expect(upstreamBodies[0].refresh_token).toBe('real-refresh')
    expect(captured[0].claude).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' })
    expect(ours).toMatchObject({ access_token: PLACEHOLDER_ACCESS_TOKEN, refresh_token: PLACEHOLDER_REFRESH_TOKEN })
  }, 60_000)
})

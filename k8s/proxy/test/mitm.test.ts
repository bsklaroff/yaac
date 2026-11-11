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
 * MITM'd requests, end to end: a TLS client speaks to `handleMitm`, whose
 * upstream is redirected to a plain-HTTP mock standing in for
 * platform.claude.com (a claude token refresh) or for github.com (git over
 * https to the project's repos).
 */

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64')

let upstreamBodies: Array<Record<string, unknown>>
let captured: Array<{ owner: string; bundles: RefreshedBundles }>
/** One MITM listener per workspace: `wa` is alice's, `wb` bob's. */
const mitmPorts: Record<string, number> = {}
let ctx: MitmContext
const servers: net.Server[] = []
/** What the mock git host saw, and the port of alice's MITM listener for it. */
let gitRequests: Array<{ method: string; url: string; authorization?: string; body: string }>
let gitPort = 0

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

  const objects = new ProxyObjects({ log: () => {} })
  const grant = (path: string, readOnly: boolean) =>
    ({ projectId: 'demo', repoId: `repo-${path}`, host: 'github.com', path, readOnly, ghToken: true })
  objects.applyCredentials({
    metadata: { name: 'yaac-proxy-credentials' },
    data: {
      ...Object.fromEntries(['alice', 'bob'].map((owner) => [`${owner}.claude.json`, b64({
        kind: 'oauth',
        claudeAiOauth: { accessToken: `${owner}-access`, refreshToken: `${owner}-refresh`, expiresAt: 1, scopes: [] },
      })])),
      'alice.git-tokens.json': b64([
        { token: 'ghp_rw', grants: [grant('acme/repo', false)] },
        { token: 'ghp_ro', grants: [grant('acme/ro', true)] },
      ]),
    },
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

  const gitHost = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      gitRequests.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body })
      res.end('ok')
    })
  })
  await new Promise<void>((r) => gitHost.listen(0, '127.0.0.1', r))
  servers.push(gitHost)
  const gitMitm = net.createServer((socket) => {
    handleMitm(ctx, socket, 'github.com', '443', 'wa', [], { host: '127.0.0.1', port: (gitHost.address() as AddressInfo).port }, null)
  })
  await new Promise<void>((r) => gitMitm.listen(0, '127.0.0.1', r))
  servers.push(gitMitm)
  gitPort = (gitMitm.address() as AddressInfo).port
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

/** A request from alice's workspace to github.com; resolves with the
 *  status and body the workspace reads. */
function git(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: gitPort, servername: 'github.com', ca: ctx.ca.pem, method, path,
      headers: { host: 'github.com', ...(body !== undefined ? { 'content-type': 'application/vnd.git-lfs+json' } : {}) },
    }, (res) => {
      let text = ''
      res.on('data', (c: Buffer) => { text += c.toString() })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: text }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('handleMitm', () => {
  it('sends each repo\'s token under its own path only, and refuses a read-only repo every git write', async () => {
    gitRequests = []
    const basic = (t: string): string => `Basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`
    const download = JSON.stringify({ operation: 'download', objects: [{ oid: 'a', size: 1 }] })
    const upload = JSON.stringify({ operation: 'upload', objects: [{ oid: 'a', size: 1 }] })

    // What passes, each with the token the host sees.
    const passes: Array<[method: string, path: string, token: string | undefined, body?: string]> = [
      ['GET', '/acme/repo.git/info/refs?service=git-receive-pack', 'ghp_rw'],
      ['POST', '/acme/repo.git/git-receive-pack', 'ghp_rw', 'pack'],
      ['POST', '/acme/repo.git/info/lfs/objects/batch', 'ghp_rw', upload],
      // The read-only repo still fetches, and downloads from LFS: the
      // batch body reaches the host as it was sent.
      ['GET', '/acme/ro.git/info/refs?service=git-upload-pack', 'ghp_ro'],
      ['POST', '/acme/ro.git/git-upload-pack', 'ghp_ro', 'wants'],
      ['POST', '/acme/ro.git/info/lfs/objects/batch', 'ghp_ro', download],
      ['POST', '/acme/ro.git/info/lfs/locks/verify', 'ghp_ro', '{}'],
      ['GET', '/acme/ro.git/info/lfs/locks', 'ghp_ro'],
      // A repo the project does not link passes with no token.
      ['GET', '/acme/elsewhere.git/info/refs?service=git-upload-pack', undefined],
    ]
    for (const [method, path, token, body] of passes) {
      expect(await git(method, path, body), path).toEqual({ status: 200, body: 'ok' })
      expect(gitRequests.at(-1), path).toEqual({
        method, url: path, authorization: token === undefined ? undefined : basic(token), body: body ?? '',
      })
    }

    // What a read-only repo refuses, under every spelling of its path:
    // everything but the reads above. None of it reaches the host.
    const seen = gitRequests.length
    const refused: Array<[method: string, path: string, body?: string]> = [
      ['GET', '/acme/ro.git/info/refs?service=git-receive-pack'],
      ['POST', '/acme/ro.git/git-receive-pack', 'pack'],
      ['POST', '/acme/ro/git-receive-pack', 'pack'],
      ['POST', '/Acme/RO.git/git-receive-pack', 'pack'],
      ['POST', '/acme/%72o.git/git-receive-pack', 'pack'],
      ['POST', '/acme/repo.git/../ro.git/git-receive-pack', 'pack'],
      ['POST', '/acme//ro.git/git-receive-pack', 'pack'],
      // A spelling of the request a host might still route to a push.
      ['POST', '/acme/ro/Git-Receive-Pack', 'pack'],
      ['POST', '/acme/ro/git-receive-pack;x', 'pack'],
      ['GET', '/acme/ro/info/refs?service=GIT-RECEIVE-PACK'],
      // Nothing but the known reads passes.
      ['POST', '/acme/ro/anything-else', '{}'],
      ['PUT', '/acme/ro.git/info/lfs/objects/abc', 'bytes'],
      ['POST', '/acme/ro.git/info/lfs/objects/batch', upload],
      ['POST', '/acme/ro.git/info/lfs/objects/batch', 'not json'],
      ['POST', '/acme/ro.git/info/lfs/locks', '{}'],
      ['POST', '/acme/ro.git/info/lfs/locks/7/unlock', '{}'],
    ]
    for (const [method, path, body] of refused) {
      const answer = await git(method, path, body)
      expect(answer.status, path).toBe(403)
      expect(answer.body, path).toContain('github.com/acme/ro is read-only in this project')
    }
    expect(gitRequests).toHaveLength(seen)
  })

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

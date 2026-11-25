import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { createYaacTestEnv, runYaac, setTestGitIdentity, type YaacTestEnv } from '#support/cli'
import { addTestProject } from '#support/cluster'
import { createTestRepo } from '@yaac/test-utils/setup'
import { assignTestGitCredential } from '@yaac/test-utils/api'
import { freeLocalPort } from '@yaac/test-utils/kubectl-forward'
import { readLock } from '@yaac/shared/lock'
import type { ServerLock } from '@yaac/shared/server-lock-file'
import { tokenKeyFingerprint } from '@yaac/shared/token-tls'

/**
 * The token listener on a host server (docs/remote-hosting.md "Token
 * access"), through the real CLI and plain HTTPS: one server for the file,
 * started by `yaac server start --token-listen` on a free loopback port.
 * Bindings are made over the main origin as a person; the calls that use
 * them go to the token origin, trusting the generated certificate as their
 * CA. The OIDC issuer is a local stub the server's issuer fetches are sent
 * to (`YAAC_E2E_OIDC_ORIGIN`). The delete runs last.
 */

const ISSUER = 'https://issuer.example'

describe('the token listener (real CLI + host server)', () => {
  let testEnv: YaacTestEnv
  let env: NodeJS.ProcessEnv
  let listen: string
  let ca: string
  let lock: ServerLock
  let issuer: http.Server
  let signingKey: CryptoKey
  const keys: JWK[] = []
  const tokens: Record<string, string> = {}

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true })
    signingKey = privateKey
    keys.push({ ...await exportJWK(publicKey), kid: 'k1', alg: 'ES256', use: 'sig' })
    issuer = http.createServer((req, res) => {
      const body = req.url === '/.well-known/openid-configuration' ? { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }
        : req.url === '/jwks' ? { keys } : undefined
      res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body ?? {}))
    })
    await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', resolve))

    testEnv = await createYaacTestEnv()
    const home = path.join(testEnv.dataDir, '..', 'home')
    await fs.mkdir(home, { recursive: true })
    env = {
      ...testEnv.env,
      YAAC_E2E_OIDC_ORIGIN: `http://127.0.0.1:${String((issuer.address() as AddressInfo).port)}`,
      YAAC_E2E_SKIP_FETCH: '1',
      YAAC_E2E_NO_ATTACH: '1',
      HOME: home,
      SHELL: '/bin/sh',
    }
    listen = `127.0.0.1:${String(await freeLocalPort())}`
  })

  afterAll(async () => {
    await runYaac(env, 'server', 'stop')
    await testEnv.cleanup()
    await new Promise<void>((resolve) => issuer.close(() => resolve()))
  })

  /** A request to the token origin, trusting the generated certificate. */
  function call(route: string, opts: { token?: string; method?: string; body?: unknown } = {}): Promise<{ status: number; text: string }> {
    const [host, port] = listen.split(':')
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    return new Promise((resolve, reject) => {
      const req = https.request({
        host, port: Number(port), path: route, method: opts.method ?? 'GET', ca,
        headers: {
          ...(opts.token !== undefined ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
      }, (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => { text += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      })
      req.on('error', reject)
      req.end(payload)
    })
  }

  async function yaac(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    const r = await runYaac(env, ...args)
    expect(r.exitCode, `${args.join(' ')}\n${r.stderr}`).toBe(0)
    return r
  }

  it('refuses a wildcard address, an address it cannot bind, and any token listener inside a workspace', async () => {
    const wildcard = await runYaac(env, 'server', 'start', '--token-listen', '0.0.0.0:8443')
    expect(wildcard.exitCode).toBe(1)
    expect(wildcard.stderr).toMatch(/wildcard address/)
    const nested = await runYaac({ ...env, YAAC_WORKSPACE_ID: 'w1' }, 'server', 'start', '--token-listen', listen)
    expect(nested.exitCode).toBe(1)
    expect(nested.stderr).toMatch(/inside a workspace takes no --token-listen/)
    expect(await readLock()).toBeNull()
    // TEST-NET-1: an address no interface here holds.
    const unbound = await runYaac(env, 'server', 'start', '--token-listen', `192.0.2.1:${listen.split(':')[1]}`)
    expect(unbound.exitCode).toBe(1)
    expect(unbound.stderr).toMatch(/refused to start: the token listener cannot start: .*EADDRNOTAVAIL/)
    expect(await readLock()).toBeNull()
  })

  it('starts with the listener, printing its key fingerprint, the certificate and the host-execution warning', async () => {
    const first = await yaac('server', 'start', '--token-listen', listen)
    const fingerprint = /key fingerprint: (sha256\/\/\S+)/.exec(first.stderr)?.[1]
    const certificate = /certificate: (\S+)/.exec(first.stderr)?.[1]
    expect(first.stderr).toMatch(/code execution on this machine/)
    ca = await fs.readFile(certificate ?? '', 'utf8')
    expect(tokenKeyFingerprint(ca)).toBe(fingerprint)

    // A second start finds it running as asked and prints the same key.
    const again = await yaac('server', 'start', '--token-listen', listen)
    expect(again.stderr).toContain(fingerprint)
    const restarted = await yaac('server', 'restart', '--token-listen', listen)
    expect(restarted.stderr).toContain(fingerprint)
    lock = (await readLock()) as ServerLock
    await setTestGitIdentity(env)
    expect((await yaac('server', 'status')).stdout).toContain(`token listener: https://${listen}`)
    const without = await runYaac(env, 'server', 'start')
    expect(without.exitCode).toBe(1)
    expect(without.stderr).toMatch(/running with a token listener/)
  })

  it('makes, binds and lists tokens as a person, another user\'s through --user', async () => {
    tokens.ci = (await yaac('token', 'create', 'ci', '--expires', '30d', '--permission-mode', 'bypass')).stdout.trim()
    tokens.low = (await yaac('token', 'create', 'low')).stdout.trim()
    expect(tokens.ci).toMatch(/^yaac_pat_/)
    const create = await runYaac(env, 'token', 'create', 'bad', '--expires', 'soon')
    expect(create.exitCode).toBe(1)
    expect(create.stderr).toMatch(/--expires takes a duration/)

    const audience = (await yaac(
      'token', 'bind', 'svc', '--issuer', ISSUER, '--subject', 'svc-1', '--claim', 'team=infra', '--permission-mode', 'plan', '--expires', '1d',
    )).stdout.trim()
    expect(audience).toMatch(/^yaac:/)
    tokens.oidc = await new SignJWT({ sub: 'svc-1', team: 'infra' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(ISSUER).setAudience(audience)
      .setIssuedAt().setExpirationTime('10m').sign(signingKey)

    const listed = await yaac('token', 'list')
    expect(listed.stdout).toMatch(/ci\s+pat\s+bypass/)
    expect(listed.stdout).toMatch(/low\s+pat\s+accept-edits/)
    expect(listed.stdout).toMatch(/svc\s+oidc\s+plan/)
    expect(listed.stderr).toMatch(/key fingerprint: sha256\/\//)
    // A local install's one user is its admin, and --user names them here.
    expect((await yaac('--user', 'local', 'token', 'list')).stdout).toMatch(/ci\s+pat/)
  })

  it('serves a token\'s calls over HTTPS as its user\'s delegate, and nothing without one', async () => {
    const who = await call('/api/whoami', { token: tokens.ci })
    expect(who.status, who.text).toBe(200)
    expect(JSON.parse(who.text)).toMatchObject({ kind: 'delegate', via: { kind: 'token', label: 'token ci' }, ceiling: 'bypass' })
    expect((await call('/api/project/list', { token: tokens.ci })).status).toBe(200)
    expect((await call('/api/whoami')).status).toBe(401)
    expect((await call('/api/token', { token: tokens.ci })).status).toBe(403)

    const oidc = await call('/api/whoami', { token: tokens.oidc })
    expect(oidc.status, oidc.text).toBe(200)
    expect(JSON.parse(oidc.text)).toMatchObject({ via: { label: 'token svc' }, ceiling: 'plan' })

    const repo = await createTestRepo(path.join(testEnv.dataDir, '..', 'demo'))
    const server = { lock, stop: () => Promise.resolve() }
    const projectId = await addTestProject(server, repo)
    await assignTestGitCredential(server, projectId, 'ghp_token_suite')
    const created = await call('/api/workspace/create', { token: tokens.ci, method: 'POST', body: { project: projectId, noSession: true } })
    expect(created.status, created.text).toBe(200)
    expect(created.text).toMatch(/"workspaceId"/)
    expect(created.text).not.toMatch(/"type":"error"/)
    // The workspace records what created it.
    const workspaceId = /"workspaceId":"([^"]+)"/.exec(created.text)?.[1]
    const listed = JSON.parse((await call('/api/workspace/list', { token: tokens.ci })).text) as { workspaces: Array<{ workspaceId: string; createdVia?: string }> }
    expect(listed.workspaces.find((w) => w.workspaceId === workspaceId)?.createdVia).toBe('token ci')
    // Above the binding's ceiling.
    const above = await call('/api/workspace/create', {
      token: tokens.low, method: 'POST', body: { project: projectId, tool: 'claude', permissionMode: 'bypass' },
    })
    expect(above.status, above.text).toBe(400)
    expect(above.text).toMatch(/accept-edits/)
  })

  it('stops a deleted token from its next request', async () => {
    expect((await call('/api/whoami', { token: tokens.low })).status).toBe(200)
    await yaac('token', 'delete', 'low')
    expect((await call('/api/whoami', { token: tokens.low })).status).toBe(401)
    expect((await yaac('token', 'list')).stdout).not.toMatch(/\blow\b/)
  })
})

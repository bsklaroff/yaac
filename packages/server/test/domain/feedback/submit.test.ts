import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { ServerError } from '@yaac/shared/errors'
import { feedbackKeyPath, feedbackUrlPath } from '@yaac/shared/project-paths'
import { BUILT_IN_USER_ID, closeDb, setGitIdentity } from '#db'
import { feedbackHost, rememberFeedbackUrl, submitFeedback } from '#domain/feedback'
import { installFakeWorkspaceDriver, resetWorkspaceDriver } from '#test/support/fake-driver'

/** A PNG's signature, which is all `sniffImage` reads. */
const PNG = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64')
const local = { kind: 'local', userId: BUILT_IN_USER_ID } as const

/** What the endpoint received, verified the way it would verify it. */
interface Received {
  path: string
  key: string
  verified: boolean
  body: { message: string; images: unknown[]; sentAt: string; from: unknown; server: unknown; client: unknown }
}

let tmpDir: string
let received: Received[]
/** How the endpoint answers the next request. */
let answer: { status: number; headers?: Record<string, string> }
let endpoint: http.Server
let url: string

// The endpoint is the process boundary: a real listener, which checks each
// request against the public key it names.
beforeAll(async () => {
  tmpDir = await createTempDataDir()
  endpoint = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const key = String(req.headers['x-yaac-key'])
      const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' })
      received.push({
        path: req.url ?? '',
        key,
        verified: crypto.verify(null, raw, publicKey, Buffer.from(String(req.headers['x-yaac-signature']), 'base64url')),
        body: JSON.parse(raw.toString('utf8')) as Received['body'],
      })
      res.writeHead(answer.status, answer.headers).end('an upstream body the user never sees')
    })
  })
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${String((endpoint.address() as AddressInfo).port)}/v1`
})

afterAll(async () => {
  endpoint.close()
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(() => {
  installFakeWorkspaceDriver({ kind: 'containerless' })
  received = []
  answer = { status: 200 }
  vi.stubEnv('YAAC_FEEDBACK_URL', url)
  vi.stubEnv('YAAC_BUILD_ID', 'build-abc')
  vi.stubEnv('YAAC_VERSION', '1.2.3')
  vi.stubEnv('YAAC_GIT_COMMIT', 'abc123')
})

afterEach(() => {
  resetWorkspaceDriver()
  vi.unstubAllEnvs()
})

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (err: unknown) => (err as ServerError).code)
}

describe('submitFeedback', () => {
  it('signs every send with one install key, and says what server and client sent it', async () => {
    const alice = { kind: 'tailnet', userId: 'u1', login: 'alice@example.com', name: 'Alice' } as const
    const client = { version: '1.2.2', gitCommit: 'def456', userAgent: 'Mozilla/5.0', app: { kind: 'ios', version: '0.1.0', build: '2' } }
    expect(await submitFeedback(alice, { message: 'first', client })).toEqual({ host: new URL(url).host })
    await submitFeedback(alice, { message: 'second' })

    expect(received.map((r) => r.verified)).toEqual([true, true])
    expect(received[1].key).toBe(received[0].key)
    expect(received[0].body).toMatchObject({
      message: 'first',
      images: [],
      server: { version: '1.2.3', gitCommit: 'abc123', buildId: 'build-abc', driver: 'containerless' },
      client: { ...client, app: { kind: 'ios', version: '0.1.0', build: '2', gitCommit: null } },
    })
    expect(received[1].body.client).toBeNull()
    expect(Date.now() - Date.parse(received[0].body.sentAt)).toBeLessThan(60_000)
    expect((await fs.stat(feedbackKeyPath())).mode & 0o777).toBe(0o600)
  })

  it('names a tailnet caller by their login, a local one by their git identity', async () => {
    await submitFeedback({ kind: 'tailnet', userId: 'u1', login: 'alice@example.com', name: 'Alice' }, { message: 'a' })
    await submitFeedback(local, { message: 'b' })
    await setGitIdentity(BUILT_IN_USER_ID, { name: 'Bea', email: 'bea@example.com' })
    await submitFeedback(local, { message: 'c' })

    expect(received.map((r) => r.body.from)).toEqual([
      { source: 'tailscale', email: 'alice@example.com', name: 'Alice' },
      null,
      { source: 'git', email: 'bea@example.com', name: 'Bea' },
    ])
  })

  it('sends screenshots typed by their bytes, and nothing when one is not an image', async () => {
    await submitFeedback(local, { message: 'see attached', images: [{ mimeType: 'image/jpeg', data: PNG }] })
    expect(received[0].verified).toBe(true)
    expect(received[0].body.images).toEqual([{ mimeType: 'image/png', data: PNG }])

    const refused = submitFeedback(local, { message: 'and this', images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }] })
    expect(await codeOf(refused)).toBe('VALIDATION')
    expect(received).toHaveLength(1)
  })

  it('agrees on one key across concurrent first sends, and replaces one that does not parse', async () => {
    await fs.rm(feedbackKeyPath(), { force: true })
    await Promise.all([1, 2, 3, 4].map((n) => submitFeedback(local, { message: String(n) })))
    expect(received.every((r) => r.verified)).toBe(true)
    expect(new Set(received.map((r) => r.key)).size).toBe(1)

    await fs.writeFile(feedbackKeyPath(), 'garbage')
    await submitFeedback(local, { message: 'after' })
    expect(received[4].verified).toBe(true)
    expect(received[4].key).not.toBe(received[0].key)
  })

  it('refuses without an endpoint, and fails when the endpoint does, never following a redirect', async () => {
    vi.stubEnv('YAAC_FEEDBACK_URL', '')
    expect(await codeOf(submitFeedback(local, { message: 'x' }))).toBe('NOT_SUPPORTED')
    vi.stubEnv('YAAC_FEEDBACK_URL', 'not a url')
    expect(await codeOf(submitFeedback(local, { message: 'x' }))).toBe('NOT_SUPPORTED')
    expect(received).toEqual([])

    vi.stubEnv('YAAC_FEEDBACK_URL', url)
    answer = { status: 500 }
    await expect(submitFeedback(local, { message: 'x' })).rejects.toThrow(/^the feedback endpoint answered 500$/)

    // A redirect is not followed, so the report reaches only the configured URL.
    answer = { status: 307, headers: { location: '/elsewhere' } }
    await expect(submitFeedback(local, { message: 'x' })).rejects.toThrow('answered 307, a redirect')
    expect(received.map((r) => r.path)).toEqual(['/v1', '/v1'])

    const closed = http.createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address() as AddressInfo
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    vi.stubEnv('YAAC_FEEDBACK_URL', `http://127.0.0.1:${String(port)}/v1`)
    await expect(submitFeedback(local, { message: 'x' })).rejects.toThrow(`could not reach the feedback endpoint at 127.0.0.1:${String(port)}`)
  })
})

describe('feedbackHost', () => {
  it('is the endpoint\'s host, or null when there is none', () => {
    expect(feedbackHost()).toBe(new URL(url).host)
    vi.stubEnv('YAAC_FEEDBACK_URL', 'https://feedback.example.test:8443/v1')
    expect(feedbackHost()).toBe('feedback.example.test:8443')
    vi.stubEnv('YAAC_FEEDBACK_URL', 'not a url')
    expect(feedbackHost()).toBeNull()
    vi.stubEnv('YAAC_FEEDBACK_URL', '')
    expect(feedbackHost()).toBeNull()
  })
})

describe('rememberFeedbackUrl', () => {
  it('keeps the last value a start was given for a start without one, else yaac.dev', async () => {
    // Off until settled, so a request served earlier cannot reach the default.
    vi.stubEnv('YAAC_FEEDBACK_URL', undefined)
    expect(feedbackHost()).toBeNull()
    await rememberFeedbackUrl()
    expect(feedbackHost()).toBe('yaac.dev')

    // Off survives a start from an environment that never set it.
    vi.stubEnv('YAAC_FEEDBACK_URL', '')
    await rememberFeedbackUrl()
    vi.stubEnv('YAAC_FEEDBACK_URL', undefined)
    await rememberFeedbackUrl()
    expect(feedbackHost()).toBeNull()
    expect(await codeOf(submitFeedback(local, { message: 'x' }))).toBe('NOT_SUPPORTED')

    vi.stubEnv('YAAC_FEEDBACK_URL', url)
    await rememberFeedbackUrl()
    vi.stubEnv('YAAC_FEEDBACK_URL', undefined)
    await rememberFeedbackUrl()
    expect(await fs.readFile(feedbackUrlPath(), 'utf8')).toBe(url)
    expect(await submitFeedback(local, { message: 'kept' })).toEqual({ host: new URL(url).host })
    expect(received.map((r) => r.body.message)).toEqual(['kept'])
  })
})

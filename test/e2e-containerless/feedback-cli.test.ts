import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { createYaacTestEnv, runYaac, setTestGitIdentity, spawnYaacServer, type YaacTestEnv } from '#support/cli'
import type { SpawnedServer } from '@yaac/test-utils/api'

/** A PNG's signature, which is all the server's type check reads. */
const PNG = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')

/**
 * `yaac feedback` through a real server, which forwards to an endpoint this
 * file stands in for and checks the way docs/feedback.md says the real one
 * should.
 */
describe('yaac feedback (real CLI + shared server)', () => {
  let testEnv: YaacTestEnv
  let server: SpawnedServer
  let endpoint: http.Server
  const received: Array<{ verified: boolean; body: Record<string, unknown> }> = []

  beforeAll(async () => {
    endpoint = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks)
        const key = crypto.createPublicKey({
          key: { kty: 'OKP', crv: 'Ed25519', x: String(req.headers['x-yaac-key']) }, format: 'jwk',
        })
        received.push({
          verified: crypto.verify(null, raw, key, Buffer.from(String(req.headers['x-yaac-signature']), 'base64url')),
          body: JSON.parse(raw.toString('utf8')) as Record<string, unknown>,
        })
        res.writeHead(200).end()
      })
    })
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
    testEnv = await createYaacTestEnv()
    const url = `http://127.0.0.1:${String((endpoint.address() as AddressInfo).port)}/`
    server = await spawnYaacServer({ ...testEnv.env, YAAC_FEEDBACK_URL: url })
    await setTestGitIdentity(testEnv.env)
  })

  afterAll(async () => {
    await server.stop()
    await testEnv.cleanup()
    endpoint.close()
  })

  it('sends the message and each --image, signed, with who and what sent it', async () => {
    const shot = path.join(testEnv.scratchDir, 'shot.png')
    await fs.writeFile(shot, PNG)
    const res = await runYaac(testEnv.env, 'feedback', 'the sidebar flickers', '--image', shot, '--image', shot)
    expect(res.exitCode, res.stderr).toBe(0)
    expect(res.stdout).toContain('Feedback sent to 127.0.0.1:')

    expect(received).toHaveLength(1)
    const [{ verified, body }] = received
    expect(verified).toBe(true)
    expect(body).toMatchObject({
      message: 'the sidebar flickers',
      images: [1, 2].map(() => ({ mimeType: 'image/png', data: PNG.toString('base64') })),
      from: { source: 'git', name: 'Test User', email: 'test@example.com' },
      server: { driver: 'containerless' },
      client: { userAgent: expect.stringMatching(/^yaac-cli node\//) as unknown },
    })
  })

  it('refuses an --image that is not one, sending nothing', async () => {
    const notes = path.join(testEnv.scratchDir, 'notes.txt')
    await fs.writeFile(notes, 'not an image')
    const res = await runYaac(testEnv.env, 'feedback', 'see attached', '--image', notes)
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toMatch(/not a PNG, JPEG, GIF or WebP/)
    expect(received).toHaveLength(1)
  })

  it('refuses inside a workspace, where an agent would send in the owner\'s name', async () => {
    const res = await runYaac({ ...testEnv.env, YAAC_WORKSPACE_ID: 'ws-1' }, 'feedback', 'sent by an agent')
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('does not run inside a workspace')
    expect(received).toHaveLength(1)
  })
})

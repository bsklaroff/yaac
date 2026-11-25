import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { freeLocalPort } from '@yaac/test-utils/kubectl-forward'
import { planTokenCertificate, type TokenTlsPair } from '@yaac/shared/token-tls'
import { startTokenListener } from '#main/token-listener'

/**
 * The token listener's certificate handling: it binds once a whole,
 * matching pair is in its directory, re-reads the directory every 30 s,
 * keeps the last good pair when the new one does not match, and swaps a
 * new good one in without rebinding. Requests carry no token, so each is a
 * 401 from the listener itself, which is enough to show which certificate
 * it served.
 */
let dir: string
let port: number
let close: (() => Promise<void>) | undefined

/** Write a pair into the listener's directory. */
async function place(pair: TokenTlsPair): Promise<void> {
  await fs.writeFile(path.join(dir, 'tls.key'), pair.key)
  await fs.writeFile(path.join(dir, 'tls.crt'), pair.cert)
}

/** The status the listener answers, trusting only `ca`; an error message
 *  when the TLS handshake fails. */
function ask(ca: string): Promise<number | string> {
  return new Promise((resolve) => {
    https.get({ host: '127.0.0.1', port, path: '/api/health', ca, agent: false }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', (err) => resolve(err.message))
  })
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-listener-'))
  port = await freeLocalPort()
  vi.stubEnv('YAAC_TOKEN_LISTEN', `127.0.0.1:${String(port)}`)
  vi.stubEnv('YAAC_TOKEN_TLS_DIR', dir)
  vi.useFakeTimers({ toFake: ['setInterval'] })
})

afterEach(async () => {
  await close?.()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('startTokenListener', () => {
  it('binds once a pair appears, keeps the last good pair, and swaps in a new one', async () => {
    const first = (await planTokenCertificate(undefined, '127.0.0.1')) as TokenTlsPair
    const second = (await planTokenCertificate(undefined, '127.0.0.1')) as TokenTlsPair
    close = (await startTokenListener({ buildId: 'test' }))?.close
    expect(await ask(first.cert)).toMatch(/ECONNREFUSED/)

    await place(first)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(async () => { expect(await ask(first.cert)).toBe(401) })

    // A certificate on another key is not served; the first pair stays.
    await place({ cert: second.cert, key: first.key })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await ask(first.cert)).toBe(401)

    await place(second)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(async () => { expect(await ask(second.cert)).toBe(401) })
    expect(await ask(first.cert)).not.toBe(401)
  })

  it('binds at once with a pair in place, and fails on an address it cannot bind', async () => {
    await place((await planTokenCertificate(undefined, '127.0.0.1')) as TokenTlsPair)
    vi.stubEnv('YAAC_TOKEN_LISTEN', `192.0.2.1:${String(port)}`)
    await expect(startTokenListener({ buildId: 'test' })).rejects.toThrow(/EADDRNOTAVAIL/)
    vi.stubEnv('YAAC_WORKSPACE_ID', 'w1')
    await expect(startTokenListener({ buildId: 'test' })).rejects.toThrow(/inside a workspace/)
  })
})

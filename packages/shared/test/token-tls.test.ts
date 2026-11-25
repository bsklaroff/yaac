import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ensureTokenTlsDir,
  formatTokenListen,
  parseTokenListen,
  planTokenCertificate,
  readTokenTlsDir,
  tokenKeyFingerprint,
  tokenPairProblem,
} from '@yaac/shared/token-tls'

const DAY = 24 * 60 * 60_000
/** A certificate someone else issued (CN=issued.example, IP 10.0.1.2,
 *  valid to 2126), as an admin or an issuer would put one in place. */
const ISSUED_CERT = `-----BEGIN CERTIFICATE-----
MIIBmjCCAUCgAwIBAgIUOOXVOgU2hPjD2hrTPQF4Oazx+LQwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOaXNzdWVkLmV4YW1wbGUwIBcNMjYxMTI0MjEzMjE5WhgPMjEy
NjEwMzEyMTMyMTlaMBkxFzAVBgNVBAMMDmlzc3VlZC5leGFtcGxlMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEAdOIIteAJxKAWO7U2jicetYKbk9phqmb7EHlpOwR
CpPgUc8wXyjIOt0WPKNuABd4MooLR6TJTOUevDZgOccLFKNkMGIwHQYDVR0OBBYE
FOELq3Oba8gYcs0+ZoAzibFJhJN1MB8GA1UdIwQYMBaAFOELq3Oba8gYcs0+ZoAz
ibFJhJN1MA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0RBAgwBocECgABAjAKBggqhkjO
PQQDAgNIADBFAiEAuPPFPH4GDh+f8vWJkd0hId1iBWg+jeKVo3G60gIRuIwCIDaE
JVdLuONVcxVo1lSsEk4Opp7peounGHkZttw4q3fw
-----END CERTIFICATE-----
`
const at = new Date('2026-06-01T00:00:00Z')

describe('parseTokenListen', () => {
  it('takes one IP literal and a port, and refuses names, wildcards and bad ports', () => {
    expect(parseTokenListen('10.0.1.2:8443')).toEqual({ address: '10.0.1.2', port: 8443 })
    expect(parseTokenListen('[::1]:8443')).toEqual({ address: '::1', port: 8443 })
    for (const bad of ['8443', ':8443', 'host.example:8443', 'eth0:8443', '0.0.0.0:8443', '[::]:8443', '::1:8443', '10.0.0.1:0', '10.0.0.1:70000', '10.0.0.1', '[::ffff:10.0.0.1]:8443', '[fe80::1%eth0]:8443']) {
      expect(() => parseTokenListen(bad), bad).toThrow(/--token-listen/)
    }
    // The server pod's own bind, which the cluster narrows one hop out.
    expect(parseTokenListen('0.0.0.0:8789', { wildcard: true })).toEqual({ address: '0.0.0.0', port: 8789 })
  })
})

describe('formatTokenListen', () => {
  it('brackets an IPv6 address', () => {
    expect(formatTokenListen({ address: '10.0.0.1', port: 1 })).toBe('10.0.0.1:1')
    expect(formatTokenListen({ address: '::1', port: 8443 })).toBe('[::1]:8443')
  })
})

describe('planTokenCertificate', () => {
  it('issues a certificate naming the address, keeps it, and reissues it on the same key', async () => {
    const first = await planTokenCertificate(undefined, '10.0.1.2', at)
    if (first === null) throw new Error('nothing issued')
    const cert = new X509Certificate(first.cert)
    expect(cert.subjectAltName).toBe('IP Address:10.0.1.2')
    expect(cert.verify(cert.publicKey)).toBe(true)
    expect(new Date(cert.validTo).getTime() - at.getTime()).toBeGreaterThan(3600 * DAY)
    expect(tokenPairProblem(first, at)).toBeNull()

    expect(await planTokenCertificate(first, '10.0.1.2', at)).toBeNull()
    // A new address, or a month before expiry, reissues on the same key, so
    // a pinned fingerprint keeps working.
    const moved = await planTokenCertificate(first, '127.0.0.1', at)
    expect(new X509Certificate(moved?.cert ?? '').subjectAltName).toBe('IP Address:127.0.0.1')
    expect(tokenKeyFingerprint(moved?.cert ?? '')).toBe(tokenKeyFingerprint(first.cert))
    const late = await planTokenCertificate(first, '10.0.1.2', new Date(at.getTime() + 3640 * DAY))
    expect(late).not.toBeNull()
    expect(tokenKeyFingerprint(late?.cert ?? '')).toBe(tokenKeyFingerprint(first.cert))
    // An IPv6 address is written whole, and kept however it is spelled.
    const v6 = await planTokenCertificate(undefined, '::1', at)
    expect(new X509Certificate(v6?.cert ?? '').subjectAltName).toBe('IP Address:0:0:0:0:0:0:0:1')
    expect(v6 !== null && await planTokenCertificate(v6, '0:0::1', at)).toBeNull()
    // A key whose certificate is gone gets a new certificate on that key.
    const relit = await planTokenCertificate({ key: first.key }, '10.0.1.2', at)
    expect(tokenKeyFingerprint(relit?.cert ?? '')).toBe(tokenKeyFingerprint(first.cert))
  })

  it('keeps a pair yaac did not generate, even for another address or near expiry', async () => {
    const issued = { cert: ISSUED_CERT, key: '' }
    expect(await planTokenCertificate(issued, '127.0.0.1', at)).toBeNull()
    expect(await planTokenCertificate(issued, '10.0.1.2', new Date('2126-10-01T00:00:00Z'))).toBeNull()
    // Neither part readable is nothing to keep.
    expect(await planTokenCertificate({ cert: 'not a certificate', key: '' }, '10.0.1.2', at)).not.toBeNull()
  })
})

describe('tokenKeyFingerprint', () => {
  it('is curl --pinnedpubkey\'s form of the key', async () => {
    const pair = await planTokenCertificate(undefined, '127.0.0.1', at)
    expect(tokenKeyFingerprint(pair?.cert ?? '')).toMatch(/^sha256\/\/[A-Za-z0-9+/]{43}=$/)
  })
})

describe('tokenPairProblem', () => {
  it('passes a whole, matching, current pair and says why any other cannot be served', async () => {
    const pair = await planTokenCertificate(undefined, '127.0.0.1', at)
    if (pair === null) throw new Error('nothing issued')
    expect(tokenPairProblem(pair, at)).toBeNull()
    const otherKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(tokenPairProblem({ cert: pair.cert, key: otherKey }, at)).toMatch(/not the certificate's/)
    expect(tokenPairProblem({ cert: pair.cert, key: 'nope' }, at)).toMatch(/key does not parse/)
    expect(tokenPairProblem({ cert: 'nope', key: pair.key }, at)).toMatch(/certificate does not parse/)
    expect(tokenPairProblem(pair, new Date(at.getTime() + 3651 * DAY))).toMatch(/expired/)
  })
})

describe('ensureTokenTlsDir and readTokenTlsDir', () => {
  let dir: string
  beforeAll(async () => { dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'token-tls-')), 'token-tls') })
  afterAll(async () => { await fs.rm(path.dirname(dir), { recursive: true, force: true }) })

  it('writes a private pair once and keeps its key across addresses', async () => {
    expect(await readTokenTlsDir(dir)).toBeUndefined()
    const fingerprint = await ensureTokenTlsDir(dir, '127.0.0.1')
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(path.join(dir, 'tls.key'))).mode & 0o777).toBe(0o600)
    expect(await ensureTokenTlsDir(dir, '127.0.0.1')).toBe(fingerprint)
    expect(await ensureTokenTlsDir(dir, '10.0.0.9')).toBe(fingerprint)
    expect(new X509Certificate((await readTokenTlsDir(dir))?.cert ?? '').subjectAltName).toBe('IP Address:10.0.0.9')
  })
})

/**
 * The token listener's address and certificate (docs/remote-hosting.md
 * "Token access"): the one parser of `--token-listen` and
 * `YAAC_TOKEN_LISTEN`, and the self-signed certificate yaac generates for
 * the listen address. `yaac server start` keeps the pair in a directory and
 * `yaac cluster install` in a Secret; both decide what to store with
 * `planTokenCertificate`.
 *
 * Node makes and parses keys and certificates, and PKI.js assembles the
 * certificate: the smallest one a TLS client accepts for an IP address,
 * v3, ECDSA P-256 over SHA-256, with the address as its only subject
 * alternative name.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, X509Certificate, type KeyObject } from 'node:crypto'
import { isIP } from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as asn1js from 'asn1js'
import * as pkijs from 'pkijs'

/** A certificate and its key, both PEM. */
export interface TokenTlsPair {
  cert: string
  key: string
}

/** Where the token listener listens. */
export interface TokenListen {
  address: string
  port: number
}

/** The file names of a pair in its directory (and the keys of the Secret). */
export const TOKEN_TLS_CERT_FILE = 'tls.crt'
export const TOKEN_TLS_KEY_FILE = 'tls.key'

/** The subject yaac gives its own certificates, which is how it tells one
 *  it may reissue from a pair someone else put there. */
const OWN_SUBJECT = 'yaac token endpoint'
const VALIDITY_MS = 3650 * 24 * 60 * 60_000
const REISSUE_BEFORE_EXPIRY_MS = 30 * 24 * 60 * 60_000

/**
 * Parse `<addr>:<port>` (an IPv6 address in brackets). The address must be
 * one IP literal: a hostname or interface name could stand for several
 * addresses, and a wildcard for all of them. `wildcard` admits `0.0.0.0`,
 * for the server pod alone, whose bind is the pod network's and whose
 * address the admin named is enforced one hop out.
 */
export function parseTokenListen(value: string, opts: { wildcard?: boolean } = {}): TokenListen {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value.trim())
  const usage = `--token-listen takes <addr>:<port>, where <addr> is one IP address this machine holds (got "${value}")`
  if (match === null) throw new Error(usage)
  const address = match[1] ?? match[2]
  const port = Number(match[3])
  // An IPv6 address in mixed notation or with a zone id is refused rather
  // than written into the certificate.
  if (isIP(address) === 0 || (match[1] !== undefined) !== (isIP(address) === 6)) throw new Error(usage)
  if (isIP(address) === 6 && /[.%]/.test(address)) throw new Error(`${usage}: write an IPv6 address in plain hex, with no zone id`)
  if (port < 1 || port > 65535) throw new Error(`${usage}: the port must be 1-65535`)
  if ((address === '0.0.0.0' && opts.wildcard !== true) || address === '::' || /^\[?::(0{1,4})?\]?$/.test(address)) {
    throw new Error(`${usage}: a wildcard address would answer on every interface; name the one address to listen on`)
  }
  return { address, port }
}

/** `<addr>:<port>` as a URL host would write it. */
export function formatTokenListen({ address, port }: TokenListen): string {
  return `${isIP(address) === 6 ? `[${address}]` : address}:${String(port)}`
}

/**
 * The SHA-256 of a certificate's public key, as `curl --pinnedpubkey`
 * takes it. A reissue keeps the key, so it keeps this.
 */
export function tokenKeyFingerprint(certPem: string): string {
  const spki = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' })
  return `sha256//${createHash('sha256').update(spki).digest('base64')}`
}

/**
 * Why a pair cannot be served, or null when it can: both parts parse, the
 * key is the certificate's, and it has not expired.
 */
export function tokenPairProblem(pair: TokenTlsPair, now = new Date()): string | null {
  let cert: X509Certificate
  try {
    cert = new X509Certificate(pair.cert)
  } catch {
    return 'the certificate does not parse'
  }
  try {
    if (!cert.checkPrivateKey(createPrivateKey(pair.key))) return 'the key is not the certificate\'s'
  } catch {
    return 'the key does not parse'
  }
  if (new Date(cert.validTo).getTime() <= now.getTime()) return `the certificate expired at ${cert.validTo}`
  return null
}

/**
 * What to store for a listener at `address`, given what is stored (either
 * part may be missing): a new pair, or null to keep it. A pair someone
 * else issued is kept as it is. Otherwise the key is kept whenever there
 * is one that parses, since a new key would break every caller that pinned
 * it: its certificate is reissued on it when missing, when it names
 * another address, or within 30 days of expiry. Only with no usable key is
 * one generated.
 */
export async function planTokenCertificate(stored: Partial<TokenTlsPair> | undefined, address: string, now = new Date()): Promise<TokenTlsPair | null> {
  let cert: X509Certificate | undefined
  try {
    if (stored?.cert !== undefined) cert = new X509Certificate(stored.cert)
  } catch {
    // An unreadable certificate is reissued.
  }
  if (cert !== undefined && cert.subject !== `CN=${OWN_SUBJECT}`) return null
  let key: KeyObject | undefined
  try {
    if (stored?.key !== undefined) key = createPrivateKey(stored.key)
  } catch {
    // An unreadable key is replaced.
  }
  if (key === undefined) return await issueTokenCertificate(address, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, now)
  const named = cert?.subjectAltName?.replace(/^IP Address:/, '')
  const sameAddress = named !== undefined && isIP(named) !== 0 && ipBytes(named).equals(ipBytes(address))
  const fresh = cert !== undefined && new Date(cert.validTo).getTime() - now.getTime() > REISSUE_BEFORE_EXPIRY_MS
  if (sameAddress && fresh && cert?.checkPrivateKey(key) === true) return null
  return await issueTokenCertificate(address, key, now)
}

/**
 * Make sure `dir` holds a pair for `address` (the containerless store):
 * written 0600 in a 0700 directory, through a rename so the listener's
 * re-read never sees half a pair. Answers the pair's key fingerprint.
 */
export async function ensureTokenTlsDir(dir: string, address: string): Promise<string> {
  const stored = await readTokenTlsParts(dir)
  const next = await planTokenCertificate(stored, address)
  if (next !== null) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    for (const [name, text] of [[TOKEN_TLS_KEY_FILE, next.key], [TOKEN_TLS_CERT_FILE, next.cert]] as const) {
      const tmp = path.join(dir, `.${name}.tmp`)
      await fs.writeFile(tmp, text, { mode: 0o600 })
      await fs.rename(tmp, path.join(dir, name))
    }
  }
  return tokenKeyFingerprint(next?.cert ?? stored.cert as string)
}

/** The pair in `dir`, or undefined unless both files are there. */
export async function readTokenTlsDir(dir: string): Promise<TokenTlsPair | undefined> {
  const { cert, key } = await readTokenTlsParts(dir)
  return cert !== undefined && key !== undefined ? { cert, key } : undefined
}

/** Whichever of the pair's files `dir` holds. */
async function readTokenTlsParts(dir: string): Promise<Partial<TokenTlsPair>> {
  const read = (name: string): Promise<string | undefined> => fs.readFile(path.join(dir, name), 'utf8').catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  })
  const [cert, key] = await Promise.all([read(TOKEN_TLS_CERT_FILE), read(TOKEN_TLS_KEY_FILE)])
  return { ...(cert !== undefined ? { cert } : {}), ...(key !== undefined ? { key } : {}) }
}

/** A self-signed certificate for `address` on `key`, valid ten years. */
async function issueTokenCertificate(address: string, key: KeyObject, now: Date): Promise<TokenTlsPair> {
  const keyPem = key.export({ type: 'pkcs8', format: 'pem' }).toString()
  const privateKey = await globalThis.crypto.subtle.importKey('pkcs8', key.export({ type: 'pkcs8', format: 'der' }), EC_P256, false, ['sign'])
  const publicKey = await globalThis.crypto.subtle.importKey('spki', createPublicKey(key).export({ type: 'spki', format: 'der' }), EC_P256, true, ['verify'])
  const cert = new pkijs.Certificate()
  cert.version = 2
  // Positive, and with no leading zero byte, which DER forbids.
  const serial = randomBytes(16)
  serial[0] = (serial[0] % 0x7f) + 1
  cert.serialNumber = new asn1js.Integer({ valueHex: serial })
  for (const name of [cert.issuer, cert.subject]) {
    name.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: OWN_SUBJECT }) }))
  }
  cert.notBefore.value = now
  cert.notAfter.value = new Date(now.getTime() + VALIDITY_MS)
  cert.extensions = [new pkijs.Extension({
    extnID: '2.5.29.17',
    extnValue: new pkijs.GeneralNames({
      names: [new pkijs.GeneralName({ type: 7, value: new asn1js.OctetString({ valueHex: ipBytes(address) }) })],
    }).toSchema().toBER(false),
  })]
  await cert.subjectPublicKeyInfo.importKey(publicKey, crypto())
  await cert.sign(privateKey, 'SHA-256', crypto())
  return { cert: pem('CERTIFICATE', Buffer.from(cert.toSchema().toBER(false))), key: keyPem }
}

const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256' }

/** pkijs's engine over Node's WebCrypto, handed to each call rather than
 *  set as its global default. */
function crypto(): pkijs.CryptoEngine {
  return new pkijs.CryptoEngine({ crypto: globalThis.crypto })
}

function ipBytes(address: string): Buffer {
  if (isIP(address) === 4) return Buffer.from(address.split('.').map(Number))
  const [head, tail = ''] = address.split('::')
  const words = (s: string): number[] => (s === '' ? [] : s.split(':').map((w) => parseInt(w, 16)))
  const h = words(head)
  const t = address.includes('::') ? words(tail) : []
  const all = [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t]
  return Buffer.from(all.flatMap((w) => [w >> 8, w & 0xff]))
}

function pem(label: string, body: Buffer): string {
  const lines = body.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

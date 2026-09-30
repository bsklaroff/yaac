import crypto from 'node:crypto'

/**
 * SSH keys yaac generates, and their three encodings.
 *
 * Only ed25519: the keys are yaac's own, every git host accepts it, and a
 * single algorithm keeps the encoder and the in-process agent simple.
 *
 * The 32-byte seed is what is stored; the public key, the signing
 * `KeyObject`, and the OpenSSH private-key container all derive from it.
 *
 * The OpenSSH container is hand-encoded because OpenSSH rejects the PKCS#8
 * Ed25519 form Node exports (`Load key: invalid format`, OpenSSH 9.6).
 */

const KEY_TYPE = 'ssh-ed25519'
const SEED_BYTES = 32
/** PKCS#8 DER for an ed25519 private key is this fixed prefix and the seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface GeneratedSshKey {
  /** The private key: the 32-byte seed everything else derives from. */
  seed: Buffer
  /** The public half as one OpenSSH line: `ssh-ed25519 <base64 blob> <comment>`. */
  publicKey: string
}

export function generateSshKey(comment: string): GeneratedSshKey {
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_ED25519_PREFIX.length)
  return { seed: Buffer.from(seed), publicKey: publicKeyLine(seed, comment) }
}

/** The `KeyObject` for a stored seed — what `crypto.sign` takes. */
export function sshKeyFromSeed(seed: Buffer): crypto.KeyObject {
  if (seed.length !== SEED_BYTES) throw new Error(`ssh key seed must be ${SEED_BYTES} bytes`)
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** The raw 32-byte public point for a seed. */
function publicPoint(seed: Buffer): Buffer {
  const der = crypto.createPublicKey(sshKeyFromSeed(seed)).export({ type: 'spki', format: 'der' })
  return Buffer.from(der.subarray(-SEED_BYTES))
}

/** The public key in wire form: `string "ssh-ed25519", string point` — what
 *  an agent lists and what a client names in a sign request. */
export function sshPublicKeyBlob(seed: Buffer): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(publicPoint(seed))])
}

/** The one-line form of {@link sshPublicKeyBlob}, as `authorized_keys` and
 *  `.pub` files hold it. */
export function publicKeyLine(seed: Buffer, comment: string): string {
  return `${KEY_TYPE} ${sshPublicKeyBlob(seed).toString('base64')} ${comment}`
}

/** A public line with its comment replaced. Hosts match on the key blob,
 *  so this does not affect authentication. */
export function withKeyComment(line: string, comment: string): string {
  const [type, blob] = line.split(' ')
  return `${type} ${blob} ${comment}`
}

/** The wire blob parsed from a public line, so an identity can be listed
 *  and matched without the private key. */
export function sshPublicKeyBlobFromLine(line: string): Buffer {
  return Buffer.from(line.split(' ')[1] ?? '', 'base64')
}

/**
 * Sign `data` the way an ssh-agent answers a sign request: the signature
 * in wire form, `string "ssh-ed25519", string sig`.
 */
export function sshSign(seed: Buffer, data: Buffer): Buffer {
  const sig = crypto.sign(null, data, sshKeyFromSeed(seed))
  return Buffer.concat([sshString(KEY_TYPE), sshString(sig)])
}

/**
 * The private key in OpenSSH's unencrypted container format, as read by
 * `ssh-add -` and `ssh-keygen`. Passed to a process, never written to a
 * file.
 */
export function encodeOpenSshPrivateKey(seed: Buffer, comment: string): string {
  const pub = publicPoint(seed)
  const check = crypto.randomBytes(4)
  let priv = Buffer.concat([
    check, check,
    sshString(KEY_TYPE),
    sshString(pub),
    // OpenSSH's "private key" field for ed25519 is the seed with the public
    // point appended.
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ])
  // Padded with 1, 2, 3… up to the (unencrypted) block size of 8.
  const pad: number[] = []
  while ((priv.length + pad.length) % 8 !== 0) pad.push(pad.length + 1)
  priv = Buffer.concat([priv, Buffer.from(pad)])

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'), // cipher
    sshString('none'), // kdf
    sshString(''), // kdf options
    sshUint32(1), // number of keys
    sshString(sshPublicKeyBlob(seed)),
    sshString(priv),
  ])
  const lines = body.toString('base64').match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

/** A wire `string`: uint32 length, then the bytes. */
export function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return Buffer.concat([sshUint32(bytes.length), bytes])
}

export function sshUint32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

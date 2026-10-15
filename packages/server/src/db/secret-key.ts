import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { env } from '@yaac/shared/env'
import { secretKeyPath } from '@yaac/shared/project-paths'
import { serverLog } from '#lib/log'
import type { SecretConfig } from 'better-auth/crypto'

/**
 * The key this install encrypts its secrets with: the `key` argument for
 * better-auth's `symmetricEncrypt`/`symmetricDecrypt`. Sources, in the same
 * order better-auth uses:
 *
 *  1. `YAAC_SECRETS`: a versioned key set, for operators who rotate keys in
 *     their own secret manager. `YAAC_SECRET`, if also set, is the legacy key
 *     for payloads without a version envelope.
 *  2. `YAAC_SECRET` alone: one unversioned key.
 *  3. Neither: a key generated once into the data dir. (better-auth would
 *     fall back to a constant dev secret instead.) This is the usual case, so
 *     an unconfigured install still stores no plaintext secrets.
 *
 *     The generated key is returned as version 0, so rows carry an envelope
 *     naming it. An operator can later move off it by listing it in
 *     `YAAC_SECRETS` beside a new key, without re-encrypting.
 *
 * Cached per data dir, since tests switch data dirs between fixtures.
 */

/** How the entropy check reads a secret: unique characters, string length. */
function estimateEntropyBits(value: string): number {
  const unique = new Set(value).size
  if (unique === 0) return 0
  return Math.log2(Math.pow(unique, value.length))
}

/** Warn, never refuse, on a short or low-entropy key; refusing would lock an
 *  install out of rows it can still decrypt. */
function warnOnWeakSecret(value: string, source: string): void {
  if (value.length < 32) {
    serverLog(
      `[secrets] ${source} is under 32 characters; use a longer key `
      + '(openssl rand -base64 32)',
    )
  }
  if (estimateEntropyBits(value) < 120) {
    serverLog(
      `[secrets] ${source} looks low-entropy; use a randomly generated key `
      + '(openssl rand -base64 32)',
    )
  }
}

/** The version a generated key encrypts under. */
const GENERATED_KEY_VERSION = 0

let cached: { dir: string; promise: Promise<string | SecretConfig> } | null = null

/**
 * Read the generated key, creating it first if missing. Written 0600 under a
 * 0700 directory to a temp file, then hard-linked into place, so a crash
 * can't leave a truncated key and a key already there is never replaced,
 * even one a failed read could not see. Only an empty file is replaced,
 * since it seals nothing.
 */
async function loadOrCreateKeyFile(): Promise<string> {
  const file = secretKeyPath()
  const existing = await readKeyFile()
  if (existing !== undefined) return existing
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const generated = crypto.randomBytes(32).toString('base64url')
  const tmp = `${file}.${process.pid.toString()}.tmp`
  await fs.writeFile(tmp, `${generated}\n`, { mode: 0o600 })
  try {
    const placed = await fs.link(tmp, file).then(() => true, async (err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (await readKeyFile() !== undefined) return false
      await fs.rename(tmp, file)
      return true
    })
    if (placed) serverLog(`[secrets] generated an encryption key at ${file} — back it up with the data dir`)
  } finally {
    await fs.rm(tmp, { force: true })
  }
  const key = await readKeyFile()
  if (key === undefined) throw new Error(`${file} is empty after writing it`)
  return key
}

/**
 * The generated key, or undefined if there is none: no file, or an empty
 * one. Any other failure to read it throws, so a passing read error is never
 * taken for a missing key.
 */
async function readKeyFile(): Promise<string | undefined> {
  const existing = await fs.readFile(secretKeyPath(), 'utf8').then((k) => k.trim(), (err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  })
  return existing !== '' ? existing : undefined
}

/**
 * Why the server must not start, if it would have to generate a key while
 * the database already holds rows sealed with another: every credential
 * would then fail to decrypt and read as signed out, with nothing said.
 * `hasSealedRows` is asked only when no key is configured or on disk.
 */
export async function lostSecretKey(hasSealedRows: () => Promise<boolean>): Promise<string | undefined> {
  if (env.secrets !== null || env.secret !== undefined || await readKeyFile() !== undefined) return undefined
  if (!await hasSealedRows()) return undefined
  const file = secretKeyPath()
  return `the database holds encrypted secrets, but their key is missing: ${file} `
    + 'is absent or empty and neither YAAC_SECRETS nor YAAC_SECRET is set. Restore the key file '
    + 'from a backup of the data dir, or set YAAC_SECRETS or YAAC_SECRET to the key the '
    + 'secrets were stored with. To give them up instead, write a new key to the file '
    + `(openssl rand -base64 32 > ${file}); every stored secret then reads as unreadable `
    + 'and must be entered again'
}

async function resolve(): Promise<string | SecretConfig> {
  const stated = env.secrets
  if (stated !== null) {
    const current = stated[0]
    warnOnWeakSecret(current.value, 'the current YAAC_SECRETS key')
    const keys = new Map<number, string>()
    for (const { version, value } of stated) keys.set(version, value)
    const legacySecret = env.secret
    return {
      keys,
      currentVersion: current.version,
      ...(legacySecret !== undefined ? { legacySecret } : {}),
    }
  }
  const single = env.secret
  if (single !== undefined) {
    warnOnWeakSecret(single, 'YAAC_SECRET')
    return single
  }
  return {
    keys: new Map([[GENERATED_KEY_VERSION, await loadOrCreateKeyFile()]]),
    currentVersion: GENERATED_KEY_VERSION,
  }
}

/** The key set for this data dir. */
export function secretConfig(): Promise<string | SecretConfig> {
  const dir = secretKeyPath()
  if (cached?.dir !== dir) {
    const promise = resolve()
    cached = { dir, promise }
    promise.catch(() => {
      if (cached?.promise === promise) cached = null
    })
  }
  return cached.promise
}

/** Drop the cached key (on `closeDb` and when a test switches data dirs). */
export function forgetSecretConfig(): void {
  cached = null
}

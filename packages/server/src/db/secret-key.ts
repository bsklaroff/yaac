import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { env } from '@yaac/shared/env'
import { secretKeyPath } from '@yaac/shared/project-paths'
import { serverLog } from '#log'
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
 * 0700 directory via temp file + rename, so a crash can't leave a truncated
 * key. Two servers can't race here in practice, since the server lock is
 * taken before the DB opens; if they did, both re-read the renamed file.
 */
async function loadOrCreateKeyFile(): Promise<string> {
  const file = secretKeyPath()
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // Missing or unreadable: generate one below.
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const generated = crypto.randomBytes(32).toString('base64url')
  const tmp = `${file}.${process.pid.toString()}.tmp`
  await fs.writeFile(tmp, `${generated}\n`, { mode: 0o600 })
  await fs.rename(tmp, file)
  serverLog(`[secrets] generated an encryption key at ${file} — back it up with the data dir`)
  return (await fs.readFile(file, 'utf8')).trim()
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

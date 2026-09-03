import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { env } from '@yaac/shared/env'
import { secretKeyPath } from '@yaac/shared/project-paths'
import { serverLog } from '#log'
import type { SecretConfig } from 'better-auth/crypto'

/**
 * Which key this install seals its secrets with.
 *
 * Three sources, in the order better-auth resolves its own — its
 * `symmetricEncrypt`/`symmetricDecrypt` are what actually do the sealing
 * (`project-env-store.ts`), and this answers the `key` they take:
 *
 *  1. `YAAC_SECRETS` — a versioned set, for an operator who keeps the key in
 *     their own secret manager and rotates it there. `YAAC_SECRET`, if also
 *     set, becomes the legacy key that opens pre-envelope payloads.
 *  2. `YAAC_SECRET` alone — one key, no versioning.
 *  3. Neither — a key this server generates for itself, once, into the data
 *     dir. This is where yaac departs from better-auth, which falls back to
 *     a constant dev secret and refuses to start with it in production: a
 *     known key is not a key, and yaac has a private directory to put a real
 *     one in. The generated file is the ordinary case, so an install that
 *     configures nothing still stores no plaintext secret.
 *
 *     It is handed back as VERSION 0 rather than as a bare key, so the rows
 *     it seals carry an envelope naming it. That is what lets an operator
 *     move off the generated key later by listing it in `YAAC_SECRETS`
 *     alongside the new one — no re-encrypt pass, and no reliance on the
 *     legacy bare-hex path.
 *
 * Cached per data dir, because every sealed read and write asks for it and
 * the answer only changes when the data dir does (which is a test moving
 * between fixtures, and the reason this is keyed rather than a plain
 * singleton).
 */

/** How the entropy check reads a secret: unique characters, string length. */
function estimateEntropyBits(value: string): number {
  const unique = new Set(value).size
  if (unique === 0) return 0
  return Math.log2(Math.pow(unique, value.length))
}

/** Warn — never refuse — on a key too short or too predictable to be one.
 *  Refusing would lock an install out of rows it can still open. */
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

/** The version a generated key seals under: zero, the version an install has
 *  before anybody has rotated anything. */
const GENERATED_KEY_VERSION = 0

let cached: { dir: string; promise: Promise<string | SecretConfig> } | null = null

/**
 * Read the generated key, writing one first if this install has none.
 *
 * 0600 under a 0700 directory, and written whole via a temp file + rename so
 * a crash mid-write cannot leave a truncated key that opens nothing. Two
 * servers racing the same fresh data dir cannot both win: the loser's rename
 * is atomic, and it re-reads afterwards — but they cannot race in practice,
 * since the server lock is held before the DB is opened.
 */
async function loadOrCreateKeyFile(): Promise<string> {
  const file = secretKeyPath()
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // Absent, or unreadable — either way, below.
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

/** Drop the cached key — paired with `closeDb`, and with a test's data-dir
 *  switch, so the next read resolves against the dir that is current now. */
export function forgetSecretConfig(): void {
  cached = null
}

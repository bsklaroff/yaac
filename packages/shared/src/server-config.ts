import fs from 'node:fs/promises'
import { clientLocalPath, ensureClientLocalRoot, serverLocalPath } from '#paths'
import { readLock } from '#lock'
import type { DriverKind } from '#types'

/**
 * Which yaac server this machine's clients talk to, and what kind of
 * install this data dir is (`~/.yaac-client/server.json`, 0600).
 *
 * `url` / `token` are the selected server and `enabled` is the switch that
 * deselects it without losing the token; `saved` remembers every server
 * ever configured so clients (the desktop shell's picker, `yaac remote
 * on`) can switch back without re-entering one. The machine has one
 * selection at a time — `saved` is history, not contexts.
 *
 * There is no other way to reach a server. A server on this machine is
 * registered here by `yaac server start` exactly as an in-cluster one is by
 * `yaac cluster install` (`registerServer` below), so no client has a local
 * case: an origin and a token is the whole of "how do I reach the server".
 */
export interface SavedServer {
  url: string
  token: string
}

export interface ServerConfig {
  url: string
  token: string
  enabled: boolean
  saved: SavedServer[]
  /**
   * Which substrate this INSTALL runs — not which substrate the selected
   * server runs. Top-level rather than per-entry because its readers ask
   * about this data dir ("is there a host server to start, or a Deployment
   * to converge?"), which does not change when the selection points at
   * another machine. A remote server's driver is not recorded at all; its
   * snapshot reports it live.
   */
  driver?: DriverKind
}

/**
 * CLIENT-LOCAL: which server this machine's clients talk to. Nothing but
 * clients ever reads it — under the k8s driver the server is a pod, and a
 * pod has no business knowing the origin its callers dial it on.
 */
export function serverConfigPath(): string {
  return clientLocalPath('server.json')
}

/**
 * What this file was called when every server it could name was a REMOTE
 * one, and where it lived when every tier was one directory — see
 * docs/legacy-compat-shims.md.
 */
function legacyConfigPaths(): string[] {
  return [clientLocalPath('remote.json'), serverLocalPath('remote.json')]
}

/**
 * Absent, unparseable, or wrong-shaped file → null (no server configured).
 * The selected server is always folded into `saved` (files written before
 * `saved` existed lack it), so callers can treat `saved` as the complete
 * known-servers list.
 */
export async function readServerConfig(): Promise<ServerConfig | null> {
  for (const p of [serverConfigPath(), ...legacyConfigPaths()]) {
    const cfg = await readServerConfigAt(p)
    if (cfg) return cfg
  }
  return null
}

async function readServerConfigAt(filePath: string): Promise<ServerConfig | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const cfg = parsed as Record<string, unknown>
    if (
      typeof cfg.url !== 'string'
      || typeof cfg.token !== 'string'
      || typeof cfg.enabled !== 'boolean'
    ) return null
    const saved = (Array.isArray(cfg.saved) ? cfg.saved : [])
      .filter((s: unknown): s is SavedServer => {
        if (!s || typeof s !== 'object') return false
        const r = s as Record<string, unknown>
        return typeof r.url === 'string' && typeof r.token === 'string'
      })
      .map((s) => ({ url: s.url, token: s.token }))
    // The empty url is `clearServerConfig`'s "nothing selected, but this is
    // still a k8s install" state — not a server to remember.
    if (cfg.url !== '' && !saved.some((s) => s.url === cfg.url)) {
      saved.unshift({ url: cfg.url, token: cfg.token })
    }
    const driver = cfg.driver === 'k8s' || cfg.driver === 'containerless' ? cfg.driver : undefined
    return {
      url: cfg.url,
      token: cfg.token,
      enabled: cfg.enabled,
      saved,
      ...(driver ? { driver } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Where the install's driver was recorded before it became a field of
 * `server.json`, at both paths that file has had — see
 * docs/legacy-compat-shims.md. Exported for `recordedDriver`, which reads
 * the same two places.
 */
export async function readLegacyDriverRecord(): Promise<DriverKind | undefined> {
  for (const p of [clientLocalPath('driver'), serverLocalPath('driver')]) {
    try {
      const raw = (await fs.readFile(p, 'utf8')).trim()
      if (raw === 'k8s' || raw === 'containerless') return raw
    } catch {
      // absent or unreadable — try the next
    }
  }
  return undefined
}

/**
 * Persist atomically (tmp + rename) at 0600 — the token is a bearer.
 *
 * A config with no `driver` picks one up from the standalone file if there
 * is one, so that EVERY writer makes the file self-describing — not just
 * the two that register a server. Without this, a `yaac remote set` on an
 * install that predates the field would write a `server.json` that
 * outranks the legacy file while saying nothing about the install, and the
 * driver record would live on only as long as that file stayed on disk.
 */
export async function writeServerConfig(cfg: ServerConfig): Promise<void> {
  await ensureClientLocalRoot()
  if (cfg.driver === undefined) {
    const legacy = await readLegacyDriverRecord()
    if (legacy) cfg = { ...cfg, driver: legacy }
  }
  const p = serverConfigPath()
  const tmp = `${p}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  await fs.rename(tmp, p)
  // Only once the new one is durable. Leaving one would strand a live
  // bearer token on disk, and a later `clearServerConfig` that missed it
  // would read as "no server" while the file still sat there.
  for (const legacy of legacyConfigPaths()) {
    await fs.rm(legacy, { force: true })
  }
}

/**
 * Forget every configured server (`yaac remote unset`), keeping the record
 * of what kind of install this is.
 *
 * Not a delete: `driver` shares this file, and dropping it would leave a
 * k8s install unable to refuse a host `yaac server start` — two writers on
 * one data dir. With nothing left to record, the file goes.
 */
export async function clearServerConfig(): Promise<void> {
  const driver = (await readServerConfig())?.driver
  for (const legacy of legacyConfigPaths()) {
    await fs.rm(legacy, { force: true })
  }
  if (driver === undefined) {
    await fs.rm(serverConfigPath(), { force: true })
    return
  }
  await writeServerConfig({ url: '', token: '', enabled: false, saved: [], driver })
}

/**
 * Validate and canonicalize a server URL to a bare http(s) origin.
 * The server serves at the origin root (tailscale serve mounts there
 * too), so paths/queries are a configuration mistake — reject rather
 * than silently strip.
 */
export function normalizeServerUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid server URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`server URL must be http(s): ${raw}`)
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`server URL must be a bare origin (no path/query/fragment): ${raw}`)
  }
  return url.origin
}

/**
 * A config with `url`/`token` as the selected server, upserted into
 * `saved` (an existing entry for the origin gets the new token). The other
 * saved servers and the install's `driver` carry over from `existing`.
 */
export function withServerSelected(
  existing: ServerConfig | null,
  url: string,
  token: string,
): ServerConfig {
  const others = (existing?.saved ?? []).filter((s) => s.url !== url)
  return {
    url,
    token,
    enabled: true,
    saved: [{ url, token }, ...others],
    ...(existing?.driver ? { driver: existing.driver } : {}),
  }
}

const PROBE_TIMEOUT_MS = 5000

/**
 * The server answered, and it says this token is not one of its own.
 *
 * Distinguished from every other probe failure because the two call for
 * opposite actions: a rejected token must be replaced, while a token we
 * merely could not CHECK — the server is down, slow, mid-migration, or
 * answering 5xx — must be kept. Treating the second as the first throws
 * away a working credential (see `registerServer`).
 */
export class TokenRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenRejectedError'
  }
}

/**
 * Verify a server end to end: the origin answers /health, and the token
 * authenticates against a protected route (/health is public — only an
 * authenticated call proves the token). Returns the server's build id so
 * callers can warn on skew; throws a prescriptive error on any failure,
 * and a `TokenRejectedError` specifically when the server rejected it.
 */
export async function probeServer(origin: string, token: string): Promise<{ buildId: string }> {
  let health: Response
  try {
    health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`cannot reach ${origin}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!health.ok) throw new Error(`${origin}/health returned HTTP ${health.status}`)
  const { buildId } = await health.json() as { ok: boolean; buildId: string }

  const check = await fetch(`${origin}/tokens`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (check.status === 401) {
    throw new TokenRejectedError(
      `token rejected by ${origin} — mint one on the server with: yaac auth token create <name>`,
    )
  }
  if (!check.ok) throw new Error(`token check against ${origin} failed (HTTP ${check.status})`)
  return { buildId }
}

/** Name of the durable token a machine keeps for its own install's server. */
export const LOCAL_CLIENT_TOKEN_NAME = 'local-client'

/**
 * The name this token had when only `yaac cluster install` minted one —
 * revoked alongside the current name so an install that predates the
 * rename doesn't keep an orphan credential (docs/legacy-compat-shims.md).
 */
const LEGACY_TOKEN_NAME = 'cluster-install'

const MINT_TIMEOUT_MS = 10_000

/**
 * Point this machine's clients at the server that was just stood up, and
 * record which kind of install stood it up.
 *
 * This is the ONLY bootstrap in the system, and both substrates use it:
 * `yaac server start` calls it for the host server it spawned,
 * `yaac cluster install` for the Deployment it applied. What makes it
 * possible either way is the lock on the shared data dir — a host server
 * writes it directly, a pod writes it into the hostPath it mounts — so the
 * per-boot secret that authenticates as the server itself is readable
 * here, and buys a DURABLE token. Durable because the lock secret is per
 * BOOT: the moment the server restarts, a config holding the old secret
 * would be answered BAD_BEARER by its replacement.
 *
 * A saved token that still works is kept rather than rotated, so a routine
 * `yaac server start` doesn't invalidate the token every other client on
 * this machine is holding.
 *
 * Deps are injected so every branch unit-tests without a server or a lock.
 */
export async function registerServer(
  origin: string,
  driver: DriverKind,
  opts: {
    log?: (message: string) => void
    /** Non-empty means "this install requires a credential" — an empty
     *  token there is a lockout, so `registerServer` says so. */
    credentialRequired?: boolean
    readConfig?: typeof readServerConfig
    writeConfig?: typeof writeServerConfig
    probe?: typeof probeServer
    mint?: (origin: string) => Promise<string>
  } = {},
): Promise<void> {
  const log = opts.log ?? ((): void => { /* quiet by default */ })
  const readConfig = opts.readConfig ?? readServerConfig
  const writeConfig = opts.writeConfig ?? writeServerConfig
  const probe = opts.probe ?? probeServer
  const mint = opts.mint ?? mintLocalClientToken

  const existing = await readConfig()
  const saved = existing?.saved.find((s) => s.url === origin)
  if (saved && saved.token !== '') {
    const verdict = await checkSavedToken(probe, origin, saved.token)
    // Reused when it still authenticates: rotating on every start would
    // break every other client holding the old one, for no gain.
    //
    // And reused when the answer is UNKNOWN, which is the important half.
    // A server that is down, slow, or mid-migration fails the probe and
    // would then fail the mint too — writing an empty token over a
    // credential that is still valid on the server, and locking this
    // machine out of a credential-requiring install until some later
    // command happens to succeed here. Only a real rejection rotates.
    if (verdict !== 'rejected') {
      if (verdict === 'unverified') {
        log(
          `could not verify this machine's token against ${origin} — keeping it. `
          + 'If commands are refused, run this again once the server is answering.',
        )
      }
      await writeConfig({ ...withServerSelected(existing, origin, saved.token), driver })
      return
    }
  }

  const token = await mint(origin)
  // An empty token is right on a credential-optional install, where
  // nothing checks it. On one that REQUIRES a credential it is a lockout,
  // and the operator has to hear about it rather than discover it on the
  // next command.
  if (token === '' && opts.credentialRequired) {
    log(
      'WARNING: could not mint a durable token for this machine, and this '
      + 'server REQUIRES a credential — so the CLI here cannot reach it. '
      + 'Mint one against the server and configure it by hand: `yaac auth '
      + `token create <name>\`, then \`yaac remote set ${origin} --token <token>\`.`,
    )
  }
  await writeConfig({ ...withServerSelected(existing, origin, token), driver })
}

/**
 * What the server said about a token this machine already holds: it is
 * good, it is not ours, or we could not get an answer. The third is not a
 * failure of the token — see `registerServer`.
 */
async function checkSavedToken(
  probe: typeof probeServer,
  origin: string,
  token: string,
): Promise<'ok' | 'rejected' | 'unverified'> {
  try {
    await probe(origin, token)
    return 'ok'
  } catch (err) {
    return err instanceof TokenRejectedError ? 'rejected' : 'unverified'
  }
}

/**
 * Mint the durable token for this machine, authenticated with the lock
 * secret (see `registerServer`).
 *
 * Revoke-then-create: the full token value only ever leaves the server at
 * creation, so a stale one cannot be recovered and is replaced instead.
 * Failures degrade to an empty token, which is exactly right on a
 * credential-optional install where nothing checks it.
 */
export async function mintLocalClientToken(origin: string): Promise<string> {
  const lock = await readLock()
  if (!lock) return ''
  const auth = { authorization: `Bearer ${lock.secret}` }
  try {
    for (const name of [LOCAL_CLIENT_TOKEN_NAME, LEGACY_TOKEN_NAME]) {
      await fetch(`${origin}/tokens/${name}`, {
        method: 'DELETE',
        headers: auth,
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      })
    }
    const res = await fetch(`${origin}/tokens`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: LOCAL_CLIENT_TOKEN_NAME }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    })
    if (!res.ok) return ''
    const entry = await res.json() as { token?: string }
    return entry.token ?? ''
  } catch {
    return ''
  }
}

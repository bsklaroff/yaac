import fs from 'node:fs/promises'
import { clientDataDir, clientLocalPath } from '#paths'
import { writeJsonFile } from '#json-file'
import { readInstallRecord, recordInstall } from '#install-record'
import type { DriverKind, Principal } from '#types'

/**
 * Which yaac server this machine's clients talk to
 * (`~/.yaac-client/server.json`, 0600).
 *
 * `url` is the selected server; `enabled` deselects it without forgetting
 * it; `saved` lists every server configured and not since removed, so
 * clients can switch back. Both `yaac server start` and `yaac cluster
 * install` register their server here (`registerServer`), so clients
 * always reach a server by its origin. The file holds no credential: the
 * server identifies the caller from the request (docs/remote-hosting.md,
 * docs/server-selection.md). What kind of install a data dir is lives in
 * its own `install.json` (`#install-record`).
 */
export interface SavedServer {
  url: string
}

export interface ServerConfig {
  url: string
  enabled: boolean
  saved: SavedServer[]
}

/** CLIENT-LOCAL: read only by clients, never by the server. */
export function serverConfigPath(): string {
  return clientLocalPath('server.json')
}

/**
 * Null for an absent or malformed file. The selected server is always
 * included in `saved`. Unknown fields are dropped.
 */
export async function readServerConfig(): Promise<ServerConfig | null> {
  try {
    const raw = await fs.readFile(serverConfigPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const cfg = parsed as Record<string, unknown>
    if (typeof cfg.url !== 'string' || typeof cfg.enabled !== 'boolean') return null
    const saved = (Array.isArray(cfg.saved) ? cfg.saved : [])
      .filter((s: unknown): s is SavedServer =>
        !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).url === 'string')
      .map((s) => ({ url: s.url }))
    // An empty url means nothing is selected.
    if (cfg.url !== '' && !saved.some((s) => s.url === cfg.url)) {
      saved.unshift({ url: cfg.url })
    }
    return { url: cfg.url, enabled: cfg.enabled, saved }
  } catch {
    return null
  }
}

/**
 * Persist atomically at 0600, like everything client-local. The client
 * data dir's install record is written beside the selection, for an older
 * `yaac` that reads it only here (docs/legacy-compat-shims.md); reading it
 * first also lifts a legacy record out before this rewrite.
 */
export async function writeServerConfig(cfg: ServerConfig): Promise<void> {
  const record = await readInstallRecord(clientDataDir())
  await writeJsonFile(serverConfigPath(), { ...cfg, ...record })
}

/**
 * Forget every configured server (`yaac remote unset`). The file stays
 * while it carries the install record (see writeServerConfig).
 */
export async function clearServerConfig(): Promise<void> {
  if (await readInstallRecord(clientDataDir())) {
    await writeServerConfig({ url: '', enabled: false, saved: [] })
    return
  }
  await fs.rm(serverConfigPath(), { force: true })
}

/**
 * Validate and canonicalize a server URL to a bare http(s) origin. The
 * server is always at the origin root, so a path or query is rejected as a
 * mistake rather than stripped.
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
 * A config with `url` as the selected server, moved to the front of
 * `saved`. Other saved servers carry over from `existing`.
 */
export function withServerSelected(existing: ServerConfig | null, url: string): ServerConfig {
  const others = (existing?.saved ?? []).filter((s) => s.url !== url)
  return { url, enabled: true, saved: [{ url }, ...others] }
}

const PROBE_TIMEOUT_MS = 5000

/**
 * The server answered but refused to identify this device, e.g. a request
 * via `tailscale serve` with no user identity, or a non-loopback name that
 * bypassed `serve`. The message is the server's. Retrying does not help;
 * the fix is on the tailnet.
 */
export class IdentityRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityRejectedError'
  }
}

/**
 * Check that the origin answers /health and that /whoami identifies this
 * device (/health is public, so only /whoami proves access). Returns the
 * build id, for skew warnings, and the caller's principal. Throws
 * `IdentityRejectedError` when the server refuses to identify the caller.
 */
export async function probeServer(origin: string): Promise<{ buildId: string; principal: Principal }> {
  let health: Response
  try {
    health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`cannot reach ${origin}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!health.ok) throw new Error(`${origin}/api/health returned HTTP ${health.status}`)
  const { buildId } = await health.json() as { ok: boolean; buildId: string }

  const whoami = await fetch(`${origin}/api/whoami`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  if (whoami.status === 401) {
    const body = await whoami.json().catch(() => null) as { error?: { message?: string } } | null
    throw new IdentityRejectedError(
      `${origin} refused to identify this device: ${body?.error?.message ?? 'HTTP 401'}`,
    )
  }
  if (!whoami.ok) throw new Error(`identity check against ${origin} failed (HTTP ${whoami.status})`)
  return { buildId, principal: await whoami.json() as Principal }
}

/**
 * Record the install's driver and origin, and make the origin known to this machine's
 * clients. A start selects it. A restart or re-install (`keepSelection`)
 * selects it only when it is new or nothing else is selected, so
 * maintenance on one install never moves clients off another.
 */
export async function registerServer(
  origin: string,
  driver: DriverKind,
  opts: { keepSelection?: boolean } = {},
): Promise<void> {
  await recordInstall({ driver, origin })
  const cfg = await readServerConfig()
  const elsewhere = !!cfg?.enabled && cfg.url !== '' && cfg.url !== origin
  if (opts.keepSelection && elsewhere && cfg.saved.some((s) => s.url === origin)) return
  await writeServerConfig(withServerSelected(cfg, origin))
}

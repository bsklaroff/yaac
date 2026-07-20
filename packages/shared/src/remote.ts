import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir } from '#paths'

/**
 * The configured remote servers (`~/.yaac/remote.json`, 0600). `url` /
 * `token` are the active remote and `enabled` is the switch back to the
 * local server without losing the token; `saved` remembers every remote
 * ever set so clients (the desktop shell's server picker) can switch
 * back without re-entering a token. The machine still has one attachment
 * at a time — `saved` is history, not contexts.
 */
export interface SavedRemote {
  url: string
  token: string
}

export interface RemoteConfig {
  url: string
  token: string
  enabled: boolean
  saved: SavedRemote[]
}

export function remoteConfigPath(): string {
  return path.join(getDataDir(), 'remote.json')
}

/**
 * Absent, unparseable, or wrong-shaped file → null (no remote). The
 * active remote is always folded into `saved` (files written before
 * `saved` existed lack it), so callers can treat `saved` as the complete
 * known-remotes list.
 */
export async function readRemote(): Promise<RemoteConfig | null> {
  try {
    const raw = await fs.readFile(remoteConfigPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const cfg = parsed as Record<string, unknown>
    if (
      typeof cfg.url !== 'string'
      || typeof cfg.token !== 'string'
      || typeof cfg.enabled !== 'boolean'
    ) return null
    const saved = (Array.isArray(cfg.saved) ? cfg.saved : [])
      .filter((s: unknown): s is SavedRemote => {
        if (!s || typeof s !== 'object') return false
        const r = s as Record<string, unknown>
        return typeof r.url === 'string' && typeof r.token === 'string'
      })
      .map((s) => ({ url: s.url, token: s.token }))
    if (!saved.some((s) => s.url === cfg.url)) {
      saved.unshift({ url: cfg.url, token: cfg.token })
    }
    return { url: cfg.url, token: cfg.token, enabled: cfg.enabled, saved }
  } catch {
    return null
  }
}

/** Persist atomically (tmp + rename) at 0600 — the token is a bearer. */
export async function writeRemote(cfg: RemoteConfig): Promise<void> {
  await fs.mkdir(getDataDir(), { recursive: true })
  const p = remoteConfigPath()
  const tmp = `${p}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  await fs.rename(tmp, p)
}

export async function clearRemote(): Promise<void> {
  await fs.rm(remoteConfigPath(), { force: true })
}

/**
 * Validate and canonicalize a remote URL to a bare http(s) origin.
 * The server serves at the origin root (tailscale serve mounts there
 * too), so paths/queries are a configuration mistake — reject rather
 * than silently strip.
 */
export function normalizeRemoteUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid remote URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`remote URL must be http(s): ${raw}`)
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`remote URL must be a bare origin (no path/query/fragment): ${raw}`)
  }
  return url.origin
}

/**
 * A config with `url`/`token` as the active, enabled remote, upserted
 * into `saved` (an existing entry for the origin gets the new token).
 * The other saved remotes carry over from `existing`.
 */
export function withRemoteActivated(
  existing: RemoteConfig | null,
  url: string,
  token: string,
): RemoteConfig {
  const others = (existing?.saved ?? []).filter((s) => s.url !== url)
  return { url, token, enabled: true, saved: [{ url, token }, ...others] }
}

const PROBE_TIMEOUT_MS = 5000

/**
 * Verify a remote end to end: the origin answers /health, and the token
 * authenticates against a protected route (/health is public — only an
 * authenticated call proves the token). Returns the server's build id so
 * callers can warn on skew; throws a prescriptive error on any failure.
 */
export async function probeRemote(origin: string, token: string): Promise<{ buildId: string }> {
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
    throw new Error(
      `token rejected by ${origin} — mint one on the server with: yaac auth token create <name>`,
    )
  }
  if (!check.ok) throw new Error(`token check against ${origin} failed (HTTP ${check.status})`)
  return { buildId }
}

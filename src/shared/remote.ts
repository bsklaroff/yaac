import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir } from '@/shared/paths'

/**
 * The one configured remote daemon (`~/.yaac/remote.json`, 0600). yaac
 * deliberately supports a single remote rather than named contexts —
 * `enabled` is the switch back to the local daemon without losing the
 * token. Growing this into a named map later is a client-side-only
 * change.
 */
export interface RemoteConfig {
  url: string
  token: string
  enabled: boolean
}

export function remoteConfigPath(): string {
  return path.join(getDataDir(), 'remote.json')
}

/** Absent, unparseable, or wrong-shaped file → null (no remote). */
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
    return { url: cfg.url, token: cfg.token, enabled: cfg.enabled }
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
 * The daemon serves at the origin root (tailscale serve mounts there
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

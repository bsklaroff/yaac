import fs from 'node:fs/promises'
import path from 'node:path'
import { getDataDir } from '#paths'
import { REMOTE_CONFIG_FILENAME, parseRemoteConfig, type RemoteConfig } from '#remote-config-file'

export function remoteConfigPath(): string {
  return path.join(getDataDir(), REMOTE_CONFIG_FILENAME)
}

/** Absent, unparseable, or wrong-shaped file → null (no remote). */
export async function readRemote(): Promise<RemoteConfig | null> {
  try {
    return parseRemoteConfig(await fs.readFile(remoteConfigPath(), 'utf8'))
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

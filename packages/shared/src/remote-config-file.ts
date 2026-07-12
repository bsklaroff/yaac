/**
 * The dependency-free half of the remote-config contract: the file's shape
 * and parsing, with no `node:*`, `#…`, or `@yaac/*` imports. Split out of
 * `#remote` (which owns the file I/O rooted at getDataDir()) so that
 * non-Node consumers — the desktop launcher reads `remote.json` through
 * Tauri's fs plugin inside a webview — can share the exact same shape rules.
 */

/**
 * The one configured remote server (`~/.yaac/remote.json`, 0600). yaac
 * deliberately supports a single remote rather than named contexts —
 * `enabled` is the switch back to the local server without losing the
 * token. Growing this into a named map later is a client-side-only
 * change.
 */
export interface RemoteConfig {
  url: string
  token: string
  enabled: boolean
}

export const REMOTE_CONFIG_FILENAME = 'remote.json'

export function isRemoteConfig(value: unknown): value is RemoteConfig {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.url === 'string'
    && typeof v.token === 'string'
    && typeof v.enabled === 'boolean'
  )
}

/** Parse raw remote.json contents; null for malformed JSON or a wrong shape. */
export function parseRemoteConfig(raw: string): RemoteConfig | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRemoteConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

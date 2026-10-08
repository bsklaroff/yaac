/**
 * Upstream manifests install applies without vendoring them (Calico, the
 * Tailscale operator). The repo holds only each one's checksum; install
 * downloads the manifest once, checks it against the pin, and caches it
 * client-local. Both the cached and downloaded copies are checked on every
 * use, and a mismatch is fatal.
 */
import crypto from 'node:crypto'
import { pinnedManifestCachePath } from '@yaac/shared/project-paths'
import { ClusterInstallError } from './arg-guards'
import type { ClusterInstallDeps } from './install'

export interface PinnedManifest {
  /** What the manifest installs, for messages ("Calico"). */
  what: string
  url: string
  /** The committed `<sha256>  <file>` pin. */
  pinFile: string
  /** File name under the client-local cache, version included. */
  cacheName: string
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The pinned manifest, from the cache or downloaded and cached. */
export async function ensurePinnedManifest(
  deps: Pick<ClusterInstallDeps, 'readTextFile' | 'writeTextFile' | 'fetchText' | 'log'>,
  manifest: PinnedManifest,
): Promise<string> {
  const pin = await deps.readTextFile(manifest.pinFile)
  const expected = pin?.trim().split(/\s+/)[0]
  if (!expected) {
    throw new ClusterInstallError(
      `${manifest.what} manifest checksum not found at ${manifest.pinFile} — broken install?`,
    )
  }
  const cache = pinnedManifestCachePath(manifest.cacheName)
  const cached = await deps.readTextFile(cache)
  if (cached !== null && sha256Hex(cached) === expected) return cached

  deps.log(`Fetching the ${manifest.what} manifest (one-time — cached at ${cache})...`)
  let raw: string
  try {
    raw = await deps.fetchText(manifest.url)
  } catch (err) {
    throw new ClusterInstallError(
      `Could not download the ${manifest.what} manifest from ${manifest.url} `
      + `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}). `
      + `Check network access, or drop a verified copy at ${cache} and re-run.`,
    )
  }
  const actual = sha256Hex(raw)
  if (actual !== expected) {
    throw new ClusterInstallError(
      `The ${manifest.what} manifest at ${manifest.url} does not match the pinned checksum `
      + `(expected ${expected}, got ${actual}) — not installing it.`,
    )
  }
  await deps.writeTextFile(cache, raw)
  return raw
}

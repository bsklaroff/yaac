/**
 * The shell's server picker: list, switch between, add and remove servers.
 * All of them edit the shared `~/.yaac-client/server.json`, so a switch here also
 * moves the CLI, like `yaac remote set/on`. A server on this machine is
 * registered there by `yaac server start` like any other, so every row is
 * an origin.
 *
 * The renderer is web content from the server, so its IPC payloads are
 * re-validated here (`parseServerSelection`).
 */
import type { ServerConfig } from '@yaac/shared/server-config'
import type { DesktopServerOutcome, DesktopServerSelection, DesktopServerTargets } from '@yaac/shared/types'

export interface ServerSwitchDeps {
  /** @yaac/shared readServerConfig — null when nothing has ever been configured. */
  readServerConfig(): Promise<ServerConfig | null>
  /** @yaac/shared writeServerConfig. */
  writeServerConfig(cfg: ServerConfig): Promise<void>
  /** @yaac/shared withServerSelected. */
  select(existing: ServerConfig | null, url: string): ServerConfig
  /** @yaac/shared probeServer — throws a prescriptive error on any failure. */
  probeServer(origin: string): Promise<unknown>
  /** @yaac/shared normalizeServerUrl — throws on a non-origin URL. */
  normalizeUrl(raw: string): string
}

/** Validate a renderer-supplied selection; anything malformed → null. */
export function parseServerSelection(raw: unknown): DesktopServerSelection | null {
  if (!raw || typeof raw !== 'object') return null
  const sel = raw as Record<string, unknown>
  return typeof sel.url === 'string' && sel.url !== '' ? { url: sel.url } : null
}

export async function getServerTargets(deps: ServerSwitchDeps): Promise<DesktopServerTargets> {
  const cfg = await deps.readServerConfig()
  return {
    current: cfg?.enabled && cfg.url !== '' ? cfg.url : null,
    saved: cfg?.saved.map((s) => s.url) ?? [],
  }
}

/**
 * Point the machine at `sel`. The server is probed before the config is
 * written, so a dead server, or one that won't identify this device, returns
 * an error and nothing changes. The already-selected server is probed too:
 * on the disconnected page, Connect on that row is the retry.
 */
export async function applyServerSwitch(
  sel: DesktopServerSelection,
  deps: ServerSwitchDeps,
): Promise<DesktopServerOutcome> {
  const cfg = await deps.readServerConfig()
  const saved = cfg?.saved.find((s) => s.url === sel.url)
  if (!saved) return { ok: false, error: `unknown server: ${sel.url}` }
  try {
    await deps.probeServer(saved.url)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  await deps.writeServerConfig(deps.select(cfg, saved.url))
  return { ok: true }
}

/** Validate, probe, and select a brand-new server (the desktop `yaac remote set`). */
export async function addServerRemote(
  rawUrl: string,
  deps: ServerSwitchDeps,
): Promise<DesktopServerOutcome> {
  let origin: string
  try {
    origin = deps.normalizeUrl(rawUrl)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    await deps.probeServer(origin)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  await deps.writeServerConfig(deps.select(await deps.readServerConfig(), origin))
  return { ok: true }
}

/**
 * Forget a saved server. The selected one is refused: removing it would
 * leave the window attached to a server the machine no longer names.
 */
export async function removeServer(
  sel: DesktopServerSelection,
  deps: ServerSwitchDeps,
): Promise<DesktopServerOutcome> {
  const cfg = await deps.readServerConfig()
  if (!cfg?.saved.some((s) => s.url === sel.url)) return { ok: false, error: `unknown server: ${sel.url}` }
  if (cfg.enabled && cfg.url === sel.url) {
    return { ok: false, error: 'switch to another server before removing this one' }
  }
  const saved = cfg.saved.filter((s) => s.url !== sel.url)
  // A deselected config's url is still remembered; forgetting it clears it.
  await deps.writeServerConfig({ ...cfg, saved, ...(cfg.url === sel.url ? { url: '' } : {}) })
  return { ok: true }
}

/**
 * Put back the selection from `before`, keeping everything else that has
 * been written since: `yaac server start` saves this machine's origin and
 * its driver as well as selecting it.
 */
export async function restoreSelection(before: ServerConfig, deps: ServerSwitchDeps): Promise<void> {
  const cfg = await deps.readServerConfig()
  if (!cfg || (cfg.url === before.url && cfg.enabled === before.enabled)) return
  await deps.writeServerConfig({ ...cfg, url: before.url, enabled: before.enabled })
}

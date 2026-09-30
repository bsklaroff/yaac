/**
 * The shell's server picker: list, switch between, and add servers. All
 * three edit the shared `~/.yaac-client/server.json`, so a switch here also
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

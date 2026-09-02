/**
 * The shell's server picker: list the servers this machine has configured,
 * switch between them, and add a new one. All three operate on the shared
 * `~/.yaac-client/server.json` — switching here is the same machine-wide
 * move as `yaac remote set/on`, so the CLI follows.
 *
 * There is no local case. A server on this machine is registered in that
 * file by `yaac server start` (or `yaac cluster install`) exactly as one
 * elsewhere is by `yaac remote set`, so the picker's rows are origins all
 * the way down.
 *
 * The renderer is web content from the server origin, so it is only ever
 * shown origins — `DesktopServerTargets` and the selections carry no
 * tokens — and its IPC payloads are re-validated here
 * (`parseServerSelection`). Deps are injected so every branch unit-tests
 * without fs or network.
 */
import type { ServerConfig } from '@yaac/shared/server-config'
import type { DesktopServerOutcome, DesktopServerSelection, DesktopServerTargets } from '@yaac/shared/types'

export interface ServerSwitchDeps {
  /** @yaac/shared readServerConfig — null when nothing has ever been configured. */
  readServerConfig(): Promise<ServerConfig | null>
  /** @yaac/shared writeServerConfig. */
  writeServerConfig(cfg: ServerConfig): Promise<void>
  /** @yaac/shared withServerSelected. */
  select(existing: ServerConfig | null, url: string, token: string): ServerConfig
  /** @yaac/shared probeServer — throws a prescriptive error on any failure. */
  probeServer(origin: string, token: string): Promise<unknown>
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
 * Point the machine at `sel`. The server is re-probed with its saved token
 * before the config is written, so a dead server or revoked token surfaces
 * as an inline error and the shell stays where it is.
 *
 * The already-selected server is probed and re-selected like any other,
 * rather than short-circuited: from the disconnected page, Connect on the
 * selected-but-unreachable row IS the retry, and answering "no change" to
 * it would leave the window sitting on the failure forever.
 */
export async function applyServerSwitch(
  sel: DesktopServerSelection,
  deps: ServerSwitchDeps,
): Promise<DesktopServerOutcome> {
  const cfg = await deps.readServerConfig()
  const saved = cfg?.saved.find((s) => s.url === sel.url)
  if (!saved) return { ok: false, error: `unknown server: ${sel.url}` }
  try {
    await deps.probeServer(saved.url, saved.token)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  await deps.writeServerConfig(deps.select(cfg, saved.url, saved.token))
  return { ok: true }
}

/** Validate, probe, and select a brand-new server (the desktop `yaac remote set`). */
export async function addServerRemote(
  rawUrl: string,
  token: string,
  deps: ServerSwitchDeps,
): Promise<DesktopServerOutcome> {
  let origin: string
  try {
    origin = deps.normalizeUrl(rawUrl)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    await deps.probeServer(origin, token)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  await deps.writeServerConfig(deps.select(await deps.readServerConfig(), origin, token))
  return { ok: true }
}

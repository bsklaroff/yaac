/**
 * The Servers page's server list: switch between, add, remove and
 * disconnect from servers. All of them edit the shared
 * `~/.yaac-client/server.json`, so a switch here also moves the CLI, like
 * `yaac remote connect/disconnect`. A server on this machine is
 * registered there by `yaac server start` like any other, so every row is
 * an origin.
 *
 * The page's IPC payloads are re-validated here (`parseServerSelection`)
 * like any renderer's.
 */
import { IdentityRejectedError, type ServerConfig } from '@yaac/shared/server-config'
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

/** Validate a page-supplied selection; anything malformed → null. */
export function parseServerSelection(raw: unknown): DesktopServerSelection | null {
  if (!raw || typeof raw !== 'object') return null
  const sel = raw as Record<string, unknown>
  return typeof sel.url === 'string' && sel.url !== '' ? { url: sel.url } : null
}

export async function getServerTargets(deps: ServerSwitchDeps): Promise<DesktopServerTargets> {
  const cfg = await deps.readServerConfig()
  return {
    current: cfg && cfg.url !== '' ? cfg.url : null,
    saved: cfg?.saved.map((s) => s.url) ?? [],
  }
}

/**
 * Why a saved server cannot be connected to: it does not answer, or it
 * answers but will not identify this device (a tagged tailnet device, or an
 * origin for the wrong access mode), which starting it would not fix.
 */
export type ServerHealth = { kind: 'stopped' } | { kind: 'refused', reason: string }

/**
 * Each saved server that cannot be connected to, and why, probed in
 * parallel as the Servers page opens. A server that can is absent.
 */
export async function serverHealth(deps: ServerSwitchDeps): Promise<Record<string, ServerHealth>> {
  const urls = (await deps.readServerConfig())?.saved.map((s) => s.url) ?? []
  const health = await Promise.all(urls.map((url) => deps.probeServer(url).then(
    () => null,
    (err: unknown): ServerHealth => err instanceof IdentityRejectedError
      ? { kind: 'refused', reason: err.message }
      : { kind: 'stopped' },
  )))
  return Object.fromEntries(urls.flatMap((url, i) => health[i] ? [[url, health[i]]] : []))
}

/**
 * Point the machine at `sel`. The server is probed before the config is
 * written, so a dead server, or one that won't identify this device, returns
 * an error and nothing changes. The already-selected server is probed too:
 * when it is unreachable, Connect on its row is the retry.
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

/** Validate, probe, and select a brand-new server (the desktop `yaac remote add`). */
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
  if (cfg.url === sel.url) {
    return { ok: false, error: 'switch to another server before removing this one' }
  }
  await deps.writeServerConfig({ ...cfg, saved: cfg.saved.filter((s) => s.url !== sel.url) })
  return { ok: true }
}

/**
 * Deselect the selected server without forgetting it, as `yaac remote
 * disconnect` does, so the machine has no server until one is picked or started.
 */
export async function disconnect(deps: ServerSwitchDeps): Promise<DesktopServerOutcome> {
  const cfg = await deps.readServerConfig()
  if (!cfg || cfg.url === '') return { ok: false, error: 'no server is selected' }
  await deps.writeServerConfig({ ...cfg, url: '' })
  return { ok: true }
}

/**
 * Put back the selection from `before`, keeping everything else that has
 * been written since: a start saves this machine's origin as well as
 * selecting it.
 */
export async function restoreSelection(before: ServerConfig, deps: ServerSwitchDeps): Promise<void> {
  const cfg = await deps.readServerConfig()
  if (!cfg || cfg.url === before.url) return
  await deps.writeServerConfig({ ...cfg, url: before.url })
}

/**
 * The shell's server picker: list the machine's attachment targets (local
 * server + every saved remote), switch between them, and add a new remote.
 * All three operate on the shared `~/.yaac-client/remote.json` — switching here is
 * the same machine-wide move as `yaac remote on/off`, so the CLI follows.
 *
 * The renderer is web content from the (possibly remote) server origin, so
 * it is only ever shown origins — `ServerTargetsView` and the switch
 * selections carry no tokens — and its IPC payloads are re-validated here
 * (`parseServerSelection`). Deps are injected so every branch unit-tests
 * without fs or network.
 */
import type { RemoteConfig } from '@yaac/shared/remote'
import type { DesktopServerOutcome, DesktopServerSelection, DesktopServerTargets } from '@yaac/shared/types'

export interface ServerSwitchDeps {
  /** @yaac/shared readRemote — null when no remote has ever been configured. */
  readRemote(): Promise<RemoteConfig | null>
  /** @yaac/shared writeRemote. */
  writeRemote(cfg: RemoteConfig): Promise<void>
  /** @yaac/shared withRemoteActivated. */
  activate(existing: RemoteConfig | null, url: string, token: string): RemoteConfig
  /** @yaac/shared probeRemote — throws a prescriptive error on any failure. */
  probeRemote(origin: string, token: string): Promise<unknown>
  /** @yaac/shared normalizeRemoteUrl — throws on a non-origin URL. */
  normalizeUrl(raw: string): string
}

/** Validate a renderer-supplied selection; anything malformed → null. */
export function parseServerSelection(raw: unknown): DesktopServerSelection | null {
  if (!raw || typeof raw !== 'object') return null
  const sel = raw as Record<string, unknown>
  if (sel.kind === 'local') return { kind: 'local' }
  if (sel.kind === 'remote' && typeof sel.url === 'string') return { kind: 'remote', url: sel.url }
  return null
}

export async function getServerTargets(deps: ServerSwitchDeps): Promise<DesktopServerTargets> {
  const cfg = await deps.readRemote()
  return {
    current: cfg?.enabled ? { kind: 'remote', url: cfg.url } : { kind: 'local' },
    saved: cfg?.saved.map((s) => s.url) ?? [],
  }
}

/**
 * Point the machine's attachment at `sel`. A remote is re-probed with its
 * saved token before the config flips, so a dead server or revoked token
 * surfaces as an inline error and the shell stays where it is. `changed:
 * false` means the selection was already current (no reland needed).
 */
export async function applyServerSwitch(
  sel: DesktopServerSelection,
  deps: ServerSwitchDeps,
): Promise<DesktopServerOutcome> {
  const cfg = await deps.readRemote()
  if (sel.kind === 'local') {
    if (!cfg?.enabled) return { ok: true, changed: false }
    await deps.writeRemote({ ...cfg, enabled: false })
    return { ok: true, changed: true }
  }
  if (cfg?.enabled && cfg.url === sel.url) return { ok: true, changed: false }
  const saved = cfg?.saved.find((s) => s.url === sel.url)
  if (!saved) return { ok: false, error: `unknown remote: ${sel.url}` }
  try {
    await deps.probeRemote(saved.url, saved.token)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  await deps.writeRemote(deps.activate(cfg, saved.url, saved.token))
  return { ok: true, changed: true }
}

/** Validate, probe, and activate a brand-new remote (the desktop `yaac remote set`). */
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
    await deps.probeRemote(origin, token)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  await deps.writeRemote(deps.activate(await deps.readRemote(), origin, token))
  return { ok: true, changed: true }
}

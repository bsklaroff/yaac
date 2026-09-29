import fs from 'node:fs/promises'
import { clientLocalPath, ensureClientLocalRoot } from '#paths'
import type { DriverKind, Principal } from '#types'

/**
 * Which yaac server this machine's clients talk to, and what kind of
 * install this data dir is (`~/.yaac-client/server.json`, 0600).
 *
 * `url` is the selected server and `enabled` is the switch that deselects
 * it without forgetting it; `saved` remembers every server ever configured
 * so clients (the desktop shell's picker, `yaac remote on`) can switch
 * back without re-entering one. The machine has one selection at a time —
 * `saved` is history, not contexts.
 *
 * There is no other way to reach a server. A server on this machine is
 * registered here by `yaac server start` exactly as an in-cluster one is by
 * `yaac cluster install` (`registerServer` below), so no client has a local
 * case: an origin is the whole of "how do I reach the server". Who the
 * caller IS is not a credential this file holds — the server derives it
 * from the request (docs/remote-hosting.md).
 */
export interface SavedServer {
  url: string
}

export interface ServerConfig {
  url: string
  enabled: boolean
  saved: SavedServer[]
  /**
   * Which substrate this INSTALL runs — not which substrate the selected
   * server runs. Top-level rather than per-entry because its readers ask
   * about this data dir ("is there a host server to start, or a Deployment
   * to converge?"), which does not change when the selection points at
   * another machine. A remote server's driver is not recorded at all; its
   * snapshot reports it live.
   */
  driver?: DriverKind
}

/**
 * CLIENT-LOCAL: which server this machine's clients talk to. Nothing but
 * clients ever reads it — under the k8s driver the server is a pod, and a
 * pod has no business knowing the origin its callers dial it on.
 */
export function serverConfigPath(): string {
  return clientLocalPath('server.json')
}

/**
 * Absent, unparseable, or wrong-shaped file → null (no server configured).
 * The selected server is always folded into `saved`, so callers can treat
 * `saved` as the complete known-servers list. Fields this reader does not
 * know are dropped, and go on the next write.
 */
export async function readServerConfig(): Promise<ServerConfig | null> {
  try {
    const raw = await fs.readFile(serverConfigPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const cfg = parsed as Record<string, unknown>
    if (typeof cfg.url !== 'string' || typeof cfg.enabled !== 'boolean') return null
    const saved = (Array.isArray(cfg.saved) ? cfg.saved : [])
      .filter((s: unknown): s is SavedServer =>
        !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).url === 'string')
      .map((s) => ({ url: s.url }))
    // The empty url is `clearServerConfig`'s "nothing selected, but this is
    // still a k8s install" state — not a server to remember.
    if (cfg.url !== '' && !saved.some((s) => s.url === cfg.url)) {
      saved.unshift({ url: cfg.url })
    }
    const driver = cfg.driver === 'k8s' || cfg.driver === 'containerless' ? cfg.driver : undefined
    return {
      url: cfg.url,
      enabled: cfg.enabled,
      saved,
      ...(driver ? { driver } : {}),
    }
  } catch {
    return null
  }
}

/** Persist atomically (tmp + rename) at 0600, like everything client-local. */
export async function writeServerConfig(cfg: ServerConfig): Promise<void> {
  await ensureClientLocalRoot()
  const p = serverConfigPath()
  const tmp = `${p}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  await fs.rename(tmp, p)
}

/**
 * Forget every configured server (`yaac remote unset`), keeping the record
 * of what kind of install this is.
 *
 * Not a delete: `driver` shares this file, and dropping it would leave a
 * k8s install unable to refuse a host `yaac server start` — two writers on
 * one data dir. With nothing left to record, the file goes.
 */
export async function clearServerConfig(): Promise<void> {
  const driver = (await readServerConfig())?.driver
  if (driver === undefined) {
    await fs.rm(serverConfigPath(), { force: true })
    return
  }
  await writeServerConfig({ url: '', enabled: false, saved: [], driver })
}

/**
 * Validate and canonicalize a server URL to a bare http(s) origin.
 * The server serves at the origin root (tailscale serve mounts there
 * too), so paths/queries are a configuration mistake — reject rather
 * than silently strip.
 */
export function normalizeServerUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`invalid server URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`server URL must be http(s): ${raw}`)
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`server URL must be a bare origin (no path/query/fragment): ${raw}`)
  }
  return url.origin
}

/**
 * A config with `url` as the selected server, moved to the front of
 * `saved`. The other saved servers and the install's `driver` carry over
 * from `existing`.
 */
export function withServerSelected(existing: ServerConfig | null, url: string): ServerConfig {
  const others = (existing?.saved ?? []).filter((s) => s.url !== url)
  return {
    url,
    enabled: true,
    saved: [{ url }, ...others],
    ...(existing?.driver ? { driver: existing.driver } : {}),
  }
}

const PROBE_TIMEOUT_MS = 5000

/**
 * The server answered, and it will not say who this device is: it reached
 * the server through `tailscale serve` with no user identity (a tagged
 * device, or Funnel), or by a name that is not loopback without going
 * through `serve` at all. The message is the server's own, which says
 * which. Distinguished from every other probe failure because retrying
 * does not help — the fix is on the tailnet, not here.
 */
export class IdentityRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityRejectedError'
  }
}

/**
 * Verify a server end to end: the origin answers /health, and /whoami
 * identifies this device (/health is public — only /whoami proves the
 * server will take this device's requests). Returns the server's build id
 * so callers can warn on skew, and who the server says this device is;
 * throws a prescriptive error on any failure, and an
 * `IdentityRejectedError` specifically when the server refused to
 * identify the caller.
 */
export async function probeServer(origin: string): Promise<{ buildId: string; principal: Principal }> {
  let health: Response
  try {
    health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`cannot reach ${origin}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!health.ok) throw new Error(`${origin}/api/health returned HTTP ${health.status}`)
  const { buildId } = await health.json() as { ok: boolean; buildId: string }

  const whoami = await fetch(`${origin}/api/whoami`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  if (whoami.status === 401) {
    const body = await whoami.json().catch(() => null) as { error?: { message?: string } } | null
    throw new IdentityRejectedError(
      `${origin} refused to identify this device: ${body?.error?.message ?? 'HTTP 401'}`,
    )
  }
  if (!whoami.ok) throw new Error(`identity check against ${origin} failed (HTTP ${whoami.status})`)
  return { buildId, principal: await whoami.json() as Principal }
}

/**
 * Point this machine's clients at the server that was just stood up, and
 * record which kind of install stood it up. `yaac server start` calls it
 * for the host server it spawned, `yaac cluster install` for the
 * Deployment it applied — the one registration both substrates share.
 */
export async function registerServer(origin: string, driver: DriverKind): Promise<void> {
  await writeServerConfig({ ...withServerSelected(await readServerConfig(), origin), driver })
}

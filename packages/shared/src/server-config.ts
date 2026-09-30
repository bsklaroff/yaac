import fs from 'node:fs/promises'
import { clientLocalPath, ensureClientLocalRoot } from '#paths'
import type { DriverKind, Principal } from '#types'

/**
 * Which yaac server this machine's clients talk to, and what kind of
 * install this data dir is (`~/.yaac-client/server.json`, 0600).
 *
 * `url` is the selected server; `enabled` deselects it without forgetting
 * it; `saved` lists every server ever configured so clients can switch
 * back. Both `yaac server start` and `yaac cluster install` register their
 * server here (`registerServer`), so clients always reach a server by its
 * origin. The file holds no credential: the server identifies the caller
 * from the request (docs/remote-hosting.md, docs/server-selection.md).
 */
export interface SavedServer {
  url: string
}

export interface ServerConfig {
  url: string
  enabled: boolean
  saved: SavedServer[]
  /**
   * Which substrate this data dir's install runs, not the selected server's
   * (which may be on another machine and reports its own driver).
   */
  driver?: DriverKind
  /**
   * Random id minted by the first `yaac cluster install` and stamped on its
   * Deployment and volumes. Data-dir paths repeat across machines, so volume
   * re-adoption, foreign-Deployment refusal and byo uninstall key on this.
   */
  installId?: string
  /**
   * The uid of the install's cluster's `kube-system` namespace. Unlike a
   * context name, it cannot be reused by another cluster, so host-side
   * cluster commands refuse when the current context points elsewhere.
   * Missing from older files until the next install
   * (docs/legacy-compat-shims.md).
   */
  clusterUid?: string
  /** The kube context the install used; shown in refusal messages. */
  kubeContext?: string
  /**
   * The install is `--byo`: yaac did not create the cluster, so
   * `yaac cluster delete` refuses and nothing here execs into its nodes.
   */
  byo?: boolean
}

const INSTALL_KEYS = ['driver', 'installId', 'clusterUid', 'kubeContext', 'byo'] as const

/** What this data dir records about its install, beside the selection. */
export type InstallRecord = Pick<ServerConfig, typeof INSTALL_KEYS[number]>

/** The install-level fields a rewrite of the selection must carry over. */
function installFields(cfg: InstallRecord | null): InstallRecord {
  const out: Record<string, unknown> = {}
  for (const key of INSTALL_KEYS) if (cfg?.[key]) out[key] = cfg[key]
  return out as InstallRecord
}

/** CLIENT-LOCAL: read only by clients, never by the server. */
export function serverConfigPath(): string {
  return clientLocalPath('server.json')
}

/**
 * Null for an absent or malformed file. The selected server is always
 * included in `saved`. Unknown fields are dropped.
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
    // An empty url means nothing is selected (see clearServerConfig).
    if (cfg.url !== '' && !saved.some((s) => s.url === cfg.url)) {
      saved.unshift({ url: cfg.url })
    }
    const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined
    return {
      url: cfg.url,
      enabled: cfg.enabled,
      saved,
      ...installFields({
        driver: cfg.driver === 'k8s' || cfg.driver === 'containerless' ? cfg.driver : undefined,
        installId: str(cfg.installId),
        clusterUid: str(cfg.clusterUid),
        kubeContext: str(cfg.kubeContext),
        byo: cfg.byo === true,
      }),
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
 * Forget every configured server (`yaac remote unset`) but keep the install
 * record, so a k8s install still refuses a host `yaac server start`. The
 * file is deleted only when there is no install record.
 */
export async function clearServerConfig(): Promise<void> {
  const install = installFields(await readServerConfig())
  if (install.driver === undefined) {
    await fs.rm(serverConfigPath(), { force: true })
    return
  }
  await writeServerConfig({ url: '', enabled: false, saved: [], ...install })
}

/**
 * Validate and canonicalize a server URL to a bare http(s) origin. The
 * server is always at the origin root, so a path or query is rejected as a
 * mistake rather than stripped.
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
 * `saved`. Other saved servers and the install record carry over from
 * `existing`.
 */
export function withServerSelected(existing: ServerConfig | null, url: string): ServerConfig {
  const others = (existing?.saved ?? []).filter((s) => s.url !== url)
  return {
    url,
    enabled: true,
    saved: [{ url }, ...others],
    ...installFields(existing),
  }
}

const PROBE_TIMEOUT_MS = 5000

/**
 * The server answered but refused to identify this device, e.g. a request
 * via `tailscale serve` with no user identity, or a non-loopback name that
 * bypassed `serve`. The message is the server's. Retrying does not help;
 * the fix is on the tailnet.
 */
export class IdentityRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityRejectedError'
  }
}

/**
 * Check that the origin answers /health and that /whoami identifies this
 * device (/health is public, so only /whoami proves access). Returns the
 * build id, for skew warnings, and the caller's principal. Throws
 * `IdentityRejectedError` when the server refuses to identify the caller.
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
 * Select a just-started server and record the install's driver. Called by
 * `yaac server start` and `yaac cluster install`.
 */
export async function registerServer(origin: string, driver: DriverKind): Promise<void> {
  await writeServerConfig({ ...withServerSelected(await readServerConfig(), origin), driver })
}

/**
 * Merge `patch` into the install record, leaving the selection alone; an
 * `undefined` value drops the field. `yaac cluster install` calls this
 * before changing anything, so a rerun after a failure recognizes what the
 * failed run created.
 */
export async function recordInstall(patch: InstallRecord): Promise<void> {
  const existing = await readServerConfig()
  await writeServerConfig({
    url: existing?.url ?? '',
    enabled: existing?.enabled ?? false,
    saved: existing?.saved ?? [],
    ...installFields({ ...installFields(existing), ...patch }),
  })
}

import { readBuildId } from '@/shared/build-id'
import { describeBuildSkew } from '@/shared/daemon-client'
import {
  clearRemote,
  normalizeRemoteUrl,
  readRemote,
  writeRemote,
  type RemoteConfig,
} from '@/shared/remote'
import { maskToken } from '@/shared/mask'

const PROBE_TIMEOUT_MS = 5000

/**
 * Configure (and enable) the remote daemon after verifying it end to
 * end: the origin answers /health, and the token authenticates against
 * a protected route. Build skew is a warning, not a failure — client
 * and server upgrade independently.
 */
export async function remoteSet(url: string, opts: { token: string }): Promise<void> {
  const origin = normalizeRemoteUrl(url)

  let health: Response
  try {
    health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`cannot reach ${origin}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!health.ok) throw new Error(`${origin}/health returned HTTP ${health.status}`)
  const { buildId } = await health.json() as { ok: boolean; buildId: string }

  // /health is public — only an authenticated call proves the token.
  const check = await fetch(`${origin}/tokens`, {
    headers: { authorization: `Bearer ${opts.token}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  if (check.status === 401) {
    throw new Error(
      `token rejected by ${origin} — mint one on the server with: yaac auth token create <name>`,
    )
  }
  if (!check.ok) throw new Error(`token check against ${origin} failed (HTTP ${check.status})`)

  const skew = describeBuildSkew(buildId, await readBuildId())
  if (skew) console.error(skew)

  await writeRemote({ url: origin, token: opts.token, enabled: true })
  console.log(`Remote set and enabled: ${origin}`)
}

export async function remoteUnset(): Promise<void> {
  await clearRemote()
  console.log('Remote cleared — commands target the local daemon.')
}

export async function remoteOn(): Promise<void> {
  const cfg = await requireRemote()
  await writeRemote({ ...cfg, enabled: true })
  console.log(`Remote enabled: ${cfg.url}`)
}

export async function remoteOff(): Promise<void> {
  const cfg = await requireRemote()
  await writeRemote({ ...cfg, enabled: false })
  console.log('Remote disabled — commands target the local daemon.')
}

export async function remoteStatus(): Promise<void> {
  const cfg = await readRemote()
  if (!cfg) {
    console.log('No remote configured. Set one with: yaac remote set <url> --token <token>')
    return
  }
  console.log(`url      ${cfg.url}`)
  console.log(`token    ${maskToken(cfg.token)}`)
  console.log(`enabled  ${cfg.enabled ? 'yes' : 'no'}`)
}

async function requireRemote(): Promise<RemoteConfig> {
  const cfg = await readRemote()
  if (!cfg) {
    throw new Error('No remote configured. Set one with: yaac remote set <url> --token <token>')
  }
  return cfg
}

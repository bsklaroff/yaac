import { readBuildId } from '@yaac/shared/build-id'
import { describeBuildSkew } from '@yaac/shared/server-api'
import {
  clearRemote,
  normalizeRemoteUrl,
  probeRemote,
  readRemote,
  withRemoteActivated,
  writeRemote,
  type RemoteConfig,
} from '@yaac/shared/remote'
import { maskToken } from '@yaac/shared/mask'

/**
 * Configure (and enable) the remote server after verifying it end to
 * end (probeRemote: /health plus an authenticated route). Build skew is
 * a warning, not a failure — client and server upgrade independently.
 * Previously set remotes stay in the config's `saved` list.
 */
export async function remoteSet(url: string, opts: { token: string }): Promise<void> {
  const origin = normalizeRemoteUrl(url)
  const { buildId } = await probeRemote(origin, opts.token)

  const skew = describeBuildSkew(buildId, await readBuildId())
  if (skew) console.error(skew)

  await writeRemote(withRemoteActivated(await readRemote(), origin, opts.token))
  console.log(`Remote set and enabled: ${origin}`)
}

export async function remoteUnset(): Promise<void> {
  await clearRemote()
  console.log('Remote cleared — commands target the local server.')
}

export async function remoteOn(): Promise<void> {
  const cfg = await requireRemote()
  await writeRemote({ ...cfg, enabled: true })
  console.log(`Remote enabled: ${cfg.url}`)
}

export async function remoteOff(): Promise<void> {
  const cfg = await requireRemote()
  await writeRemote({ ...cfg, enabled: false })
  console.log('Remote disabled — commands target the local server.')
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
  const others = cfg.saved.filter((s) => s.url !== cfg.url)
  if (others.length > 0) {
    console.log(`saved    ${others.map((s) => s.url).join(', ')}`)
  }
}

async function requireRemote(): Promise<RemoteConfig> {
  const cfg = await readRemote()
  if (!cfg) {
    throw new Error('No remote configured. Set one with: yaac remote set <url> --token <token>')
  }
  return cfg
}

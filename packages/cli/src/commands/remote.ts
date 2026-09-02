import { readBuildId } from '@yaac/shared/build-id'
import { describeBuildSkew } from '@yaac/shared/server-api'
import {
  clearServerConfig,
  normalizeServerUrl,
  probeServer,
  readServerConfig,
  withServerSelected,
  writeServerConfig,
  type ServerConfig,
} from '@yaac/shared/server-config'
import { maskToken } from '@yaac/shared/mask'

/**
 * `yaac remote …` — pick which server this machine's clients talk to.
 *
 * The selection is machine-wide (`~/.yaac-client/server.json`) and covers
 * every server, including one on this machine: `yaac server start` and
 * `yaac cluster install` register theirs here, so these verbs switch
 * between them and any server elsewhere with no local case. Deselecting
 * leaves the machine pointed at nothing until something is selected again
 * — there is no fallback to look for a server on this host.
 */

/**
 * Select a server after verifying it end to end (`probeServer`: /health
 * plus an authenticated route). Build skew is a warning, not a failure —
 * client and server upgrade independently. Previously configured servers
 * stay in the config's `saved` list.
 */
export async function remoteSet(url: string, opts: { token: string }): Promise<void> {
  const origin = normalizeServerUrl(url)
  const { buildId } = await probeServer(origin, opts.token)

  const skew = describeBuildSkew(buildId, await readBuildId(), origin)
  if (skew) console.error(skew)

  await writeServerConfig(withServerSelected(await readServerConfig(), origin, opts.token))
  console.log(`Server selected: ${origin}`)
}

export async function remoteUnset(): Promise<void> {
  await clearServerConfig()
  console.log('Servers forgotten — no server is selected.')
}

export async function remoteOn(): Promise<void> {
  const cfg = await requireConfigured()
  await writeServerConfig({ ...cfg, enabled: true })
  console.log(`Server selected: ${cfg.url}`)
}

export async function remoteOff(): Promise<void> {
  const cfg = await requireConfigured()
  await writeServerConfig({ ...cfg, enabled: false })
  console.log(
    'No server selected — commands will not reach one until you run '
    + '`yaac remote on` or `yaac server start`.',
  )
}

export async function remoteStatus(): Promise<void> {
  const cfg = await readServerConfig()
  if (!cfg || cfg.url === '') {
    console.log('No server configured. Select one with: yaac remote set <url> --token <token>')
    return
  }
  console.log(`url      ${cfg.url}`)
  console.log(`token    ${maskToken(cfg.token)}`)
  console.log(`selected ${cfg.enabled ? 'yes' : 'no'}`)
  const others = cfg.saved.filter((s) => s.url !== cfg.url)
  if (others.length > 0) {
    console.log(`saved    ${others.map((s) => s.url).join(', ')}`)
  }
}

async function requireConfigured(): Promise<ServerConfig> {
  const cfg = await readServerConfig()
  if (!cfg || cfg.url === '') {
    throw new Error('No server configured. Select one with: yaac remote set <url> --token <token>')
  }
  return cfg
}

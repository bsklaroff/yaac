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

/**
 * `yaac remote …`: pick which server this machine's clients talk to
 * (docs/server-selection.md).
 *
 * The selection is machine-wide (`~/.yaac-client/server.json`). A local
 * server is selected the same way: `yaac server start` and `yaac cluster
 * install` register theirs here. With nothing selected, clients have no
 * server; there is no fallback to a local one.
 */

/**
 * Select a server after `probeServer` checks /health and /whoami. A build
 * mismatch only warns, since client and server upgrade independently.
 * Previously configured servers stay in the `saved` list.
 */
export async function remoteSet(url: string): Promise<void> {
  const origin = normalizeServerUrl(url)
  const { buildId, principal } = await probeServer(origin)

  const skew = describeBuildSkew(buildId, await readBuildId(), origin)
  if (skew) console.error(skew)

  await writeServerConfig(withServerSelected(await readServerConfig(), origin))
  const as = principal.kind === 'tailnet' ? ` (as ${principal.login})` : ''
  console.log(`Server selected: ${origin}${as}`)
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
    console.log('No server configured. Select one with: yaac remote set <url>')
    return
  }
  console.log(`url      ${cfg.url}`)
  console.log(`selected ${cfg.enabled ? 'yes' : 'no'}`)
  const others = cfg.saved.filter((s) => s.url !== cfg.url)
  if (others.length > 0) {
    console.log(`saved    ${others.map((s) => s.url).join(', ')}`)
  }
}

async function requireConfigured(): Promise<ServerConfig> {
  const cfg = await readServerConfig()
  if (!cfg || cfg.url === '') {
    throw new Error('No server configured. Select one with: yaac remote set <url>')
  }
  return cfg
}

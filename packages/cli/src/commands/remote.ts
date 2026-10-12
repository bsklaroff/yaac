import { readBuildId } from '@yaac/shared/build-id'
import { describeBuildSkew } from '@yaac/shared/server-api'
import {
  normalizeServerUrl,
  probeServer,
  readServerConfig,
  withServerSelected,
  writeServerConfig,
} from '@yaac/shared/server-config'

/**
 * `yaac remote …`: pick which server this machine's clients talk to
 * (docs/server-selection.md). The commands mirror the desktop app's
 * Servers page, and both edit the same machine-wide
 * `~/.yaac-client/server.json`.
 * A server on this machine is saved the same way: `yaac server start` and
 * `yaac cluster install` register theirs here. With nothing selected,
 * clients have no server; there is no fallback to a local one.
 */

/** Print every saved server, marking the selected one. */
export async function remoteList(): Promise<void> {
  const cfg = await readServerConfig()
  if (!cfg || cfg.saved.length === 0) {
    console.log('No servers saved. Add one with: yaac remote add <url>')
    return
  }
  for (const { url } of cfg.saved) console.log(`${url === cfg.url ? '*' : ' '} ${url}`)
  if (cfg.url === '') console.log('No server selected. Pick one with: yaac remote connect <url>')
}

/** Save a new server and select it, like the Servers page's Add. */
export async function remoteAdd(url: string): Promise<void> {
  await probeAndSelect(normalizeServerUrl(url))
}

/**
 * Select a saved server. The selected one is probed too, so connecting to
 * it again is how to check it still answers.
 */
export async function remoteConnect(url: string): Promise<void> {
  const origin = normalizeServerUrl(url)
  if (!(await readServerConfig())?.saved.some((s) => s.url === origin)) {
    throw new Error(`Unknown server: ${origin}. Add it with: yaac remote add ${origin}`)
  }
  await probeAndSelect(origin)
}

export async function remoteDisconnect(): Promise<void> {
  const cfg = await readServerConfig()
  if (cfg && cfg.url !== '') await writeServerConfig({ ...cfg, url: '' })
  console.log(
    'No server selected — commands will not reach one until you run '
    + '`yaac remote connect <url>` or `yaac server start`.',
  )
}

/**
 * Forget a saved server, like the Servers page's Remove. The selected one is
 * refused, so the selection always names a saved server.
 */
export async function remoteRemove(url: string): Promise<void> {
  const origin = normalizeServerUrl(url)
  const cfg = await readServerConfig()
  if (!cfg?.saved.some((s) => s.url === origin)) throw new Error(`Unknown server: ${origin}`)
  if (cfg.url === origin) {
    throw new Error(
      `${origin} is the selected server. Run \`yaac remote disconnect\` or connect to another one first.`,
    )
  }
  await writeServerConfig({ ...cfg, saved: cfg.saved.filter((s) => s.url !== origin) })
  console.log(`Server removed: ${origin}`)
}

/**
 * Select `origin` once `probeServer` has checked /health and /whoami, so a
 * dead server never becomes the selection. A build mismatch only warns,
 * since client and server upgrade independently.
 */
async function probeAndSelect(origin: string): Promise<void> {
  const { buildId, principal } = await probeServer(origin)
  const skew = describeBuildSkew(buildId, await readBuildId(), origin)
  if (skew) console.error(skew)

  await writeServerConfig(withServerSelected(await readServerConfig(), origin))
  const as = principal.kind === 'tailnet' ? ` (as ${principal.login})` : ''
  console.log(`Server selected: ${origin}${as}`)
}

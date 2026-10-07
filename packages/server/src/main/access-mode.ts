import { env } from '@yaac/shared/env'
import type { AccessMode } from '@yaac/shared/types'
import { readAccessMode, recordAccessMode } from '#db'

/** A start whose requested access mode the install cannot run in. The
 *  message names the command that fixes it. */
export class AccessModeRefusal extends Error {}

/**
 * Settle which callers this start admits (docs/remote-hosting.md "Access
 * modes"), from the mode it was asked for (`env.accessMode`, set by `yaac
 * server start` or the k8s Deployment) and the one the database records.
 *
 * - A fresh install records whatever it is asked for.
 * - `local` → `tailnet` is one-way and needs `--owner <login>`, which gives
 *   the built-in user that login; a fresh `tailnet` install may name one
 *   too. `--owner` is ignored once the install is `tailnet`.
 * - `tailnet` → `local` is refused, and so is `tailnet` for a server nested
 *   in a workspace, which is reached only through its outer workspace.
 */
export async function settleAccessMode(): Promise<AccessMode> {
  const requested = env.accessMode
  const recorded = await readAccessMode()
  const how = env.inCluster
    ? { local: 'yaac cluster install', tailnet: 'yaac cluster install --tailnet' }
    : { local: 'yaac server start', tailnet: 'yaac server start --tailnet <host>' }
  if (requested === 'tailnet' && env.workspaceId !== undefined) {
    throw new AccessModeRefusal(
      'a yaac server inside a workspace is always local: it is reached through its '
      + 'workspace\'s forward, which only that workspace\'s owner can open. Start it '
      + 'without --tailnet.',
    )
  }
  if (recorded === 'tailnet' && requested === 'local') {
    throw new AccessModeRefusal(
      `this install runs in tailnet mode, and switching it back to local is refused. Start it with \`${how.tailnet}\`.`,
    )
  }
  if (recorded === 'local' && requested === 'tailnet' && env.accessOwner === undefined) {
    throw new AccessModeRefusal(
      'this install runs in local mode, and switching it to tailnet needs the tailnet '
      + `login that will own its projects and settings: \`${how.tailnet} --owner <login>\`. `
      + `To keep it local, use \`${how.local}\`.`,
    )
  }
  if (recorded !== requested) {
    await recordAccessMode(requested, requested === 'tailnet' ? env.accessOwner : undefined)
  }
  return requested
}

import { env } from '@yaac/shared/env'
import type { AccessMode } from '@yaac/shared/types'
import { listAdmins, readAccessMode, recordAccessMode } from '#db'

/** A start whose requested access mode the install cannot run in. The
 *  message names the command that fixes it. */
export class AccessModeRefusal extends Error {}

/**
 * Settle which callers this start admits (docs/remote-hosting.md "Access
 * modes"), from the mode it was asked for (`env.accessMode`, set by `yaac
 * server start` or the k8s Deployment) and the one the database records, and
 * give a `tailnet` install with no admin the ones `--admin` names
 * (`env.accessAdmins`; docs/multi-user.md "Roles").
 *
 * - A fresh `local` install records the mode.
 * - `local` → `tailnet` is one-way and needs exactly one `--admin`, which
 *   gives the built-in user that login.
 * - A `tailnet` start with no admin (a fresh install, or one from before
 *   roles) needs at least one `--admin`, and those logins become the admins.
 *   Once it has one, `--admin` is the admin socket's to apply.
 * - `tailnet` → `local` is refused, and so is `tailnet` for a server nested
 *   in a workspace, which is reached only through its outer workspace.
 */
export async function settleAccessMode(): Promise<AccessMode> {
  const requested = env.accessMode
  const recorded = await readAccessMode()
  const admins = env.accessAdmins
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
  if (recorded === 'local' && requested === 'tailnet') {
    if (admins.length !== 1) {
      throw new AccessModeRefusal(
        'this install runs in local mode, and switching it to tailnet needs exactly one admin: the '
        + `tailnet login that will own its projects and settings, \`${how.tailnet} --admin <login>\`. `
        + `Add more admins once it has switched. To keep it local, use \`${how.local}\`.`,
      )
    }
    await recordAccessMode('tailnet', { claim: admins[0] })
    return requested
  }
  if (requested === 'tailnet' && (recorded === undefined || (await listAdmins()).length === 0)) {
    if (admins.length === 0) {
      throw new AccessModeRefusal(
        'this tailnet install has no admin, who alone may publish sites and choose other admins. '
        + `Name one or more by their tailnet login: \`${how.tailnet} --admin <login>\`.`,
      )
    }
    await recordAccessMode('tailnet', { admins })
    return requested
  }
  if (recorded !== requested) await recordAccessMode(requested)
  return requested
}

import { env } from '@yaac/shared/env'
import { recordedTailnetHost } from '@yaac/shared/install-record'
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
 *
 * A refusal names a command that works when copied. An in-cluster start
 * asking for `tailnet` was deployed by a `yaac cluster install` the user
 * just ran, whose flags (`--byo`, `--tailnet [<host>]`) only they know, so
 * it says to run that again. A host server names the host it was started
 * with: the one it was handed (`YAAC_ALLOWED_HOSTS`), else the one its
 * install record holds.
 */
export async function settleAccessMode(): Promise<AccessMode> {
  const requested = env.accessMode
  const recorded = await readAccessMode()
  const admins = env.accessAdmins
  const how = env.inCluster
    ? {
        local: 'yaac cluster install',
        addAdmin: (count: string) => `run the \`yaac cluster install\` you ran again with ${count}\`--admin <login>\``,
      }
    : {
        local: 'yaac server start',
        addAdmin: () => `\`yaac server start --tailnet ${env.allowedHosts[0] ?? '<host>'} --admin <login>\``,
      }
  if (requested === 'tailnet' && env.workspaceId !== undefined) {
    throw new AccessModeRefusal(
      'a yaac server inside a workspace is always local: it is reached through its '
      + 'workspace\'s forward, which only that workspace\'s owner can open. Start it '
      + 'without --tailnet.',
    )
  }
  if (recorded === 'tailnet' && requested === 'local') {
    const host = env.inCluster ? undefined : await recordedTailnetHost()
    const restart = env.inCluster
      ? '`yaac cluster install --tailnet <host>` if this machine\'s `tailscale serve` publishes it '
        + 'at <host>, or a bare `yaac cluster install --tailnet` if the Tailscale operator does'
      : host === undefined
        ? '`yaac server start --tailnet <host>`, where <host> is this machine\'s MagicDNS name'
        : `\`yaac server start --tailnet ${host}\``
    throw new AccessModeRefusal(
      `this install runs in tailnet mode, and switching it back to local is refused. Start it with ${restart}.`,
    )
  }
  if (recorded === 'local' && requested === 'tailnet') {
    if (admins.length !== 1) {
      throw new AccessModeRefusal(
        'this install runs in local mode, and switching it to tailnet needs exactly one admin: the '
        + `tailnet login that will own its projects and settings. Name it: ${how.addAdmin('exactly one ')}. `
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
        + `Name one or more by their tailnet login: ${how.addAdmin('')}.`,
      )
    }
    await recordAccessMode('tailnet', { admins })
    return requested
  }
  if (recorded !== requested) await recordAccessMode(requested)
  return requested
}

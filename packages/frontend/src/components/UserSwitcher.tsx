import type { JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { CheckIcon, UsersIcon } from '#lib/icons'
import { identityColor, identityInitial } from '#lib/projectIdentity'
import { useUiStore } from '#lib/store'
import { useSnapshot } from '#lib/useSnapshot'
import { projectsOf, useViewedUserId, whoamiQuery } from '#lib/viewer'
import type { ServerSnapshot, User } from '@yaac/shared/types'

/**
 * Picks whose projects the rail and sidebar show (#lib/viewer): your own, or
 * a teammate's, read-only. Only a `tailnet` install has more than one user.
 * The user list is refetched on each open, since a teammate becomes a user
 * on their first request. Each user's row counts their live workspaces.
 * Under containerless it also says that the substrate does not separate
 * users (docs/containerless-driver.md).
 *
 * `rail` is the desktop rail's chip; `row` the mobile projects screen's row.
 */
export function UserSwitcher({ variant = 'rail' }: { variant?: 'rail' | 'row' }): JSX.Element | null {
  const whoami = useQuery(whoamiQuery)
  const snapshot = useSnapshot()
  const viewed = useViewedUserId()
  const viewUser = useUiStore((s) => s.viewUser)
  if (whoami.data?.kind !== 'tailnet') return null
  const me = whoami.data.userId
  const users = [...whoami.data.users].sort((a, b) =>
    Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name))
  const current = users.find((u) => u.id === viewed)
  const active = activeByUser(snapshot)
  const label = viewed === me ? 'Your projects' : `${current?.name ?? 'Unknown user'}'s projects`

  const pick = (userId: string): void => {
    const first = projectsOf(snapshot?.projects ?? [], userId)[0]?.id ?? null
    viewUser(userId === me ? null : userId, first)
  }

  return (
    <Menu.Root onOpenChange={(open) => { if (open) void whoami.refetch() }}>
      <Menu.Trigger
        title={label}
        aria-label={`Switch user (${label})`}
        className={variant === 'row'
          ? 'flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-text-dim transition '
            + 'active:bg-surface-2'
          : clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-[20px] transition-all',
            'hover:rounded-xl',
            viewed === me ? 'text-text-faint hover:text-text-dim' : 'bg-accent/25 text-accent')}
      >
        <UsersIcon size={18} />
        {variant === 'row' && <span className="truncate">{label}</span>}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side={variant === 'row' ? 'bottom' : 'right'} align="start" sideOffset={6}>
          <Menu.Popup className={clsx('w-72', POPUP)}>
            {users.map((u) => (
              <Menu.Item key={u.id} className={clsx(MENU_ITEM, 'gap-2.5')} onClick={() => pick(u.id)}>
                <Avatar user={u} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-text">{u.id === me ? `${u.name} (you)` : u.name}</span>
                  {u.login !== null && <span className="truncate text-[11px] text-text-faint">{u.login}</span>}
                </span>
                {active.get(u.id)
                  ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-text-dim">
                      <span className="h-1.5 w-1.5 rounded-full bg-success" />
                      {active.get(u.id)} active
                    </span>
                  )
                  : <span className="shrink-0 text-[11px] text-text-faint">idle</span>}
                {u.id === viewed && <CheckIcon size={14} className="shrink-0" />}
              </Menu.Item>
            ))}
            <p className="px-2 pb-1 pt-2 text-[11px] leading-relaxed text-text-faint">
              A teammate&apos;s projects open read-only.
              {snapshot?.driver === 'containerless' && (
                ' This server runs workspaces on its host without containers, so it does not separate '
                + "users: any workspace can read every user's files and credentials."
              )}
            </p>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/** A user's initial on a muted tint of their color, as the rail tints a
 *  project's chip. */
function Avatar({ user }: { user: User }): JSX.Element {
  const color = identityColor(user.id)
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
      style={{
        background: `color-mix(in oklab, ${color} 26%, var(--color-surface-2))`,
        color: `color-mix(in oklab, ${color} 40%, var(--color-text))`,
      }}
    >
      {identityInitial(user.name)}
    </span>
  )
}

/**
 * How many live workspaces each user's projects hold, across every project
 * since the snapshot is install-wide; idle users are absent. A workspace
 * being created or restarted is a provisioning entry, and is missing from
 * `workspaces` meanwhile, so those count too unless stopping or failed.
 */
function activeByUser(snapshot: ServerSnapshot | undefined): Map<string, number> {
  const owners = new Map(snapshot?.projects.map((p) => [p.id, p.owner]))
  const live = [
    ...(snapshot?.workspaces ?? []).filter((w) => !w.stopping),
    ...(snapshot?.provisioning ?? []).filter((p) => !p.stopping && p.error === undefined),
  ]
  const counts = new Map<string, number>()
  for (const { projectId } of live) {
    const owner = owners.get(projectId)
    if (owner !== undefined) counts.set(owner, (counts.get(owner) ?? 0) + 1)
  }
  return counts
}

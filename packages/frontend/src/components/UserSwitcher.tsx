import type { JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { MENU_ITEM, POPUP } from '#components/ui/menu'
import { CheckIcon, UsersIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { useSnapshot } from '#lib/useSnapshot'
import { projectsOf, useViewedUserId, whoamiQuery } from '#lib/viewer'

/**
 * Picks whose projects the rail and sidebar show (#lib/viewer): your own, or
 * a teammate's, read-only. Only a `tailnet` install has more than one user.
 * The user list is refetched on each open, since a teammate becomes a user
 * on their first request. Under containerless it also says that the
 * substrate does not separate users (docs/containerless-driver.md).
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
          <Menu.Popup className={clsx('w-64', POPUP)}>
            {users.map((u) => (
              <Menu.Item key={u.id} className={MENU_ITEM} onClick={() => pick(u.id)}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-text">{u.id === me ? `${u.name} (you)` : u.name}</span>
                  {u.login !== null && <span className="truncate text-[11px] text-text-faint">{u.login}</span>}
                </span>
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

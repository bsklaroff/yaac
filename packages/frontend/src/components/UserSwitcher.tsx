import type { JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckIcon, UsersIcon } from '#lib/icons'
import { useUiStore } from '#lib/store'
import { useSnapshot } from '#lib/useSnapshot'
import { projectsOf, useViewedUserId, whoamiQuery } from '#lib/viewer'
import type { ServerSnapshot, User } from '@yaac/shared/types'
import { YAvatar, YMenu, YMenuItem, YMenuPopup } from '#ui'

/**
 * Picks whose projects the rail and sidebar show (#lib/viewer): your own, or
 * a teammate's, read-only. Only a `tailnet` install has more than one user.
 * The user list is refetched on each open, since a teammate becomes a user
 * on their first request. Picking a user reopens the project of theirs last
 * open on this device, else their first. Each user's row counts their live
 * workspaces.
 * Under containerless it also says that the substrate does not separate
 * users (docs/containerless-driver.md).
 */
export function UserSwitcher(): JSX.Element | null {
  const switcher = useUserSwitch()
  if (switcher === null) return null
  return (
    <YMenu.Root onOpenChange={(open) => { if (open) switcher.refresh() }}>
      <YMenu.Trigger
        title={switcher.label}
        aria-label={`Switch user (${switcher.label})`}
        className="flex w-full items-center gap-3 rounded-sm px-3 py-3 text-left text-base text-muted transition active:bg-selected"
      >
        <UsersIcon size={18} />
        <span className="truncate">{switcher.label}</span>
      </YMenu.Trigger>
      <YMenuPopup side="bottom" align="start" sideOffset={6} className="w-72">
        <UserItems switcher={switcher} />
      </YMenuPopup>
    </YMenu.Root>
  )
}

/** The users to switch between, and switching, for a `tailnet` install;
 *  null on any other. */
export function useUserSwitch(): UserSwitch | null {
  const whoami = useQuery(whoamiQuery)
  const snapshot = useSnapshot()
  const viewed = useViewedUserId()
  const viewUser = useUiStore((s) => s.viewUser)
  const lastProjectOf = useUiStore((s) => s.lastProjectOf)
  if (whoami.data?.kind !== 'tailnet') return null
  const me = whoami.data.userId
  const users = [...whoami.data.users].sort((a, b) =>
    Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name))
  const current = users.find((u) => u.id === viewed)
  return {
    me,
    viewed,
    users,
    active: activeByUser(snapshot),
    label: viewed === me ? 'Your projects' : `${current?.name ?? 'Unknown user'}'s projects`,
    containerless: snapshot?.driver === 'containerless',
    refresh: () => { void whoami.refetch() },
    pick: (userId) => {
      const theirs = projectsOf(snapshot?.projects ?? [], userId)
      const last = theirs.find((p) => p.id === lastProjectOf[userId])
      viewUser(userId === me ? null : userId, (last ?? theirs[0])?.id ?? null)
    },
  }
}

interface UserSwitch {
  me: string
  viewed: string | undefined
  users: User[]
  active: Map<string, number>
  label: string
  containerless: boolean
  refresh: () => void
  pick: (userId: string) => void
}

/** One menu row per user, then what viewing a teammate means. */
export function UserItems({ switcher }: { switcher: UserSwitch }): JSX.Element {
  const { me, viewed, users, active, pick, containerless } = switcher
  return (
    <>
      {users.map((u) => (
        <YMenuItem key={u.id} className="gap-2.5" onClick={() => pick(u.id)}>
          <YAvatar id={u.id} name={u.name} size={26} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-text">{u.id === me ? `${u.name} (you)` : u.name}</span>
            {u.login !== null && (
              <span className="truncate text-sm text-subtle">{u.login}{u.role === 'admin' && ', admin'}</span>
            )}
          </span>
          {active.get(u.id)
            ? <span className="shrink-0 text-sm text-muted">{active.get(u.id)} active</span>
            : <span className="shrink-0 text-sm text-subtle">idle</span>}
          {u.id === viewed && <CheckIcon size={14} className="shrink-0" />}
        </YMenuItem>
      ))}
      <p className="px-2.5 pb-1 pt-2 text-sm text-subtle">
        A teammate&apos;s projects open read-only.
        {containerless && (
          ' This server runs workspaces on its host without containers, so it does not separate '
          + "users: any workspace can read every user's files and credentials."
        )}
      </p>
    </>
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

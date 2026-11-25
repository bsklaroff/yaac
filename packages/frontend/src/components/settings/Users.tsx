import { useState, type JSX } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'
import { whoamiQuery } from '#lib/viewer'
import type { UserRole } from '@yaac/shared/types'
import { SettingsPageTitle } from '#components/settings/SettingsPage'
import { UserTokens } from '#components/settings/Tokens'
import { YButton, YPersonRow, YSelect } from '#ui'

/**
 * The install's users and their roles (docs/multi-user.md "Roles"), on a
 * `tailnet` install. Every user sees the list; an admin can change any
 * role, their own included, and see and delete anyone's tokens, so a
 * leaked one can be cut off without its owner. The server refuses demoting
 * the last admin.
 */
export function UsersPane(): JSX.Element {
  const whoami = useQuery(whoamiQuery)
  const me = whoami.data?.userId
  const admin = whoami.data?.users.find((u) => u.id === me)?.role === 'admin'
  const [tokensOf, setTokensOf] = useState<string | null>(null)
  const setRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: UserRole }) => {
      await api.users[':userId'].role.$put({ param: { userId }, json: { role } })
    },
    onSettled: () => whoami.refetch(),
  })

  return (
    <>
      <SettingsPageTitle title="Users">
        Admins publish sites and choose who else is an admin; members do neither. Whoever runs the server can also
        replace the admins with <code>--admin</code> on <code>yaac server start</code> or{' '}
        <code>yaac cluster install</code>.
        {setRole.error && <p className="mt-2 text-danger">{setRole.error.message}</p>}
      </SettingsPageTitle>
      <div className="border-t border-line">
        {whoami.data?.users.map((u) => (
          <div key={u.id}>
            <YPersonRow
              id={u.id}
              name={u.id === me ? `${u.name} (you)` : u.name}
              role={u.login ?? undefined}
              meta={admin ? undefined : u.role === 'admin' ? 'Admin' : 'Member'}
              actionsShown
              actions={admin && (
                <span className="flex items-center gap-1">
                  <YButton variant="ghost" size="sm" onClick={() => setTokensOf((t) => (t === u.id ? null : u.id))}>Tokens</YButton>
                  <YSelect
                    aria-label={`Role of ${u.login ?? u.name}`}
                    value={u.role}
                    disabled={setRole.isPending}
                    onChange={(e) => setRole.mutate({ userId: u.id, role: e.target.value === 'admin' ? 'admin' : 'member' })}
                    className="w-fit"
                  >
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                  </YSelect>
                </span>
              )}
              className="px-1"
            />
            {tokensOf === u.id && <UserTokens userId={u.id} />}
          </div>
        ))}
      </div>
    </>
  )
}

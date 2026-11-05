import type { JSX } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'
import { whoamiQuery } from '#lib/viewer'
import type { UserRole } from '@yaac/shared/types'

/**
 * The install's users and their roles (docs/multi-user.md "Roles"), on a
 * `tailnet` install. Every user sees the list; an admin can change any
 * role, their own included. The server refuses demoting the last admin.
 */
export function UsersPane(): JSX.Element {
  const whoami = useQuery(whoamiQuery)
  const me = whoami.data?.userId
  const admin = whoami.data?.users.find((u) => u.id === me)?.role === 'admin'
  const setRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: UserRole }) => {
      await api.users[':userId'].role.$put({ param: { userId }, json: { role } })
    },
    onSettled: () => whoami.refetch(),
  })

  return (
    <section>
      <h2 className="text-sm font-semibold">Users</h2>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Admins publish sites and choose who else is an admin; members do neither. Whoever runs the server can also
        replace the admins with <code className="text-text-dim">--admin</code> on{' '}
        <code className="text-text-dim">yaac server start</code> or{' '}
        <code className="text-text-dim">yaac cluster install</code>.
      </p>
      {setRole.error && <p className="mt-2 text-xs text-red-400">{setRole.error.message}</p>}
      <div className="mt-4 space-y-1">
        {whoami.data?.users.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-3 rounded-md bg-bg px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-text">{u.id === me ? `${u.name} (you)` : u.name}</div>
              {u.login !== null && <div className="truncate text-[11px] text-text-faint">{u.login}</div>}
            </div>
            {admin ? (
              <select
                aria-label={`Role of ${u.login ?? u.name}`}
                value={u.role}
                disabled={setRole.isPending}
                onChange={(e) => setRole.mutate({ userId: u.id, role: e.target.value === 'admin' ? 'admin' : 'member' })}
                className="w-fit rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text outline-none
                  disabled:opacity-50"
              >
                <option value="admin">Admin</option>
                <option value="member">Member</option>
              </select>
            ) : (
              <span className="shrink-0 text-[11px] text-text-dim">{u.role === 'admin' ? 'Admin' : 'Member'}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

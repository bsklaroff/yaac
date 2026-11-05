import { api, findUser } from '#commands/api'
import { printTable } from '#commands/table'
import type { UserRole } from '@yaac/shared/types'

/** `yaac user list`: the install's users and their roles. */
export async function userList(): Promise<void> {
  const { userId, users } = await api.whoami.$get()
  printTable(
    [{ header: 'USER' }, { header: 'ROLE' }, { header: 'NAME' }],
    users.map((u) => [u.login ?? u.name, u.role, u.id === userId ? `${u.name} (you)` : u.name]),
  )
}

/** `yaac user role <user> <role>`: set a user's role, as an admin. */
export async function userRole(user: string, role: UserRole): Promise<void> {
  const { users } = await api.whoami.$get()
  const userId = findUser(users, user)
  await api.users[':userId'].role.$put({ param: { userId }, json: { role } })
  console.log(`${users.find((u) => u.id === userId)?.login ?? user} is now ${role === 'admin' ? 'an admin' : 'a member'}.`)
}

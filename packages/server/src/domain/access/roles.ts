import {
  getUser,
  listAdmins,
  readAccessMode,
  replaceAdmins as writeAdmins,
  setUserRole as writeUserRole,
} from '#db'
import { ServerError } from '@yaac/shared/errors'
import type { AdminEntry, UserRole } from '@yaac/shared/types'
import type { Actor } from './authorize'

/*
 * Install roles (docs/multi-user.md "Roles"): an admin publishes sites and
 * sets roles. Roles are read from the database on every check, so a
 * demotion holds from the demoted user's next request.
 */

/**
 * Refuse with FORBIDDEN unless `actor` is an admin. The server passes; a
 * workspace's yaac-mama call never does, so an admin's agent does not act
 * with the role.
 */
export async function requireAdmin(actor: Actor, what = 'do that'): Promise<void> {
  if (actor.kind === 'system') return
  if (actor.kind !== 'workspace' && (await getUser(actor.userId))?.role === 'admin') return
  throw new ServerError('FORBIDDEN', `only an admin of this yaac install may ${what}`)
}

/**
 * Set a user's role, as an admin. A `tailnet` install's login-less built-in
 * user is no one anyone can sign in as, so it is not found; the last admin
 * cannot be demoted.
 */
export async function setUserRole(actor: Actor, userId: string, role: UserRole): Promise<void> {
  await requireAdmin(actor, 'change roles')
  const user = await getUser(userId)
  if (!user || (user.login === null && await readAccessMode() === 'tailnet')) {
    throw new ServerError('NOT_FOUND', `user ${userId} not found`)
  }
  if (await writeUserRole(userId, role) === 'last-admin') {
    throw new ServerError('CONFLICT', `${user.login ?? user.name} is this install's last admin; make someone else an admin first`)
  }
}

/**
 * Only a `tailnet` install has admins to read or replace over the admin
 * socket: a `local` one's only user is the login-less built-in user, which
 * a replace would demote with no way back. The read refuses too, so
 * `--admin` switching a `local` install to `tailnet` finds no admins to
 * revoke before the switch.
 */
async function requireTailnetInstall(): Promise<void> {
  if (await readAccessMode() !== 'tailnet') {
    throw new ServerError('VALIDATION', 'only a tailnet install takes admins: a local install\'s one user is its admin already')
  }
}

/** The admins, for the admin socket. */
export async function listInstallAdmins(): Promise<AdminEntry[]> {
  await requireTailnetInstall()
  return listAdmins()
}

/**
 * Make exactly `logins` the admins, for the admin socket (`--admin` on an
 * install that has admins). `expected` is the admins' logins the caller
 * confirmed revoking against; if they changed since, this is CONFLICT and
 * nothing is written. Answers the admins it left.
 */
export async function replaceAdmins(logins: string[], expected: string[]): Promise<AdminEntry[]> {
  await requireTailnetInstall()
  if (logins.length === 0) throw new ServerError('VALIDATION', 'name at least one admin')
  if (await writeAdmins(logins, expected) === 'stale') {
    throw new ServerError('CONFLICT', 'the admins changed since they were read; read them again')
  }
  return listAdmins()
}

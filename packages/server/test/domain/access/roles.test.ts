import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import type { ServerError } from '@yaac/shared/errors'
import { BUILT_IN_USER_ID, closeDb, getUser, listAdmins, recordAccessMode, seeTailnetUser } from '#db'
import { listInstallAdmins, replaceAdmins, requireAdmin, setUserRole, systemPrincipal, type Actor } from '#domain/access'

function user(userId: string): Actor {
  return { kind: 'tailnet', userId, login: `${userId}@example.com`, name: userId }
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (err: unknown) => (err as ServerError).code)
}

let tmpDir: string
let admin: string
let member: string

// One tailnet install for the file: admin@ is its admin and member@ is not.
// Each case leaves those two roles as it found them.
beforeAll(async () => {
  tmpDir = await createTempDataDir()
  await recordAccessMode('tailnet', { admins: ['admin@example.com'] })
  admin = await seeTailnetUser('admin@example.com', 'Admin')
  member = await seeTailnetUser('member@example.com', 'Member')
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

describe('requireAdmin', () => {
  it('admits an admin and the server, refuses a member and any workspace', async () => {
    await expect(requireAdmin(user(admin))).resolves.toBeUndefined()
    await expect(requireAdmin(systemPrincipal)).resolves.toBeUndefined()
    expect(await codeOf(requireAdmin(user(member)))).toBe('FORBIDDEN')
    // An admin's agent does not act with the role.
    expect(await codeOf(requireAdmin({ kind: 'workspace', workspaceId: 'w1', userId: admin }))).toBe('FORBIDDEN')
    await expect(requireAdmin(user(member), 'publish sites')).rejects.toThrow(/only an admin of this yaac install may publish sites/)
  })
})

describe('setUserRole', () => {
  it('lets an admin set roles, holding from the next check, and never demotes the last admin', async () => {
    expect(await codeOf(setUserRole(user(member), member, 'admin'))).toBe('FORBIDDEN')

    await setUserRole(user(admin), member, 'admin')
    await expect(requireAdmin(user(member))).resolves.toBeUndefined()
    // Admins are peers: the promoted one may demote whoever promoted them.
    await setUserRole(user(member), admin, 'member')
    expect(await codeOf(requireAdmin(user(admin)))).toBe('FORBIDDEN')
    await expect(setUserRole(user(member), member, 'member')).rejects.toThrow(/last admin/)
    expect((await getUser(member))?.role).toBe('admin')

    await setUserRole(user(member), admin, 'admin')
    await setUserRole(user(admin), member, 'member')
  })

  it('finds no unknown user, nor the login-less built-in user of a tailnet install', async () => {
    expect(await codeOf(setUserRole(user(admin), '4101bef8-794f-4d98-8e95-dfb54850c68b', 'admin'))).toBe('NOT_FOUND')
    expect(await codeOf(setUserRole(user(admin), BUILT_IN_USER_ID, 'admin'))).toBe('NOT_FOUND')
  })
})

describe('listInstallAdmins', () => {
  it('lists a tailnet install\'s admins, and refuses a local one, so --admin finds none to revoke there', async () => {
    expect(await listInstallAdmins()).toEqual([{ login: 'admin@example.com', name: 'Admin', signedIn: true }])
    await recordAccessMode('local')
    expect(await codeOf(listInstallAdmins())).toBe('VALIDATION')
    await recordAccessMode('tailnet')
  })
})

describe('replaceAdmins', () => {
  it('replaces the admins against the list the caller confirmed, refusing a stale one or none', async () => {
    expect(await codeOf(replaceAdmins([], ['admin@example.com']))).toBe('VALIDATION')
    expect(await codeOf(replaceAdmins(['member@example.com'], []))).toBe('CONFLICT')
    expect((await listAdmins()).map((a) => a.login)).toEqual(['admin@example.com'])

    expect(await replaceAdmins(['member@example.com', 'new@example.com'], ['admin@example.com'])).toEqual([
      { login: 'member@example.com', name: 'Member', signedIn: true },
      { login: 'new@example.com', name: 'new@example.com', signedIn: false },
    ])
    expect((await getUser(admin))?.role).toBe('member')

    await replaceAdmins(['admin@example.com'], ['member@example.com', 'new@example.com'])
  })

  it('refuses a local install, whose one user is its admin', async () => {
    await recordAccessMode('local')
    expect(await codeOf(replaceAdmins(['evil@example.com'], ['admin@example.com']))).toBe('VALIDATION')
    expect((await listAdmins()).map((a) => a.login)).toEqual(['admin@example.com'])
    await recordAccessMode('tailnet')
  })
})

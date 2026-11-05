import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { ne } from 'drizzle-orm'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { accessModes, users } from '#db/schema'
import { BUILT_IN_USER_ID, listAdmins, listUsers, readAccessMode } from '#db'
import { AccessModeRefusal, settleAccessMode } from '#main/access-mode'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

/** Back to a freshly migrated install: no mode, only the built-in admin. */
beforeEach(async () => {
  const db = await getDb()
  await db.delete(accessModes)
  await db.delete(users).where(ne(users.id, BUILT_IN_USER_ID))
  await db.update(users).set({ login: null, name: 'local', role: 'admin' })
})

afterEach(() => vi.unstubAllEnvs())

/** Start once, asking for `mode` with these `--admin`s, as `yaac server start` does. */
function start(mode: 'local' | 'tailnet', ...admins: string[]): Promise<string> {
  vi.stubEnv('YAAC_ACCESS_MODE', mode)
  vi.stubEnv('YAAC_ACCESS_ADMINS', admins.join(','))
  return settleAccessMode()
}

const adminLogins = async (): Promise<Array<string | null>> => (await listAdmins()).map((a) => a.login)

describe('settleAccessMode', () => {
  it('gives a fresh tailnet install the admins --admin names, and refuses one without', async () => {
    await expect(start('tailnet')).rejects.toThrow(/has no admin.*`yaac server start --tailnet <host> --admin <login>`/s)
    expect(await readAccessMode()).toBeUndefined()

    expect(await start('tailnet', 'alice@example.com', 'bob@example.com')).toBe('tailnet')
    expect(await readAccessMode()).toBe('tailnet')
    expect(await listAdmins()).toEqual([
      { login: 'alice@example.com', name: 'alice@example.com', signedIn: false },
      { login: 'bob@example.com', name: 'bob@example.com', signedIn: false },
    ])
    // The login-less built-in user is no admin of a tailnet install.
    expect((await listUsers()).find((u) => u.id === BUILT_IN_USER_ID)).toMatchObject({ login: null, role: 'member' })

    // Once it has admins, a start's --admin changes nothing here.
    expect(await start('tailnet')).toBe('tailnet')
    expect(await start('tailnet', 'carol@example.com')).toBe('tailnet')
    expect(await adminLogins()).toEqual(['alice@example.com', 'bob@example.com'])
  })

  it('takes admins for a tailnet install from before roles, which has none', async () => {
    await start('tailnet', 'alice@example.com')
    await (await getDb()).update(users).set({ role: 'member' })
    await expect(start('tailnet')).rejects.toThrow(AccessModeRefusal)
    await start('tailnet', 'bob@example.com')
    expect(await adminLogins()).toEqual(['bob@example.com'])
  })

  it('records a fresh local install, which takes no admins', async () => {
    expect(await start('local')).toBe('local')
    expect(await readAccessMode()).toBe('local')
    expect(await listAdmins()).toEqual([{ login: null, name: 'local', signedIn: true }])
  })

  it('switches local to tailnet only with exactly one --admin, who takes over the built-in user', async () => {
    await start('local')
    await expect(start('tailnet')).rejects.toThrow(
      /runs in local mode.*exactly one admin.*`yaac server start --tailnet <host> --admin <login>`/s,
    )
    await expect(start('tailnet', 'alice@example.com', 'bob@example.com')).rejects.toThrow(/exactly one admin/)
    expect(await readAccessMode()).toBe('local')

    expect(await start('tailnet', 'alice@example.com')).toBe('tailnet')
    expect(await readAccessMode()).toBe('tailnet')
    expect(await listUsers()).toEqual([
      { id: BUILT_IN_USER_ID, login: 'alice@example.com', name: 'alice@example.com', role: 'admin' },
    ])
    // Later starts need no --admin.
    expect(await start('tailnet')).toBe('tailnet')
  })

  it('refuses tailnet back to local, naming the command that starts it', async () => {
    await start('tailnet', 'alice@example.com')
    const err = await start('local').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccessModeRefusal)
    expect((err as Error).message).toMatch(/runs in tailnet mode.*`yaac server start --tailnet <host>`/s)
    expect(await readAccessMode()).toBe('tailnet')
  })

  it('names `yaac cluster install` for an in-cluster server', async () => {
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    await start('local')
    await expect(start('tailnet')).rejects.toThrow(/`yaac cluster install --tailnet --admin <login>`/)
  })

  it('keeps a server nested in a workspace local', async () => {
    vi.stubEnv('YAAC_WORKSPACE_ID', 'abcd1234')
    await expect(start('tailnet', 'alice@example.com')).rejects.toThrow(/inside a workspace is always local/)
    expect(await readAccessMode()).toBeUndefined()
    expect(await start('local')).toBe('local')
  })
})

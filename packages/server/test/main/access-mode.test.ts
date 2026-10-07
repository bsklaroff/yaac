import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { getDb, closeDb } from '#db/client'
import { accessModes } from '#db/schema'
import { BUILT_IN_USER_ID, listUsers, readAccessMode } from '#db'
import { AccessModeRefusal, settleAccessMode } from '#main/access-mode'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await createTempDataDir()
})

afterAll(async () => {
  await closeDb()
  await cleanupTempDir(tmpDir)
})

beforeEach(async () => {
  await (await getDb()).delete(accessModes)
})

afterEach(() => vi.unstubAllEnvs())

/** Start once, asking for `mode` (and `owner`), as `yaac server start` does. */
function start(mode: 'local' | 'tailnet', owner?: string): Promise<string> {
  vi.stubEnv('YAAC_ACCESS_MODE', mode)
  vi.stubEnv('YAAC_ACCESS_OWNER', owner)
  return settleAccessMode()
}

describe('settleAccessMode', () => {
  it('records whatever a fresh install is first asked for, with no --owner needed', async () => {
    expect(await start('tailnet')).toBe('tailnet')
    expect(await readAccessMode()).toBe('tailnet')
    // The built-in user owns nothing on a fresh tailnet install, so keeps no login.
    expect((await listUsers()).find((u) => u.id === BUILT_IN_USER_ID)?.login).toBeNull()
    expect(await start('tailnet', 'alice@example.com')).toBe('tailnet')
    expect((await listUsers()).find((u) => u.id === BUILT_IN_USER_ID)?.login).toBeNull()

    await (await getDb()).delete(accessModes)
    expect(await start('local')).toBe('local')
    expect(await readAccessMode()).toBe('local')
  })

  it('switches local to tailnet only with --owner, giving the built-in user that login', async () => {
    await start('local')
    await expect(start('tailnet')).rejects.toThrow(
      /runs in local mode.*`yaac server start --tailnet <host> --owner <login>`/s,
    )
    expect(await readAccessMode()).toBe('local')

    expect(await start('tailnet', 'alice@example.com')).toBe('tailnet')
    expect(await readAccessMode()).toBe('tailnet')
    expect(await listUsers()).toContainEqual({ id: BUILT_IN_USER_ID, login: 'alice@example.com', name: 'alice@example.com' })
    // Later starts need no --owner.
    expect(await start('tailnet')).toBe('tailnet')
  })

  it('refuses tailnet back to local, naming the command that starts it', async () => {
    await start('tailnet')
    const err = await start('local').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccessModeRefusal)
    expect((err as Error).message).toMatch(/runs in tailnet mode.*`yaac server start --tailnet <host>`/s)
    expect(await readAccessMode()).toBe('tailnet')
  })

  it('names `yaac cluster install` for an in-cluster server', async () => {
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    await start('local')
    await expect(start('tailnet')).rejects.toThrow(/`yaac cluster install --tailnet --owner <login>`/)
  })

  it('keeps a server nested in a workspace local', async () => {
    vi.stubEnv('YAAC_WORKSPACE_ID', 'abcd1234')
    await expect(start('tailnet')).rejects.toThrow(/inside a workspace is always local/)
    expect(await readAccessMode()).toBeUndefined()
    expect(await start('local')).toBe('local')
  })
})

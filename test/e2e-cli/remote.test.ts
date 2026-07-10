import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createYaacTestEnv,
  spawnYaacDaemon,
  runYaac,
  type YaacTestEnv,
  type SpawnedDaemon,
} from '@test/helpers/cli'

/**
 * The remote path without a second machine: point `yaac remote set` at
 * the spawned daemon's own loopback origin, authenticated by a durable
 * token instead of the lock secret. The Host header the CLI sends is
 * loopback, which the host check allows unconditionally, so this is the
 * full remote code path minus the network in between.
 */
describe('yaac remote (real CLI + real daemon)', () => {
  let testEnv: YaacTestEnv
  let daemon: SpawnedDaemon

  beforeEach(async () => {
    testEnv = await createYaacTestEnv()
    daemon = await spawnYaacDaemon(testEnv.env)
  })

  afterEach(async () => {
    await daemon.stop()
    await testEnv.cleanup()
  })

  async function mintToken(name: string): Promise<string> {
    const res = await runYaac(testEnv.env, 'auth', 'token', 'create', name)
    expect(res.exitCode, res.stderr).toBe(0)
    return res.stdout.trim()
  }

  function origin(): string {
    return `http://127.0.0.1:${daemon.lock.port}`
  }

  it('set → commands run via the token; revoke kills them while the lock stays live', async () => {
    const token = await mintToken('laptop')

    const set = await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)
    expect(set.exitCode, set.stderr).toBe(0)
    expect(set.stdout).toMatch(/Remote set and enabled/)

    const list = await runYaac(testEnv.env, 'project', 'list')
    expect(list.exitCode, list.stderr).toBe(0)

    // Revoking the token breaks the remote path even though the local
    // lock is still live — proof the remote (not the lock) served it.
    const revoke = await runYaac(testEnv.env, 'auth', 'token', 'revoke', 'laptop')
    expect(revoke.exitCode, revoke.stderr).toBe(0)

    const broken = await runYaac(testEnv.env, 'project', 'list')
    expect(broken.exitCode).toBe(1)
    expect(broken.stderr).toMatch(/rejected the token/)
    expect(broken.stderr).toMatch(/yaac remote set/)

    // remote off → falls back to the local lock and works again.
    const off = await runYaac(testEnv.env, 'remote', 'off')
    expect(off.exitCode, off.stderr).toBe(0)
    const viaLock = await runYaac(testEnv.env, 'project', 'list')
    expect(viaLock.exitCode, viaLock.stderr).toBe(0)
  })

  it('status shows the masked token; unset forgets it', async () => {
    const token = await mintToken('phone')
    const set = await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)
    expect(set.exitCode, set.stderr).toBe(0)

    const status = await runYaac(testEnv.env, 'remote', 'status')
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toContain(origin())
    expect(status.stdout).toContain(`${token.slice(0, 8)}…`)
    expect(status.stdout).not.toContain(token)
    expect(status.stdout).toMatch(/enabled\s+yes/)

    const unset = await runYaac(testEnv.env, 'remote', 'unset')
    expect(unset.exitCode).toBe(0)
    const after = await runYaac(testEnv.env, 'remote', 'status')
    expect(after.stdout).toMatch(/No remote configured/)
  })

  it('on / off toggle the remote without re-entering the token', async () => {
    const token = await mintToken('tablet')
    expect((await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)).exitCode).toBe(0)

    const off = await runYaac(testEnv.env, 'remote', 'off')
    expect(off.exitCode).toBe(0)
    expect((await runYaac(testEnv.env, 'remote', 'status')).stdout).toMatch(/enabled\s+no/)

    const on = await runYaac(testEnv.env, 'remote', 'on')
    expect(on.exitCode).toBe(0)
    expect((await runYaac(testEnv.env, 'remote', 'status')).stdout).toMatch(/enabled\s+yes/)
    expect((await runYaac(testEnv.env, 'project', 'list')).exitCode).toBe(0)
  })

  it('set fails fast on an unreachable URL and persists nothing', async () => {
    const res = await runYaac(testEnv.env, 'remote', 'set', 'http://127.0.0.1:1', '--token', 'x')
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toMatch(/cannot reach http:\/\/127\.0\.0\.1:1/)
    expect((await runYaac(testEnv.env, 'remote', 'status')).stdout).toMatch(/No remote configured/)
  })

  it('set rejects a bad token with minting guidance', async () => {
    const res = await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', 'f'.repeat(64))
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toMatch(/token rejected/)
    expect(res.stderr).toMatch(/yaac auth token create/)
  })

  it('yaac open --no-browser prints the remote-derived URL', async () => {
    const token = await mintToken('opener')
    expect((await runYaac(testEnv.env, 'remote', 'set', origin(), '--token', token)).exitCode).toBe(0)

    const open = await runYaac(testEnv.env, 'open', '--no-browser')
    expect(open.exitCode, open.stderr).toBe(0)
    expect(open.stdout.trim()).toMatch(
      new RegExp(`^${origin().replace(/[.:/]/g, '\\$&')}/\\?bootstrap=[0-9a-f]+$`),
    )
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readLock } from '@yaac/shared/lock'
import {
  createYaacTestEnv,
  runYaac,
  type YaacTestEnv,
} from '@yaac/test-utils/cli'

/**
 * `yaac server start --driver <kind>`: the flag, end to end.
 *
 * Its own file because it is the one case that must NOT inherit the tier's
 * `YAAC_DRIVER`. Every other containerless suite reaches its server through
 * that variable, which means the flag's actual path — parse, publish to
 * `process.env`, inherit into the detached child, read back through
 * `env.driver` at the composition root — is exercised by nothing. Stripping
 * the variable here also pins the precedence: the flag has to be what
 * selects the driver, not a leftover in the environment.
 *
 * Deliberately not using `spawnYaacServer`: that helper runs `server run` in
 * the foreground, and what is under test is `server start`, which spawns the
 * detached child the flag has to survive.
 */

let testEnv: YaacTestEnv
/** The tier's env with the driver variable removed — see the note above. */
let bareEnv: NodeJS.ProcessEnv

async function healthDriver(): Promise<string | null | undefined> {
  const lock = await readLock()
  if (!lock) throw new Error('server did not write a lock')
  const res = await fetch(`http://127.0.0.1:${String(lock.port)}/health`)
  const body = await res.json() as { driver?: string | null }
  return body.driver
}

beforeAll(async () => {
  testEnv = await createYaacTestEnv()
  const { YAAC_DRIVER: _stripped, ...rest } = testEnv.env
  bareEnv = rest
}, 60_000)

afterAll(async () => {
  await runYaac(bareEnv, 'server', 'stop').catch(() => { /* already down */ })
  await testEnv.cleanup()
})

describe('yaac server start --driver', () => {
  it('selects the substrate for the detached server it spawns', async () => {
    expect(bareEnv.YAAC_DRIVER).toBeUndefined()
    const { stdout, stderr, exitCode } = await runYaac(
      bareEnv, 'server', 'start', '--driver', 'containerless',
    )
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    // The flag reached the child: nothing in its environment said so.
    expect(await healthDriver()).toBe('containerless')
  }, 120_000)

  it('rejects a substrate that does not exist, rather than falling back', async () => {
    // A typo silently starting the default would be the worst outcome here —
    // the whole point of the flag is that it decides where worktrees run.
    const { stderr, exitCode } = await runYaac(
      bareEnv, 'server', 'start', '--driver', 'kubernets',
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('--driver')
  })

  // The defect this file's sibling record exists to prevent: without it a
  // bare restart selects the DEFAULT, a k8s server adopts a containerless
  // data dir, and its reaper removes the state dirs the markers live in —
  // leaving the agents running as the user and unreachable forever.
  it('keeps the recorded substrate across a restart that names none', async () => {
    const { exitCode } = await runYaac(bareEnv, 'server', 'restart')
    expect(exitCode).toBe(0)
    expect(await healthDriver()).toBe('containerless')
  }, 120_000)

  it('switches substrate when a restart names one explicitly', async () => {
    // Deliberately switching a data dir is allowed — the other kind's
    // worktrees simply have no runtime here, and the stale sweep stops them.
    const { exitCode } = await runYaac(bareEnv, 'server', 'restart', '--driver', 'k8s')
    expect(exitCode).toBe(0)
    expect(await healthDriver()).toBe('k8s')

    // ...and the switch is now what a later bare restart keeps.
    await runYaac(bareEnv, 'server', 'restart')
    expect(await healthDriver()).toBe('k8s')
  }, 180_000)
})

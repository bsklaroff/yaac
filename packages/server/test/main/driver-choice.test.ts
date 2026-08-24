import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDataDir, serverLocalPath } from '@yaac/shared/paths'
import { assertHostServerAllowed, resolveDriverKind } from '#main/driver-choice'

/**
 * Placement is the driver (docs/server-in-cluster.md), so these two answer
 * the same question from opposite sides: what a start becomes, and what a
 * start is refused for. Both read the real data dir — the recorded driver
 * is a file beside the lock, and the point of the pair is what happens to
 * that file.
 */
let dataDir: string

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-driver-choice-'))
  setDataDir(dataDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(dataDir, { recursive: true, force: true })
})

async function recorded(): Promise<string> {
  return (await fs.readFile(serverLocalPath('driver'), 'utf8')).trim()
}

describe('resolveDriverKind', () => {
  it('is containerless for a host process, and records it', async () => {
    expect(await resolveDriverKind()).toBe('containerless')
    expect(await recorded()).toBe('containerless')
  })

  it('is k8s inside the server pod, and records it', async () => {
    // YAAC_IN_CLUSTER is set by the server Deployment's manifest and by
    // nothing else, so it IS the question "am I the pod?".
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    expect(await resolveDriverKind()).toBe('k8s')
    expect(await recorded()).toBe('k8s')
  })

  it('ignores YAAC_DRIVER: a host process cannot elect to be a k8s server', async () => {
    // The whole retired mode in one assertion — there is no host-process k8s
    // server to ask for, so asking for one gets the substrate that placement
    // dictates rather than a second writer of a cluster install's data dir.
    vi.stubEnv('YAAC_DRIVER', 'k8s')
    expect(await resolveDriverKind()).toBe('containerless')
  })
})

describe('assertHostServerAllowed', () => {
  it('allows a host start on a fresh data dir and on a containerless one', async () => {
    await expect(assertHostServerAllowed()).resolves.toBeUndefined()
    await fs.writeFile(serverLocalPath('driver'), 'containerless\n')
    await expect(assertHostServerAllowed()).resolves.toBeUndefined()
  })

  it('refuses a host start on a k8s install, naming the converge command', async () => {
    await fs.writeFile(serverLocalPath('driver'), 'k8s\n')
    await expect(assertHostServerAllowed()).rejects.toThrow(/yaac cluster install/)
  })

  it('does not refuse the pod itself, which is that install\'s server', async () => {
    await fs.writeFile(serverLocalPath('driver'), 'k8s\n')
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    await expect(assertHostServerAllowed()).resolves.toBeUndefined()
  })
})

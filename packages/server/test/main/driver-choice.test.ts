import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clientLocalPath, ensureClientLocalRoot, serverLocalPath, setDataDir } from '@yaac/shared/paths'
import { assertHostServerAllowed, resolveDriverKind } from '#main/driver-choice'

/**
 * Placement is the driver (docs/server-in-cluster.md), so these two answer
 * the same question from opposite sides: what a start becomes, and what a
 * start is refused for. Both use a real data dir — the recorded driver is a
 * CLIENT-LOCAL file beside it, and the point of the pair is what happens to
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
  await fs.rm(`${dataDir}-client`, { recursive: true, force: true })
})

async function recorded(): Promise<string> {
  return (await fs.readFile(clientLocalPath('driver'), 'utf8')).trim()
}

/** Seed the record the way `yaac cluster install` does. */
async function record(kind: string): Promise<void> {
  await ensureClientLocalRoot()
  await fs.writeFile(clientLocalPath('driver'), `${kind}\n`)
}

describe('resolveDriverKind', () => {
  it('is containerless for a host process, and records it', async () => {
    expect(await resolveDriverKind()).toBe('containerless')
    expect(await recorded()).toBe('containerless')
  })

  it('is k8s inside the server pod, and leaves the record to the installer', async () => {
    // YAAC_IN_CLUSTER is set by the server Deployment's manifest and by
    // nothing else, so it IS the question "am I the pod?".
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    expect(await resolveDriverKind()).toBe('k8s')
    // The record is CLIENT-LOCAL and deliberately not mounted into the pod,
    // so the pod does not write it — `yaac cluster install`, which is what
    // made this pod exist, wrote it before the Deployment was applied.
    // Attempting it would only produce a warning on every boot.
    await expect(fs.access(clientLocalPath('driver'))).rejects.toThrow()
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
    await record('containerless')
    await expect(assertHostServerAllowed()).resolves.toBeUndefined()
  })

  it('refuses a host start on a k8s install, naming the converge command', async () => {
    await record('k8s')
    await expect(assertHostServerAllowed()).rejects.toThrow(/yaac cluster install/)
  })

  it('still refuses one recorded by a pre-split install, inside the data dir', async () => {
    // Upgrading must not quietly re-enable the second writer this guard
    // exists to stop — see docs/legacy-compat-shims.md.
    await fs.writeFile(serverLocalPath('driver'), 'k8s\n')
    await expect(assertHostServerAllowed()).rejects.toThrow(/yaac cluster install/)
  })

  it('does not refuse the pod itself, which is that install\'s server', async () => {
    await record('k8s')
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    await expect(assertHostServerAllowed()).resolves.toBeUndefined()
  })
})

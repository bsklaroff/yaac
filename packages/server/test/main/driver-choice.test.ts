import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clientLocalPath, setDataDir } from '@yaac/shared/paths'
import { recordInstall } from '@yaac/shared/install-record'
import { writeServerConfig } from '@yaac/shared/server-config'
import { assertHostServerAllowed, resolveDriverKind } from '#main/driver-choice'

/**
 * Where the server runs decides its driver (docs/server-in-cluster.md).
 * The data dir's `install.json` is seeded here the way `yaac server start`
 * and `yaac cluster install` write it.
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

async function record(kind: 'k8s' | 'containerless'): Promise<void> {
  await recordInstall({ driver: kind })
}

describe('resolveDriverKind', () => {
  it('is containerless for a host process, and writes nothing', () => {
    // Only `yaac server start` / `yaac cluster install` write the record.
    expect(resolveDriverKind()).toBe('containerless')
  })

  it('is k8s inside the server pod', () => {
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    expect(resolveDriverKind()).toBe('k8s')
  })

  it('records nothing on either substrate', async () => {
    expect(resolveDriverKind()).toBe('containerless')
    await expect(fs.access(clientLocalPath('driver'))).rejects.toThrow()
    await expect(fs.access(clientLocalPath('server.json'))).rejects.toThrow()
    await expect(fs.access(path.join(dataDir, 'install.json'))).rejects.toThrow()
  })

  it('ignores YAAC_DRIVER: a host process cannot elect to be a k8s server', () => {
    // A host process is always containerless.
    vi.stubEnv('YAAC_DRIVER', 'k8s')
    expect(resolveDriverKind()).toBe('containerless')
  })
})

describe('assertHostServerAllowed', () => {
  it('allows a host start on a fresh data dir and on a containerless one', async () => {
    await expect(assertHostServerAllowed()).resolves.toBeUndefined()
    await record('containerless')
    await expect(assertHostServerAllowed()).resolves.toBeUndefined()
  })

  it('refuses a host start on a k8s install, naming the command that starts its server', async () => {
    await record('k8s')
    await expect(assertHostServerAllowed()).rejects.toThrow(/is a cluster install[\s\S]*yaac cluster start/)
  })

  it('refuses even when the selection points at a server on another machine', async () => {
    // The record describes this data dir, whatever server is selected.
    await record('k8s')
    await writeServerConfig({ url: 'https://elsewhere.ts.net', enabled: true, saved: [] })
    await expect(assertHostServerAllowed()).rejects.toThrow(/yaac cluster start/)
  })

  it('does not refuse the pod itself, which is that install\'s server', async () => {
    await record('k8s')
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    await expect(assertHostServerAllowed()).resolves.toBeUndefined()
  })
})

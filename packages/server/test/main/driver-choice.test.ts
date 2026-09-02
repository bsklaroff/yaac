import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clientLocalPath, ensureClientLocalRoot, serverLocalPath, setDataDir } from '@yaac/shared/paths'
import { writeServerConfig } from '@yaac/shared/server-config'
import { assertHostServerAllowed, resolveDriverKind } from '#main/driver-choice'

/**
 * Placement is the driver (docs/server-in-cluster.md), so these two answer
 * the same question from opposite sides: what a start becomes, and what a
 * start is refused for. The record itself is written by neither — the
 * COMMAND that stood the server up writes it into `server.json` — so these
 * seed it the way `yaac server start` and `yaac cluster install` do.
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

/** Seed the record the way `yaac server start` / `yaac cluster install` do. */
async function record(kind: 'k8s' | 'containerless'): Promise<void> {
  await writeServerConfig({
    url: 'http://127.0.0.1:8787', token: 't', enabled: true, saved: [], driver: kind,
  })
}

/** Seed it the way an install that predates the move into server.json did. */
async function recordLegacyFile(kind: string): Promise<void> {
  await ensureClientLocalRoot()
  await fs.writeFile(clientLocalPath('driver'), `${kind}\n`)
}

describe('resolveDriverKind', () => {
  it('is containerless for a host process, and writes nothing', () => {
    // `yaac server run` may be a foreground server the operator drove
    // directly, which registers nothing — the record belongs to whichever
    // COMMAND stood the server up.
    expect(resolveDriverKind()).toBe('containerless')
  })

  it('is k8s inside the server pod', () => {
    // YAAC_IN_CLUSTER is set by the server Deployment's manifest and by
    // nothing else, so it IS the question "am I the pod?".
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    expect(resolveDriverKind()).toBe('k8s')
  })

  it('records nothing on either substrate', async () => {
    expect(resolveDriverKind()).toBe('containerless')
    await expect(fs.access(clientLocalPath('driver'))).rejects.toThrow()
    await expect(fs.access(clientLocalPath('server.json'))).rejects.toThrow()
  })

  it('ignores YAAC_DRIVER: a host process cannot elect to be a k8s server', () => {
    // The whole retired mode in one assertion — there is no host-process k8s
    // server to ask for, so asking for one gets the substrate that placement
    // dictates rather than a second writer of a cluster install's data dir.
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

  it('refuses a host start on a k8s install, naming the converge command', async () => {
    await record('k8s')
    await expect(assertHostServerAllowed()).rejects.toThrow(/yaac cluster install/)
  })

  it('still refuses one recorded in the standalone file, at both its paths', async () => {
    // Upgrading must not quietly re-enable the second writer this guard
    // exists to stop — see docs/legacy-compat-shims.md.
    await fs.writeFile(serverLocalPath('driver'), 'k8s\n')
    await expect(assertHostServerAllowed()).rejects.toThrow(/yaac cluster install/)
    await fs.rm(serverLocalPath('driver'))
    await recordLegacyFile('k8s')
    await expect(assertHostServerAllowed()).rejects.toThrow(/yaac cluster install/)
  })

  it('refuses even when the selection points at a server on another machine', async () => {
    // The driver is a property of THIS data dir, not of whatever origin is
    // currently selected — so `yaac remote set` cannot unlock a host start.
    await writeServerConfig({
      url: 'https://elsewhere.ts.net', token: 't', enabled: true, saved: [], driver: 'k8s',
    })
    await expect(assertHostServerAllowed()).rejects.toThrow(/yaac cluster install/)
  })

  it('does not refuse the pod itself, which is that install\'s server', async () => {
    await record('k8s')
    vi.stubEnv('YAAC_IN_CLUSTER', '1')
    await expect(assertHostServerAllowed()).resolves.toBeUndefined()
  })
})

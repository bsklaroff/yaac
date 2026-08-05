import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testTmpBase, e2eMkdtemp, setHermeticScratch } from '#tmp'

// This file runs under the `unit:test-utils` project, so unit-setup has
// already put the module in hermetic mode. Each case sets the mode it is
// asserting on, and the hook restores the unit-run default.
afterEach(() => {
  vi.unstubAllEnvs()
  setHermeticScratch(true)
})

describe('testTmpBase', () => {
  it('is the OS tmpdir for a hermetic (unit) run', () => {
    setHermeticScratch(true)
    vi.stubEnv('YAAC_DATA_DIR', undefined)
    expect(testTmpBase()).toBe(os.tmpdir())
  })

  it('stays the OS tmpdir for a hermetic run even with a custom data dir', () => {
    // A unit run must not follow YAAC_DATA_DIR onto a virtiofs/network
    // filesystem: its assertions are timestamp-sensitive.
    setHermeticScratch(true)
    vi.stubEnv('YAAC_DATA_DIR', '/srv/yaac-data')
    expect(testTmpBase()).toBe(os.tmpdir())
  })

  it('hangs off the default data dir for a pod-facing (api/e2e) run', () => {
    // Node-visible by contract — `yaac cluster check` mounts the data dir
    // into a pod on every setup. os.tmpdir() carries no such guarantee.
    setHermeticScratch(false)
    vi.stubEnv('YAAC_DATA_DIR', undefined)
    expect(testTmpBase()).toBe(path.join(os.homedir(), '.yaac', 'e2e-tmp'))
  })

  it('follows YAAC_DATA_DIR for a pod-facing run (the nested-session case)', () => {
    // Inside a nested yaac the pod's /tmp and $HOME are overlay
    // filesystems the node cannot see; $YAAC_DATA_DIR is the node-shared
    // mount at the same absolute path on both sides.
    setHermeticScratch(false)
    vi.stubEnv('YAAC_DATA_DIR', '/Users/ben/.yaac/nested')
    expect(testTmpBase()).toBe('/Users/ben/.yaac/nested/e2e-tmp')
  })
})

describe('e2eMkdtemp', () => {
  it('creates a unique dir under the temp base with the given prefix', async () => {
    setHermeticScratch(true)
    const dir = await e2eMkdtemp('yaac-tmp-helper-test-')
    try {
      expect(path.dirname(dir)).toBe(testTmpBase())
      expect(path.basename(dir)).toMatch(/^yaac-tmp-helper-test-/)
      await expect(fs.stat(dir)).resolves.toBeDefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('creates the base directory when it does not exist yet', async () => {
    // The pod-facing base (<data dir>/e2e-tmp) usually will not exist on a
    // fresh install, unlike the OS tmpdir.
    setHermeticScratch(false)
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-tmp-base-test-'))
    vi.stubEnv('YAAC_DATA_DIR', path.join(base, 'data'))
    try {
      const dir = await e2eMkdtemp('yaac-tmp-helper-test-')
      expect(path.dirname(dir)).toBe(path.join(base, 'data', 'e2e-tmp'))
      await expect(fs.stat(dir)).resolves.toBeDefined()
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})

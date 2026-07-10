import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { e2eTmpBase, e2eMkdtemp } from '#tmp'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('e2eTmpBase', () => {
  it('returns os.tmpdir() on a normal host', () => {
    vi.stubEnv('YAAC_NESTED', undefined)
    expect(e2eTmpBase()).toBe(os.tmpdir())
  })

  it('returns os.tmpdir() on a host with a custom data dir', () => {
    vi.stubEnv('YAAC_NESTED', undefined)
    vi.stubEnv('YAAC_DATA_DIR', '/srv/yaac-data')
    expect(e2eTmpBase()).toBe(os.tmpdir())
  })

  it('relocates under $YAAC_DATA_DIR inside a nested yaac session', () => {
    vi.stubEnv('YAAC_NESTED', '1')
    vi.stubEnv('YAAC_DATA_DIR', '/Users/ben/.yaac/nested')
    expect(e2eTmpBase()).toBe('/Users/ben/.yaac/nested/e2e-tmp')
  })

  it('falls back to os.tmpdir() when nested but $YAAC_DATA_DIR is unset', () => {
    vi.stubEnv('YAAC_NESTED', '1')
    vi.stubEnv('YAAC_DATA_DIR', undefined)
    expect(e2eTmpBase()).toBe(os.tmpdir())
  })
})

describe('e2eMkdtemp', () => {
  it('creates a unique dir under the temp base with the given prefix', async () => {
    vi.stubEnv('YAAC_NESTED', undefined)
    const dir = await e2eMkdtemp('yaac-tmp-helper-test-')
    try {
      expect(path.dirname(dir)).toBe(e2eTmpBase())
      expect(path.basename(dir)).toMatch(/^yaac-tmp-helper-test-/)
      await expect(fs.stat(dir)).resolves.toBeDefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

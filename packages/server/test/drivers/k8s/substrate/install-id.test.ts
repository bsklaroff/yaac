import { describe, it, expect, vi, afterEach } from 'vitest'
import { bindInstall, installId, installNameKey, legacyDataDirHash, legacyNameKey } from '#drivers/k8s/substrate'

// A binding lasts for the process, so the cases that read the environment
// run before the first `bindInstall`.

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('installId', () => {
  it('is the server pod\'s YAAC_INSTALL_ID, and throws when nothing names one', () => {
    vi.stubEnv('YAAC_INSTALL_ID', 'pod-install')
    expect(installId()).toBe('pod-install')
    vi.stubEnv('YAAC_INSTALL_ID', '')
    expect(() => installId()).toThrow(/no k8s install id/)
  })
})

describe('legacyDataDirHash', () => {
  it('is the server pod\'s YAAC_LEGACY_DATA_DIR_HASH when nothing is bound', () => {
    expect(legacyDataDirHash()).toBeUndefined()
    vi.stubEnv('YAAC_LEGACY_DATA_DIR_HASH', 'abc123')
    expect(legacyDataDirHash()).toBe('abc123')
  })
})

describe('legacyNameKey', () => {
  it('is the hash only while the server pod is told the names still carry it', () => {
    vi.stubEnv('YAAC_LEGACY_DATA_DIR_HASH', 'abc123')
    expect(legacyNameKey()).toBeUndefined()
    vi.stubEnv('YAAC_LEGACY_NAMES', '1')
    expect(legacyNameKey()).toBe('abc123')
  })
})

describe('bindInstall', () => {
  it('wins over the environment, so a recorded install is never taken for a test file\'s', () => {
    vi.stubEnv('YAAC_LEGACY_DATA_DIR_HASH', 'env-hash')
    vi.stubEnv('YAAC_LEGACY_NAMES', '1')
    bindInstall('recorded')
    expect(installId()).toBe('recorded')
    // A binding without a hash means none, whatever the environment says.
    expect(legacyDataDirHash()).toBeUndefined()
    expect(legacyNameKey()).toBeUndefined()
    bindInstall('recorded', { hash: 'abc123' })
    expect(legacyDataDirHash()).toBe('abc123')
    expect(legacyNameKey()).toBeUndefined()
  })
})

describe('installNameKey', () => {
  it('is the install id, or the legacy hash while objects are still named after it', () => {
    bindInstall('id-1', { hash: 'abc123' })
    expect(installNameKey()).toBe('id-1')
    bindInstall('id-1', { hash: 'abc123', names: true })
    expect(installNameKey()).toBe('abc123')
  })
})

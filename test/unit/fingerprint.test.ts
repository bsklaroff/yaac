import { describe, it, expect } from 'vitest'
import { computeFingerprint } from '@/lib/session/fingerprint'
import { hashConfig } from '@/lib/project/config'
import type { FingerprintInputs } from '@/lib/session/fingerprint'
import type { YaacConfig } from '@/types'

describe('computeFingerprint', () => {
  const baseInputs: FingerprintInputs = {
    imageTag: 'yaac-base:abc123',
    proxyImageTag: 'yaac-proxy:def456',
    configHash: '1234567890abcdef',
    remoteHead: 'a'.repeat(40),
  }

  it('returns a 16-char hex string', () => {
    const fp = computeFingerprint(baseInputs)
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic', () => {
    const a = computeFingerprint(baseInputs)
    const b = computeFingerprint(baseInputs)
    expect(a).toBe(b)
  })

  it('changes when imageTag changes', () => {
    const a = computeFingerprint(baseInputs)
    const b = computeFingerprint({ ...baseInputs, imageTag: 'yaac-base:xyz789' })
    expect(a).not.toBe(b)
  })

  it('changes when proxyImageTag changes', () => {
    const a = computeFingerprint(baseInputs)
    const b = computeFingerprint({ ...baseInputs, proxyImageTag: 'yaac-proxy:changed' })
    expect(a).not.toBe(b)
  })

  it('changes when configHash changes', () => {
    const a = computeFingerprint(baseInputs)
    const b = computeFingerprint({ ...baseInputs, configHash: 'fedcba0987654321' })
    expect(a).not.toBe(b)
  })

  it('changes when remoteHead changes', () => {
    const a = computeFingerprint(baseInputs)
    const b = computeFingerprint({ ...baseInputs, remoteHead: 'b'.repeat(40) })
    expect(a).not.toBe(b)
  })
})

describe('hashConfig', () => {
  it('returns a 16-char hex string', () => {
    const hash = hashConfig({})
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic', () => {
    const config: YaacConfig = { envPassthrough: ['FOO'], initCommands: ['npm install'] }
    expect(hashConfig(config)).toBe(hashConfig(config))
  })

  it('is insensitive to key order', () => {
    const a: YaacConfig = { envPassthrough: ['FOO'], initCommands: ['npm install'] }
    // Create an object with reversed key insertion order
    const b: YaacConfig = {}
    b.initCommands = ['npm install']
    b.envPassthrough = ['FOO']
    expect(hashConfig(a)).toBe(hashConfig(b))
  })

  it('changes when config values change', () => {
    const a = hashConfig({ envPassthrough: ['FOO'] })
    const b = hashConfig({ envPassthrough: ['BAR'] })
    expect(a).not.toBe(b)
  })

  it('changes when fields are added', () => {
    const a = hashConfig({})
    const b = hashConfig({ initCommands: ['echo hi'] })
    expect(a).not.toBe(b)
  })

  it('is sensitive to nestedContainers', () => {
    const a = hashConfig({ nestedContainers: false })
    const b = hashConfig({ nestedContainers: true })
    expect(a).not.toBe(b)
  })

  it('is sensitive to pgRelay config', () => {
    const a = hashConfig({ pgRelay: { enabled: true } })
    const b = hashConfig({ pgRelay: { enabled: true, hostPort: 5433 } })
    expect(a).not.toBe(b)
  })
})

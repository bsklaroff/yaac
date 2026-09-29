import { describe, it, expect } from 'vitest'
import { SENSITIVE_PORTS, isForwardablePort, isInfraPort } from '#lib/port-policy'

describe('isForwardablePort', () => {
  it('rejects sensitive ports, the infra range, and out-of-range values', () => {
    for (const p of SENSITIVE_PORTS) expect(isForwardablePort(p)).toBe(false)
    expect(isForwardablePort(10300)).toBe(false) // streamd
    expect(isForwardablePort(10260)).toBe(false) // relay
    expect(isForwardablePort(0)).toBe(false)
    expect(isForwardablePort(65536)).toBe(false)
    expect(isForwardablePort(3.5)).toBe(false)
    expect(isForwardablePort(8080)).toBe(true)
    expect(isForwardablePort(5173)).toBe(true)
  })
})

describe('isInfraPort', () => {
  it('is exactly yaac\'s own 10250-10350 range, sensitive ports not included', () => {
    expect(isInfraPort(10249)).toBe(false)
    expect(isInfraPort(10250)).toBe(true)
    expect(isInfraPort(10350)).toBe(true)
    expect(isInfraPort(10351)).toBe(false)
    expect(isInfraPort(5432)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { SENSITIVE_PORTS, isForwardablePort } from '#drivers/shared/port-policy'

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

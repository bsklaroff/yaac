import { describe, it, expect } from 'vitest'
import { buildWebappUrl } from '@/daemon/cli'

describe('buildWebappUrl', () => {
  it('builds a loopback URL carrying the bootstrap code', () => {
    expect(buildWebappUrl(54213, 'abc123')).toBe('http://127.0.0.1:54213/?bootstrap=abc123')
  })
})

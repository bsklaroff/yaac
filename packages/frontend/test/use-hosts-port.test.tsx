import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useHostsPort } from '#lib/useHostsPort'

afterEach(cleanup)

describe('useHostsPort', () => {
  it('is the page\'s own port when it came from a server on loopback', () => {
    // The test page is served from localhost.
    const { result } = renderHook(() => useHostsPort())
    expect(window.location.hostname).toBe('localhost')
    expect(result.current).toBe(Number(window.location.port || 80))
  })
})

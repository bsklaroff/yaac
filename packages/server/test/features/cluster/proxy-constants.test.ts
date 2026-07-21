import { describe, it, expect } from 'vitest'
import {
  PROXY_APP_NAME,
  PROXY_AUTH_SECRET_NAME,
  PROXY_PORT,
  TRANSPARENT_HTTP_PORT,
  TRANSPARENT_HTTPS_PORT,
  TRANSPARENT_TUNNEL_PORT,
} from '#features/cluster/proxy-constants'

describe('constants', () => {
  it('expose the proxy app/secret names and in-cluster ports', () => {
    expect(PROXY_APP_NAME).toBe('yaac-proxy')
    expect(PROXY_AUTH_SECRET_NAME).toBe('yaac-proxy-auth')
    expect(PROXY_PORT).toBe(10255)
    expect(TRANSPARENT_HTTPS_PORT).toBe(10256)
    expect(TRANSPARENT_HTTP_PORT).toBe(10257)
    expect(TRANSPARENT_TUNNEL_PORT).toBe(10258)
  })
})

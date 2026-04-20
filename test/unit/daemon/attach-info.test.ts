import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { buildApp } from '@/daemon/server'

function withAuth(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer shh')
  return { ...init, headers }
}

describe('GET /session/:id/attach-info', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('returns 404 NOT_FOUND when no container matches the id', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'test' })
    const res = await app.request('/session/bogus-id/attach-info', withAuth())
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

describe('GET /session/:id/shell-info', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('returns 404 NOT_FOUND when no container matches the id', async () => {
    const app = buildApp({ secret: 'shh', buildId: 'test' })
    const res = await app.request('/session/bogus-id/shell-info', withAuth())
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

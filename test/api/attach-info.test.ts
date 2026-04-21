import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@test/helpers/setup'
import { buildApp } from '@/daemon/server'
import { makeTestRpcClient } from '@test/helpers/rpc'

describe('GET /session/:id/attach-info', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await cleanupTempDir(tmpDir)
  })

  it('returns 404 NOT_FOUND when no container matches the id', async () => {
    const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.session[':id']['attach-info'].$get({ param: { id: 'bogus-id' } })
    expect(res.status).toBe(404)
    const body = await res.json() as unknown as { error: { code: string } }
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
    const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.session[':id']['shell-info'].$get({ param: { id: 'bogus-id' } })
    expect(res.status).toBe(404)
    const body = await res.json() as unknown as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

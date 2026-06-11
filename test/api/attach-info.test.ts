import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createTempDataDir,
  cleanupTempDir,
  clusterAvailable,
  useTestNamespace,
} from '@test/helpers/setup'
import { buildApp } from '@/daemon/server'
import { makeTestRpcClient } from '@test/helpers/rpc'

// Session resolution lists pods via kubectl, so even the NOT_FOUND path
// needs a reachable cluster. Skip (don't fail) when none is configured —
// these are otherwise in-process tests.
const haveCluster = await clusterAvailable()

describe.skipIf(!haveCluster)('GET /session/:id/attach-info', () => {
  let tmpDir: string
  let restoreNamespace: (() => void) | null = null

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    restoreNamespace = useTestNamespace()
  })

  afterEach(async () => {
    restoreNamespace?.()
    restoreNamespace = null
    await cleanupTempDir(tmpDir)
  })

  it('returns 404 NOT_FOUND when no session pod matches the id', async () => {
    const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.session[':id']['attach-info'].$get({ param: { id: 'bogus-id' } })
    expect(res.status).toBe(404)
    const body = await res.json() as unknown as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

describe.skipIf(!haveCluster)('GET /session/:id/shell-info', () => {
  let tmpDir: string
  let restoreNamespace: (() => void) | null = null

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
    restoreNamespace = useTestNamespace()
  })

  afterEach(async () => {
    restoreNamespace?.()
    restoreNamespace = null
    await cleanupTempDir(tmpDir)
  })

  it('returns 404 NOT_FOUND when no session pod matches the id', async () => {
    const client = makeTestRpcClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.session[':id']['shell-info'].$get({ param: { id: 'bogus-id' } })
    expect(res.status).toBe(404)
    const body = await res.json() as unknown as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })
})

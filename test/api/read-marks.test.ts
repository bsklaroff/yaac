import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/server'
import { makeTestApiClient } from '@yaac/test-utils/api'
import { closeDb } from '@yaac/server/lib/db/client'
import { recordSessionDeleted, listDeletedInfo } from '@yaac/server/lib/session/deleted-store'

describe('POST /session/mark-death-seen', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  it('marks a recorded death seen on its deleted_sessions row', async () => {
    // Seed an abnormal death (unseen by default).
    await recordSessionDeleted('proj', 'sid-1', { reason: 'oom' })
    expect((await listDeletedInfo('proj')).get('sid-1')?.seen).toBe(false)

    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.session['mark-death-seen'].$post({
      json: { projectSlug: 'proj', sessionId: 'sid-1' },
    })
    expect(res.status).toBe(204)

    expect((await listDeletedInfo('proj')).get('sid-1')?.seen).toBe(true)
  })

  it('is a 204 no-op for a session with no row (best-effort)', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.session['mark-death-seen'].$post({
      json: { projectSlug: 'proj', sessionId: 'ghost' },
    })
    expect(res.status).toBe(204)
    expect((await listDeletedInfo('proj')).size).toBe(0)
  })

  it('rejects a malformed body', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.session['mark-death-seen'].$post({
      // @ts-expect-error — sessionId is required
      json: { projectSlug: 'proj' },
    })
    expect(res.status).toBe(400)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { buildApp } from '@yaac/server/main/server'
import { makeTestApiClient } from '@yaac/test-utils/api'
import { closeDb } from '@yaac/server/platform/db/client'
import {
  recordSessionCreated,
  recordSessionDeleted,
  listSessionRows,
} from '@yaac/server/features/sessions/store'

describe('POST /session/mark-death-seen', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTempDataDir()
  })

  afterEach(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  const seen = async (sessionId: string): Promise<boolean | undefined> =>
    (await listSessionRows('proj')).find((r) => r.sessionId === sessionId)?.deathSeen

  it('marks a recorded death seen on its session row', async () => {
    // Seed an abnormal death (unseen by default).
    await recordSessionCreated({ projectSlug: 'proj', sessionId: 'sid-1', tool: 'claude' })
    await recordSessionDeleted('proj', 'sid-1', { reason: 'oom' })
    expect(await seen('sid-1')).toBe(false)

    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.session['mark-death-seen'].$post({
      json: { projectSlug: 'proj', sessionId: 'sid-1' },
    })
    expect(res.status).toBe(204)

    expect(await seen('sid-1')).toBe(true)
  })

  it('is a 204 no-op for a session with no row (best-effort)', async () => {
    const client = makeTestApiClient(buildApp({ secret: 'shh', buildId: 'test' }))
    const res = await client.session['mark-death-seen'].$post({
      json: { projectSlug: 'proj', sessionId: 'ghost' },
    })
    expect(res.status).toBe(204)
    expect(await listSessionRows('proj')).toEqual([])
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

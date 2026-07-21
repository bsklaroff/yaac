import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import { createTempDataDir, cleanupTempDir } from '@yaac/test-utils/setup'
import { projectDir } from '@yaac/shared/project-paths'
import { getDb, closeDb } from '#platform/db/client'
import { schedules } from '#platform/db/schema'
import { scheduleApp } from '#routes/schedules'
import { toErrorBody } from '#http/errors'
import type { ScheduleEntry } from '@yaac/shared/types'

// Same error normalization buildApp applies, so ServerErrors surface as
// their wire status/body instead of hono's bare 500.
const app = new Hono()
  .route('/schedule', scheduleApp)
  .onError((err: Error, c: Context) => {
    const { status, body } = toErrorBody(err)
    return c.json(body, status as 400)
  })

async function addViaRoute(over: Record<string, unknown> = {}): Promise<ScheduleEntry> {
  const res = await app.request('/schedule/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'proj-a', spec: '0 9 * * *', prompt: 'review the queue', ...over }),
  })
  expect(res.status).toBe(200)
  const { schedule } = await res.json() as { schedule: ScheduleEntry }
  return schedule
}

describe('schedule routes', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await createTempDataDir()
    for (const slug of ['proj-a', 'proj-b']) {
      const dir = projectDir(slug)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, 'project.json'),
        JSON.stringify({ slug, remoteUrl: `file:///tmp/${slug}`, addedAt: new Date().toISOString() }),
      )
    }
  })

  afterAll(async () => {
    await closeDb()
    await cleanupTempDir(tmpDir)
  })

  beforeEach(async () => {
    const db = await getDb()
    await db.delete(schedules)
  })

  it('GET /list returns an empty set on a fresh DB', async () => {
    const res = await app.request('/schedule/list')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ schedules: [] })
  })

  it('POST /add round-trips through GET /list, with the project filter applied', async () => {
    const a = await addViaRoute()
    const b = await addViaRoute({ project: 'proj-b', tool: 'codex' })
    expect(b.tool).toBe('codex')

    const all = await (await app.request('/schedule/list')).json() as { schedules: ScheduleEntry[] }
    expect(all.schedules.map((s) => s.id).sort()).toEqual([a.id, b.id].sort())

    const filtered = await (await app.request('/schedule/list?project=proj-a')).json() as { schedules: ScheduleEntry[] }
    expect(filtered.schedules).toEqual([a])
  })

  it('POST /add rejects a bad cron spec as 400 VALIDATION', async () => {
    const res = await app.request('/schedule/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'proj-a', spec: 'bogus', prompt: 'p' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
  })

  it('POST /add rejects an unknown project as 404', async () => {
    const res = await app.request('/schedule/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'ghost', spec: '* * * * *', prompt: 'p' }),
    })
    expect(res.status).toBe(404)
  })

  it('POST /add rejects a missing prompt at the schema layer', async () => {
    const res = await app.request('/schedule/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'proj-a', spec: '* * * * *' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /remove deletes; an unknown id is 404', async () => {
    const entry = await addViaRoute()
    const ok = await app.request('/schedule/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: entry.id }),
    })
    expect(ok.status).toBe(200)
    expect(await (await app.request('/schedule/list')).json()).toEqual({ schedules: [] })

    const missing = await app.request('/schedule/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: entry.id }),
    })
    expect(missing.status).toBe(404)
  })
})

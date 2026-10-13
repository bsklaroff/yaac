import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { streamProvisioned } from '#routes/provisioned-stream'
import { ServerError } from '@yaac/shared/errors'

type Run = Parameters<typeof streamProvisioned>[1]

async function request(run: Run): Promise<{ res: Response; events: unknown[] }> {
  const app = new Hono().post('/op', (c) => streamProvisioned(c, run))
  const res = await app.request('/op', { method: 'POST' })
  const text = await res.text()
  return { res, events: text.trim().split('\n').map((l) => JSON.parse(l) as unknown) }
}

describe('streamProvisioned', () => {
  it('streams NDJSON progress events followed by the terminal result', async () => {
    const { res, events } = await request((onProgress) => {
      onProgress('step one')
      onProgress('step two')
      return Promise.resolve({ workspaceId: 'sid-1', jobName: 'job-1' })
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    expect(events).toEqual([
      { type: 'progress', message: 'step one' },
      { type: 'progress', message: 'step two' },
      { type: 'result', result: { workspaceId: 'sid-1', jobName: 'job-1' } },
    ])
  })

  it('ends with an error event, mapped through the uniform error taxonomy', async () => {
    expect((await request(() => Promise.reject(new ServerError('NOT_FOUND', 'missing')))).events).toEqual([
      { type: 'error', error: { code: 'NOT_FOUND', message: 'missing' } },
    ])
    expect((await request(() => Promise.reject(new Error('exploded')))).events).toEqual([
      { type: 'error', error: { code: 'INTERNAL', message: 'exploded' } },
    ])
  })
})

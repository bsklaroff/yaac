import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { streamProvisioned } from '#routes/provisioned-stream'
import {
  registerProvisioning,
  listProvisioning,
  clearAllProvisioningForTests,
} from '#features/sessions/provisioning'
import {
  onSessionListChanged,
  _resetSessionListChangedForTests,
} from '#features/sessions/notify'
import { ServerError } from '@yaac/shared/errors'

type Run = Parameters<typeof streamProvisioned>[2]

async function request(sessionId: string, run: Run): Promise<{ res: Response; events: unknown[] }> {
  const app = new Hono().post('/op', (c) => streamProvisioned(c, sessionId, run))
  const res = await app.request('/op', { method: 'POST' })
  const text = await res.text()
  return { res, events: text.trim().split('\n').map((l) => JSON.parse(l) as unknown) }
}

describe('streamProvisioned', () => {
  let notifies: number

  beforeEach(() => {
    clearAllProvisioningForTests()
    notifies = 0
    onSessionListChanged(() => { notifies += 1 })
  })

  afterEach(() => {
    clearAllProvisioningForTests()
    _resetSessionListChangedForTests()
  })

  it('streams NDJSON progress events followed by the terminal result', async () => {
    const { res, events } = await request('sid-1', (onProgress) => {
      onProgress('step one')
      onProgress('step two')
      return Promise.resolve({ worktreeId: 'sid-1', jobName: 'job-1' })
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    expect(events).toEqual([
      { type: 'progress', message: 'step one' },
      { type: 'progress', message: 'step two' },
      { type: 'result', result: { worktreeId: 'sid-1', jobName: 'job-1' } },
    ])
  })

  it('mirrors progress into a registered provisioning row and drops it on success', async () => {
    registerProvisioning({ worktreeId: 'sid-1', projectSlug: 'demo', tool: 'claude', kind: 'create' })
    let messageDuringRun: string | undefined
    await request('sid-1', (onProgress) => {
      onProgress('Creating job...')
      messageDuringRun = listProvisioning().find((p) => p.worktreeId === 'sid-1')?.message
      return Promise.resolve({ ok: true })
    })
    expect(messageDuringRun).toBe('Creating job...')
    expect(listProvisioning()).toEqual([])
    // register + progress update + row drop + post-result push
    expect(notifies).toBe(4)
  })

  it('emits a terminal error event and marks the row failed (kept until dismissed)', async () => {
    registerProvisioning({ worktreeId: 'sid-1', projectSlug: 'demo', tool: 'claude', kind: 'restart' })
    const { events } = await request('sid-1', () =>
      Promise.reject(new ServerError('NOT_FOUND', 'missing')))
    expect(events).toEqual([
      { type: 'error', error: { code: 'NOT_FOUND', message: 'missing' } },
    ])
    const row = listProvisioning().find((p) => p.worktreeId === 'sid-1')
    expect(row?.error).toBe('missing')
  })

  it('maps non-ServerError failures through the uniform error taxonomy', async () => {
    const { events } = await request('sid-1', () => Promise.reject(new Error('exploded')))
    expect(events).toEqual([
      { type: 'error', error: { code: 'INTERNAL', message: 'exploded' } },
    ])
  })

  it('leaves the registry alone when the caller never registered a row', async () => {
    // The create route's prewarm fast path resolves without registering;
    // progress must still stream, and no row may appear or get resurrected.
    const { events } = await request('sid-2', (onProgress) => {
      onProgress('Claiming prewarmed session...')
      return Promise.resolve({ worktreeId: 'spare-1' })
    })
    expect(events).toEqual([
      { type: 'progress', message: 'Claiming prewarmed session...' },
      { type: 'result', result: { worktreeId: 'spare-1' } },
    ])
    expect(listProvisioning()).toEqual([])
    // Only the post-result snapshot push — registry no-ops don't notify.
    expect(notifies).toBe(1)
  })
})

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { zv } from '@/daemon/routes/validator'

describe('zv', () => {
  const app = new Hono().post(
    '/add',
    zv('json', z.object({ remoteUrl: z.string().min(1) })),
    (c) => c.json({ got: c.req.valid('json').remoteUrl }),
  )

  async function post(body: unknown): Promise<Response> {
    return await app.request('/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('answers a failure with the daemon error body: first issue as `path: message`', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        code: 'VALIDATION',
        message: 'remoteUrl: Invalid input: expected string, received undefined',
      },
    })
  })

  it('omits the path prefix for top-level issues', async () => {
    const res = await post([])
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { code: 'VALIDATION', message: 'Invalid input: expected object, received array' },
    })
  })

  it('passes valid input through to the handler', async () => {
    const res = await post({ remoteUrl: 'x/y' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ got: 'x/y' })
  })
})

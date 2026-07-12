import { describe, expect, it } from 'vitest'
import { makeServerClient } from '#client'

describe('makeServerClient', () => {
  it('targets the base URL with the injected fetch and bearer header', async () => {
    const seen: { url: string, auth: string | null }[] = []
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return Promise.resolve(new Response(JSON.stringify({ ok: true, buildId: 'b' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    const client = makeServerClient(fetchImpl, {
      baseUrl: 'http://127.0.0.1:9999', secret: 'sekrit', remote: false,
    })
    const res = await client.health.$get()
    expect(res.ok).toBe(true)
    expect(seen).toEqual([{ url: 'http://127.0.0.1:9999/health', auth: 'Bearer sekrit' }])
  })
})

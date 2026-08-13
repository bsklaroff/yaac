import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProxyClient } from '#drivers/k8s/egress/proxy-client'

// allowHost needs a resolved base URL + auth secret, both set only after the
// port-forward + secret exchange. Inject them directly so the method can be
// exercised without a live proxy (TS `private`/`readonly` are compile-time only).
function makeClient(): ProxyClient {
  const c = new ProxyClient({ image: 'yaac-test-proxy' })
  const internals = c as unknown as { authSecret: string; forward: { currentPort: number } }
  internals.authSecret = 'sekret'
  internals.forward = { currentPort: 4444 }
  return c
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

function stubFetch(res: { ok: boolean; status: number; text?: string }): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: res.ok,
    status: res.status,
    text: () => Promise.resolve(res.text ?? ''),
  })
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

describe('ProxyClient.allowHost', () => {
  it('POSTs the allow-host endpoint with bearer auth and a json host body', async () => {
    const mock = stubFetch({ ok: true, status: 200 })
    await expect(makeClient().allowHost('sess 1', 'evil.example.com')).resolves.toBe(true)

    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:4444/worktrees/sess%201/allow-host')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sekret')
    expect(JSON.parse(init.body as string)).toEqual({ host: 'evil.example.com' })
  })

  it('returns false on a 404 (session not registered) so callers choose the tolerance', async () => {
    stubFetch({ ok: false, status: 404, text: 'Unknown session' })
    await expect(makeClient().allowHost('s', 'h.com')).resolves.toBe(false)
  })

  it('throws on other non-OK statuses', async () => {
    stubFetch({ ok: false, status: 500, text: 'boom' })
    await expect(makeClient().allowHost('s', 'h.com'))
      .rejects.toThrow('Failed to allow host: 500 boom')
  })
})

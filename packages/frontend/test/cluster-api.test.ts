import { describe, it, expect, vi, afterEach } from 'vitest'
import { getClusterCheck, streamClusterSetup } from '#lib/clusterApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function streamBody(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(`${l}\n`))
      controller.close()
    },
  })
}

describe('getClusterCheck', () => {
  it('returns the server check result', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: false, results: [{ name: 'kind', status: 'fail', detail: 'no cluster' }] }),
    }) as unknown as typeof fetch
    const r = await getClusterCheck()
    expect(r.ok).toBe(false)
    expect(r.results[0].name).toBe('kind')
  })
})

describe('streamClusterSetup', () => {
  it('reports progress lines and resolves with the final ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: streamBody([
        JSON.stringify({ type: 'progress', message: 'Creating cluster' }),
        JSON.stringify({ type: 'progress', message: 'Installing Calico' }),
        JSON.stringify({ type: 'result', ok: true }),
      ]),
    }) as unknown as typeof fetch
    const lines: string[] = []
    const ok = await streamClusterSetup((l) => lines.push(l))
    expect(ok).toBe(true)
    expect(lines).toEqual(['Creating cluster', 'Installing Calico'])
  })

  it('throws the server error message on an error event', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: streamBody([JSON.stringify({ type: 'error', error: { message: 'podman not found' } })]),
    }) as unknown as typeof fetch
    await expect(streamClusterSetup(() => { /* ignore */ })).rejects.toThrow(/podman not found/)
  })

  it('throws on a non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch
    await expect(streamClusterSetup(() => { /* ignore */ })).rejects.toThrow(/HTTP 500/)
  })
})

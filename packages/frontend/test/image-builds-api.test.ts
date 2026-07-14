import { describe, it, expect, vi, afterEach } from 'vitest'
import { dismissImageBuild, getImageBuildLog, retryImageBuild } from '#lib/imageBuildsApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stub(json: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(''),
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('image builds api calls', () => {
  it('getImageBuildLog GETs the build log route and unwraps { log }', async () => {
    const fetchMock = stub({ log: 'step 1/3' })
    expect(await getImageBuildLog('build-7')).toEqual({ log: 'step 1/3' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/image/builds/build-7/log')
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('dismissImageBuild DELETEs the build route', async () => {
    const fetchMock = stub(undefined, 204)
    await dismissImageBuild('build-7')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/image/builds/build-7')
    expect(init.method).toBe('DELETE')
  })

  it('retryImageBuild POSTs the retry route', async () => {
    const fetchMock = stub(undefined, 202)
    await retryImageBuild('build-7')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/image/builds/build-7/retry')
    expect(init.method).toBe('POST')
  })
})

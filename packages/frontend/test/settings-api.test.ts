import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  cancelToolInstall, cancelToolLogin, clearToolAuth, getToolInstall, getToolLogin,
  sendToolLoginInput, setToolApiKey, startToolInstall, startToolLogin,
} from '#lib/settingsApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Stub globalThis.fetch. Returns a JSON body (for the poll/start routes that
 *  unwrap a view) and defaults to a 200. */
function stub(json: unknown = {}, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    status,
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(''),
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function call(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit]
}

describe('tool sign-in api calls', () => {
  it('setToolApiKey PUTs an api-key payload to the tool route', async () => {
    const fetchMock = stub(undefined, 204)
    await setToolApiKey('codex', 'sk-openai-x')
    const [url, init] = call(fetchMock)
    expect(url).toBe('/auth/codex')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'api-key', apiKey: 'sk-openai-x' })
  })

  it('setToolApiKey carries the opencode provider when given', async () => {
    const fetchMock = stub(undefined, 204)
    await setToolApiKey('opencode', 'nw-key', 'neuralwatt')
    const [url, init] = call(fetchMock)
    expect(url).toBe('/auth/opencode')
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'api-key', apiKey: 'nw-key', provider: 'neuralwatt' })
  })

  it('clearToolAuth POSTs the tool as the clear service', async () => {
    const fetchMock = stub(undefined, 204)
    await clearToolAuth('opencode')
    const [url, init] = call(fetchMock)
    expect(url).toBe('/auth/clear')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ service: 'opencode' })
  })
})

describe('web sign-in flow api calls', () => {
  it('startToolLogin POSTs to the tool login route', async () => {
    const fetchMock = stub()
    await startToolLogin('claude')
    const [url, init] = call(fetchMock)
    expect(url).toBe('/auth/claude/login/start')
    expect(init.method).toBe('POST')
  })

  it('getToolLogin polls the session route', async () => {
    const fetchMock = stub()
    await getToolLogin('id-1')
    const [url, init] = call(fetchMock)
    expect(url).toBe('/auth/login/id-1')
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('sendToolLoginInput POSTs the stdin line', async () => {
    const fetchMock = stub()
    await sendToolLoginInput('id-1', 'code#state')
    const [url, init] = call(fetchMock)
    expect(url).toBe('/auth/login/id-1/input')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'code#state' })
  })

  it('cancelToolLogin POSTs the cancel route', async () => {
    const fetchMock = stub(undefined, 204)
    await cancelToolLogin('id-1')
    const [url, init] = call(fetchMock)
    expect(url).toBe('/auth/login/id-1/cancel')
    expect(init.method).toBe('POST')
  })
})

describe('web install flow api calls', () => {
  it('startToolInstall POSTs to the tool install route', async () => {
    const fetchMock = stub()
    await startToolInstall('codex')
    expect(call(fetchMock)[0]).toBe('/auth/codex/install/start')
  })

  it('getToolInstall polls the session route', async () => {
    const fetchMock = stub()
    await getToolInstall('id-2')
    expect(call(fetchMock)[0]).toBe('/auth/install/id-2')
  })

  it('cancelToolInstall POSTs the cancel route', async () => {
    const fetchMock = stub(undefined, 204)
    await cancelToolInstall('id-2')
    const [url, init] = call(fetchMock)
    expect(url).toBe('/auth/install/id-2/cancel')
    expect(init.method).toBe('POST')
  })
})

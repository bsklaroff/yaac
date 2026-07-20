import { describe, it, expect, vi, afterEach } from 'vitest'
import { encodeBase64, projectBuildFilesApi, userBuildFilesApi } from '#lib/buildFilesApi'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stub(json: unknown, status = 200): ReturnType<typeof vi.fn> {
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

describe('encodeBase64', () => {
  it('encodes bytes, including multi-chunk inputs', () => {
    expect(encodeBase64(new Uint8Array([104, 105]).buffer)).toBe('aGk=')
    const big = new Uint8Array(0x8000 + 3).fill(65)
    expect(atob(encodeBase64(big.buffer)).length).toBe(big.length)
  })
})

describe('projectBuildFilesApi', () => {
  it('list GETs the project route and unwraps { files }', async () => {
    const entry = { path: 'a.txt', size: 1, binary: false }
    const fetchMock = stub({ files: [entry] })
    expect(await projectBuildFilesApi('demo').list()).toEqual([entry])
    expect(fetchMock.mock.calls[0][0] as string).toBe('/project/demo/build-files')
  })

  it('read GETs /file with the path query', async () => {
    const file = { path: 'a.txt', size: 1, binary: false, content: 'x' }
    const fetchMock = stub(file)
    expect(await projectBuildFilesApi('demo').read('nvim/init.lua')).toEqual(file)
    expect(fetchMock.mock.calls[0][0] as string)
      .toBe('/project/demo/build-files/file?path=nvim%2Finit.lua')
  })

  it('saveText PUTs { path, content }', async () => {
    const fetchMock = stub({ path: 'a.txt', size: 1, binary: false })
    await projectBuildFilesApi('demo').saveText('a.txt', 'x')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/project/demo/build-files/file')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ path: 'a.txt', content: 'x' })
  })

  it('upload PUTs { path, contentBase64 }', async () => {
    const fetchMock = stub({ path: 'b.bin', size: 2, binary: true })
    await projectBuildFilesApi('demo').upload('b.bin', new Uint8Array([0, 1]).buffer)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ path: 'b.bin', contentBase64: 'AAE=' })
  })

  it('rename POSTs /rename with { from, to }', async () => {
    const fetchMock = stub({ path: 'b.txt', size: 1, binary: false })
    await projectBuildFilesApi('demo').rename('a.txt', 'b.txt')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/project/demo/build-files/rename')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ from: 'a.txt', to: 'b.txt' })
  })

  it('remove DELETEs /file with the path query', async () => {
    const fetchMock = stub(undefined, 200)
    await projectBuildFilesApi('demo').remove('a.txt')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/project/demo/build-files/file?path=a.txt')
    expect(init.method).toBe('DELETE')
  })
})

describe('userBuildFilesApi', () => {
  it('targets the /config/user-build-files routes', async () => {
    const fetchMock = stub({ files: [] })
    expect(await userBuildFilesApi().list()).toEqual([])
    expect(fetchMock.mock.calls[0][0] as string).toBe('/config/user-build-files')

    stub({ path: 'a', size: 1, binary: false })
    await userBuildFilesApi().saveText('a', 'x')
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)
      .toBe('/config/user-build-files/file')
  })
})

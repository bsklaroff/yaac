import { describe, it, expect, vi, afterEach } from 'vitest'
import { encodeBase64, projectBuildFilesApi, userBuildFilesApi } from '#lib/buildFilesApi'
import { mockFetch } from './harness'

afterEach(() => vi.unstubAllGlobals())

describe('encodeBase64', () => {
  it('encodes bytes, including multi-chunk inputs', () => {
    expect(encodeBase64(new Uint8Array([104, 105]).buffer)).toBe('aGk=')
    const big = new Uint8Array(0x8000 + 3).fill(65)
    expect(atob(encodeBase64(big.buffer)).length).toBe(big.length)
  })
})

describe('projectBuildFilesApi', () => {
  it('drives every project build-files route', async () => {
    const entry = { path: 'a.txt', size: 1, binary: false }
    const server = mockFetch({
      'GET /api/project/demo/build-files': { files: [entry] },
      'GET /api/project/demo/build-files/file': { ...entry, content: 'x' },
      'PUT /api/project/demo/build-files/file': entry,
      'POST /api/project/demo/build-files/rename': entry,
      'DELETE /api/project/demo/build-files/file': undefined,
    })
    const files = projectBuildFilesApi('demo')

    expect(await files.list()).toEqual([entry])
    expect(await files.read('nvim/init.lua')).toEqual({ ...entry, content: 'x' })
    await files.saveText('a.txt', 'x')
    await files.upload('b.bin', new Uint8Array([0, 1]).buffer)
    await files.rename('a.txt', 'b.txt')
    await files.remove('a.txt')

    expect(server.called('GET /api/project/demo/build-files/file')[0].query.get('path')).toBe('nvim/init.lua')
    expect(server.called('PUT /api/project/demo/build-files/file').map((c) => c.body)).toEqual([
      { path: 'a.txt', content: 'x' },
      { path: 'b.bin', contentBase64: 'AAE=' },
    ])
    expect(server.called('POST /api/project/demo/build-files/rename')[0].body).toEqual({ from: 'a.txt', to: 'b.txt' })
    expect(server.called('DELETE /api/project/demo/build-files/file')[0].query.get('path')).toBe('a.txt')
  })
})

describe('userBuildFilesApi', () => {
  it('targets the /config/user-build-files routes', async () => {
    const server = mockFetch({
      'GET /api/config/user-build-files': { files: [] },
      'PUT /api/config/user-build-files/file': { path: 'a', size: 1, binary: false },
    })
    expect(await userBuildFilesApi().list()).toEqual([])
    await userBuildFilesApi().saveText('a', 'x')
    expect(server.called('PUT /api/config/user-build-files/file')[0].body).toEqual({ path: 'a', content: 'x' })
  })
})

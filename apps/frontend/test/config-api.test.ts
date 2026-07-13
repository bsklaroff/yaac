import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getProjectConfig,
  saveProjectConfig,
  getProjectDockerfile,
  saveProjectDockerfile,
} from '#lib/projectApi'
import { getUserDockerfile, saveUserDockerfile } from '#lib/settingsApi'

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

describe('project config / dockerfile api', () => {
  it('getProjectConfig GETs the config route and unwraps { config }', async () => {
    const fetchMock = stub({ config: { envPassthrough: ['X'] } })
    expect(await getProjectConfig('demo')).toEqual({ envPassthrough: ['X'] })
    expect(fetchMock.mock.calls[0][0] as string).toBe('/project/demo/config')
  })

  it('saveProjectConfig PUTs { config } and unwraps the result', async () => {
    const fetchMock = stub({ config: { envPassthrough: ['Y'] } })
    expect(await saveProjectConfig('demo', { envPassthrough: ['Y'] })).toEqual({ envPassthrough: ['Y'] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/project/demo/config')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ config: { envPassthrough: ['Y'] } })
  })

  it('getProjectDockerfile unwraps { content }', async () => {
    stub({ content: 'FROM x\n' })
    expect(await getProjectDockerfile('demo')).toBe('FROM x\n')
  })

  it('saveProjectDockerfile PUTs { content }', async () => {
    const fetchMock = stub({ content: 'FROM x\n' })
    await saveProjectDockerfile('demo', 'FROM x\n')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/project/demo/dockerfile')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ content: 'FROM x\n' })
  })
})

describe('user dockerfile api', () => {
  it('getUserDockerfile unwraps { content }', async () => {
    stub({ content: 'ARG BASE_IMAGE\n' })
    expect(await getUserDockerfile()).toBe('ARG BASE_IMAGE\n')
  })

  it('saveUserDockerfile PUTs { content } to /config/user-dockerfile', async () => {
    const fetchMock = stub({ content: '' })
    await saveUserDockerfile('')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/config/user-dockerfile')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ content: '' })
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  deleteProjectEnvVar,
  getProjectConfig,
  getProjectEnv,
  saveProjectConfig,
  setProjectEnvVar,
  getProjectDockerfile,
  saveProjectDockerfile,
} from '#lib/projectApi'
import {
  getGitIdentity,
  getUserDockerfile,
  saveUserDockerfile,
  setGitIdentity,
} from '#lib/settingsApi'

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

describe('project env api', () => {
  it('getProjectEnv unwraps { vars }', async () => {
    const vars = [{ id: 'a', name: 'K', secret: true, hasValue: true, rule: { hosts: ['a.com'] } }]
    const fetchMock = stub({ vars })
    expect(await getProjectEnv('demo')).toEqual(vars)
    expect(fetchMock.mock.calls[0][0] as string).toBe('/project/demo/env')
  })

  it('setProjectEnvVar PUTs the variable and unwraps { var }', async () => {
    const saved = { id: 'a', name: 'K', secret: false, hasValue: true, value: 'v' }
    const fetchMock = stub({ var: saved })
    expect(await setProjectEnvVar('demo', { name: 'K', value: 'v', secret: false })).toEqual(saved)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/project/demo/env')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'K', value: 'v', secret: false })
  })

  it('deleteProjectEnvVar DELETEs by id', async () => {
    const fetchMock = stub(null, 204)
    await deleteProjectEnvVar('demo', 'row-id')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/project/demo/env/row-id')
    expect(init.method).toBe('DELETE')
  })
})

describe('git identity api', () => {
  it('getGitIdentity unwraps { identity }, null included', async () => {
    stub({ identity: null })
    expect(await getGitIdentity()).toBeNull()
    stub({ identity: { name: 'Ada', email: 'ada@example.com' } })
    expect(await getGitIdentity()).toEqual({ name: 'Ada', email: 'ada@example.com' })
  })

  it('setGitIdentity PUTs both halves', async () => {
    const fetchMock = stub({ identity: { name: 'Ada', email: 'ada@example.com' } })
    await setGitIdentity({ name: 'Ada', email: 'ada@example.com' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/config/git-identity')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Ada', email: 'ada@example.com' })
  })
})

describe('project config / dockerfile api', () => {
  it('getProjectConfig GETs the config route and unwraps { config }', async () => {
    const fetchMock = stub({ config: { initCommands: ['pnpm install'] } })
    expect(await getProjectConfig('demo')).toEqual({ initCommands: ['pnpm install'] })
    expect(fetchMock.mock.calls[0][0] as string).toBe('/project/demo/config')
  })

  it('saveProjectConfig PUTs { config } and unwraps the result', async () => {
    const fetchMock = stub({ config: { initCommands: ['pnpm build'] } })
    expect(await saveProjectConfig('demo', { initCommands: ['pnpm build'] })).toEqual({ initCommands: ['pnpm build'] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/project/demo/config')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ config: { initCommands: ['pnpm build'] } })
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

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { configDockerfile, configUserDockerfile } from '#commands/config-dockerfile'
import { serveProjects, startFakeApi, type FakeApi } from './fake-api'

/**
 * The Dockerfile commands against a fake server: each prints what is
 * stored, or replaces it from a file, stdin or nothing.
 */
let api: FakeApi
let scratch: string
let logged: string[]
let errors: string[]
let written: string[]

beforeAll(async () => {
  api = await startFakeApi()
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-config-dockerfile-'))
  vi.stubEnv('YAAC_SERVER_URL', api.url)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await api.close()
  await fs.rm(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  api.reset()
  logged = []
  errors = []
  written = []
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { errors.push(String(msg)) })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  })
  serveProjects(api, [['id-demo', 'demo']])
})

afterEach(() => {
  vi.restoreAllMocks()
})

const sent = (route: string): unknown[] => api.requests.filter((r) => r.route === route).map((r) => r.body)

describe('configDockerfile', () => {
  const GET = 'GET /api/project/id-demo/dockerfile'
  const PUT = 'PUT /api/project/id-demo/dockerfile'

  it('prints it verbatim, or says there is none', async () => {
    api.on(GET, { json: { content: 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n' } })
    await configDockerfile('demo', {})
    expect(written.join('')).toBe('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n')
    api.on(GET, { json: { content: '' } })
    await configDockerfile('demo', {})
    expect(errors).toEqual(['demo has no Dockerfile.yaac; its workspaces run the default image.'])
    expect(sent(PUT)).toEqual([])
  })

  it('replaces it from a file or stdin, clears it with --none, and refuses both at once', async () => {
    api.on(PUT, {})
    const file = path.join(scratch, 'Dockerfile')
    await fs.writeFile(file, 'RUN true\n')
    await configDockerfile('demo', { file })
    const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['RUN from-stdin\n']) as typeof process.stdin)
    await configDockerfile('demo', { file: '-' })
    stdin.mockRestore()
    await configDockerfile('demo', { none: true })
    expect(sent(PUT)).toEqual([{ content: 'RUN true\n' }, { content: 'RUN from-stdin\n' }, { content: '' }])
    expect(logged.at(-1)).toMatch(/^Cleared demo's Dockerfile.yaac/)

    await expect(configDockerfile('demo', { file, none: true })).rejects.toThrow('Pass --file or --none, not both.')
    await expect(configDockerfile('demo', { file: path.join(scratch, 'missing') })).rejects.toThrow(/^Cannot read .*missing/)
    expect(sent(PUT)).toHaveLength(3)
  })
})

describe('configUserDockerfile', () => {
  const PUT = 'PUT /api/config/user-dockerfile'

  it('prints it, and saves a replacement over the config route, showing the server\'s refusal', async () => {
    api.on('GET /api/config/user-dockerfile', { json: { content: '' } })
    await configUserDockerfile({})
    expect(errors).toEqual(['You have no Dockerfile.user.'])

    const file = path.join(scratch, 'Dockerfile.user')
    await fs.writeFile(file, 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN true\n')
    api.on(PUT, {})
    await configUserDockerfile({ file })
    expect(sent(PUT)).toEqual([{ content: 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN true\n' }])

    api.on(PUT, { status: 400, json: { error: { code: 'VALIDATION', message: 'user Dockerfile must be layered' } } })
    await fs.writeFile(file, 'FROM scratch\n')
    await expect(configUserDockerfile({ file })).rejects.toThrow('must be layered')
  })
})

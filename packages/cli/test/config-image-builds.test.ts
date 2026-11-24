import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { configBuildConcurrency, configImageCacheDays } from '#commands/config-image-builds'
import { ME, serveProjects, startFakeApi, type FakeApi } from './fake-api'

/*
 * `yaac config build-concurrency` and `yaac config image-cache-days`
 * against a fake server: what each prints, what it sends, and the values
 * it refuses before asking the server anything.
 */
let api: FakeApi
let logged: string[]

beforeAll(async () => {
  api = await startFakeApi()
  vi.stubEnv('YAAC_SERVER_URL', api.url)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await api.close()
})

beforeEach(() => {
  api.reset()
  logged = []
  vi.spyOn(console, 'log').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
  serveProjects(api, [['id-demo', 'demo']])
})

afterEach(() => {
  vi.restoreAllMocks()
})

const sent = (route: string): unknown[] => api.requests.filter((r) => r.route === route).map((r) => r.body)

/** A value or option combination the CLI refuses, and the message. */
const refusals: Array<[string | undefined, { none?: boolean }, string]> = [
  ['0', {}, '0 is not a whole number of'],
  ['-1', {}, '-1 is not a whole number of'],
  ['2.5', {}, '2.5 is not a whole number of'],
  ['many', {}, 'many is not a whole number of'],
  ['3', { none: true }, 'or --none, not both'],
]

describe('configBuildConcurrency', () => {
  it('prints the install\'s concurrency, sets it, and returns it to the default with --none', async () => {
    api.on('GET /api/image/settings', { json: { buildConcurrency: 2 } })
    api.on('PUT /api/image/settings', (req) => {
      const n = (req.body as { buildConcurrency: number | null }).buildConcurrency
      return { json: { buildConcurrency: n ?? 2 } }
    })
    await configBuildConcurrency(undefined, {})
    await configBuildConcurrency('6', {})
    await configBuildConcurrency(undefined, { none: true })
    expect(sent('PUT /api/image/settings')).toEqual([{ buildConcurrency: 6 }, { buildConcurrency: null }])
    expect(logged).toEqual([
      'The server runs up to 2 image builds at once.',
      'The server now runs up to 6 image builds at once.',
      'The server now runs up to 2 image builds at once.',
    ])
  })

  it.each(refusals)('refuses %s %o without asking the server', async (value, opts, message) => {
    await expect(configBuildConcurrency(value, opts)).rejects.toThrow(message)
    expect(api.requests).toEqual([])
  })
})

describe('configImageCacheDays', () => {
  it('prints the project\'s age or the default, sets days, and returns to the default with --none', async () => {
    api.on('PUT /api/image/project/id-demo/cache-days', {})
    await configImageCacheDays('demo', undefined, {})
    await configImageCacheDays('demo', '7', {})
    await configImageCacheDays('demo', undefined, { none: true })
    api.on('GET /api/project/list', { json: [{ id: 'id-demo', name: 'demo', owner: ME, repos: [], imageCacheDays: 7 }] })
    await configImageCacheDays('demo', undefined, {})
    expect(sent('PUT /api/image/project/id-demo/cache-days')).toEqual([{ days: 7 }, { days: null }])
    expect(logged).toEqual([
      'demo\'s image builds reuse cached steps up to 28 days old (the default).',
      'demo\'s image builds now reuse cached steps up to 7 days old.',
      'demo\'s image builds now reuse cached steps up to 28 days old (the default).',
      'demo\'s image builds reuse cached steps up to 7 days old.',
    ])
  })

  it.each(refusals)('refuses %s %o without writing', async (value, opts, message) => {
    await expect(configImageCacheDays('demo', value, opts)).rejects.toThrow(message)
    expect(api.requests.filter((r) => r.route.startsWith('PUT '))).toEqual([])
  })
})

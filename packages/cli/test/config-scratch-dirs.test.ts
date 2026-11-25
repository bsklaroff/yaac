import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { configScratchDirs } from '#commands/config-scratch-dirs'
import type { ScratchDirSettings } from '@yaac/shared/types'
import { ME, serveProjects, startFakeApi, type FakeApi } from './fake-api'

/*
 * `yaac config scratch-dirs` against a fake server: what the command refuses
 * before asking it anything, and the change it sends. The PUT answers the
 * settings it was sent laid over the stored ones, as the server does.
 */
let api: FakeApi
let logged: string[]
let stored: ScratchDirSettings

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
  stored = { dirs: [{ path: 'node_modules' }, { path: 'target' }], sizeGiB: 32, ignoredTracked: [] }
  serveProjects(api, [['id-demo', 'demo']])
  api.on('GET /api/project/list', () => ({ json: [{ id: 'id-demo', name: 'demo', owner: ME, repos: [], scratchDirs: stored }] }))
  api.on('PUT /api/project/id-demo/scratch-dirs', (req) => {
    stored = { ...stored, ...req.body as Partial<ScratchDirSettings> }
    return { json: stored }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const puts = (): unknown[] => api.requests.filter((r) => r.route.startsWith('PUT ')).map((r) => r.body)

describe('configScratchDirs', () => {
  it('shows the dirs, their size and the tracked ones it does not warn about', async () => {
    await configScratchDirs('demo', [], {})
    stored = { dirs: [], sizeGiB: 8, ignoredTracked: ['vendor', 'target'] }
    await configScratchDirs('demo', [], {})
    expect(logged).toEqual([
      'Scratch directories in demo: node_modules, target, holding at most 32 GiB together',
      'Scratch directories in demo: none, holding at most 8 GiB together',
      'Not warned about when tracked in git: vendor, target',
    ])
    expect(puts()).toEqual([])
  })

  it('sends only the parts it is given', async () => {
    await configScratchDirs('demo', ['web/node_modules'], {})
    await configScratchDirs('demo', [], { size: '48' })
    await configScratchDirs('demo', ['target', 'vendor'], { size: '1' })
    await configScratchDirs('demo', [], { none: true, size: '1024' })
    await configScratchDirs('demo', [], { none: true })
    expect(puts()).toEqual([
      { dirs: [{ path: 'web/node_modules' }] },
      // A size alone leaves the dirs as they are.
      { sizeGiB: 48 },
      { dirs: [{ path: 'target' }, { path: 'vendor' }], sizeGiB: 1 },
      { dirs: [], sizeGiB: 1024 },
      { dirs: [] },
    ])
    expect(logged).toEqual([
      'Scratch directories in demo are now: web/node_modules, holding at most 32 GiB together. Workspaces pick this up when they next start.',
      'Scratch directories in demo are now: web/node_modules, holding at most 48 GiB together. Workspaces pick this up when they next start.',
      'Scratch directories in demo are now: target, vendor, holding at most 1 GiB together. Workspaces pick this up when they next start.',
      'Scratch directories in demo are now: none, holding at most 1024 GiB together. Workspaces pick this up when they next start.',
      'Scratch directories in demo are now: none, holding at most 1024 GiB together. Workspaces pick this up when they next start.',
    ])
  })

  it('refuses dirs with --none, and a size that is not a whole number of GiB from 1 to 1024, sending nothing', async () => {
    await expect(configScratchDirs('demo', ['target'], { none: true })).rejects.toThrow('Pass directories or --none, not both.')
    await expect(configScratchDirs('demo', ['target'], { none: true, size: '8' })).rejects.toThrow('not both')
    // `path:GiB` would be stored as a dir of that name.
    await expect(configScratchDirs('demo', ['node_modules', 'target:32'], {})).rejects.toThrow('target:32: scratch dirs share one size, set with --size.')
    for (const bad of ['0', '1025', '1.5', '-3', 'abc', '', '1e2', '0x10', ' 8 ']) {
      await expect(configScratchDirs('demo', [], { size: bad }), bad)
        .rejects.toThrow('--size takes a whole number of GiB, from 1 to 1024.')
      await expect(configScratchDirs('demo', ['target'], { size: bad }), bad).rejects.toThrow('--size takes')
    }
    expect(puts()).toEqual([])
  })
})

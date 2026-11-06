import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { siteDeploy, siteEdit } from '#commands/site'
import type { SiteDetail } from '@yaac/shared/types'
import { serveProjects, startFakeApi, type FakeApi } from './fake-api'

/*
 * `yaac site deploy` and `site edit` against a fake server: what they send,
 * and how `--wait` reads the site until its deploy ends.
 */
let api: FakeApi
let logged: string[]

const SITE: SiteDetail = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'web',
  hostname: 'app.example.com',
  port: 3000,
  steps: { server: { run: ['pnpm start'], service: true } },
  createdAt: '2026-11-01T00:00:00.000Z',
  releases: [],
}

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
  process.exitCode = undefined
  serveProjects(api, [['id-demo', 'demo']])
  api.on('POST /api/site/deploy', { json: { workspaceId: 'ws-new', commit: 'abcdef1234567890' } })
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

/** Answer `/site/show` with each of `answers` in turn, then the last. */
function showInTurn(...answers: SiteDetail[]): void {
  let i = 0
  api.on('GET /api/site/show', () => ({ json: answers[Math.min(i++, answers.length - 1)] }))
}

const deploying = (phase: 'building' | 'starting'): SiteDetail => ({
  ...SITE, deploy: { workspaceId: 'ws-new', commit: 'abcdef1234567890', startedAt: SITE.createdAt, phase },
})
const finished = (outcome: 'succeeded' | 'failed', error?: string): SiteDetail => ({
  ...SITE,
  lastDeploy: { workspaceId: 'ws-new', commit: 'abcdef1234567890', outcome, finishedAt: SITE.createdAt, ...(error ? { error } : {}) },
})

describe('siteDeploy', () => {
  it('sends --ref and --timeout, and --wait prints each phase until the deploy succeeds', async () => {
    // Two polls apart, so this case waits out two of its 2s intervals.
    showInTurn(deploying('building'), deploying('starting'), finished('succeeded'))
    await siteDeploy('demo', 'web', { ref: 'main', timeout: '1h', wait: true })

    expect(api.requests.find((r) => r.route === 'POST /api/site/deploy')?.body)
      .toEqual({ project: 'id-demo', name: 'web', ref: 'main', timeoutMinutes: 60 })
    expect(logged).toEqual([
      'Deploying abcdef1 to site "web" in release ws-new.',
      '  building',
      '  starting',
      'Deployed: https://app.example.com serves abcdef1.',
    ])
    expect(process.exitCode).toBeUndefined()
  })

  it('exits 1 with the error of a failed deploy, and when the outcome is another deploy\'s', async () => {
    showInTurn(finished('failed', 'step build failed'))
    await siteDeploy('demo', 'web', { wait: true })
    expect(logged.at(-1)).toContain('The deploy failed: step build failed.')
    expect(process.exitCode).toBe(1)

    process.exitCode = undefined
    showInTurn({ ...finished('succeeded'), lastDeploy: { ...finished('succeeded').lastDeploy!, workspaceId: 'ws-other' } })
    await siteDeploy('demo', 'web', { wait: true })
    expect(logged.at(-1)).toContain('without an outcome')
    expect(process.exitCode).toBe(1)
  })
})

describe('siteEdit', () => {
  it('sends only the options given, --no-admin-port, --no-volume and --no-follow as null, and refuses none or a bad port', async () => {
    api.on('POST /api/site/edit', {})
    await siteEdit('demo', 'web', { port: '8080', adminPort: false, volume: false, follow: false })
    expect(api.requests.find((r) => r.route === 'POST /api/site/edit')?.body)
      .toEqual({ project: 'id-demo', name: 'web', port: 8080, adminPort: null, volume: null, followBranch: null })
    api.reset()
    serveProjects(api, [['id-demo', 'demo']])
    api.on('POST /api/site/edit', {})
    await siteEdit('demo', 'web', { adminPort: '3001' })
    expect(api.requests.find((r) => r.route === 'POST /api/site/edit')?.body)
      .toEqual({ project: 'id-demo', name: 'web', adminPort: 3001 })
    await expect(siteEdit('demo', 'web', {})).rejects.toThrow('Nothing to change')
    await expect(siteEdit('demo', 'web', { port: '80a' })).rejects.toThrow('--port takes a port number')
    await expect(siteEdit('demo', 'web', { adminPort: '0' })).rejects.toThrow('--admin-port takes a port number')
  })
})

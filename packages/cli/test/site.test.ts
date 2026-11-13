import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { siteCreate, siteDeploy, siteEdit } from '#commands/site'
import type { SiteDetail } from '@yaac/shared/types'
import { serveProjects, startFakeApi, type FakeApi } from './fake-api'

/*
 * `yaac site create`, `deploy` and `edit` against a fake server: what they
 * send, what create says to do next for each edge, and how `--wait` reads
 * the site until its deploy ends.
 */
let api: FakeApi
let logged: string[]

const SITE: SiteDetail = {
  name: 'web',
  workflow: 'web',
  hostname: 'app.example.com',
  edge: 'public',
  port: 3000,
  steps: { server: { run: ['pnpm start'], service: true } },
  repos: [{ dir: 'demo', branch: 'main' }],
  follow: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  releases: [],
}
const COMMITS = [{ dir: '', commit: 'abcdef1234567890' }]

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
  api.on('POST /api/site/deploy', { json: { workspaceId: 'ws-new', commits: COMMITS } })
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
  ...SITE, deploy: { workspaceId: 'ws-new', commits: COMMITS, startedAt: SITE.createdAt, phase },
})
const finished = (outcome: 'succeeded' | 'failed', error?: string): SiteDetail => ({
  ...SITE,
  lastDeploy: { workspaceId: 'ws-new', commits: COMMITS, outcome, finishedAt: SITE.createdAt, ...(error ? { error } : {}) },
})

describe('siteCreate', () => {
  it('says where a site under the site domain answers and what the tailnet tunnel lacks, and the Cloudflare route for any other', async () => {
    api.on('POST /api/site/create', { json: {} })
    api.on('GET /api/site/edge', { json: { cloudflare: 'connected', tailnet: 'no-certificate', siteDomain: 'apps.example.com' } })
    const opts = { hostname: 'Kanban.apps.example.com', port: '3000', workflow: 'web', repo: ['demo@main'] }
    await siteCreate('demo', 'kanban', opts)
    expect(logged).toEqual([
      'Created site "kanban", a tailnet site: https://kanban.apps.example.com answers only users on this install\'s tailnet.',
      'The tailnet tunnel has no certificate yet: put one for *.apps.example.com in the Secret yaac-site-tunnel-tailnet-tls.',
      'Then publish it with: yaac site deploy demo kanban',
    ])

    logged = []
    await siteCreate('demo', 'web', { ...opts, hostname: 'app.example.com' })
    expect(logged[0]).toBe('Created site "web", a public site. In Cloudflare, add a public hostname to the install\'s tunnel:')
    expect(logged).toContain('  service   http://yaac-site-router:8080')
  })
})

describe('siteDeploy', () => {
  it('sends --ref and --timeout, and --wait prints each phase until the deploy succeeds', async () => {
    // Two polls apart, so this case waits out two of its 2s intervals.
    showInTurn(deploying('building'), deploying('starting'), finished('succeeded'))
    await siteDeploy('demo', 'web', { ref: ['main'], timeout: '1h', wait: true })

    expect(api.requests.find((r) => r.route === 'POST /api/site/deploy')?.body)
      .toEqual({ project: 'id-demo', name: 'web', ref: 'main', timeoutMinutes: 60 })
    expect(logged).toEqual([
      'Deploying abcdef12 to site "web" in release ws-new.',
      '  building',
      '  starting',
      'Deployed: https://app.example.com serves abcdef12.',
    ])
    expect(process.exitCode).toBeUndefined()
  })

  it('sends a ref per repo as <dir>@<ref>, printing commits per repo', async () => {
    api.on('POST /api/site/deploy', { json: { workspaceId: 'ws-new', commits: [{ dir: 'api', commit: 'a'.repeat(40) }, { dir: 'web', commit: 'b'.repeat(40) }] } })
    await siteDeploy('demo', 'web', { ref: ['api@main', 'web@1234'] })
    expect(api.requests.find((r) => r.route === 'POST /api/site/deploy')?.body)
      .toEqual({ project: 'id-demo', name: 'web', refs: { api: 'main', web: '1234' } })
    expect(logged[0]).toBe(`Deploying api@${'a'.repeat(8)} web@${'b'.repeat(8)} to site "web" in release ws-new.`)
    await expect(siteDeploy('demo', 'web', { ref: ['main', 'dev'] })).rejects.toThrow('one bare --ref')
  })

  it('exits 1 with the error of a failed deploy, and when the outcome is another deploy\'s', async () => {
    showInTurn(finished('failed', 'step build failed'))
    await siteDeploy('demo', 'web', { ref: [], wait: true })
    expect(logged.at(-1)).toContain('The deploy failed: step build failed.')
    expect(process.exitCode).toBe(1)

    process.exitCode = undefined
    showInTurn({ ...finished('succeeded'), lastDeploy: { ...finished('succeeded').lastDeploy!, workspaceId: 'ws-other' } })
    await siteDeploy('demo', 'web', { ref: [], wait: true })
    expect(logged.at(-1)).toContain('without an outcome')
    expect(process.exitCode).toBe(1)
  })
})

describe('siteEdit', () => {
  it('sends only the options given, --no-admin-port and --no-volume as null, and refuses none or a bad port', async () => {
    api.on('POST /api/site/edit', {})
    await siteEdit('demo', 'web', { port: '8080', adminPort: false, volume: false, follow: false, repo: [] })
    expect(api.requests.find((r) => r.route === 'POST /api/site/edit')?.body)
      .toEqual({ project: 'id-demo', name: 'web', port: 8080, adminPort: null, volume: null, follow: false })
    api.reset()
    serveProjects(api, [['id-demo', 'demo']])
    api.on('POST /api/site/edit', {})
    await siteEdit('demo', 'web', { adminPort: '3001', repo: ['web@main', `api@${'c'.repeat(40)}`], follow: true })
    expect(api.requests.find((r) => r.route === 'POST /api/site/edit')?.body).toEqual({
      project: 'id-demo', name: 'web', adminPort: 3001, follow: true,
      repos: [{ repo: 'web', branch: 'main' }, { repo: 'api', commit: 'c'.repeat(40) }],
    })
    await expect(siteEdit('demo', 'web', { repo: [] })).rejects.toThrow('Nothing to change')
    await expect(siteEdit('demo', 'web', { port: '80a', repo: [] })).rejects.toThrow('--port takes a port number')
    await expect(siteEdit('demo', 'web', { adminPort: '0', repo: [] })).rejects.toThrow('--admin-port takes a port number')
    // Every repo names a branch or commit, and a site keeps at least one.
    await expect(siteEdit('demo', 'web', { repo: ['web'] })).rejects.toThrow('--repo takes <dir>@<branch or full commit>')
    await expect(siteEdit('demo', 'web', { repo: [], repos: false })).rejects.toThrow('at least one repo')
  })
})

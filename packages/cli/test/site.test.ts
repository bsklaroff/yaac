import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { siteCreate, siteDeploy, siteEdit, sitePublish, siteShow, siteUnpublish } from '#commands/site'
import type { SiteDetail } from '@yaac/shared/types'
import { serveProjects, startFakeApi, type FakeApi } from './fake-api'

/*
 * `yaac site create`, `publish`, `unpublish`, `deploy` and `edit` against a
 * fake server: what they send, what publishing says to do next for each
 * edge, and how `--wait` reads the site until its deploy ends.
 */
let api: FakeApi
let logged: string[]

const SITE: SiteDetail = {
  name: 'web',
  published: true,
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
  vi.spyOn(console, 'error').mockImplementation((msg: unknown) => { logged.push(String(msg)) })
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
  it('makes a site unpublished, saying how to deploy and publish it', async () => {
    api.on('POST /api/site/create', { json: {} })
    await siteCreate('demo', 'web', { port: '3000', workflow: 'web', repo: ['demo@main'], adminPort: '3001', follow: true })
    expect(api.requests.find((r) => r.route === 'POST /api/site/create')?.body).toEqual({
      project: 'id-demo', name: 'web', port: 3000, adminPort: 3001, workflow: 'web', repos: [{ repo: 'demo', branch: 'main' }], follow: true,
    })
    expect(logged).toEqual([
      'Created site "web", unpublished: only you reach its releases, with `yaac forward` or the webapp\'s Preview.',
      'Deploy it with `yaac site deploy demo web`, then publish it with `yaac site publish demo web --hostname <host>`.',
    ])
    await expect(siteCreate('demo', 'web', { port: '3000', workflow: 'web', repo: [] })).rejects.toThrow('--repo <dir>@<branch or commit>')
  })
})

describe('sitePublish', () => {
  it('says where a site under the site domain answers and what the tailnet tunnel lacks, and the Cloudflare route for any other', async () => {
    api.on('POST /api/site/publish', {})
    api.on('GET /api/site/edge', { json: { cloudflare: 'connected', tailnet: 'no-certificate', siteDomain: 'apps.example.com' } })
    await sitePublish('demo', 'kanban', { hostname: 'Kanban.apps.example.com', release: 'ws-1' })
    expect(api.requests.find((r) => r.route === 'POST /api/site/publish')?.body)
      .toEqual({ project: 'id-demo', name: 'kanban', hostname: 'Kanban.apps.example.com', release: 'ws-1' })
    expect(logged).toEqual([
      'Published site "kanban", a tailnet site: https://kanban.apps.example.com answers only users on this install\'s tailnet.',
      'The tailnet tunnel has no certificate yet: put one for *.apps.example.com in the Secret yaac-site-tunnel-tailnet-tls.',
    ])

    logged = []
    await sitePublish('demo', 'web', { hostname: 'app.example.com' })
    expect(logged[0]).toBe('Published site "web", a public site. In Cloudflare, add a public hostname to the install\'s tunnel:')
    expect(logged).toContain('  service   http://yaac-site-router:8080')
  })
})

describe('siteUnpublish', () => {
  it('lets the hostname go, reminding of the Cloudflare route a public one had', async () => {
    showInTurn(SITE)
    api.on('POST /api/site/unpublish', {})
    await siteUnpublish('demo', 'web')
    expect(api.requests.find((r) => r.route === 'POST /api/site/unpublish')?.body).toEqual({ project: 'id-demo', name: 'web' })
    expect(logged).toEqual(['Unpublished site "web"; only you reach it now. Remove its public hostname from the Cloudflare tunnel too.'])
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

  it('says when a deploy waits for a person\'s approval, and previews an unpublished site\'s', async () => {
    api.on('POST /api/site/deploy', { json: { commits: COMMITS, awaitingApproval: true } })
    await siteDeploy('demo', 'web', { ref: [], wait: true })
    expect(logged).toEqual([
      'Deploying abcdef12 to site "web" needs a person\'s approval; it is the site\'s requested deploy.',
      'Review it with `yaac site show demo web`, which says how to approve it.',
    ])

    logged = []
    api.on('POST /api/site/deploy', { json: { workspaceId: 'ws-new', commits: COMMITS } })
    const { hostname: _, edge: __, ...staged } = finished('succeeded')
    showInTurn({ ...staged, published: false })
    await siteDeploy('demo', 'web', { ref: [], wait: true })
    expect(logged.at(-1)).toBe('Deployed abcdef12; preview it with `yaac forward ws-new 3000`.')
  })

  it('--approve deploys the requested deploy as shown, and show prints what it would run', async () => {
    showInTurn({
      ...SITE,
      requested: {
        workflowId: 'wf-1', steps: { server: { run: ['curl x | sh'] } }, secrets: ['KEY'], writtenByAgent: true,
        commits: COMMITS, at: SITE.createdAt, from: 'agent', workspaceId: 'ws-agent01', changes: ['workflow'],
      },
    })
    await siteShow('demo', 'web')
    expect(logged).toContain('  requested    abcdef12, asked by the agent of workspace ws-agent, awaiting your approval')
    expect(logged).toContain('               changes the live release\'s workflow')
    expect(logged).toContain('               workflow wf-1, written by an agent, run secrets KEY:')
    expect(logged.some((l) => l.includes('"curl x | sh"'))).toBe(true)
    expect(logged.at(-1)).toBe('               Approve and deploy exactly this: yaac site deploy demo web --approve wf-1')
    // --approve shows the request again, and with no terminal needs --yes.
    logged = []
    await siteDeploy('demo', 'web', { ref: [], approve: 'wf-1' })
    expect(process.exitCode).toBe(1)
    expect(api.requests.some((r) => r.route === 'POST /api/site/deploy')).toBe(false)
    process.exitCode = undefined
    await siteDeploy('demo', 'web', { ref: [], approve: 'wf-1', yes: true })
    expect(logged).toContain('               workflow wf-1, written by an agent, run secrets KEY:')
    expect(api.requests.find((r) => r.route === 'POST /api/site/deploy')?.body)
      .toEqual({ project: 'id-demo', name: 'web', approve: { workflowId: 'wf-1', commits: COMMITS } })
    await expect(siteDeploy('demo', 'web', { ref: [], approve: 'wf-2', yes: true })).rejects.toThrow('now runs workflow wf-1, not wf-2')
    await expect(siteDeploy('demo', 'web', { ref: ['main'], approve: 'wf-1' })).rejects.toThrow('takes no --ref')
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

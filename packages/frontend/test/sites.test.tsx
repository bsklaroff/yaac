import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { ProjectSummary, SiteEdgeStatus, SiteEntry, VolumeEntry, WorkflowEntry } from '@yaac/shared/types'
import { Sites } from '#components/settings/Sites'
import {
  TEST_USER_ID, TEST_WHOAMI, mockFetch, projectRepo, renderWithClient, serverError, serverSnapshot, testQueryClient, type FetchCall,
  type FetchMock,
} from './harness'

/*
 * A project's public sites in its settings (docs/public-sites.md): the
 * install's edge, each site's release lines, and creating, editing,
 * deploying, stopping, starting and deleting one. A release's own
 * workspace view is in workspace-view-steps, its sidebar row in
 * workspace-list.
 */

const LIST = 'GET /api/site/list'
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const SERVE = { server: { run: ['pnpm start'], service: true } }
const commits = (commit: string) => [{ dir: '', commit }]
/** The project the sites belong to, of two repos. */
const PROJECT: ProjectSummary = {
  id: 'proj', name: 'proj', addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {},
  createDefaults: {}, repos: [projectRepo({ id: 'r-web', dir: 'web' }), projectRepo({ id: 'r-api', dir: 'api' })],
  scratchDirs: { dirs: [], ignoredTracked: [] }, portForwards: [], cacheVolumes: {}, nestedContainers: false, npmCache: true,
}

let sites: SiteEntry[]
let workflows: WorkflowEntry[]
let edge: SiteEdgeStatus
let server: FetchMock
const site = (name: string): SiteEntry => sites.find((s) => s.name === name) as SiteEntry
beforeEach(() => {
  edge = { tunnel: 'connected' }
  sites = [
    {
      name: 'web', hostname: 'app.example.com', port: 3000, adminPort: 3001, workflow: 'release', steps: SERVE, volume: 'db',
      repos: [{ dir: 'web', branch: 'main' }, { dir: 'api', commit: 'c'.repeat(40) }], follow: false, createdAt: ago(60),
      live: {
        workspaceId: 'w-live0001', commits: [{ dir: 'api', commit: 'c'.repeat(40) }, { dir: 'web', commit: 'abcdef1234567' }],
        since: ago(5), running: true,
      },
      lastDeploy: {
        workspaceId: 'w-fail0001', commits: commits('9876543210'), outcome: 'failed', error: 'step "build" failed (exit 2)',
        finishedAt: ago(2),
      },
    },
    {
      name: 'docs', hostname: 'docs.example.com', port: 8080, workflow: 'release', steps: SERVE, createdAt: ago(60),
      repos: [{ dir: 'web', branch: 'docs' }], follow: true,
      lastDeploy: { workspaceId: 'w-docs0001', commits: commits('1111111222'), outcome: 'succeeded', finishedAt: ago(90) },
    },
  ]
  const volumes: VolumeEntry[] = [{ name: 'db', size: '5Gi', createdAt: '', stoppedWorkspaces: [] }]
  const workflow = (name: string, steps: WorkflowEntry['steps']): WorkflowEntry => ({
    id: `wf-${name}`, projectId: 'proj', name, steps, secrets: [], repos: [], init: false, approvedCommits: [], approvedBranches: [], createdAt: '',
  })
  workflows = [workflow('release', SERVE), workflow('preview', SERVE), workflow('lint', { lint: { run: ['pnpm lint'] } })]
  // A server that keeps its sites in `sites`, and refuses a workflow with no
  // service step as the real one does.
  server = mockFetch({
    [LIST]: () => sites,
    'GET /api/site/edge': () => edge,
    'GET /api/volume/list': volumes,
    'GET /api/workflow/list': () => workflows,
    'GET /api/repo/r-web/branches': { branches: ['main', 'dev'], defaultBranch: 'main' },
    'GET /api/repo/r-api/branches': { branches: ['main'], defaultBranch: 'main' },
    'POST /api/site/create': ({ body }: FetchCall) => {
      const { name, hostname, port, workflow: wf, volume, follow } = body as SiteEntry
      const { steps } = workflows.find((w) => w.name === wf) as WorkflowEntry
      if (!Object.values(steps).some((s) => s.service === true)) {
        return serverError('VALIDATION', `workflow "${wf}" has no service step`, 400)
      }
      sites = [...sites, { name, hostname, port, workflow: wf, steps, ...(volume !== undefined ? { volume } : {}), repos: [], follow, createdAt: '' }]
      return undefined
    },
    'POST /api/site/edit': () => undefined,
    'POST /api/site/deploy': ({ body }: FetchCall) => {
      const { name } = body as { name: string }
      site(name).deploy = { workspaceId: 'w-new00001', commits: commits('fedcba9876'), startedAt: ago(0), phase: 'building' }
      return { workspaceId: 'w-new00001', commits: commits('fedcba9876') }
    },
    'POST /api/site/stop': ({ body }: FetchCall) => {
      delete site((body as { name: string }).name).live
      return undefined
    },
    'POST /api/site/start': ({ body }: FetchCall) => {
      site((body as { name: string }).name).deploy = {
        workspaceId: 'w-start001', commits: commits('1111111222'), startedAt: ago(0), phase: 'launching',
      }
      return { workspaceId: 'w-start001', commits: commits('1111111222') }
    },
    'POST /api/site/delete': ({ body }: FetchCall) => {
      sites = sites.filter((s) => s.name !== (body as { name: string }).name)
      return undefined
    },
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const client = () => testQueryClient(undefined, serverSnapshot({ driver: 'k8s' }))
/** The caller as a member: `TEST_WHOAMI` is an admin. */
const MEMBER = { ...TEST_WHOAMI, users: [{ ...TEST_WHOAMI.users[0], role: 'member' as const }] }
const row = (hostname: string): string | null | undefined => screen.getByText(hostname).closest('.rounded-md')?.textContent
const dialog = () => within(screen.getByRole('alertdialog'))

describe('Sites settings', () => {
  it('shows the edge and each site\'s releases, and deploys, stops, starts and deletes', async () => {
    renderWithClient(<Sites project={PROJECT} readOnly={false} />, client())
    expect(await screen.findByText('app.example.com')).toBeTruthy()
    expect(server.called(LIST)[0].query.get('project')).toBe('proj')
    expect(await screen.findByText('Cloudflare tunnel connected')).toBeTruthy()
    expect(screen.getByText('app.example.com').getAttribute('href')).toBe('https://app.example.com')
    expect(row('app.example.com')).toBe(`webapp.example.com:3000 · admin :3001 · db · web@main api@${'c'.repeat(8)}DeployStopEdit`
      + `Live api@${'c'.repeat(8)} web@abcdef12 · running, deployed 5m ago`
      + 'Last deploy 98765432 failed 2m ago: step "build" failed (exit 2)')
    expect(row('docs.example.com')).toBe('docsdocs.example.com:8080 · web@docs · followsDeployStartEdit'
      + 'Not servingLast deploy 11111112 succeeded 1h ago')

    // Deploy a ref per repo; while it runs the site offers no second one.
    fireEvent.click(screen.getAllByRole('button', { name: 'Deploy' })[0])
    fireEvent.change(dialog().getByLabelText('Ref to deploy web at'), { target: { value: ' v2 ' } })
    expect(dialog().getByLabelText('Ref to deploy api at')).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Deploy' }))
    expect(await screen.findByText(/^Deploying/)).toBeTruthy()
    expect(server.called('POST /api/site/deploy')[0].body).toEqual({ project: 'proj', name: 'web', refs: { web: 'v2' } })
    expect(row('app.example.com')).toContain('Deploying fedcba98 · building')
    expect(screen.getAllByRole('button', { name: 'Deploy' })).toHaveLength(1)

    // Stop asks first.
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(dialog().getByText(/hostname answers 503/)).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(row('app.example.com')).toContain('Not serving'))

    // Start does not, and shows the replacement's deploy.
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(row('docs.example.com')).toContain('Deploying 11111112 · creating release'))
    expect(server.called('POST /api/site/start')[0].body).toEqual({ project: 'proj', name: 'docs' })

    // Delete says it stops the site's releases.
    fireEvent.click(screen.getByRole('button', { name: 'Delete site docs' }))
    expect(dialog().getByText(/stops the site’s releases/)).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('docs.example.com')).toBeNull())
    expect(server.called('POST /api/site/delete')[0].body).toEqual({ project: 'proj', name: 'docs' })
  })

  it('creates a site running a workflow, showing the server\'s refusal, then says what to set in Cloudflare', async () => {
    renderWithClient(<Sites project={PROJECT} readOnly={false} />, client())
    fireEvent.click(await screen.findByRole('button', { name: 'New site' }))
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'api' } })
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'api.example.com' } })
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '4000' } })
    fireEvent.change(screen.getByLabelText('Admin port'), { target: { value: '4001' } })
    await screen.findByRole('option', { name: 'db' })
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: 'db' } })

    // A site needs a workflow and a repo before it can be created.
    const create = screen.getByRole<HTMLButtonElement>('button', { name: 'Create' })
    expect(create.disabled).toBe(true)
    await screen.findByRole('option', { name: 'Workflow lint' })
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'lint' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include web' }))
    fireEvent.change(screen.getByLabelText('Branch or commit of web'), { target: { value: 'main' } })
    fireEvent.click(create)
    expect(await screen.findByText('workflow "lint" has no service step')).toBeTruthy()

    // Its repos: each ticked one names a branch or a full commit, starting
    // empty rather than at origin's default.
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'release' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include api' }))
    expect(screen.getByLabelText<HTMLInputElement>('Branch or commit of api').value).toBe('')
    expect(create.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Branch or commit of api'), { target: { value: 'd'.repeat(40) } })
    fireEvent.click(screen.getByRole('switch', { name: /^Follow/ }))
    fireEvent.click(create)
    expect(await screen.findByRole('link', { name: 'api.example.com' })).toBeTruthy()
    expect(server.called('POST /api/site/create').at(-1)?.body).toEqual({
      project: 'proj', name: 'api', hostname: 'api.example.com', port: 4000, adminPort: 4001, workflow: 'release', volume: 'db',
      repos: [{ repo: 'r-web', branch: 'main' }, { repo: 'r-api', commit: 'd'.repeat(40) }], follow: true,
    })
    expect(screen.queryByLabelText('Site name')).toBeNull()
    expect(screen.getByRole('note').textContent).toContain('add a public hostname api.example.com')
    expect(screen.getByRole('note').textContent).toContain('the router (yaac-site-router, port 8080)')
  })

  it('edits a site, switching its workflow and dropping its admin port and volume', async () => {
    renderWithClient(<Sites project={PROJECT} readOnly={false} />, client())
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0])
    expect(screen.queryByLabelText('Site name')).toBeNull()
    await screen.findByRole('option', { name: 'Workflow preview' })
    expect(screen.getByLabelText<HTMLSelectElement>('Workflow').value).toBe('release')
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'preview' } })
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'www.example.com' } })
    expect(screen.getByLabelText<HTMLInputElement>('Admin port').value).toBe('3001')
    fireEvent.change(screen.getByLabelText('Admin port'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByLabelText('Hostname')).toBeNull())
    expect(server.called('POST /api/site/edit')[0].body).toEqual({
      project: 'proj', name: 'web', hostname: 'www.example.com', port: 3000, adminPort: null, workflow: 'preview', volume: null,
      repos: [{ repo: 'r-web', branch: 'main' }, { repo: 'r-api', commit: 'c'.repeat(40) }], follow: false,
    })
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('points to Workflows when the project has none to run', async () => {
    workflows = []
    renderWithClient(<Sites project={PROJECT} readOnly={false} />, client())
    fireEvent.click(await screen.findByRole('button', { name: 'New site' }))
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'api' } })
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'api.example.com' } })
    expect(await screen.findByText(/^This project has no workflows yet/)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(true)
  })

  it('says how to set up a tunnel on an install without one, and only lists a teammate\'s sites to a member', async () => {
    edge = { tunnel: 'absent' }
    renderWithClient(<Sites project={PROJECT} readOnly />, testQueryClient(MEMBER, serverSnapshot({ driver: 'k8s' })))
    expect((await screen.findByText(/^This install has no tunnel/)).textContent)
      .toContain('CF_TUNNEL_TOKEN=… yaac cluster install.')
    expect(await screen.findByText('app.example.com')).toBeTruthy()
    for (const name of ['Deploy', 'Stop', 'Start', 'Edit', 'New site', 'Delete site web']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('lets an admin stop and delete a teammate\'s site, but not publish it', async () => {
    renderWithClient(<Sites project={PROJECT} readOnly />, client())
    expect(await screen.findByText('app.example.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete site web' })).toBeTruthy()
    for (const name of ['Deploy', 'Start', 'Edit', 'New site']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('lets an owner who is no admin only stop and delete', async () => {
    renderWithClient(<Sites project={PROJECT} readOnly={false} />, testQueryClient(MEMBER, serverSnapshot({ driver: 'k8s' })))
    expect(await screen.findByText('app.example.com')).toBeTruthy()
    expect(screen.getByText(/^Only an admin of this yaac install can publish sites/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete site web' })).toBeTruthy()
    for (const name of ['Deploy', 'Start', 'Edit', 'New site']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('polls the list while a deploy runs, and stops once it ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const poll = (): void => { act(() => { vi.advanceTimersByTime(3000) }) }
    site('web').deploy = { workspaceId: 'w-new00001', commits: commits('fedcba9876'), startedAt: ago(1), phase: 'handoff' }
    renderWithClient(<Sites project={PROJECT} readOnly={false} />, client())
    expect(await screen.findByText(/handing over the volume/)).toBeTruthy()

    site('web').deploy = { workspaceId: 'w-new00001', commits: commits('fedcba9876'), startedAt: ago(1), phase: 'starting' }
    poll()
    await waitFor(() => expect(row('app.example.com')).toContain('Deploying fedcba98 · starting'))

    delete site('web').deploy
    poll()
    await waitFor(() => expect(row('app.example.com')).not.toContain('Deploying'))
    const fetches = server.called(LIST).length
    poll()
    poll()
    expect(server.called(LIST)).toHaveLength(fetches)
  })
})

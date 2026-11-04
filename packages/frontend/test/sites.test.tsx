import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { SiteEdgeStatus, SiteEntry, VolumeEntry } from '@yaac/shared/types'
import { Sites } from '#components/settings/Sites'
import {
  mockFetch, renderWithClient, serverError, serverSnapshot, testQueryClient, type FetchCall, type FetchMock,
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

let sites: SiteEntry[]
let edge: SiteEdgeStatus
let server: FetchMock
const site = (name: string): SiteEntry => sites.find((s) => s.name === name) as SiteEntry
beforeEach(() => {
  edge = { tunnel: 'connected' }
  sites = [
    {
      name: 'web', hostname: 'app.example.com', port: 3000, steps: SERVE, volume: 'db', createdAt: ago(60),
      live: { workspaceId: 'w-live0001', commit: 'abcdef1234567', since: ago(5), running: true },
      lastDeploy: {
        workspaceId: 'w-fail0001', commit: '9876543210', outcome: 'failed', error: 'step "build" failed (exit 2)',
        finishedAt: ago(2),
      },
    },
    {
      name: 'docs', hostname: 'docs.example.com', port: 8080, steps: SERVE, createdAt: ago(60),
      lastDeploy: { workspaceId: 'w-docs0001', commit: '1111111222', outcome: 'succeeded', finishedAt: ago(90) },
    },
  ]
  const volumes: VolumeEntry[] = [{ name: 'db', size: '5Gi', createdAt: '', stoppedWorkspaces: [] }]
  // A server that keeps its sites in `sites`, and refuses steps with no
  // service as the real one does.
  server = mockFetch({
    [LIST]: () => sites,
    'GET /api/site/edge': () => edge,
    'GET /api/volume/list': volumes,
    'POST /api/site/create': ({ body }: FetchCall) => {
      const { name, hostname, port, steps, volume } = body as SiteEntry
      if (!Object.values(steps).some((s) => s.service === true)) {
        return serverError('VALIDATION', 'a site\'s steps need a service step', 400)
      }
      sites = [...sites, { name, hostname, port, steps, ...(volume !== undefined ? { volume } : {}), createdAt: '' }]
      return undefined
    },
    'POST /api/site/edit': () => undefined,
    'POST /api/site/deploy': ({ body }: FetchCall) => {
      const { name } = body as { name: string }
      site(name).deploy = { workspaceId: 'w-new00001', commit: 'fedcba9876', startedAt: ago(0), phase: 'building' }
      return { workspaceId: 'w-new00001', commit: 'fedcba9876' }
    },
    'POST /api/site/stop': ({ body }: FetchCall) => {
      delete site((body as { name: string }).name).live
      return undefined
    },
    'POST /api/site/start': ({ body }: FetchCall) => {
      site((body as { name: string }).name).deploy = {
        workspaceId: 'w-start001', commit: '1111111222', startedAt: ago(0), phase: 'launching',
      }
      return { workspaceId: 'w-start001', commit: '1111111222' }
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
const row = (hostname: string): string | null | undefined => screen.getByText(hostname).closest('.rounded-md')?.textContent
const dialog = () => within(screen.getByRole('alertdialog'))

describe('Sites settings', () => {
  it('shows the edge and each site\'s releases, and deploys, stops, starts and deletes', async () => {
    renderWithClient(<Sites projectId="proj" readOnly={false} />, client())
    expect(await screen.findByText('app.example.com')).toBeTruthy()
    expect(server.called(LIST)[0].query.get('project')).toBe('proj')
    expect(await screen.findByText('Cloudflare tunnel connected')).toBeTruthy()
    expect(screen.getByText('app.example.com').getAttribute('href')).toBe('https://app.example.com')
    expect(row('app.example.com')).toBe('webapp.example.com:3000 · dbDeployStopEdit'
      + 'Live abcdef1 · running, deployed 5m ago'
      + 'Last deploy 9876543 failed 2m ago: step "build" failed (exit 2)')
    expect(row('docs.example.com')).toBe('docsdocs.example.com:8080DeployStartEdit'
      + 'Not servingLast deploy 1111111 succeeded 1h ago')

    // Deploy at a ref; while it runs the site offers no second one.
    fireEvent.click(screen.getAllByRole('button', { name: 'Deploy' })[0])
    fireEvent.change(dialog().getByLabelText('Ref to deploy'), { target: { value: ' v2 ' } })
    fireEvent.click(dialog().getByRole('button', { name: 'Deploy' }))
    expect(await screen.findByText(/^Deploying/)).toBeTruthy()
    expect(server.called('POST /api/site/deploy')[0].body).toEqual({ project: 'proj', name: 'web', ref: 'v2' })
    expect(row('app.example.com')).toContain('Deploying fedcba9 · building')
    expect(screen.getAllByRole('button', { name: 'Deploy' })).toHaveLength(1)

    // Stop asks first.
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(dialog().getByText(/hostname answers 503/)).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(row('app.example.com')).toContain('Not serving'))

    // Start does not, and shows the replacement's deploy.
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(row('docs.example.com')).toContain('Deploying 1111111 · creating release'))
    expect(server.called('POST /api/site/start')[0].body).toEqual({ project: 'proj', name: 'docs' })

    // Delete says it stops the site's releases.
    fireEvent.click(screen.getByRole('button', { name: 'Delete site docs' }))
    expect(dialog().getByText(/stops the site’s releases/)).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('docs.example.com')).toBeNull())
    expect(server.called('POST /api/site/delete')[0].body).toEqual({ project: 'proj', name: 'docs' })
  })

  it('creates a site, checking its steps and showing the server\'s refusal, then says what to set in Cloudflare', async () => {
    renderWithClient(<Sites projectId="proj" readOnly={false} />, client())
    fireEvent.click(await screen.findByRole('button', { name: 'New site' }))
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'api' } })
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'api.example.com' } })
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '4000' } })
    await screen.findByRole('option', { name: 'db' })
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: 'db' } })

    const steps = screen.getByLabelText('Steps')
    const create = screen.getByRole('button', { name: 'Create' })
    fireEvent.change(steps, { target: { value: '{' } })
    fireEvent.click(create)
    expect(await screen.findByText(/^Invalid JSON/)).toBeTruthy()
    fireEvent.change(steps, { target: { value: '[]' } })
    fireEvent.click(create)
    expect(await screen.findByText('Steps must be a JSON object')).toBeTruthy()
    fireEvent.change(steps, { target: { value: '{"build": {"run": "make"}}' } })
    fireEvent.click(create)
    expect(await screen.findByText('a site\'s steps need a service step')).toBeTruthy()

    fireEvent.change(steps, { target: { value: JSON.stringify(SERVE) } })
    fireEvent.click(create)
    expect(await screen.findByRole('link', { name: 'api.example.com' })).toBeTruthy()
    expect(server.called('POST /api/site/create').at(-1)?.body).toEqual({
      project: 'proj', name: 'api', hostname: 'api.example.com', port: 4000, steps: SERVE, volume: 'db',
    })
    expect(screen.queryByLabelText('Site name')).toBeNull()
    expect(screen.getByRole('note').textContent).toContain('add a public hostname api.example.com')
    expect(screen.getByRole('note').textContent).toContain('the router (yaac-site-router, port 8080)')
  })

  it('edits a site, dropping its volume', async () => {
    renderWithClient(<Sites projectId="proj" readOnly={false} />, client())
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0])
    expect(screen.queryByLabelText('Site name')).toBeNull()
    expect(screen.getByLabelText<HTMLTextAreaElement>('Steps').value).toBe(`${JSON.stringify(SERVE, null, 2)}\n`)
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'www.example.com' } })
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByLabelText('Hostname')).toBeNull())
    expect(server.called('POST /api/site/edit')[0].body).toEqual({
      project: 'proj', name: 'web', hostname: 'www.example.com', port: 3000, steps: SERVE, volume: null,
    })
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('says how to set up a tunnel on an install without one, and only lists sites for a teammate', async () => {
    edge = { tunnel: 'absent' }
    renderWithClient(<Sites projectId="proj" readOnly />, client())
    expect((await screen.findByText(/^This install has no tunnel/)).textContent)
      .toContain('CF_TUNNEL_TOKEN=… yaac cluster install.')
    expect(await screen.findByText('app.example.com')).toBeTruthy()
    for (const name of ['Deploy', 'Stop', 'Start', 'Edit', 'New site', 'Delete site web']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('polls the list while a deploy runs, and stops once it ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const poll = (): void => { act(() => { vi.advanceTimersByTime(3000) }) }
    site('web').deploy = { workspaceId: 'w-new00001', commit: 'fedcba9876', startedAt: ago(1), phase: 'handoff' }
    renderWithClient(<Sites projectId="proj" readOnly={false} />, client())
    expect(await screen.findByText(/handing over the volume/)).toBeTruthy()

    site('web').deploy = { workspaceId: 'w-new00001', commit: 'fedcba9876', startedAt: ago(1), phase: 'starting' }
    poll()
    await waitFor(() => expect(row('app.example.com')).toContain('Deploying fedcba9 · starting'))

    delete site('web').deploy
    poll()
    await waitFor(() => expect(row('app.example.com')).not.toContain('Deploying'))
    const fetches = server.called(LIST).length
    poll()
    poll()
    expect(server.called(LIST)).toHaveLength(fetches)
  })
})

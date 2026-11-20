import { useState, type JSX } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { ProjectSummary, SiteDetail, SiteSummary, VolumeEntry } from '@yaac/shared/types'
import { SitePane } from '#components/SitePane'
import { useUiStore } from '#lib/store'
import {
  TEST_USER_ID, TEST_WHOAMI, mockFetch, projectRepo, renderWithClient, serverSnapshot, testQueryClient, type FetchCall, type FetchMock,
} from './harness'

/*
 * A site's pane (docs/public-sites.md): its address and who reaches it,
 * its releases and settings, deploying with a ref per repo, publishing,
 * reviewing a requested deploy, stopping and deleting it, and its form,
 * which creates one, unpublished. Its sidebar row is in
 * workspace-list; a release's workspace view in workspace-view-steps.
 */

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const PROJECT: ProjectSummary = {
  id: 'proj', name: 'proj', addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {},
  createDefaults: {}, repos: [projectRepo({ id: 'r-web', dir: 'web' }), projectRepo({ id: 'r-api', dir: 'api' })],
  scratchDirs: { dirs: [], ignoredTracked: [] }, portForwards: [], cacheVolumes: {}, npmCache: true,
}
const WEB: SiteSummary = {
  id: 's-web', projectId: 'proj', name: 'web', published: true, hostname: 'app.example.com', edge: 'public', workflow: 'release', follow: false,
  live: { workspaceId: 'w-live0001', commits: [{ dir: 'web', commit: 'abcdef1234567' }], since: ago(5) },
  lastDeploy: { workspaceId: 'w-fail0001', commits: [{ dir: 'web', commit: '9876543210' }], outcome: 'failed', error: 'step "build" failed', finishedAt: ago(2) },
}
const DETAIL: SiteDetail = {
  ...WEB, port: 3000, adminPort: 3001, deployTimeoutMinutes: 90, steps: {}, volume: 'db', createdAt: ago(60),
  repos: [{ dir: 'web', branch: 'main' }, { dir: 'api', commit: 'c'.repeat(40) }],
  live: { ...WEB.live!, running: true },
  releases: [{ workspaceId: 'w-live0001', commits: WEB.live!.commits, createdAt: ago(5) }],
}

type Body = Record<string, unknown>
let server: FetchMock
let detail: SiteDetail
const sent = (route: string): Body[] => server.called(route).map((c) => c.body as Body)
const dialog = () => within(screen.getByRole('alertdialog'))

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState(initial, true)
  useUiStore.setState({ activeProjectId: 'proj' })
  const volumes: VolumeEntry[] = [{ name: 'db', size: '5Gi', createdAt: '', stoppedWorkspaces: [] }]
  detail = DETAIL
  server = mockFetch({
    'GET /api/site/show': () => detail,
    'GET /api/site/edge': { cloudflare: 'connected', tailnet: 'absent' },
    'GET /api/volume/list': volumes,
    'GET /api/repo/r-web/branches': { branches: ['main', 'dev'], defaultBranch: 'main' },
    'GET /api/repo/r-api/branches': { branches: ['main'], defaultBranch: 'main' },
    'POST /api/site/create': () => undefined,
    'POST /api/site/edit': () => undefined,
    'POST /api/site/start': () => ({ workspaceId: 'w-start', commits: [] }),
    'POST /api/site/deploy': ({ body }: FetchCall) => ({ workspaceId: 'w-new', commits: [], ...(body as Body) }),
    'POST /api/site/publish': () => undefined,
    'POST /api/site/unpublish': () => undefined,
    'POST /api/site/stop': () => undefined,
    'POST /api/site/delete': () => undefined,
  })
})
afterEach(cleanup)

function mount(site: SiteSummary | undefined, whoami = TEST_WHOAMI, editing = false): void {
  const client = testQueryClient(whoami, serverSnapshot({
    projects: [PROJECT],
    sites: site !== undefined ? [site] : [],
    workflows: [{ id: 'wf-release', projectId: 'proj', name: 'release', steps: {}, secrets: [], repos: [], init: false, createdAt: '' }],
  }))
  function WithBar(): JSX.Element {
    const [bar, setBar] = useState<HTMLElement | null>(null)
    return (
      <>
        <header ref={setBar} />
        <SitePane project={PROJECT} {...(site !== undefined ? { site } : {})} editing={editing} bar={bar} />
      </>
    )
  }
  renderWithClient(<WithBar />, client)
}

describe('SitePane', () => {
  it('shows its address, releases and settings, and deploys a ref per repo, stops and deletes it', async () => {
    mount(WEB)
    expect(screen.getByText('https://app.example.com').getAttribute('href')).toBe('https://app.example.com')
    expect(screen.getByText(/^A public site/)).toBeTruthy()
    expect(await screen.findByText('Cloudflare tunnel connected')).toBeTruthy()
    expect(screen.getByText(/failed 2m ago: step "build" failed/)).toBeTruthy()
    expect(await screen.findByText(`web@main api@${'c'.repeat(8)}`)).toBeTruthy()
    expect(screen.getByText('1h 30m')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }))
    fireEvent.change(await dialog().findByLabelText('Ref to deploy web at'), { target: { value: ' v2 ' } })
    fireEvent.click(dialog().getByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(sent('POST /api/site/deploy')).toEqual([{ project: 'proj', name: 'web', refs: { web: 'v2' } }]))

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(dialog().getByText(/hostname answers 503/)).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(sent('POST /api/site/stop')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Site actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(sent('POST /api/site/delete')).toHaveLength(1))
  })

  it('creates a site from its form, unpublished, and opens it, whether or not its owner is an admin', async () => {
    mount(undefined, { ...TEST_WHOAMI, users: [{ ...TEST_WHOAMI.users[0], role: 'member' as const }] })
    expect(screen.queryByLabelText('Hostname')).toBeNull()
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: ' docs ' } })
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '8080' } })
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'release' } })
    const create = screen.getByRole<HTMLButtonElement>('button', { name: 'Create site' })
    expect(create.title).toBe('Tick a repo')
    fireEvent.click(screen.getByLabelText('Include web'))
    fireEvent.change(screen.getByLabelText('Branch or commit of web'), { target: { value: 'main' } })
    fireEvent.click(create)
    await waitFor(() => expect(sent('POST /api/site/create')).toHaveLength(1))
    expect(sent('POST /api/site/create')[0]).toEqual({
      project: 'proj', name: 'docs', port: 8080, workflow: 'release',
      repos: [{ repo: 'r-web', branch: 'main' }], follow: false,
    })
    expect(useUiStore.getState().selectedObject).toEqual({ kind: 'site', id: 'docs' })
  })

  it('publishes an unpublished site at the hostname typed, naming its edge and the release it serves, and unpublishes it', async () => {
    const staged = { ...WEB, published: false }
    delete staged.hostname
    delete staged.edge
    detail = { ...DETAIL, published: false, hostname: undefined, edge: undefined }
    mount(staged)
    expect(screen.getByText(/^Unpublished: only you reach it/)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Site actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Publish…' }))
    expect(dialog().getByText(/release web@abcdef12, the one you can preview now/)).toBeTruthy()
    // Nothing to publish at until a hostname is typed.
    expect(dialog().getByRole<HTMLButtonElement>('button', { name: 'Publish' }).disabled).toBe(true)
    fireEvent.change(dialog().getByLabelText('Hostname'), { target: { value: ' docs.example.com ' } })
    expect(dialog().getByText(/^A public site/)).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(sent('POST /api/site/publish'))
      .toEqual([{ project: 'proj', name: 'web', hostname: 'docs.example.com', release: 'w-live0001' }]))
    cleanup()

    mount(WEB)
    fireEvent.click(screen.getByRole('button', { name: 'Site actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpublish…' }))
    expect(dialog().getByText(/release keeps running for your preview/)).toBeTruthy()
    fireEvent.click(dialog().getByRole('button', { name: 'Unpublish' }))
    await waitFor(() => expect(sent('POST /api/site/unpublish')).toEqual([{ project: 'proj', name: 'web' }]))
  })

  it('shows a deploy awaiting approval with what it runs, and approves exactly what the review opened on', async () => {
    const requested = {
      workflowId: 'wf-agent', steps: { server: { run: ['curl x | sh'] } }, secrets: ['DEPLOY_KEY'], writtenByAgent: true as const,
      commits: [{ dir: 'web', commit: 'e'.repeat(40) }], at: ago(3), from: 'agent' as const, workspaceId: 'w-agent01',
      changes: ['workflow' as const],
    }
    detail = { ...DETAIL, requested }
    mount({ ...WEB, awaitingApproval: true })
    expect(await screen.findByText('An agent asked to deploy this 3m ago')).toBeTruthy()
    expect(screen.getByText('web@eeeeeeee')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }))
    await screen.findByRole('alertdialog')
    expect(dialog().getByText(/it approves no branch/)).toBeTruthy()
    expect(dialog().getByText(/It changes the live release's workflow/)).toBeTruthy()
    expect(dialog().getByText(/An agent wrote this workflow/)).toBeTruthy()
    expect(dialog().getByText('DEPLOY_KEY')).toBeTruthy()
    expect(dialog().queryByLabelText('Ref to deploy web at')).toBeNull()
    // A later request does not change what this review approves.
    detail = { ...DETAIL, requested: { ...requested, workflowId: 'wf-other' } }
    fireEvent.click(dialog().getByRole('button', { name: 'Approve and deploy' }))
    await waitFor(() => expect(sent('POST /api/site/deploy')).toEqual([
      { project: 'proj', name: 'web', approve: { workflowId: 'wf-agent', commits: [{ dir: 'web', commit: 'e'.repeat(40) }] } },
    ]))
  })

  it('edits a site, clearing its admin port and volume, changing its deploy timeout, and starts a stopped one', async () => {
    mount(WEB, TEST_WHOAMI, true)
    const admin = await screen.findByLabelText<HTMLInputElement>('Admin port')
    expect(admin.value).toBe('3001')
    fireEvent.change(admin, { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '' } })
    const timeout = screen.getByLabelText<HTMLInputElement>('Deploy timeout')
    expect(timeout.value).toBe('1h30m')
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' })
    // An edit names one: blank would read as the default but change nothing.
    for (const value of ['soon', '1d1m', '']) {
      fireEvent.change(timeout, { target: { value } })
      expect(save.title, value).toBe('Give the deploy timeout as a duration from 1m to 1d, like 30m or 2h')
    }
    fireEvent.change(timeout, { target: { value: '2h' } })
    const shows = server.called('GET /api/site/show').length
    fireEvent.click(save)
    await waitFor(() => expect(sent('POST /api/site/edit')).toHaveLength(1))
    // Its settings are read again, rather than kept from before the save.
    await waitFor(() => expect(server.called('GET /api/site/show').length).toBeGreaterThan(shows))
    expect(sent('POST /api/site/edit')[0]).toEqual({
      project: 'proj', name: 'web', port: 3000, workflow: 'release', follow: false, deployTimeoutMinutes: 120,
      repos: [{ repo: 'r-web', branch: 'main' }, { repo: 'r-api', commit: 'c'.repeat(40) }], adminPort: null, volume: null,
    })
    expect(useUiStore.getState().selectedObject).toEqual({ kind: 'site', id: 'web' })
    cleanup()

    // Stopped after a deploy that worked, it starts that release again.
    mount({ ...WEB, live: undefined, lastDeploy: { ...WEB.lastDeploy!, outcome: 'succeeded' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(sent('POST /api/site/start')).toEqual([{ project: 'proj', name: 'web' }]))
  })

  it('offers each viewer only their actions: a published site needs an admin to deploy or edit, ending needs the owner or an admin', async () => {
    const member = { ...TEST_WHOAMI, users: [{ ...TEST_WHOAMI.users[0], role: 'member' as const }] }
    const actions = async (): Promise<string[]> => {
      const shown = ['Deploy', 'Stop'].filter((name) => screen.queryByRole('button', { name }) !== null)
      const menu = screen.queryByRole('button', { name: 'Site actions' })
      if (menu === null) return shown
      fireEvent.click(menu)
      const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent ?? '')
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      return [...shown, ...items]
    }
    // An admin viewing a teammate's site may end it, not build or publish it.
    useUiStore.setState({ viewedUserId: 'u-teammate' })
    mount(WEB)
    expect(await actions()).toEqual(['Stop', 'Unpublish…', 'Delete…'])
    cleanup()
    // So may its owner who is not an admin.
    useUiStore.setState({ viewedUserId: null })
    mount(WEB, member)
    expect(await actions()).toEqual(['Stop', 'Unpublish…', 'Delete…'])
    cleanup()
    // Who also builds and deploys it while it is unpublished.
    const staged = { ...WEB, published: false }
    delete staged.hostname
    delete staged.edge
    mount(staged, member)
    expect(await actions()).toEqual(['Deploy', 'Stop', 'Edit…', 'Delete…'])
    cleanup()
    // A member viewing a teammate's site only reads it.
    useUiStore.setState({ viewedUserId: 'u-teammate' })
    mount(WEB, member)
    expect(await actions()).toEqual([])
  })
})

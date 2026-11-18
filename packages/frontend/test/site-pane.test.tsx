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
 * its releases and settings, deploying with a ref per repo, stopping and
 * deleting it, and its form, which creates one. Its sidebar row is in
 * workspace-list; a release's workspace view in workspace-view-steps.
 */

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const PROJECT: ProjectSummary = {
  id: 'proj', name: 'proj', addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {},
  createDefaults: {}, repos: [projectRepo({ id: 'r-web', dir: 'web' }), projectRepo({ id: 'r-api', dir: 'api' })],
  scratchDirs: { dirs: [], ignoredTracked: [] }, portForwards: [], cacheVolumes: {}, npmCache: true,
}
const WEB: SiteSummary = {
  id: 's-web', projectId: 'proj', name: 'web', hostname: 'app.example.com', edge: 'public', workflow: 'release', follow: false,
  live: { workspaceId: 'w-live0001', commits: [{ dir: 'web', commit: 'abcdef1234567' }], since: ago(5) },
  lastDeploy: { workspaceId: 'w-fail0001', commits: [{ dir: 'web', commit: '9876543210' }], outcome: 'failed', error: 'step "build" failed', finishedAt: ago(2) },
}
const DETAIL: SiteDetail = {
  ...WEB, port: 3000, adminPort: 3001, steps: {}, volume: 'db', createdAt: ago(60),
  repos: [{ dir: 'web', branch: 'main' }, { dir: 'api', commit: 'c'.repeat(40) }],
  live: { ...WEB.live!, running: true },
  releases: [{ workspaceId: 'w-live0001', commits: WEB.live!.commits, createdAt: ago(5) }],
}

type Body = Record<string, unknown>
let server: FetchMock
const sent = (route: string): Body[] => server.called(route).map((c) => c.body as Body)
const dialog = () => within(screen.getByRole('alertdialog'))

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState(initial, true)
  useUiStore.setState({ activeProjectId: 'proj' })
  const volumes: VolumeEntry[] = [{ name: 'db', size: '5Gi', createdAt: '', stoppedWorkspaces: [] }]
  server = mockFetch({
    'GET /api/site/show': DETAIL,
    'GET /api/site/edge': { cloudflare: 'connected', tailnet: 'absent' },
    'GET /api/volume/list': volumes,
    'GET /api/repo/r-web/branches': { branches: ['main', 'dev'], defaultBranch: 'main' },
    'GET /api/repo/r-api/branches': { branches: ['main'], defaultBranch: 'main' },
    'POST /api/site/create': () => undefined,
    'POST /api/site/edit': () => undefined,
    'POST /api/site/start': () => ({ workspaceId: 'w-start', commits: [] }),
    'POST /api/site/deploy': ({ body }: FetchCall) => ({ workspaceId: 'w-new', commits: [], ...(body as Body) }),
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

  it('creates a site from its form, and opens it; a member cannot publish', async () => {
    mount(undefined)
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: ' docs ' } })
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'docs.example.com' } })
    expect(screen.getByText(/^A public site/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '8080' } })
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'release' } })
    const create = screen.getByRole<HTMLButtonElement>('button', { name: 'Create site' })
    expect(create.title).toBe('Tick a repo')
    fireEvent.click(screen.getByLabelText('Include web'))
    fireEvent.change(screen.getByLabelText('Branch or commit of web'), { target: { value: 'main' } })
    fireEvent.click(create)
    await waitFor(() => expect(sent('POST /api/site/create')).toHaveLength(1))
    expect(sent('POST /api/site/create')[0]).toEqual({
      project: 'proj', name: 'docs', hostname: 'docs.example.com', port: 8080, workflow: 'release',
      repos: [{ repo: 'r-web', branch: 'main' }], follow: false,
    })
    expect(useUiStore.getState().selectedObject).toEqual({ kind: 'site', id: 'docs' })
    cleanup()

    mount(undefined, { ...TEST_WHOAMI, users: [{ ...TEST_WHOAMI.users[0], role: 'member' as const }] })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create site' }).title)
      .toBe('Only an admin of this yaac install can publish sites')
  })

  it('edits a site, clearing its admin port and volume, and starts a stopped one', async () => {
    mount(WEB, TEST_WHOAMI, true)
    const admin = await screen.findByLabelText<HTMLInputElement>('Admin port')
    expect(admin.value).toBe('3001')
    fireEvent.change(admin, { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sent('POST /api/site/edit')).toHaveLength(1))
    expect(sent('POST /api/site/edit')[0]).toEqual({
      project: 'proj', name: 'web', hostname: 'app.example.com', port: 3000, workflow: 'release', follow: false,
      repos: [{ repo: 'r-web', branch: 'main' }, { repo: 'r-api', commit: 'c'.repeat(40) }], adminPort: null, volume: null,
    })
    expect(useUiStore.getState().selectedObject).toEqual({ kind: 'site', id: 'web' })
    cleanup()

    // Stopped after a deploy that worked, it starts that release again.
    mount({ ...WEB, live: undefined, lastDeploy: { ...WEB.lastDeploy!, outcome: 'succeeded' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(sent('POST /api/site/start')).toEqual([{ project: 'proj', name: 'web' }]))
  })

  it('offers each viewer only their actions: publishing needs an admin, ending needs the owner or an admin', async () => {
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
    // An admin viewing a teammate's site may end it, not publish it.
    useUiStore.setState({ viewedUserId: 'u-teammate' })
    mount(WEB)
    expect(await actions()).toEqual(['Stop', 'Delete…'])
    cleanup()
    // So may its owner who is not an admin.
    useUiStore.setState({ viewedUserId: null })
    mount(WEB, member)
    expect(await actions()).toEqual(['Stop', 'Delete…'])
    cleanup()
    // A member viewing a teammate's site only reads it.
    useUiStore.setState({ viewedUserId: 'u-teammate' })
    mount(WEB, member)
    expect(await actions()).toEqual([])
  })
})

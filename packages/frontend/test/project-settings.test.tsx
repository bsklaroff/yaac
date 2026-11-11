import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { ProjectEnvVar, ProjectRunSecret, ProjectSummary } from '@yaac/shared/types'

// CodeMirror doesn't run under jsdom; each file editor gets a textarea.
vi.mock('#components/ui/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { ProjectSettings } from '#components/settings/ProjectSettings'
import { useUiStore } from '#lib/store'
import {
  mockFetch, projectRepo, renderWithClient, repoSummary, serverSnapshot, testQueryClient, TEST_USER_ID,
  type FetchCall, type FetchMock,
} from './harness'

afterEach(() => {
  cleanup()
  useUiStore.setState({ viewedUserId: null, settingsProjectId: null })
})

/** A project keyed by `id-<name>`, so a test can tell the key from the
 *  displayed name, linking one repo `repo-<name>` in a folder of its name. */
const project = (name: string, remoteUrl: string): ProjectSummary =>
  ({ id: `id-${name}`, name, addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {}, createDefaults: {}, repos: [projectRepo({ id: `repo-${name}`, dir: name, remoteUrl })], scratchDirs: { dirs: [], ignoredTracked: [] }, portForwards: [], cacheVolumes: {}, nestedContainers: false, npmCache: true })

/** Show settings for `alpha` (and `beta`) on a containerless server, whose
 *  env routes keep `vars` in memory. */
function renderAlpha(vars: ProjectEnvVar[] = []): FetchMock {
  useUiStore.setState({ activeProjectId: 'id-alpha' })
  const snapshot = serverSnapshot({
    driver: 'containerless',
    projects: [project('alpha', 'https://github.com/o/alpha.git'), project('beta', 'git@gitlab.com:o/beta.git')],
  })
  const server = mockFetch({
    'GET /api/project/id-alpha/env': () => ({ vars }),
    'PUT /api/project/id-alpha/env': ({ body }: FetchCall) => {
      const { name, value, secret, rule } = body as ProjectEnvVar
      const saved = { id: `id-${name}`, name, secret, hasValue: true, ...(secret ? { rule } : { value }) }
      vars = [...vars.filter((v) => v.name !== name), saved]
      return { var: saved }
    },
    'DELETE /api/project/id-alpha/env/v1': () => {
      vars = vars.filter((v) => v.id !== 'v1')
      return undefined
    },
    'GET /api/project/id-beta/env': { vars: [] },
  })
  renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))
  return server
}

describe('ProjectSettings', () => {
  it('picks a project by name and lists its repos, each in its folder, above the environment', () => {
    renderAlpha()
    expect([...screen.getByRole<HTMLSelectElement>('combobox').options].map((o) => [o.value, o.textContent]))
      .toEqual([['id-alpha', 'alpha'], ['id-beta', 'beta']])

    const remote = screen.getByText('https://github.com/o/alpha.git')
    expect(remote.previousElementSibling?.textContent).toBe('alpha/')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'id-beta' } })
    expect(screen.getByText('git@gitlab.com:o/beta.git').previousElementSibling?.textContent).toBe('beta/')
  })

  it('has no Volumes or Sites section on a containerless server, nor asks for either', () => {
    const server = renderAlpha()
    expect(screen.queryByText('Volumes')).toBeNull()
    expect(screen.queryByText('Sites')).toBeNull()
    expect(server.calls.filter((c) => c.path.startsWith('/api/volume') || c.path.startsWith('/api/site'))).toEqual([])
  })

  it('shows the init workflows, each with its repos, apart from the project\'s other workflows', async () => {
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    const snapshot = serverSnapshot({ driver: 'containerless', projects: [project('alpha', 'https://github.com/o/alpha.git')] })
    const flow = (name: string, init: boolean): Record<string, unknown> => ({
      id: `wf-${name}`, projectId: 'id-alpha', name, steps: { install: { run: ['pnpm install'] } }, secrets: [],
      repos: init ? ['alpha'] : [], init, approvedCommits: [], approvedBranches: [], createdAt: '',
    })
    mockFetch({
      'GET /api/project/id-alpha/env': { vars: [] },
      'GET /api/workflow/list': [flow('alpha-init', true), flow('lint', false)],
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))
    const section = (await screen.findByText('Init workflows')).parentElement as HTMLElement
    await waitFor(() => expect(within(section).getByText('alpha-init')).toBeTruthy())
    expect(within(section).queryByText('lint')).toBeNull()
    expect(within(section).getByText('repos: alpha')).toBeTruthy()
    expect(within(section).getByRole('button', { name: 'Add init workflow' })).toBeTruthy()
  })

  it('adds a kept ignored path to the snapshot\'s list, and removes one', async () => {
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [{ ...project('alpha', 'https://github.com/o/alpha.git'), keptIgnoredPaths: ['.env'] }],
    })
    const server = mockFetch({
      'GET /api/project/id-alpha/env': { vars: [] },
      'PUT /api/project/id-alpha/kept-ignored-paths': ({ body }: FetchCall) => body,
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    expect(screen.getByRole('button', { name: 'Remove .env' })).toBeTruthy()
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Path to keep' })
    fireEvent.change(input, { target: { value: ' data/dev.db ' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(input.value).toBe(''))
    fireEvent.click(screen.getByRole('button', { name: 'Remove .env' }))
    await waitFor(() => expect(server.called('PUT /api/project/id-alpha/kept-ignored-paths').map((c) => c.body))
      .toEqual([{ paths: ['.env', 'data/dev.db'] }, { paths: [] }]))
  })

  it('adds, resizes and removes scratch directories, and warns again about an ignored one', async () => {
    useUiStore.setState({ activeProjectId: 'id-delta' })
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [{
        ...project('delta', 'https://github.com/o/delta.git'),
        scratchDirs: { dirs: [{ path: 'node_modules', sizeGiB: 8 }, { path: 'target', sizeGiB: 32 }], ignoredTracked: ['target'] },
      }],
    })
    const server = mockFetch({
      'GET /api/project/id-delta/env': { vars: [] },
      'PUT /api/project/id-delta/scratch-dirs': { dirs: [], ignoredTracked: [] },
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))
    const puts = (): unknown[] => server.called('PUT /api/project/id-delta/scratch-dirs').map((c) => c.body)
    const settled = (name: string): Promise<void> =>
      waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(false))
    const node = { path: 'node_modules', sizeGiB: 8 }

    fireEvent.change(screen.getByPlaceholderText('packages/web/node_modules'), { target: { value: 'web/node_modules' } })
    fireEvent.change(screen.getByLabelText('Cap of the new directory in GiB'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add scratch directory' }))
    await waitFor(() => expect(puts()).toEqual([{
      dirs: [node, { path: 'target', sizeGiB: 32 }, { path: 'web/node_modules', sizeGiB: 2 }],
    }]))

    // A cap is saved once it leaves the field.
    await settled('Remove target')
    const cap = screen.getByLabelText('Cap of target in GiB')
    fireEvent.change(cap, { target: { value: '48' } })
    fireEvent.blur(cap)
    await waitFor(() => expect(puts().slice(1)).toEqual([{ dirs: [node, { path: 'target', sizeGiB: 48 }] }]))
    // An emptied cap is the default again.
    await settled('Remove target')
    fireEvent.change(cap, { target: { value: '' } })
    fireEvent.blur(cap)
    await waitFor(() => expect(puts().slice(2)).toEqual([{ dirs: [node, { path: 'target' }] }]))

    await settled('Remove target')
    fireEvent.click(screen.getByRole('button', { name: 'Remove target' }))
    await waitFor(() => expect(puts().slice(3)).toEqual([{ dirs: [node] }]))
    await settled('Warn again')
    fireEvent.click(screen.getByRole('button', { name: 'Warn again' }))
    await waitFor(() => expect(puts().slice(4)).toEqual([{ ignoredTracked: [] }]))
  })

  it('edits forwarded ports, cache volumes and the container options, the last two only under k8s', async () => {
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    const alpha = {
      ...project('alpha', 'https://github.com/o/alpha.git'),
      portForwards: [{ containerPort: 3000, hostPortStart: 3000 }],
      cacheVolumes: { pip: '/home/yaac/.cache/pip' },
    }
    const server = mockFetch({
      'GET /api/project/id-alpha/env': { vars: [] },
      'GET /api/project/id-alpha/allowlist': { allowlist: { hosts: [], defaults: true }, defaultHosts: [] },
      'GET /api/project/id-alpha/dockerfile': { content: '' },
      'GET /api/project/id-alpha/build-files': { files: [] },
      'PUT /api/project/id-alpha/port-forwards': {},
      'PUT /api/project/id-alpha/cache-volumes': {},
      'PUT /api/project/id-alpha/nested-containers': {},
      'PUT /api/project/id-alpha/npm-cache': {},
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, serverSnapshot({ driver: 'k8s', projects: [alpha] })))
    const bodies = (route: string): unknown[] => server.called(`PUT /api/project/id-alpha/${route}`).map((c) => c.body)

    // A host port left empty is the container port.
    fireEvent.change(screen.getByLabelText('Container port'), { target: { value: '5173' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add forwarded port' }))
    await waitFor(() => expect(bodies('port-forwards')).toEqual([{ ports: [
      { containerPort: 3000, hostPortStart: 3000 }, { containerPort: 5173, hostPortStart: 5173 },
    ] }]))
    fireEvent.change(screen.getByLabelText('Container port'), { target: { value: '8080' } })
    fireEvent.change(screen.getByLabelText('Host port'), { target: { value: '9000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add forwarded port' }))
    await waitFor(() => expect(bodies('port-forwards')[1]).toEqual({ ports: [
      { containerPort: 3000, hostPortStart: 3000 }, { containerPort: 8080, hostPortStart: 9000 },
    ] }))
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove port 3000' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Remove port 3000' }))
    await waitFor(() => expect(bodies('port-forwards')[2]).toEqual({ ports: [] }))

    fireEvent.change(screen.getByLabelText('Cache volume name'), { target: { value: 'cargo' } })
    fireEvent.change(screen.getByLabelText('Cache volume path'), { target: { value: '/home/yaac/.cargo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add cache volume' }))
    await waitFor(() => expect(bodies('cache-volumes')).toEqual([
      { volumes: { pip: '/home/yaac/.cache/pip', cargo: '/home/yaac/.cargo' } },
    ]))
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove pip' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Remove pip' }))
    await waitFor(() => expect(bodies('cache-volumes')[1]).toEqual({ volumes: {} }))

    fireEvent.click(screen.getByRole('checkbox', { name: /Nested containers/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /npm cache/ }))
    await waitFor(() => expect([bodies('nested-containers'), bodies('npm-cache')])
      .toEqual([[{ enabled: true }], [{ enabled: false }]]))

    // A containerless server has no pods to give either.
    cleanup()
    renderAlpha()
    expect(screen.getByRole('button', { name: 'Add forwarded port' })).toBeTruthy()
    expect(screen.queryByText('Cache volumes')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Nested containers/ })).toBeNull()
  })

  it('confirms a stopped-workspace auto-delete with the count it deletes at once, and turns it off without asking', async () => {
    const server = renderAlpha()
    const before = '2026-10-16T12:00:00.000Z'
    server.route('GET /api/project/id-alpha/workspace-auto-delete', ({ query }: FetchCall) => ({ expired: query.get('days') === '7' ? 3 : 0, before }))
    server.route('PUT /api/project/id-alpha/workspace-auto-delete', {
      deleted: 2, kept: [{ workspaceId: 'w1', reason: 'workspace w1 is running or still stopping; stop it first' }],
    })
    const days = screen.getByRole<HTMLInputElement>('textbox', { name: 'Days stopped before a workspace is deleted' })
    expect(days.value).toBe('')
    const save = (): boolean => fireEvent.click(within(days.closest('form')!).getByRole('button', { name: 'Save' }))

    fireEvent.change(days, { target: { value: '7' } })
    save()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Delete up to 3 stopped workspaces now?')
    expect(dialog.textContent).toContain('Up to 3 stopped workspaces already past that will be deleted irretrievably')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(server.called('PUT /api/project/id-alpha/workspace-auto-delete')).toEqual([])

    save()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete up to 3 stopped workspaces' }))
    await waitFor(() => expect(server.called('PUT /api/project/id-alpha/workspace-auto-delete').map((c) => c.body))
      .toEqual([{ days: 7, before }]))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByText(/^Deleted 2 stopped workspaces\./).textContent).toBe('Deleted 2 stopped workspaces. Kept 1 stopped '
      + 'workspace for now, deleted once they can be: workspace w1 is running or still stopping; stop it first')

    cleanup()
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    const kept = mockFetch({
      'GET /api/project/id-alpha/env': { vars: [] },
      'GET /api/project/id-alpha/workspace-auto-delete': { expired: 0, before: '2026-08-24T12:00:00.000Z' },
      'PUT /api/project/id-alpha/workspace-auto-delete': { deleted: 0, kept: [] },
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, serverSnapshot({
      driver: 'containerless',
      projects: [{ ...project('alpha', 'https://github.com/o/alpha.git'), stoppedWorkspaceRetentionDays: 30 }],
    })))
    const on = screen.getByRole<HTMLInputElement>('textbox', { name: 'Days stopped before a workspace is deleted' })
    expect(on.value).toBe('30')
    // Already on, so a change that deletes nothing yet is a plain save.
    fireEvent.change(on, { target: { value: '60' } })
    fireEvent.click(within(on.closest('form')!).getByRole('button', { name: 'Save' }))
    const change = await screen.findByRole('alertdialog')
    expect(change.textContent).toContain('None is past that yet.')
    fireEvent.click(within(change).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(kept.called('PUT /api/project/id-alpha/workspace-auto-delete').map((c) => c.body))
      .toEqual([{ days: 60, before: '2026-08-24T12:00:00.000Z' }, { days: null }]))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  // The Repos section: each link's folder, order and (under a proxy) its two
  // flags; a repo is linked by URL, by picking one, or as a new hosted one.
  describe('Repos', () => {
    const api = projectRepo({ id: 'repo-api', dir: 'api', remoteUrl: 'https://github.com/o/api.git' })
    const web = projectRepo({ id: 'repo-web', dir: 'web', remoteUrl: 'git@github.com:o/web.git' })
    const two = (driver: 'k8s' | 'containerless', repos = [api, web]): ReturnType<typeof serverSnapshot> =>
      serverSnapshot({ driver, projects: [{ ...project('alpha', ''), repos }] })
    const LINK = 'POST /api/project/id-alpha/repo'
    const show = (snapshot: ReturnType<typeof serverSnapshot>, routes: Record<string, unknown> = {}): FetchMock => {
      useUiStore.setState({ activeProjectId: 'id-alpha' })
      const server = mockFetch({ 'GET /api/project/id-alpha/env': { vars: [] }, 'GET /api/repo/list': [], ...routes })
      renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))
      return server
    }

    it('renames a link\'s folder, reorders the links and unlinks one', async () => {
      const server = show(two('containerless'), {
        'PATCH /api/project/id-alpha/repo/repo-api': () => undefined,
        'PUT /api/project/id-alpha/repo-order': () => undefined,
        'DELETE /api/project/id-alpha/repo/repo-web': () => undefined,
      })
      // A name another link has, or that is no folder name, is not sent.
      for (const name of ['web', 'a b', '..', 'backend']) {
        fireEvent.click(screen.getByRole('button', { name: 'api/' }))
        const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Folder name' })
        fireEvent.change(input, { target: { value: name } })
        fireEvent.keyDown(input, { key: 'Enter' })
      }
      await waitFor(() => expect(server.called('PATCH /api/project/id-alpha/repo/repo-api').map((c) => c.body))
        .toEqual([{ dir: 'backend' }]))

      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Move api up' }).disabled).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Move web up' }))
      await waitFor(() => expect(server.called('PUT /api/project/id-alpha/repo-order').map((c) => c.body))
        .toEqual([{ repos: ['repo-web', 'repo-api'] }]))

      fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[1])
      await waitFor(() => expect(server.called('DELETE /api/project/id-alpha/repo/repo-web')).toHaveLength(1))
    })

    it('offers read-only and GH_TOKEN only behind a proxy, and never GH_TOKEN for a read-only repo', async () => {
      const server = show(two('k8s', [api, { ...web, readOnly: true }, projectRepo({
        id: 'repo-ro', dir: 'ro', remoteUrl: 'https://github.com/o/ro.git', readOnly: true, ghToken: true,
      })]), {
        'PUT /api/project/id-alpha/repo/repo-api/read-only': () => undefined,
        'PUT /api/project/id-alpha/repo/repo-api/gh-token': () => undefined,
      })
      const row = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-repo="${id}"]`)!
      const box = (id: string, name: RegExp): HTMLInputElement | null =>
        within(row(id)).queryByRole<HTMLInputElement>('checkbox', { name })
      // An ssh remote has no token to offer.
      expect(box('repo-web', /Read-only/)?.checked).toBe(true)
      expect(box('repo-web', /GH_TOKEN/)).toBeNull()
      // Read-only turns the token off, with why, whatever was stored.
      expect(box('repo-ro', /GH_TOKEN/)).toMatchObject({ checked: false, disabled: true })
      expect(row('repo-ro').textContent).toContain('off while read-only')

      fireEvent.click(box('repo-api', /GH_TOKEN/)!)
      await waitFor(() => expect(server.called('PUT /api/project/id-alpha/repo/repo-api/gh-token').map((c) => c.body))
        .toEqual([{ enabled: false }]))
      fireEvent.click(box('repo-api', /Read-only/)!)
      await waitFor(() => expect(server.called('PUT /api/project/id-alpha/repo/repo-api/read-only').map((c) => c.body))
        .toEqual([{ enabled: true }]))
      cleanup()

      show(two('containerless'))
      expect(screen.queryByRole('checkbox', { name: /Read-only/ })).toBeNull()
      expect(screen.queryByRole('checkbox', { name: /GH_TOKEN/ })).toBeNull()
    })

    it('links a repo by URL with a credential, one of the owner\'s or one shared with them, or a new hosted one', async () => {
      const token = { id: 'c-token', name: 'gh', kind: 'https', preview: '***abcd', repos: [] } as const
      const server = show(two('containerless', [api]), {
        'GET /api/auth/list': { gitCredentials: [token], toolAuth: [], customEndpoints: [] },
        'GET /api/repo/list': [
          repoSummary({ id: 'repo-api', remoteUrl: api.remoteUrl }),
          repoSummary({ id: 'repo-docs', remoteUrl: 'https://github.com/o/docs.git' }),
          repoSummary({ id: 'repo-hers', owner: 'u-ada', hosted: true, sharedWith: [TEST_USER_ID] }),
          repoSummary({ id: 'repo-theirs', owner: 'u-ada', remoteUrl: 'https://github.com/a/theirs.git' }),
          repoSummary({ id: 'repo-gone', remoteUrl: 'https://github.com/o/gone.git', deleted: { heldBy: [] } }),
        ],
        [LINK]: ({ body }: FetchCall) => ({ repoId: 'new', dir: (body as { dir?: string }).dir ?? 'x', knownHostsEntry: null }),
      })
      const open = async (): Promise<HTMLSelectElement> => {
        fireEvent.click(await screen.findByRole('button', { name: 'Add repo…' }))
        return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Repo to add' })
      }
      /** The form's own Add, apart from the environment section's. */
      const add = (): void => {
        const form = screen.getByRole('combobox', { name: 'Repo to add' }).parentElement!
        fireEvent.click(within(form).getByRole('button', { name: 'Add' }))
      }
      // Its own unlinked repos and the ones shared with its owner, no others.
      const what = await open()
      await waitFor(() => expect([...what.options].map((o) => o.value))
        .toEqual(['url', 'repo-docs', 'repo-hers', 'hosted']))

      fireEvent.change(screen.getByRole('textbox', { name: 'Repository URL' }), { target: { value: 'https://github.com/o/new.git' } })
      fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'api' } })
      screen.getByText(/no other repo of this project has it/)
      fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), { target: { value: 'fresh' } })
      fireEvent.change(await screen.findByRole('combobox', { name: 'Git credential' }), { target: { value: 'c-token' } })
      add()
      await waitFor(() => expect(server.called(LINK).map((c) => c.body))
        .toEqual([{ remoteUrl: 'https://github.com/o/new.git', credentialId: 'c-token', dir: 'fresh' }]))

      fireEvent.change(await open(), { target: { value: 'repo-hers' } })
      add()
      await waitFor(() => expect(server.called(LINK).at(-1)?.body).toEqual({ repoId: 'repo-hers' }))

      fireEvent.change(await open(), { target: { value: 'hosted' } })
      add()
      await waitFor(() => expect(server.called(LINK).at(-1)?.body).toEqual({ hosted: true }))
    })
  })

  it('lists the project\'s variables, adds a secret with its proxy rule, and deletes one', async () => {
    const server = renderAlpha([{ id: 'v1', name: 'FOO', secret: false, value: 'bar', hasValue: true }])
    await screen.findByText('FOO')
    screen.getByText('bar')

    fireEvent.change(screen.getByPlaceholderText('NAME'), { target: { value: 'TOKEN' } })
    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 's3cret' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Secret' }))
    fireEvent.change(screen.getByLabelText('hosts'), { target: { value: 'api.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await screen.findByText('TOKEN')
    expect(server.called('PUT /api/project/id-alpha/env').map((c) => c.body)).toEqual([
      {
        name: 'TOKEN', value: 's3cret', secret: true,
        rule: { hosts: ['api.example.com'], path: '/*', header: 'authorization', prefix: 'Bearer ' },
      },
    ])
    // A secret shows masked, with where it is injected.
    screen.getByText('••••••••')
    screen.getByTitle('api.example.com · header authorization')
    expect(screen.getByPlaceholderText<HTMLInputElement>('NAME').value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Delete FOO' }))
    await waitFor(() => expect(screen.queryByText('FOO')).toBeNull())
    expect(server.called('DELETE /api/project/id-alpha/env/v1')).toHaveLength(1)
  })

  it('adds a run secret, its value write-only', async () => {
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    let secrets: ProjectRunSecret[] = []
    const server = mockFetch({
      'GET /api/project/id-alpha/env': { vars: [] },
      'GET /api/project/id-alpha/run-secrets': () => ({ secrets }),
      'PUT /api/project/id-alpha/run-secrets': ({ body }: FetchCall) => {
        secrets = [{ id: 'rs1', name: (body as { name: string }).name, hasValue: true }]
        return { secret: secrets[0] }
      },
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, serverSnapshot({
      driver: 'containerless',
      projects: [project('alpha', 'https://github.com/o/alpha.git')],
    })))

    fireEvent.change(await screen.findByPlaceholderText('SECRET_NAME'), { target: { value: 'P8_KEY' } })
    fireEvent.change(screen.getByLabelText('Run secret value'), { target: { value: 'pem' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add run secret' }))

    await screen.findByText('P8_KEY')
    expect(server.called('PUT /api/project/id-alpha/run-secrets').map((c) => c.body)).toEqual([{ name: 'P8_KEY', value: 'pem' }])
    expect(screen.queryByText('pem')).toBeNull()
  })

  it('shows a teammate\'s project read-only', async () => {
    // The caller is TEST_USER_ID; Ada's projects are what the switcher shows.
    useUiStore.setState({ activeProjectId: 'id-hers', viewedUserId: 'u-ada' })
    const snapshot = serverSnapshot({
      driver: 'k8s',
      projects: [
        { ...project('hers', 'https://github.com/a/hers.git'), owner: 'u-ada' },
        project('mine', 'https://github.com/o/mine.git'),
      ],
    })
    const server = mockFetch({
      'GET /api/project/id-hers/env': { vars: [
        { id: 'v1', name: 'PLAIN', secret: false, value: 'visible-elsewhere', hasValue: true },
        { id: 'v2', name: 'TOKEN', secret: true, hasValue: true, rule: { hosts: ['api.example.com'] } },
      ] },
      'GET /api/project/id-hers/dockerfile': { content: 'FROM scratch\n' },
      'GET /api/project/id-hers/build-files': { files: [{ path: 'init.lua', size: 3, binary: false }] },
      'GET /api/project/id-hers/build-files/file': { path: 'init.lua', size: 3, binary: false, content: 'x=1' },
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    // Only the viewed user's projects are offered.
    expect([...screen.getByRole<HTMLSelectElement>('combobox').options].map((o) => o.value)).toEqual(['id-hers'])
    await screen.findByText('PLAIN')
    // A plain value reads as for the owner; a secret's never leaves the server.
    expect(screen.getByText('visible-elsewhere')).toBeTruthy()
    expect(screen.getAllByText('••••••••')).toHaveLength(1)
    expect(screen.queryByPlaceholderText('NAME')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()

    // The Dockerfile and a build file read, with nothing to save or upload,
    // no init workflow to add, and the launch settings shown but not
    // editable.
    await waitFor(() => expect(screen.getAllByLabelText('editor')).toHaveLength(1))
    fireEvent.click(await screen.findByRole('button', { name: 'init.lua' }))
    await waitFor(() => expect(screen.getAllByLabelText('editor')).toHaveLength(2))
    expect(screen.queryByRole('button', { name: 'Add init workflow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add forwarded port' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add cache volume' })).toBeNull()
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every((c) => c.disabled)).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rename init.lua' })).toBeNull()
    expect(server.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it("shows the project's icon, offers it for download, crops a pasted image where it is dragged and zoomed, and removes the icon", async () => {
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [
        { ...project('alpha', 'git@github.com:o/alpha.git'), iconHash: 'h1' },
        project('beta', 'git@gitlab.com:o/beta.git'),
        { ...project('next.js', 'git@github.com:o/next.js.git'), iconHash: 'h2' },
      ],
    })
    const server = mockFetch({
      'GET /api/project/id-alpha/env': { vars: [] },
      'GET /api/project/id-alpha/run-secrets': { secrets: [] },
      'GET /api/project/id-beta/env': { vars: [] },
      'GET /api/project/id-beta/run-secrets': { secrets: [] },
      'GET /api/project/id-next.js/env': { vars: [] },
      'GET /api/project/id-next.js/run-secrets': { secrets: [] },
      'PUT /api/project/id-alpha/icon': undefined,
      'DELETE /api/project/id-alpha/icon': undefined,
    })
    // The browser's canvas, which jsdom lacks.
    const drawImage = vi.fn()
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage } }
      convertToBlob() { return Promise.resolve(new Blob(['png'], { type: 'image/png' })) }
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    const chip = screen.getByLabelText('Project icon')
    expect(chip.querySelector('img')?.getAttribute('src')).toBe('/api/project/id-alpha/icon?v=h1')
    const download = screen.getByRole('link', { name: 'Download' })
    expect([download.getAttribute('href'), download.getAttribute('download')]).toEqual(['/api/project/id-alpha/icon?v=h1', 'alpha icon'])

    /** Paste `file` on the chip and answer the cropper's image load as a
     *  `w`x`h` image, returning the crop area. */
    const paste = async (file: File, w: number, h: number): Promise<HTMLElement> => {
      fireEvent.paste(chip, { clipboardData: { getData: () => '', files: [file] } })
      const area = await screen.findByRole('group', { name: 'Crop area' })
      const img = area.querySelector('img') as HTMLImageElement
      expect(img.src).toMatch(/^data:/)
      Object.defineProperties(img, { naturalWidth: { value: w }, naturalHeight: { value: h } })
      fireEvent.load(img)
      return area
    }

    // A 300x200 image just covers the 240px square, centered: 360px wide, 60px off each side.
    const area = await paste(new File(['x'], 'shot.png', { type: 'image/png' }), 300, 200)
    const img = area.querySelector('img') as HTMLImageElement
    expect([img.style.left, img.style.top, img.style.width]).toEqual(['-60px', '0px', '360px'])
    // Dragging past the left edge stops there; dragging back moves it.
    fireEvent.pointerDown(area, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 200, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 170, clientY: 150 })
    fireEvent.pointerUp(window)
    expect([img.style.left, img.style.top]).toEqual(['-30px', '0px'])
    // Zooming 2x about the center.
    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '2' } })
    expect([img.style.left, img.style.top]).toEqual(['-180px', '-120px'])

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.called('PUT /api/project/id-alpha/icon')).toHaveLength(1))
    // At 2.4 CSS px per image px, the square is the image's 100px from (75, 50), drawn at 256px.
    expect(drawImage.mock.calls[0].slice(1)).toEqual([75, 50, 100, 100, 0, 0, 256, 256])
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Crop area' })).toBeNull())

    // An SVG opens the cropper too; Cancel uploads nothing.
    await paste(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }), 24, 24)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Crop area' })).toBeNull())
    expect(server.called('PUT /api/project/id-alpha/icon')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(server.called('DELETE /api/project/id-alpha/icon')).toHaveLength(1))

    // A picture that fails to load shows the initial instead.
    fireEvent.error(chip.querySelector('img') as HTMLImageElement)
    expect(chip.textContent).toBe('A')

    // A project without a picture has nothing to download or remove.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'id-beta' } })
    expect(screen.getByLabelText('Project icon').textContent).toBe('B')
    expect(screen.queryByRole('link', { name: 'Download' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()

    // A dot in the name would read as the file's extension, and the browser
    // then adds none from the picture's type.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'id-next.js' } })
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('download')).toBe('next-js icon')
  })
})

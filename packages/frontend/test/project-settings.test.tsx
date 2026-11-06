import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { ProjectEnvVar, ProjectRunSecret, ProjectSummary, Whoami } from '@yaac/shared/types'

// CodeMirror doesn't run under jsdom; each file editor gets a textarea.
vi.mock('#components/ui/CodeEditor', () => ({
  CodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import { ProjectSettings } from '#components/settings/ProjectSettings'
import { useUiStore } from '#lib/store'
import {
  mockFetch, renderWithClient, serverError, serverSnapshot, testQueryClient, TEST_USER_ID, type FetchCall, type FetchMock,
} from './harness'

afterEach(() => {
  cleanup()
  useUiStore.setState({ viewedUserId: null, settingsProjectId: null })
})

/** A project keyed by `id-<name>`, so a test can tell the key from the
 *  displayed name. */
const project = (name: string, remoteUrl: string): ProjectSummary =>
  ({ id: `id-${name}`, name, remoteUrl, addedAt: '', owner: TEST_USER_ID, workspaceCount: 0, stoppedCount: 0, deaths: 0, deathsSeenBy: {}, createDefaults: {}, gitCredential: null, hosted: false, guardDefaultBranch: true, scratchDirs: { dirs: [], ignoredTracked: [] }, initSteps: {}, portForwards: [], cacheVolumes: {}, nestedContainers: false, npmCache: true })

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
  it('picks a project by name and shows its remote, with its scheme, above the environment', () => {
    renderAlpha()
    expect([...screen.getByRole<HTMLSelectElement>('combobox').options].map((o) => [o.value, o.textContent]))
      .toEqual([['id-alpha', 'alpha'], ['id-beta', 'beta']])

    const remote = screen.getByText('https://github.com/o/alpha.git')
    expect(remote.previousElementSibling?.textContent).toBe('HTTPS')
    // Directly under the project picker, ahead of the environment section.
    expect(remote.closest('div')?.querySelector('select')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'id-beta' } })
    expect(screen.getByText('git@gitlab.com:o/beta.git').previousElementSibling?.textContent).toBe('SSH')
  })

  it('has no Volumes or Sites section on a containerless server, nor asks for either', () => {
    const server = renderAlpha()
    expect(screen.queryByText('Volumes')).toBeNull()
    expect(screen.queryByText('Sites')).toBeNull()
    expect(server.calls.filter((c) => c.path.startsWith('/api/volume') || c.path.startsWith('/api/site'))).toEqual([])
  })

  it('shows a hosted project\'s clone command instead of a remote, changes its default branch, and turns its guard off', async () => {
    useUiStore.setState({ activeProjectId: 'id-gamma' })
    let defaultBranch = 'main'
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [{ ...project('gamma', 'http://yaac.internal/api/workspace/git/id-gamma.git'), hosted: true }],
    })
    const server = mockFetch({
      'GET /api/project/id-gamma/env': { vars: [] },
      'PUT /api/project/id-gamma/default-branch-guard': () => undefined,
      'GET /api/project/id-gamma/branches': () => ({ branches: ['agent/x', 'main'], defaultBranch }),
      'PUT /api/project/id-gamma/default-branch': ({ body }: FetchCall) => {
        defaultBranch = (body as { branch: string }).branch
        return undefined
      },
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    expect(screen.getByText('HOSTED BY YAAC')).toBeTruthy()
    expect(screen.queryByText('http://yaac.internal/api/workspace/git/id-gamma.git')).toBeNull()
    expect(screen.getByText(`git clone ${window.location.origin}/api/project/id-gamma/git gamma`)).toBeTruthy()

    const branch = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Default branch' })
    await waitFor(() => expect(branch.value).toBe('main'))
    expect([...branch.options].map((o) => o.value)).toEqual(['agent/x', 'main'])
    fireEvent.change(branch, { target: { value: 'agent/x' } })
    await waitFor(() => expect(branch.value).toBe('agent/x'))
    expect(server.called('PUT /api/project/id-gamma/default-branch').map((c) => c.body)).toEqual([{ branch: 'agent/x' }])

    const guard = screen.getByRole<HTMLInputElement>('checkbox', { name: /Protect the default branch/ })
    expect(guard.checked).toBe(true)
    fireEvent.click(guard)
    await waitFor(() => expect(server.called('PUT /api/project/id-gamma/default-branch-guard').map((c) => c.body))
      .toEqual([{ enabled: false }]))
  })

  it('edits the init steps, showing the server\'s refusal of a bad graph', async () => {
    useUiStore.setState({ activeProjectId: 'id-alpha' })
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [{ ...project('alpha', 'https://github.com/o/alpha.git'), initSteps: { install: { run: ['pnpm install'] } } }],
    })
    const server = mockFetch({
      'GET /api/project/id-alpha/env': { vars: [] },
      'PUT /api/project/id-alpha/init-steps': ({ body }: FetchCall) => {
        const { steps } = body as { steps: Record<string, unknown> }
        return 'cycle' in steps
          ? serverError('VALIDATION', 'init steps: steps form a cycle: cycle -> cycle', 400)
          : { steps }
      },
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    // The first editor is the init steps', opened on the snapshot's graph.
    const editor = await waitFor(() => {
      const [first] = screen.getAllByLabelText<HTMLTextAreaElement>('editor')
      expect(first.value).toContain('pnpm install')
      return first
    })
    const save = (text: string): void => {
      fireEvent.change(editor, { target: { value: text } })
      const box = editor.closest('.flex-col') as HTMLElement
      fireEvent.click(within(box).getByRole('button', { name: 'Save' }))
    }
    save('{"build": {"run": "pnpm build"}}')
    await waitFor(() => expect(server.called('PUT /api/project/id-alpha/init-steps').map((c) => c.body))
      .toEqual([{ steps: { build: { run: 'pnpm build' } } }]))
    save('{"cycle": {"run": "x", "needs": ["cycle"]}}')
    await screen.findByText('init steps: steps form a cycle: cycle -> cycle')
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

  it('shares a hosted project with another user and stops sharing it', async () => {
    useUiStore.setState({ activeProjectId: 'id-gamma' })
    const whoami: Whoami = {
      kind: 'tailnet', userId: TEST_USER_ID, login: 'me@x.com', name: 'Me',
      users: [{ id: TEST_USER_ID, login: 'me@x.com', name: 'Me', role: 'admin' }, { id: 'u-ada', login: 'ada@x.com', name: 'Ada', role: 'member' }, { id: 'u-bo', login: 'bo@x.com', name: 'Bo', role: 'member' }],
    }
    const gamma = { ...project('gamma', 'http://yaac.internal/api/workspace/git/id-gamma.git'), hosted: true }
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [gamma, { ...gamma, id: 'id-ada-gamma', owner: 'u-ada', sharedFrom: { projectId: 'id-gamma', revoked: false } }],
    })
    const server = mockFetch({
      'GET /api/project/id-gamma/env': { vars: [] },
      'POST /api/project/id-gamma/shares': { id: 'id-bo-gamma', name: 'gamma', remoteUrl: '', addedAt: '' },
      'DELETE /api/project/id-gamma/shares/u-ada': () => undefined,
    })
    renderWithClient(<ProjectSettings />, testQueryClient(whoami, snapshot))

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('gamma')
    screen.getByText('ada@x.com')
    const pick = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Share with' })
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Share with…', 'Bo'])
    fireEvent.change(pick, { target: { value: 'u-bo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(server.called('POST /api/project/id-gamma/shares').map((c) => c.body)).toEqual([{ userId: 'u-bo' }]))

    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Ada' }))
    await waitFor(() => expect(server.called('DELETE /api/project/id-gamma/shares/u-ada')).toHaveLength(1))
  })

  it('warns what a move stops and hands over, then moves the project with the chosen credential', async () => {
    useUiStore.setState({ activeProjectId: 'id-gamma' })
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [{ ...project('gamma', 'http://yaac.internal/api/workspace/git/id-gamma.git'), hosted: true }],
    })
    const token = { id: 'c-token', name: 'gh', kind: 'https', preview: '***abcd', projects: [] } as const
    const server = mockFetch({
      'GET /api/project/id-gamma/env': { vars: [] },
      'GET /api/auth/list': { gitCredentials: [token], toolAuth: [] },
      'GET /api/project/id-gamma/move': { runningWorkspaces: 2, sharedWith: ['ada@x.com'] },
      'POST /api/project/id-gamma/move': { knownHostsEntry: null },
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    fireEvent.click(screen.getByRole('button', { name: 'Move…' }))
    const warning = await screen.findByRole('note', { name: 'What moving does' })
    await waitFor(() => expect(warning.textContent).toContain('2 running workspaces on this project stop first, whoever owns them'))
    expect(warning.textContent).toContain('It is shared with ada@x.com')
    expect(warning.textContent).toContain('yaac keeps its own copy')
    fireEvent.change(screen.getByRole('textbox', { name: 'Repository URL' }), { target: { value: 'https://github.com/o/gamma.git' } })
    fireEvent.change(await screen.findByRole('combobox', { name: 'Git credential' }), { target: { value: 'c-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop 2 workspaces and move' }))
    await waitFor(() => expect(server.called('POST /api/project/id-gamma/move').map((c) => c.body))
      .toEqual([{ remoteUrl: 'https://github.com/o/gamma.git', gitCredentialId: 'c-token' }]))
  })

  it("shows how to compare a moved project's old repository with its remote, and removes it once confirmed", async () => {
    useUiStore.setState({ activeProjectId: 'id-gamma' })
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [{ ...project('gamma', 'https://github.com/o/gamma.git'), keepsHostedRepo: true }],
    })
    const server = mockFetch({
      'GET /api/project/id-gamma/env': { vars: [] },
      'DELETE /api/project/id-gamma/hosted-repo': () => undefined,
    })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    expect(screen.queryByRole('button', { name: 'Move…' })).toBeNull()
    screen.getByText(`git ls-remote ${window.location.origin}/api/project/id-gamma/git`)
    screen.getByText('git ls-remote https://github.com/o/gamma.git')
    fireEvent.click(screen.getByRole('button', { name: 'Remove yaac\'s copy…' }))
    expect(server.called('DELETE /api/project/id-gamma/hosted-repo')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(server.called('DELETE /api/project/id-gamma/hosted-repo')).toHaveLength(1))
  })

  it("shows a share as its sharer's, with the guard left to them and no sharing of its own", () => {
    useUiStore.setState({ activeProjectId: 'id-mine' })
    const whoami: Whoami = {
      kind: 'tailnet', userId: TEST_USER_ID, login: 'me@x.com', name: 'Me',
      users: [{ id: TEST_USER_ID, login: 'me@x.com', name: 'Me', role: 'admin' }, { id: 'u-ada', login: 'ada@x.com', name: 'Ada', role: 'member' }],
    }
    const hosted = { ...project('gamma', 'http://yaac.internal/api/workspace/git/x.git'), hosted: true }
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [
        { ...hosted, id: 'id-gamma', owner: 'u-ada' },
        { ...hosted, id: 'id-mine', sharedFrom: { projectId: 'id-gamma', revoked: false } },
      ],
    })
    mockFetch({ 'GET /api/project/id-mine/env': { vars: [] } })
    renderWithClient(<ProjectSettings />, testQueryClient(whoami, snapshot))

    screen.getByText('Shared by Ada')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Protect the default branch/ }).disabled).toBe(true)
    expect(screen.queryByText('Sharing')).toBeNull()
  })

  it('shows a share its source\'s owner removed to its owner read-only', () => {
    useUiStore.setState({ activeProjectId: 'id-mine' })
    const hosted = { ...project('gamma', 'http://yaac.internal/api/workspace/git/x.git'), hosted: true }
    const snapshot = serverSnapshot({
      driver: 'containerless',
      projects: [{ ...hosted, id: 'id-mine', sharedFrom: { projectId: 'id-gamma', revoked: true } }],
    })
    mockFetch({ 'GET /api/project/id-mine/env': { vars: [] } })
    renderWithClient(<ProjectSettings />, testQueryClient(undefined, snapshot))

    screen.getByText('Sharing removed')
    expect(screen.queryByPlaceholderText('NAME')).toBeNull()
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

    // Init steps, Dockerfile and a build file read, with nothing to save or
    // upload, and the launch settings shown but not editable.
    await waitFor(() => expect(screen.getAllByLabelText('editor')).toHaveLength(2))
    fireEvent.click(await screen.findByRole('button', { name: 'init.lua' }))
    await waitFor(() => expect(screen.getAllByLabelText('editor')).toHaveLength(3))
    expect(screen.queryByRole('button', { name: 'Add forwarded port' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add cache volume' })).toBeNull()
    expect(screen.getAllByRole<HTMLInputElement>('checkbox').every((c) => c.disabled)).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rename init.lua' })).toBeNull()
    expect(server.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
})

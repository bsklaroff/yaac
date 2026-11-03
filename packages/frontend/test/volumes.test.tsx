import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { VolumeEntry } from '@yaac/shared/types'
import { Volumes } from '#components/settings/Volumes'
import { VolumeBadge } from '#components/VolumeBadge'
import { useUiStore } from '#lib/store'
import {
  mockFetch, renderWithClient, serverError, serverSnapshot, testQueryClient, type FetchCall, type FetchMock,
} from './harness'

/*
 * A project's workspace volumes in the webapp: the settings section that
 * lists, creates, resizes and deletes them, and the workspace header's
 * label for the one it holds. The picker and the restart-without-volume
 * path are in new-workspace-pane and workspace-view-create.
 */

const LIST = 'GET /api/volume/list'

let volumes: VolumeEntry[]
let server: FetchMock
const initial = useUiStore.getState()
beforeEach(() => {
  volumes = [
    {
      name: 'db', size: '5Gi', createdAt: '2026-11-01T00:00:00.000Z', stoppedWorkspaces: [],
      holder: { workspaceId: 'w-live0001', title: 'Serve the app', attachedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
    },
    {
      name: 'cache', size: '10Gi', createdAt: '2026-11-01T00:00:00.000Z',
      stoppedWorkspaces: [{ workspaceId: 'w-old00001', title: 'Old run' }, { workspaceId: 'w-untitled' }],
    },
  ]
  // A server that keeps its volumes in `volumes`, and refuses a resize as
  // a kind cluster does.
  server = mockFetch({
    [LIST]: () => volumes,
    'POST /api/volume/create': ({ body }: FetchCall) => {
      const { name, size } = body as { name: string; size?: string }
      volumes = [...volumes, { name, size: size ?? '10Gi', createdAt: '', stoppedWorkspaces: [] }]
      return undefined
    },
    'POST /api/volume/resize': serverError('NOT_SUPPORTED', 'volumes on a kind cluster have no size', 501),
    'POST /api/volume/delete': ({ body }: FetchCall) => {
      const { name } = body as { name: string }
      if (name === 'db') return serverError('VOLUME_HELD', 'volume "db" is attached to a running workspace', 409)
      volumes = volumes.filter((v) => v.name !== name)
      return undefined
    },
  })
})
afterEach(() => {
  cleanup()
  useUiStore.setState(initial, true)
})

const client = (driver: 'k8s' | 'containerless' = 'k8s') => testQueryClient(undefined, serverSnapshot({ driver }))

describe('Volumes settings', () => {
  it('lists each volume with its holder and stopped workspaces, and creates, resizes and deletes', async () => {
    renderWithClient(<Volumes projectId="proj" readOnly={false} />, client())
    expect(await screen.findByText('db')).toBeTruthy()
    expect(server.called(LIST)[0].query.get('project')).toBe('proj')
    expect(screen.getByText('db').closest('.rounded-md')?.textContent)
      .toBe('db5GiResizeAttached to running Serve the app 5m ago')
    expect(screen.getByText('cache').closest('.rounded-md')?.textContent)
      .toBe('cache10GiResizeFree · restarts with it: Old run, w-untitl')

    // Create, with the default size left to the server.
    fireEvent.change(screen.getByLabelText('Volume name'), { target: { value: ' uploads ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('uploads')).toBeTruthy()
    expect(server.called('POST /api/volume/create')[0].body).toEqual({ project: 'proj', name: 'uploads' })
    expect(screen.getByLabelText<HTMLInputElement>('Volume name').value).toBe('')

    // A refused resize shows the server's reason and keeps the box open.
    fireEvent.click(screen.getAllByRole('button', { name: 'Resize' })[1])
    fireEvent.change(screen.getByLabelText('New size of cache'), { target: { value: '20Gi' } })
    fireEvent.keyDown(screen.getByLabelText('New size of cache'), { key: 'Enter' })
    expect(await screen.findByText('volumes on a kind cluster have no size')).toBeTruthy()
    expect(server.called('POST /api/volume/resize')[0].body).toEqual({ project: 'proj', name: 'cache', size: '20Gi' })
    fireEvent.keyDown(screen.getByLabelText('New size of cache'), { key: 'Escape' })
    expect(screen.queryByLabelText('New size of cache')).toBeNull()

    // Delete asks first; a held volume's refusal shows in the dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Delete volume db' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('volume "db" is attached to a running workspace')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Delete volume cache' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('cache')).toBeNull())
    expect(server.called('POST /api/volume/delete').map((c) => c.body))
      .toEqual([{ project: 'proj', name: 'db' }, { project: 'proj', name: 'cache' }])
  })

  it('opens a linked workspace in place of settings', async () => {
    useUiStore.getState().openSettings()
    renderWithClient(<Volumes projectId="proj" readOnly={false} />, client())
    fireEvent.click(await screen.findByRole('button', { name: 'Old run' }))
    const st = useUiStore.getState()
    expect(st.settingsOpen).toBe(false)
    expect([st.activeProjectId, st.selectedWorkspaceId]).toEqual(['proj', 'w-old00001'])
  })

  it('only lists them for a teammate', async () => {
    renderWithClient(<Volumes projectId="proj" readOnly />, client())
    expect(await screen.findByText('db')).toBeTruthy()
    expect(screen.queryByLabelText('Volume name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resize' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete volume db' })).toBeNull()
  })
})

describe('VolumeBadge', () => {
  it('names the volume the workspace holds, and nothing on a server without volumes', async () => {
    renderWithClient(<>
      <VolumeBadge projectId="proj" workspaceId="w-live0001" />
      <VolumeBadge projectId="proj" workspaceId="w-old00001" />
    </>, client())
    expect(await screen.findByText('db')).toBeTruthy()
    expect(screen.queryByText('cache')).toBeNull()

    cleanup()
    renderWithClient(<VolumeBadge projectId="proj" workspaceId="w-live0001" />, client('containerless'))
    expect(screen.queryByText('db')).toBeNull()
    expect(server.called(LIST)).toHaveLength(1)
  })
})

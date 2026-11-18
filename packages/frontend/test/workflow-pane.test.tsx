import { useState, type JSX } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { RoutineEntry, SiteSummary, WorkflowEntry, WorkflowSummary } from '@yaac/shared/types'
import { WorkflowPane } from '#components/WorkflowPane'
import { useUiStore } from '#lib/store'
import {
  mockFetch, projectRepo, renderWithClient, serverError, serverSnapshot, testQueryClient, type FetchCall, type FetchMock,
} from './harness'

/*
 * A named workflow's pane (docs/workflows.md): its steps, repos, run
 * secrets and approvals, what runs it, Run now, the "Run at workspace
 * start" switch, and its editor, which also makes a new one. Its sidebar
 * row is in workspace-list; the new-workspace pane's Workflow tab in
 * new-workspace-pane.
 */

const DEPLOY: WorkflowSummary = {
  id: 'wf-deploy', projectId: 'proj', name: 'deploy', createdAt: '', init: false, secrets: ['TOKEN'], repos: ['web'],
  steps: { build: { run: ['pnpm build'] }, serve: { run: ['pnpm start'], needs: ['build'], service: true } },
}
const NIGHTLY = { id: 'r1', projectId: 'proj', name: 'Nightly deploy', workflow: 'deploy' } as RoutineEntry
const DOCS = { id: 's1', projectId: 'proj', name: 'docs', workflow: 'deploy' } as SiteSummary

type Body = Record<string, unknown>
let server: FetchMock
const sent = (route: string): Body[] => server.called(route).map((c) => c.body as Body)

const initial = useUiStore.getState()
beforeEach(() => {
  useUiStore.setState(initial, true)
  useUiStore.setState({ activeProjectId: 'proj' })
  server = mockFetch({
    'GET /api/workflow/show': (): WorkflowEntry => ({ ...DEPLOY, approvedCommits: ['0123456789abcdef0123'], approvedBranches: ['main'] }),
    'GET /api/project/proj/run-secrets': { secrets: [{ id: 'rs1', name: 'TOKEN', hasValue: true }] },
    'POST /api/workflow/edit': ({ body }: FetchCall) => ({ ...DEPLOY, ...(body as Body), approvedCommits: [], approvedBranches: [] }),
    'POST /api/workflow/create': ({ body }: FetchCall) => ({ ...DEPLOY, id: 'wf-new', ...(body as Body), approvedCommits: [], approvedBranches: [] }),
    'POST /api/workflow/delete': () => serverError('CONFLICT', 'site "docs" runs workflow "deploy"', 409),
    'POST /api/workspace/create': ({ body }: FetchCall) => (
      { type: 'result', result: { workspaceId: (body as Body).workspaceId, jobName: 'job' } }),
  })
})
afterEach(cleanup)

function mount(workflow: WorkflowSummary | undefined, editing = false): void {
  const client = testQueryClient(undefined, serverSnapshot({
    projects: [{ ...serverSnapshot().projects[0], id: 'proj', name: 'proj', repos: [projectRepo({ id: 'r-web', dir: 'web' })] }],
    workflows: [DEPLOY],
    routines: [NIGHTLY],
    sites: [DOCS],
    workspaceGroups: [{
      groupId: 'g-deploy', projectId: 'proj', name: 'deploy', owner: { kind: 'workflow', id: 'wf-deploy' }, pinned: false,
      createdAt: '', stoppedCount: 0, deaths: 0, deathsSeenBy: {},
    }],
  }))
  function WithBar(): JSX.Element {
    const [bar, setBar] = useState<HTMLElement | null>(null)
    return (
      <>
        <header ref={setBar} />
        <WorkflowPane projectId="proj" {...(workflow !== undefined ? { workflow } : {})} editing={editing} bar={bar} />
      </>
    )
  }
  renderWithClient(<WithBar />, client)
}

describe('WorkflowPane', () => {
  it('shows its steps, secrets, approvals and what runs it, runs it now, and marks it to run at workspace start', async () => {
    mount(DEPLOY)
    expect(screen.getByText('pnpm build')).toBeTruthy()
    expect(screen.getByText('service')).toBeTruthy()
    expect(screen.getByText('after build')).toBeTruthy()
    expect(screen.getByText('TOKEN')).toBeTruthy()
    expect(await screen.findByText('0123456789ab, branch main')).toBeTruthy()

    // What runs it links to its pane.
    fireEvent.click(screen.getByRole('button', { name: 'Routine Nightly deploy' }))
    expect(useUiStore.getState().selectedObject).toEqual({ kind: 'routine', id: 'r1' })
    expect(screen.getByRole('button', { name: 'Site docs' })).toBeTruthy()

    // Run now: unattended, on its repos' default branches, in its group.
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }))
    await waitFor(() => expect(sent('POST /api/workspace/create')).toHaveLength(1))
    expect(sent('POST /api/workspace/create')[0]).toMatchObject({
      project: 'proj', workflow: 'deploy', nonInteractive: true, repos: [{ repo: 'r-web' }], group: 'g-deploy',
    })
    expect(sent('POST /api/workspace/create')[0]).not.toHaveProperty('sessionId')

    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(sent('POST /api/workflow/edit')).toEqual([{ project: 'proj', name: 'deploy', init: true }]))

    // Run… opens the Workflow tab on it.
    fireEvent.click(screen.getByRole('button', { name: 'Run…' }))
    expect(useUiStore.getState().newWorkspace).toMatchObject({ kind: 'workflow', workflow: 'deploy' })
  })

  it('edits its whole graph with its secrets and repos, and makes a new one', async () => {
    mount(DEPLOY, true)
    const steps = screen.getByLabelText<HTMLTextAreaElement>('Workflow steps')
    expect(JSON.parse(steps.value)).toEqual(DEPLOY.steps)
    fireEvent.change(steps, { target: { value: '{"build": {"run": "make"}}' } })
    expect(within(screen.getByRole('group', { name: 'Run secrets it gets' })).getByRole<HTMLInputElement>('checkbox', { name: 'TOKEN' }).checked)
      .toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(sent('POST /api/workflow/edit')).toHaveLength(1))
    expect(sent('POST /api/workflow/edit')[0]).toEqual({
      project: 'proj', name: 'deploy', steps: { build: { run: 'make' } }, secrets: ['TOKEN'], repos: ['web'], init: false,
    })
    expect(useUiStore.getState().selectedObject).toEqual({ kind: 'workflow', id: 'wf-deploy' })
    cleanup()

    // A new one starts on the project's lone repo, and opens once made.
    mount(undefined)
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: ' lint ' } })
    fireEvent.change(screen.getByLabelText('Workflow steps'), { target: { value: '{"lint": {"run": "pnpm lint"}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create workflow' }))
    await waitFor(() => expect(sent('POST /api/workflow/create')).toHaveLength(1))
    expect(sent('POST /api/workflow/create')[0]).toMatchObject({ name: 'lint', repos: ['web'], secrets: [] })
    await waitFor(() => expect(useUiStore.getState().selectedObject).toEqual({ kind: 'workflow', id: 'wf-new' }))
  })

  it('says why a workflow cannot be deleted, and shows a teammate\'s read-only', async () => {
    mount(DEPLOY)
    fireEvent.click(screen.getByRole('button', { name: 'Workflow actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('site "docs" runs workflow "deploy"')).toBeTruthy()
    cleanup()

    useUiStore.setState({ viewedUserId: 'u-teammate' })
    mount(DEPLOY)
    expect(screen.getByText('pnpm build')).toBeTruthy()
    for (const name of [/Run now/, 'Run…', 'Workflow actions']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByRole<HTMLInputElement>('switch').disabled).toBe(true)
  })
})

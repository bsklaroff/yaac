import { useState, type FormEvent, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Menu } from '@base-ui/react/menu'
import { ContainerlessBadge } from '#components/ContainerlessBadge'
import { useRunSecrets } from '#components/settings/ProjectRunSecrets'
import { ConfirmDialog } from '#components/ui/ConfirmDialog'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { MENU_ITEM, MenuPopup } from '#components/ui/menu'
import { api } from '#lib/api'
import { MoreIcon, RunIcon, WorkflowIcon } from '#lib/icons'
import { parseSteps } from '#lib/steps'
import { useCreateWorkspace } from '#lib/useCreateDefaults'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore } from '#lib/store'
import { useReadOnly } from '#lib/viewer'
import type { ProjectSummary, WorkflowSummary } from '@yaac/shared/types'

export const BAR_BUTTON = 'no-drag flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-text-dim '
  + 'transition hover:bg-surface-2 hover:text-text'

const INPUT = 'rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-text outline-none '
  + 'focus:border-border-strong'

/** What can be done to a named workflow, from its sidebar row or its pane. */
export interface WorkflowActions {
  /** Start an unattended run now, with each of its repos at its default
   *  branch. The run gets its run secrets, and starting it approves those
   *  commits for them (docs/workflows.md "Approvals"). */
  runNow: () => void
  /** Open the new-workspace pane on the Workflow tab, to pick branches or
   *  a start time first; `schedule` opens it as a routine. */
  openRun: (schedule?: boolean) => void
  /** Open an agent workspace that starts with its steps, to debug them. */
  runInteractively: () => void
  edit: () => void
  /** Ask, then delete. */
  remove: () => void
  error: string | null
  /** The delete confirmation, to render beside the controls. */
  dialog: JSX.Element
}

export function useWorkflowActions(workflow: WorkflowSummary): WorkflowActions {
  const snapshot = useSnapshot()
  const createWorkspace = useCreateWorkspace()
  const openNewWorkspace = useUiStore((s) => s.openNewWorkspace)
  const openObject = useUiStore((s) => s.openObject)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { projectId, name } = workflow
  const project = snapshot?.projects.find((p) => p.id === projectId)
  const group = snapshot?.workspaceGroups.find((g) => g.owner?.kind === 'workflow' && g.owner.id === workflow.id)
  return {
    runNow: () => createWorkspace({
      projectId,
      workflow: name,
      nonInteractive: true,
      ...(workflow.repos.length > 0 ? { repos: workflowRepos(project, workflow) } : {}),
      ...(group !== undefined ? { groupId: group.groupId } : {}),
    }),
    openRun: (schedule) => openNewWorkspace({ projectId, kind: 'workflow', workflow: name, ...(schedule === true ? { schedule } : {}) }),
    runInteractively: () => openNewWorkspace({ projectId, workflow: name }),
    edit: () => openObject(projectId, { kind: 'workflow', id: workflow.id, edit: true }),
    remove: () => setConfirmDelete(true),
    error,
    dialog: (
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete workflow “${name}”?`}
        description="Its approvals go with it. Runs already started keep going. A routine, site or queued workspace that runs it must be changed first."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          setConfirmDelete(false)
          setError(null)
          api.workflow.delete.$post({ json: { project: projectId, name } })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        }}
      />
    ),
  }
}

/** A workflow's repos as a start names them, each at its default branch. */
export function workflowRepos(project: ProjectSummary | undefined, workflow: WorkflowSummary): Array<{ repo: string }> {
  return workflow.repos.map((dir) => ({ repo: project?.repos.find((r) => r.dir === dir)?.id ?? dir }))
}

/**
 * A named workflow in the main pane (docs/workflows.md), opened from its
 * sidebar row. The bar holds Run now and Run…, and Edit, Schedule and
 * Delete. The body shows its steps, repos and run secrets, whether it runs
 * at workspace start, whether an agent wrote it, what people approved it
 * to run on, and what runs it.
 * Its runs are the rows under it in the sidebar. With `workflow` absent it
 * is the form for a new one.
 */
export function WorkflowPane({ projectId, workflow, editing, bar }: {
  projectId: string
  workflow?: WorkflowSummary
  /** Open on the editor. */
  editing: boolean
  bar: HTMLElement | null
}): JSX.Element {
  const snapshot = useSnapshot()
  const project = snapshot?.projects.find((p) => p.id === projectId)
  const openObject = useUiStore((s) => s.openObject)
  const select = useUiStore((s) => s.selectWorkspace)
  const readOnly = useReadOnly()
  const done = (w?: { id: string; name: string }): void => {
    if (w !== undefined) openObject(projectId, { kind: 'workflow', id: w.id })
    else if (workflow !== undefined) openObject(projectId, { kind: 'workflow', id: workflow.id })
    else select(null)
  }

  if (workflow === undefined || editing) {
    return (
      <div className="h-full overflow-y-auto bg-bg px-4 py-6">
        {bar !== null && createPortal(
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <WorkflowIcon size={12} className="shrink-0 text-text-faint" />
            <h2 className="min-w-0 truncate font-medium text-text">
              {workflow !== undefined ? `Edit “${workflow.name}”` : 'New workflow'}
            </h2>
          </span>,
          bar,
        )}
        <div className="mx-auto max-w-2xl">
          {project !== undefined && (
            <WorkflowForm
              key={workflow?.id ?? ''}
              project={project}
              {...(workflow !== undefined ? { workflow } : {})}
              onDone={done}
              onCancel={() => done()}
            />
          )}
        </div>
      </div>
    )
  }
  return <WorkflowDetail workflow={workflow} readOnly={readOnly} bar={bar} />
}

function WorkflowDetail({ workflow, readOnly, bar }: {
  workflow: WorkflowSummary
  readOnly: boolean
  bar: HTMLElement | null
}): JSX.Element {
  const snapshot = useSnapshot()
  const actions = useWorkflowActions(workflow)
  const { projectId, name } = workflow
  // Read again whenever a run of it starts or stops: a run by hand or a
  // queued one a person saved approves the commits it runs.
  const group = snapshot?.workspaceGroups.find((g) => g.owner?.kind === 'workflow' && g.owner.id === workflow.id)
  const runs = group === undefined ? '' : [...snapshot?.workspaces ?? [], ...snapshot?.provisioning ?? []]
    .filter((w) => w.groupId === group.groupId).map((w) => w.workspaceId).join(',')
  const { data: detail } = useQuery({
    queryKey: ['workflow', projectId, name, workflow.init, workflow.steps, runs, group?.stoppedCount],
    queryFn: () => api.workflow.show.$get({ query: { project: projectId, name } }),
  })
  const setInit = useMutation({
    mutationFn: (init: boolean) => api.workflow.edit.$post({ json: { project: projectId, name, init } }),
  })
  const routines = (snapshot?.routines ?? []).filter((r) => r.projectId === projectId && r.workflow === name)
  const sites = (snapshot?.sites ?? []).filter((s) => s.projectId === projectId && s.workflow === name)
  const openObject = useUiStore((s) => s.openObject)
  const approved = detail === undefined ? undefined
    : [...detail.approvedCommits.map((c) => c.slice(0, 12)), ...detail.approvedBranches.map((b) => `branch ${b}`)]

  return (
    <div className="h-full overflow-y-auto bg-bg px-4 py-6">
      {bar !== null && createPortal(
        <>
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <WorkflowIcon size={12} className="shrink-0 text-text-faint" />
            <h2 className="min-w-0 truncate font-medium text-text">{name}</h2>
            {actions.error !== null && <span className="truncate text-danger" title={actions.error}>{actions.error}</span>}
          </span>
          <ContainerlessBadge />
          {!readOnly && <>
            <button type="button" onClick={actions.runNow} title="Run it unattended now, on its repos' default branches" className={BAR_BUTTON}>
              <RunIcon size={11} /> Run now
            </button>
            <button type="button" onClick={() => actions.openRun()} title="Pick branches, a start time or a group first" className={BAR_BUTTON}>
              Run…
            </button>
            <Menu.Root>
              <Menu.Trigger aria-label="Workflow actions" title="Workflow actions" className={BAR_BUTTON}>
                <MoreIcon size={14} />
              </Menu.Trigger>
              <MenuPopup side="bottom" align="end" sideOffset={4} className="min-w-[170px]">
                <Menu.Item className={MENU_ITEM} onClick={actions.edit}>Edit…</Menu.Item>
                <Menu.Item className={MENU_ITEM} onClick={() => actions.openRun(true)}>Schedule…</Menu.Item>
                <Menu.Item className={MENU_ITEM} onClick={actions.runInteractively}>Run interactively…</Menu.Item>
                <Menu.Item className={MENU_ITEM} onClick={actions.remove}>Delete…</Menu.Item>
              </MenuPopup>
            </Menu.Root>
            {actions.dialog}
          </>}
        </>,
        bar,
      )}
      <div className="mx-auto flex max-w-2xl flex-col gap-5 text-xs">
        <Section title="Steps">
          <StepList steps={workflow.steps} />
        </Section>

        <Section title="Runs in">
          <p className="text-text-dim">
            {workflow.repos.length === 0 ? 'The workspace’s working directory: it names no repo.'
              : workflow.repos.length === 1 ? <>The checkout of <code className="text-text">{workflow.repos[0]}</code>.</>
              : <>The workspace root, beside {workflow.repos.map((r) => <code key={r} className="mr-1 text-text">{r}</code>)}</>}
          </p>
          <label className="mt-1 flex w-fit items-center gap-2 text-text-dim">
            <input
              type="checkbox"
              role="switch"
              checked={setInit.isPending ? setInit.variables : workflow.init}
              disabled={readOnly || setInit.isPending}
              onChange={(e) => setInit.mutate(e.target.checked)}
            />
            Run at workspace start, in every workspace with its repos that brings no steps of its own
          </label>
          {setInit.error && <p className="text-danger">{setInit.error.message}</p>}
        </Section>

        <Section title="Run secrets">
          {workflow.secrets.length === 0 ? <p className="text-text-faint">None.</p> : (
            <>
              <p className="font-mono text-text">{workflow.secrets.join(', ')}</p>
              <p className="text-text-faint">
                An unattended run gets them only on commits a person approved for exactly this content. Running it
                by hand, or a run a person queued, approves the commits it runs; saving a routine approves the
                branch or commit it starts at. The project&apos;s agents may write workflows too.
              </p>
              {workflow.writtenByAgent === true && (
                <p className="text-warning">
                  Written by an agent: its runs with secrets wait for your review, and saving it here approves it.
                </p>
              )}
              {approved !== undefined && (
                <p className="text-text-dim">Approved: {approved.length > 0 ? <span className="font-mono">{approved.join(', ')}</span> : 'nothing yet'}</p>
              )}
            </>
          )}
        </Section>

        {(routines.length > 0 || sites.length > 0) && (
          <Section title="Run by">
            <ul className="flex flex-col">
              {routines.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => openObject(projectId, { kind: 'routine', id: r.id })} className={TEXT_BUTTON}>
                    Routine {r.name}
                  </button>
                </li>
              ))}
              {sites.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => openObject(projectId, { kind: 'site', id: s.id })} className={TEXT_BUTTON}>
                    Site {s.name}
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  )
}

/** A step graph, one step a line: its name, what it runs and what it waits
 *  for. */
export function StepList({ steps }: { steps: WorkflowSummary['steps'] }): JSX.Element {
  const names = Object.keys(steps)
  if (names.length === 0) return <p className="text-text-faint">No steps.</p>
  return (
    <ul className="flex flex-col gap-1.5">
      {names.map((n) => {
        const spec = steps[n]
        return (
          <li key={n} className="rounded-md bg-surface px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <span className="font-mono font-medium text-text">{n}</span>
              {spec.service === true && <span className="rounded bg-surface-3 px-1 text-[10px] text-text-dim">service</span>}
              {spec.needs !== undefined && spec.needs.length > 0 && (
                <span className="text-text-faint">after {spec.needs.join(', ')}</span>
              )}
            </div>
            <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[11px] text-text-dim">{spec.run.join('\n')}</pre>
          </li>
        )
      })}
    </ul>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-faint">{title}</h3>
      {children}
    </section>
  )
}

/**
 * Create a workflow, or edit `workflow`, sending the whole graph with its
 * secrets and repos: what a person saves here is what they approve
 * (docs/workflows.md "Approvals"). `onDone` gets the workflow it saved.
 */
function WorkflowForm({ project, workflow, onDone, onCancel }: {
  project: ProjectSummary
  workflow?: WorkflowSummary
  onDone: (saved: { id: string; name: string }) => void
  onCancel: () => void
}): JSX.Element {
  const projectId = project.id
  const { data: runSecrets } = useRunSecrets(projectId)
  const [name, setName] = useState('')
  const [steps, setSteps] = useState(workflow !== undefined ? `${JSON.stringify(workflow.steps, null, 2)}\n` : '')
  const [secrets, setSecrets] = useState(workflow?.secrets ?? [])
  const [chosen, setChosen] = useState(workflow?.repos ?? (project.repos.length === 1 ? [project.repos[0].dir] : []))
  const [atStart, setAtStart] = useState(workflow?.init ?? false)
  // A named secret that was since deleted stays listed, so it can be unticked.
  const offered = [...new Set([...runSecrets?.map((s) => s.name) ?? [], ...workflow?.secrets ?? []])]
  const toggle = (list: string[], item: string): string[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])

  const save = useMutation({
    mutationFn: async () => {
      const body = { project: projectId, steps: parseSteps(steps), secrets, repos: chosen, init: atStart }
      return workflow !== undefined
        ? await api.workflow.edit.$post({ json: { ...body, name: workflow.name } })
        : await api.workflow.create.$post({ json: { ...body, name: name.trim() } })
    },
    onSuccess: (saved) => onDone(saved),
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 text-xs">
      {workflow === undefined && (
        <label className="flex flex-col gap-1">
          <span className="font-medium text-text">Name</span>
          <input
            aria-label="Workflow name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="deploy"
            className={INPUT}
          />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="font-medium text-text">Steps</span>
        <span className="text-[11px] text-text-faint">
          JSON: each step <code className="text-text-dim">{'{"run": "<cmd>" or ["<cmd>", …], "needs": [...]}'}</code>, with{' '}
          <code className="text-text-dim">{'"service": true'}</code> and a <code className="text-text-dim">ready</code> check for one
          that keeps running.
        </span>
        <textarea
          aria-label="Workflow steps"
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          placeholder={'{\n  "install": { "run": "pnpm install" },\n  "deploy": { "run": "pnpm deploy", "needs": ["install"] }\n}'}
          rows={12}
          spellCheck={false}
          className={`${INPUT} block w-full resize-y`}
        />
      </label>
      {project.repos.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium text-text">Repos</legend>
          <p className="text-[11px] text-text-faint">
            Its steps start in their checkout (the workspace root for several), and it runs only in a workspace with each.
          </p>
          {[...new Set([...project.repos.map((r) => r.dir), ...chosen])].map((dir) => (
            <label key={dir} className="flex items-center gap-2 font-mono text-text">
              <input type="checkbox" checked={chosen.includes(dir)} onChange={() => setChosen(toggle(chosen, dir))} />
              {dir}
            </label>
          ))}
        </fieldset>
      )}
      <label className="flex items-center gap-2 text-text">
        <input type="checkbox" role="switch" checked={atStart} onChange={() => setAtStart(!atStart)} />
        Run at workspace start
      </label>
      {offered.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium text-text">Run secrets it gets</legend>
          {offered.map((s) => (
            <label key={s} className="flex items-center gap-2 font-mono text-text">
              <input type="checkbox" checked={secrets.includes(s)} onChange={() => setSecrets(toggle(secrets, s))} />
              {s}
            </label>
          ))}
        </fieldset>
      )}
      {save.error && <p className="text-red-400">{save.error.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={TEXT_BUTTON}>Cancel</button>
        <button
          type="submit"
          disabled={save.isPending || (workflow === undefined && name.trim() === '')}
          className={BUTTON}
        >
          {save.isPending ? 'Saving…' : workflow !== undefined ? 'Save workflow' : 'Create workflow'}
        </button>
      </div>
    </form>
  )
}

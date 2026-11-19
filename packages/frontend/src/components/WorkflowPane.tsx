import { useState, type FormEvent, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ContainerlessBadge } from '#components/ContainerlessBadge'
import { useRunSecrets } from '#components/settings/ProjectRunSecrets'
import { api } from '#lib/api'
import { MoreIcon, RoutineIcon, RunIcon, SiteIcon, WorkflowIcon } from '#lib/icons'
import { parseSteps } from '#lib/steps'
import { useCreateWorkspace } from '#lib/useCreateDefaults'
import { useSnapshot } from '#lib/useSnapshot'
import { useUiStore } from '#lib/store'
import { useReadOnly } from '#lib/viewer'
import type { ProjectSummary, WorkflowSummary } from '@yaac/shared/types'
import {
  YBadge, YButton, YCallout, YCheckbox, YConfirm, YInput, YListRow, YMenu, YMenuItem, YMenuPopup, YPageBody, YSection, YSettingGroup, YSettingRow, YSwitch, YTextArea,
} from '#ui'

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
      <YConfirm
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
      <div className="flex h-full flex-col bg-surface">
        {bar !== null && createPortal(
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <WorkflowIcon size={12} className="shrink-0 text-subtle" />
            <h2 className="min-w-0 truncate font-medium text-text">
              {workflow !== undefined ? `Edit “${workflow.name}”` : 'New workflow'}
            </h2>
          </span>,
          bar,
        )}
        <YPageBody>
          {project !== undefined && (
            <WorkflowForm
              key={workflow?.id ?? ''}
              project={project}
              {...(workflow !== undefined ? { workflow } : {})}
              onDone={done}
              onCancel={() => done()}
            />
          )}
        </YPageBody>
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
    <div className="flex h-full flex-col bg-surface">
      {bar !== null && createPortal(
        <>
          <span className="titlebar-drag flex min-w-0 flex-1 items-center gap-1.5">
            <WorkflowIcon size={12} className="shrink-0 text-subtle" />
            <h2 className="min-w-0 truncate font-medium text-text">{name}</h2>
            {actions.error !== null && <span className="truncate text-danger" title={actions.error}>{actions.error}</span>}
          </span>
          <ContainerlessBadge />
          {!readOnly && <>
            <YButton
              variant="ghost"
              size="sm"
              icon={RunIcon}
              onClick={actions.runNow}
              title="Run it unattended now, on its repos' default branches"
              className="no-drag"
            >
              Run now
            </YButton>
            <YButton
              variant="ghost"
              size="sm"
              onClick={() => actions.openRun()}
              title="Pick branches, a start time or a group first"
              className="no-drag"
            >
              Run…
            </YButton>
            <YMenu.Root>
              <YMenu.Trigger
                render={<YButton variant="ghost" size="sm" icon={MoreIcon} aria-label="Workflow actions" title="Workflow actions" className="no-drag" />}
              />
              <YMenuPopup side="bottom" align="end" sideOffset={4} className="min-w-[170px]">
                <YMenuItem onClick={actions.edit}>Edit…</YMenuItem>
                <YMenuItem onClick={() => actions.openRun(true)}>Schedule…</YMenuItem>
                <YMenuItem onClick={actions.runInteractively}>Run interactively…</YMenuItem>
                <YMenuItem onClick={actions.remove}>Delete…</YMenuItem>
              </YMenuPopup>
            </YMenu.Root>
            {actions.dialog}
          </>}
        </>,
        bar,
      )}
      <YPageBody>
        <YSection title="Steps">
          <StepList steps={workflow.steps} />
        </YSection>

        <YSection
          title="Runs in"
          description={workflow.repos.length === 0 ? 'The workspace’s working directory: it names no repo.'
            : workflow.repos.length === 1 ? <>The checkout of <code className="text-text">{workflow.repos[0]}</code>.</>
            : <>The workspace root, beside {workflow.repos.map((r) => <code key={r} className="mr-1 text-text">{r}</code>)}</>}
        >
          <YSettingGroup>
            <YSettingRow
              label="Run at workspace start"
              hint={<>
                In every workspace with its repos that brings no steps of its own.
                {setInit.error && <span className="block text-danger">{setInit.error.message}</span>}
              </>}
            >
              <YSwitch
                aria-label="Run at workspace start"
                checked={setInit.isPending ? setInit.variables : workflow.init}
                disabled={readOnly || setInit.isPending}
                onCheckedChange={(on) => setInit.mutate(on)}
              />
            </YSettingRow>
          </YSettingGroup>
        </YSection>

        <YSection
          title="Run secrets"
          description={workflow.secrets.length > 0 && <>
            An unattended run gets them only on commits a person approved for exactly this content. Running it by
            hand, or a run a person queued, approves the commits it runs; saving a routine approves the branch or
            commit it starts at. The project&apos;s agents may write workflows too.
          </>}
        >
          {workflow.writtenByAgent === true && (
            <YCallout title="Written by an agent">
              Its runs with secrets wait for your review, and saving it here approves it.
            </YCallout>
          )}
          {workflow.secrets.length === 0 ? <p className="text-md text-subtle">None.</p> : (
            <YSettingGroup>
              <YSettingRow label="Secrets">
                <span className="font-mono text-md text-text">{workflow.secrets.join(', ')}</span>
              </YSettingRow>
              {approved !== undefined && (
                <YSettingRow label="Approved">
                  {approved.length > 0 ? <span className="font-mono text-md text-muted">{approved.join(', ')}</span>
                    : <span className="text-md text-subtle">Nothing yet</span>}
                </YSettingRow>
              )}
            </YSettingGroup>
          )}
        </YSection>

        {(routines.length > 0 || sites.length > 0) && (
          <YSection title="Run by">
            <div className="border-t border-line">
              {routines.map((r) => (
                <YListRow
                  key={r.id}
                  label={`Routine ${r.name}`}
                  onSelect={() => openObject(projectId, { kind: 'routine', id: r.id })}
                  leading={<RoutineIcon size={14} aria-hidden className="ml-1.5 shrink-0 text-subtle" />}
                  title={r.name}
                  sub="Routine"
                />
              ))}
              {sites.map((s) => (
                <YListRow
                  key={s.id}
                  label={`Site ${s.name}`}
                  onSelect={() => openObject(projectId, { kind: 'site', id: s.id })}
                  leading={<SiteIcon size={14} aria-hidden className="ml-1.5 shrink-0 text-subtle" />}
                  title={s.name}
                  sub="Site"
                />
              ))}
            </div>
          </YSection>
        )}
      </YPageBody>
    </div>
  )
}

/** A step graph, one step a line: its name, what it runs and what it waits
 *  for. */
export function StepList({ steps }: { steps: WorkflowSummary['steps'] }): JSX.Element {
  const names = Object.keys(steps)
  if (names.length === 0) return <p className="text-md text-subtle">No steps.</p>
  return (
    <ul className="flex flex-col divide-y divide-line border-y border-line text-md">
      {names.map((n) => {
        const spec = steps[n]
        return (
          <li key={n} className="px-1.5 py-2">
            <div className="flex items-center gap-2">
              <span className="font-mono font-medium text-text">{n}</span>
              {spec.service === true && <YBadge>service</YBadge>}
              {spec.needs !== undefined && spec.needs.length > 0 && (
                <span className="text-subtle">after {spec.needs.join(', ')}</span>
              )}
            </div>
            <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-sm text-muted">{spec.run.join('\n')}</pre>
          </li>
        )
      })}
    </ul>
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
    <form onSubmit={submit} className="flex flex-col gap-3">
      <YSettingGroup>
        {workflow === undefined && (
          <YSettingRow label="Name">
            <YInput
              aria-label="Workflow name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="deploy"
              className="w-56 font-mono"
            />
          </YSettingRow>
        )}
        <YSettingRow
          stacked
          label="Steps"
          hint={<>
            JSON: each step <code className="text-muted">{'{"run": "<cmd>" or ["<cmd>", …], "needs": [...]}'}</code>, with{' '}
            <code className="text-muted">{'"service": true'}</code> and a <code className="text-muted">ready</code> check for one
            that keeps running.
          </>}
        >
          <YTextArea
            aria-label="Workflow steps"
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            placeholder={'{\n  "install": { "run": "pnpm install" },\n  "deploy": { "run": "pnpm deploy", "needs": ["install"] }\n}'}
            rows={12}
            spellCheck={false}
            className="block w-full resize-y font-mono"
          />
        </YSettingRow>
        {project.repos.length > 0 && (
          <YSettingRow
            stacked
            label="Repos"
            hint="Its steps start in their checkout (the workspace root for several), and it runs only in a workspace with each."
          >
            <div role="group" aria-label="Repos" className="flex flex-col gap-1">
              {[...new Set([...project.repos.map((r) => r.dir), ...chosen])].map((dir) => (
                <YCheckbox key={dir} checked={chosen.includes(dir)} onCheckedChange={() => setChosen(toggle(chosen, dir))} className="font-mono">
                  {dir}
                </YCheckbox>
              ))}
            </div>
          </YSettingRow>
        )}
        <YSettingRow label="Run at workspace start">
          <YSwitch aria-label="Run at workspace start" checked={atStart} onCheckedChange={setAtStart} />
        </YSettingRow>
        {offered.length > 0 && (
          <YSettingRow stacked label="Run secrets it gets">
            <div role="group" aria-label="Run secrets it gets" className="flex flex-col gap-1">
              {offered.map((s) => (
                <YCheckbox key={s} checked={secrets.includes(s)} onCheckedChange={() => setSecrets(toggle(secrets, s))} className="font-mono">
                  {s}
                </YCheckbox>
              ))}
            </div>
          </YSettingRow>
        )}
      </YSettingGroup>
      {save.error && <p className="text-md text-danger">{save.error.message}</p>}
      <div className="flex justify-end gap-2">
        <YButton variant="ghost" onClick={onCancel}>Cancel</YButton>
        <YButton
          variant="primary"
          type="submit"
          disabled={save.isPending || (workflow === undefined && name.trim() === '')}
        >
          {save.isPending ? 'Saving…' : workflow !== undefined ? 'Save workflow' : 'Create workflow'}
        </YButton>
      </div>
    </form>
  )
}

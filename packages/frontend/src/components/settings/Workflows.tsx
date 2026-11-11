import { useState, type FormEvent, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { api } from '#lib/api'
import { DeleteIcon } from '#lib/icons'
import { parseSteps } from '#lib/steps'
import { SectionLabel } from '#components/settings/Field'
import { useRunSecrets } from '#components/settings/ProjectRunSecrets'
import { INPUT } from '#components/settings/Volumes'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import type { ProjectRepo, WorkflowEntry } from '@yaac/shared/types'

const workflowsKey = (projectId: string): string[] => ['workflows', projectId]

/** A project's workflows, also offered to its sites. */
export function useWorkflows(projectId: string): UseQueryResult<WorkflowEntry[]> {
  return useQuery({
    queryKey: workflowsKey(projectId),
    queryFn: () => api.workflow.list.$get({ query: { project: projectId } }),
    staleTime: 0,
  })
}

/**
 * A project's workflows (docs/workflows.md): each one's steps, repos and run
 * secrets, whether it runs at workspace start, and the commits and branches
 * people approved it to run on, with create, edit and delete. `init` lists
 * only the init workflows, and adds one marked as such. `readOnly` (a
 * teammate's project) only lists them.
 */
export function Workflows({ projectId, repos, readOnly, init = false }: {
  projectId: string
  repos: ProjectRepo[]
  readOnly: boolean
  init?: boolean
}): JSX.Element {
  const queryClient = useQueryClient()
  const { data: all, error: loadError } = useWorkflows(projectId)
  const workflows = init ? all?.filter((w) => w.init) : all
  // The workflow the form edits, or 'new'.
  const [form, setForm] = useState<WorkflowEntry | 'new' | null>(null)
  const onSettled = (): Promise<void> => queryClient.invalidateQueries({ queryKey: workflowsKey(projectId) })
  const remove = useMutation({
    mutationFn: (name: string) => api.workflow.delete.$post({ json: { project: projectId, name } }),
    onSuccess: (_, name) => { if (form !== 'new' && form?.name === name) setForm(null) },
    onSettled,
  })
  const error = remove.error ?? loadError

  return (
    <div>
      {init ? <>
        <SectionLabel>Init workflows</SectionLabel>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
          The workflows every workspace starts, unless its create brings its own steps, each in a workspace
          that has its repos: steps by name, each{' '}
          <code className="text-text-dim">{'{"run": "<cmd>" or ["<cmd>", …], "needs": [...]}'}</code>, with{' '}
          <code className="text-text-dim">{'"service": true'}</code> and an optional{' '}
          <code className="text-text-dim">ready</code> check for one that keeps running.
        </p>
      </> : <>
        <SectionLabel>Workflows</SectionLabel>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
          Named steps that routines, sites and creates can run, kept here rather than in the repository. The
          run secrets a workflow names reach a run only on commits a person ran it on.
        </p>
      </>}

      {workflows !== undefined && workflows.length > 0 && <div className="mt-3 space-y-1">
        {workflows.map((w) => {
          const approved = [...w.approvedCommits.map((c) => c.slice(0, 12)), ...w.approvedBranches.map((b) => `branch ${b}`)]
          return (
            <div key={w.id} className="rounded-md bg-bg px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-text">{w.name}</span>
                {!readOnly && <>
                  <button
                    type="button"
                    onClick={() => setForm(w)}
                    aria-label={`Edit workflow ${w.name}`}
                    className={TEXT_BUTTON}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(w.name)}
                    disabled={remove.isPending}
                    aria-label={`Delete workflow ${w.name}`}
                    className="shrink-0 text-text-faint transition hover:text-text disabled:opacity-50"
                  >
                    <DeleteIcon size={12} />
                  </button>
                </>}
              </div>
              <div className="mt-0.5 space-y-0.5 font-mono text-[11px] text-text-faint">
                <div>steps: {Object.keys(w.steps).join(', ')}</div>
                <div>repos: {w.repos.length > 0 ? w.repos.join(', ') : 'none (runs in the workspace\'s cwd)'}</div>
                {w.init && <div>runs at workspace start</div>}
                {w.secrets.length > 0 && <div>run secrets: {w.secrets.join(', ')}</div>}
                {approved.length > 0 && <div>approved: {approved.join(', ')}</div>}
              </div>
            </div>
          )
        })}
      </div>}

      {workflows?.length === 0 && <p className="mt-3 text-[11px] text-text-faint">
        {init ? 'No init workflows: workspaces start with no steps.' : 'No workflows yet.'}
      </p>}

      {!readOnly && (form === null ? (
        <button type="button" onClick={() => setForm('new')} className={`${BUTTON} mt-3`}>
          {init ? 'Add init workflow' : 'Add workflow'}
        </button>
      ) : (
        <WorkflowForm
          key={form === 'new' ? '' : form.name}
          projectId={projectId}
          repos={repos}
          init={init}
          {...(form !== 'new' ? { workflow: form } : {})}
          onDone={() => { setForm(null); void onSettled() }}
          onCancel={() => setForm(null)}
        />
      ))}

      {error && <p className="mt-2 text-xs text-red-400">{error.message}</p>}
    </div>
  )
}

/**
 * Create a workflow, or edit `workflow`. An edit always sends the whole
 * graph with the secrets and repos, so a person never gives secrets to
 * steps they did not see (docs/workflows.md "Run secrets"). A new one
 * from the init section starts marked to run at workspace start.
 */
function WorkflowForm({ projectId, repos, init, workflow, onDone, onCancel }: {
  projectId: string
  repos: ProjectRepo[]
  init: boolean
  workflow?: WorkflowEntry
  onDone: () => void
  onCancel: () => void
}): JSX.Element {
  const { data: runSecrets } = useRunSecrets(projectId)
  const [name, setName] = useState('')
  const [steps, setSteps] = useState(workflow !== undefined ? `${JSON.stringify(workflow.steps, null, 2)}\n` : '')
  const [secrets, setSecrets] = useState(workflow?.secrets ?? [])
  const [chosen, setChosen] = useState(workflow?.repos ?? [])
  const [atStart, setAtStart] = useState(workflow?.init ?? init)
  // A named secret that was since deleted stays listed, so it can be unticked.
  const offered = [...new Set([...runSecrets?.map((s) => s.name) ?? [], ...workflow?.secrets ?? []])]
  const toggle = (list: string[], item: string): string[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])

  const save = useMutation({
    mutationFn: async () => {
      const body = { project: projectId, steps: parseSteps(steps), secrets, repos: chosen, init: atStart }
      if (workflow !== undefined) await api.workflow.edit.$post({ json: { ...body, name: workflow.name } })
      else await api.workflow.create.$post({ json: { ...body, name: name.trim() } })
    },
    onSuccess: onDone,
  })
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded-md bg-bg p-2.5">
      <div className="text-[11px] font-medium text-text">
        {workflow !== undefined ? `Edit “${workflow.name}”` : 'New workflow'}
      </div>
      {workflow === undefined && (
        <input
          aria-label="Workflow name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="workflow name"
          className={`${INPUT} w-full`}
        />
      )}
      <textarea
        aria-label="Workflow steps"
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
        placeholder={'{\n  "install": { "run": "pnpm install" },\n  "deploy": { "run": "pnpm deploy", "needs": ["install"] }\n}'}
        rows={8}
        spellCheck={false}
        className={`${INPUT} block w-full resize-y`}
      />
      {repos.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-[11px] text-text-faint">
            Repos its steps are written for: they start in its checkout (the workspace root for several), and it
            runs only in a workspace with each
          </legend>
          {[...new Set([...repos.map((r) => r.dir), ...chosen])].map((dir) => (
            <label key={dir} className="flex items-center gap-2 font-mono text-xs text-text">
              <input type="checkbox" checked={chosen.includes(dir)} onChange={() => setChosen(toggle(chosen, dir))} />
              {dir}
            </label>
          ))}
        </fieldset>
      )}
      <label className="flex items-center gap-2 text-xs text-text">
        <input type="checkbox" role="switch" checked={atStart} onChange={() => setAtStart(!atStart)} />
        Run at workspace start
      </label>
      {offered.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-[11px] text-text-faint">Run secrets it gets</legend>
          {offered.map((s) => (
            <label key={s} className="flex items-center gap-2 font-mono text-xs text-text">
              <input type="checkbox" checked={secrets.includes(s)} onChange={() => setSecrets(toggle(secrets, s))} />
              {s}
            </label>
          ))}
        </fieldset>
      )}
      {save.error && <p className="text-xs text-red-400">{save.error.message}</p>}
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

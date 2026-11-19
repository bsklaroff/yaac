import { useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'
import { StepLog } from '#components/StepLog'
import { GraphOverLog } from '#components/StepPane'
import { byWorkflow } from '#lib/steps'
import { YChip } from '#ui'

/**
 * A stopped workspace's terminal logs (docs/workspace-steps.md "Logs"):
 * each window of its last run, a step's included, as a tab, steps grouped
 * under their workflow, the picked one replayed in a read-only terminal
 * under its workflow's graph.
 * The logs outlive the workspace's runtime until it is deleted.
 */
export function WorkspaceLogs({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { data, isError } = useQuery({
    queryKey: ['workspace-logs', workspaceId],
    queryFn: () => api.workspace[':id'].logs.$get({ param: { id: workspaceId } }),
  })
  const [picked, setPicked] = useState<string | null>(null)
  const last = data?.[0]
  const logs = (last?.files ?? []).filter((f) => f.name.endsWith('.log')).map((f) => f.name)
  const file = picked !== null && logs.includes(picked) ? picked : logs[0]
  const groups = byWorkflow(logs, (name) => name.replace(/\.log$/, ''))
  const shortName = (name: string, workflow: string): string => name.replace(/\.log$/, '').slice(workflow === '' ? 0 : workflow.length + 1)
  // A shell's window shares the '' group with a step of a life from before
  // steps had workflows, so the graph shows only for a window that is in it.
  // Own keys only: a window may be named after an Object.prototype member.
  const workflow = groups.find((g) => file !== undefined && g.items.includes(file))?.workflow ?? ''
  const graph = last !== undefined && Object.hasOwn(last.workflows, workflow) ? last.workflows[workflow] : undefined
  const ran = file !== undefined && graph !== undefined && Object.hasOwn(graph, shortName(file, workflow)) ? graph : undefined
  if (isError || (data !== undefined && file === undefined)) {
    return (
      <p className="flex flex-1 items-center justify-center text-md text-subtle">
        {isError ? 'Its logs could not be loaded.' : 'It kept no logs.'}
      </p>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-1.5 py-1">
        {groups.map((g) => (
          <div key={g.workflow} className="flex shrink-0 items-center gap-0.5" role="group" aria-label={g.workflow || 'Windows'}>
            {g.workflow !== '' && <span className="pl-1 font-mono text-xs text-subtle">{g.workflow}</span>}
            {g.items.map((name) => (
              <YChip key={name} selected={name === file} onClick={() => setPicked(name)} className="font-mono">
                {shortName(name, g.workflow)}
              </YChip>

            ))}
          </div>
        ))}
      </div>
      <GraphOverLog workflow={workflow} graph={ran} logClassName="bg-sunken">
        {last !== undefined && file !== undefined && (
          <StepLog key={`${last.life}/${file}`} workspaceId={workspaceId} life={last.life} file={file} follow={false} />
        )}
      </GraphOverLog>
    </div>
  )
}

import { useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'
import { StepLog } from '#components/StepLog'
import { byWorkflow } from '#lib/steps'
import { YChip } from '#ui'

/**
 * A stopped workspace's terminal logs (docs/workspace-steps.md "Logs"):
 * each window of its last run, a step's included, as a tab, steps grouped
 * under their workflow, the picked one replayed in a read-only terminal.
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
        {byWorkflow(logs, (name) => name.replace(/\.log$/, '')).map((g) => (
          <div key={g.workflow} className="flex shrink-0 items-center gap-0.5" role="group" aria-label={g.workflow || 'Windows'}>
            {g.workflow !== '' && <span className="pl-1 font-mono text-xs text-subtle">{g.workflow}</span>}
            {g.items.map((name) => (
              <YChip key={name} selected={name === file} onClick={() => setPicked(name)} className="font-mono">
                {name.replace(/\.log$/, '').slice(g.workflow === '' ? 0 : g.workflow.length + 1)}
              </YChip>

            ))}
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 bg-sunken px-2.5 py-1.5">
        {last !== undefined && file !== undefined && (
          <StepLog key={`${last.life}/${file}`} workspaceId={workspaceId} life={last.life} file={file} follow={false} />
        )}
      </div>
    </div>
  )
}

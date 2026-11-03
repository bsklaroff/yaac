import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'
import { StepLog } from '#components/StepLog'

/**
 * A stopped workspace's terminal logs (docs/workspace-steps.md "Logs"):
 * each window of its last run, a step's included, as a tab, the picked one
 * replayed in a read-only terminal. The logs outlive the workspace's
 * runtime until it is deleted.
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
      <p className="flex flex-1 items-center justify-center text-xs text-text-faint">
        {isError ? 'Its logs could not be loaded.' : 'It kept no logs.'}
      </p>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto px-1.5 py-1">
        {logs.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setPicked(name)}
            className={clsx('rounded px-2 py-0.5 font-mono text-[11px] transition',
              name === file ? 'bg-surface-3 text-text' : 'text-text-faint hover:text-text-dim')}
          >
            {name.replace(/\.log$/, '')}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 bg-bg px-2.5 py-1.5">
        {last !== undefined && file !== undefined && (
          <StepLog key={`${last.life}/${file}`} workspaceId={workspaceId} life={last.life} file={file} follow={false} />
        )}
      </div>
    </div>
  )
}

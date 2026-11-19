import type { JSX } from 'react'
import { formatCommits } from '@yaac/shared/steps'
import type { LaunchApprovalRequest } from '@yaac/shared/types'

/**
 * What a person approving a privileged launch is shown (docs/workflows.md
 * "Approvals"): whether an agent wrote the workflow, the run secrets it
 * names, each repo's commit, and the whole graph. The approval names this
 * workflow's id, so the server runs exactly this or refuses.
 */
export function ApprovalDetails({ request }: { request: LaunchApprovalRequest }): JSX.Element {
  return (
    <div className="mt-3 space-y-1 text-[11px] text-text-faint">
      {request.writtenByAgent === true && (
        <p className="text-warning">An agent wrote this workflow; no person has approved it yet.</p>
      )}
      <p>Run secrets it gets: <span className="font-mono text-text-dim">{request.secrets.join(', ') || 'none'}</span></p>
      <p>
        Commits: <span className="font-mono text-text-dim">
          {request.commits.length > 0 ? formatCommits(request.commits, 12) : 'none (no repos)'}
        </span>
      </p>
      <pre aria-label="Workflow steps" className="max-h-48 overflow-auto rounded bg-surface-2 p-2 text-[10px] text-text-dim">
        {JSON.stringify(request.steps, null, 2)}
      </pre>
    </div>
  )
}

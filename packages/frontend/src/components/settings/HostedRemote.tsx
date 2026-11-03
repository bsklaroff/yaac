import { useState, type JSX } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '#lib/api'
import { useProjectBranches } from '#lib/useProjectBranches'
import { TEXT_BUTTON } from '#components/ui/button'
import { hostedCloneUrl } from '@yaac/shared/hosted-git'

/**
 * Project settings for a project whose git remote yaac hosts
 * (docs/hosted-projects.md): the URL to clone it from on this machine, its
 * default branch, and the default-branch guard. The guard's value comes
 * from the snapshot, which the server pushes again once it changes; the
 * default branch from the project's branch list, read again after a
 * change. `cliRef` names the project to `yaac project clone`; `shared`
 * says it is a share, whose repository is the source's
 * (docs/hosted-projects.md "Sharing").
 */
export function HostedRemote({ projectId, name, cliRef, shared, guardDefaultBranch, readOnly }: {
  projectId: string
  name: string
  cliRef: string
  shared: boolean
  guardDefaultBranch: boolean
  readOnly: boolean
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const url = hostedCloneUrl(window.location.origin, projectId)
  const copy = (): void => {
    void navigator.clipboard?.writeText(`git clone ${url} ${name}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const queryClient = useQueryClient()
  const { data: branchData } = useProjectBranches(projectId)
  const current = branchData?.defaultBranch
  // An empty repository's default is a branch no push has made yet.
  const options = branchData && current !== undefined && !branchData.branches.includes(current)
    ? [current, ...branchData.branches]
    : branchData?.branches ?? []
  const setDefault = useMutation({
    mutationFn: (branch: string) => api.project[':projectId']['default-branch'].$put({
      param: { projectId },
      json: { branch },
    }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['project-branches', projectId] }),
  })
  const guard = useMutation({
    mutationFn: (enabled: boolean) => api.project[':projectId']['default-branch-guard'].$put({
      param: { projectId },
      json: { enabled },
    }),
  })

  return (
    <div>
      <div className="text-xs font-medium text-text">Git repository</div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        {shared
          ? 'yaac hosts this project\'s repository, which it shares with the project it was shared from; '
            + 'removing this project leaves it alone.'
          : 'yaac hosts this project\'s repository, and it is the only copy.'}{' '}
        Clone it with <code className="text-text-dim">yaac project clone {cliRef}</code>, or:
      </p>
      <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md bg-bg px-2.5 py-1.5">
        <code title={url} className="min-w-0 flex-1 select-all truncate font-mono text-[11px] text-text-faint">
          git clone {url} {name}
        </code>
        <button type="button" onClick={copy} className={TEXT_BUTTON}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <label className="mt-3 flex items-center gap-2 text-[11px] text-text-dim">
        Default branch
        <select
          value={current ?? ''}
          disabled={readOnly || setDefault.isPending || branchData === undefined || branchData.branches.length === 0}
          onChange={(e) => setDefault.mutate(e.target.value)}
          className="min-w-0 max-w-[240px] rounded-md border border-border bg-bg px-2 py-1 font-mono text-[11px] text-text
            outline-none focus:border-border-strong disabled:opacity-60"
        >
          {options.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </label>
      {setDefault.error && <p className="mt-2 text-xs text-red-400">{setDefault.error.message}</p>}
      <label className="mt-3 flex items-center gap-1.5 text-[11px] text-text-dim">
        <input
          type="checkbox"
          checked={guardDefaultBranch}
          disabled={readOnly || guard.isPending}
          onChange={(e) => guard.mutate(e.target.checked)}
        />
        Protect the default branch: refuse pushes that delete it or rewrite its history
      </label>
      {guard.error && <p className="mt-2 text-xs text-red-400">{guard.error.message}</p>}
    </div>
  )
}

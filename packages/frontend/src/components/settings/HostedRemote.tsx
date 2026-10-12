import { useState, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '#lib/api'
import { TEXT_BUTTON } from '#components/ui/button'
import { hostedCloneUrl } from '@yaac/shared/hosted-git'

/**
 * Project settings for a project whose git remote yaac hosts
 * (docs/hosted-projects.md): the URL to clone it from on this machine, and
 * the default-branch guard. The guard's value comes from the snapshot,
 * which the server pushes again once it changes.
 */
export function HostedRemote({ projectId, name, guardDefaultBranch, readOnly }: {
  projectId: string
  name: string
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
        yaac hosts this project&apos;s repository, and it is the only copy. Clone it with{' '}
        <code className="text-text-dim">yaac project clone {name}</code>, or:
      </p>
      <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md bg-bg px-2.5 py-1.5">
        <code title={url} className="min-w-0 flex-1 select-all truncate font-mono text-[11px] text-text-faint">
          git clone {url} {name}
        </code>
        <button type="button" onClick={copy} className={TEXT_BUTTON}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
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

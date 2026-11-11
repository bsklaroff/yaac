import { useState, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { hostedCloneUrl } from '@yaac/shared/hosted-git'
import { SectionLabel } from '#components/settings/Field'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { removeKeptHostedRepo } from '#lib/repoApi'

/**
 * The repository yaac kept when a repo moved to another git host
 * (docs/hosted-projects.md "Moving to a git host"): read-only, so the owner
 * can compare it with the new remote, then remove it. Removal asks twice,
 * since yaac's copy may be the only other one. Once it is gone
 * (`onRemoved`), the repo list drops `keepsHostedRepo` and this section
 * with it.
 */
export function KeptHostedRepo({ repoId, remoteUrl, readOnly, onRemoved }: {
  repoId: string
  remoteUrl: string
  readOnly: boolean
  onRemoved: () => void
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const kept = hostedCloneUrl(window.location.origin, repoId)
  const remove = useMutation({ mutationFn: () => removeKeptHostedRepo(repoId), onSuccess: onRemoved })

  return (
    <div>
      <SectionLabel>yaac&apos;s old repository</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        yaac still keeps the repository this repo was before it moved, read-only. The move pushed its
        branches and tags only; other refs and its reflog are here alone. Check that the new remote has
        what you need, for example by comparing:
      </p>
      <div className="mt-2 flex flex-col gap-1 rounded-md bg-bg px-2.5 py-1.5">
        {[kept, remoteUrl].map((url) => (
          <code key={url} title={url} className="select-all truncate font-mono text-[11px] text-text-faint">
            git ls-remote {url}
          </code>
        ))}
      </div>
      {!readOnly && (confirming ? (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-text-dim">
          <span className="flex-1">Remove yaac&apos;s copy for good? It cannot be brought back.</span>
          <button type="button" onClick={() => setConfirming(false)} className={TEXT_BUTTON}>Cancel</button>
          <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} className={BUTTON}>
            {remove.isPending ? 'Removing…' : 'Remove'}
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={`mt-2 ${BUTTON}`}>
          Remove yaac&apos;s copy…
        </button>
      ))}
      {remove.error && <p className="mt-2 text-[11px] text-red-400">{remove.error.message}</p>}
    </div>
  )
}

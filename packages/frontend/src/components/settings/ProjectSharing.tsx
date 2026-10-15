import { useState, type JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '#lib/api'
import { DeleteIcon } from '#lib/icons'
import { SectionLabel } from '#components/settings/Field'
import { BUTTON } from '#components/ui/button'
import { useSnapshot } from '#lib/useSnapshot'
import { useWhoami } from '#lib/viewer'

const shares = api.project[':projectId'].shares

/**
 * Who a project created in yaac is shared with (docs/hosted-projects.md
 * "Sharing"): each such user gets a project of their own on this project's
 * repository. The list comes from the snapshot, which carries every share.
 * Only the owner shares or removes a share; `readOnly` (a teammate viewing)
 * only lists them.
 */
export function ProjectSharing({ projectId, owner, readOnly }: {
  projectId: string
  owner: string
  readOnly: boolean
}): JSX.Element | null {
  const users = useWhoami()?.users ?? []
  const shared = new Set((useSnapshot()?.projects ?? [])
    .filter((p) => p.sharedFrom?.projectId === projectId && !p.sharedFrom.revoked)
    .map((p) => p.owner))
  const others = users.filter((u) => u.id !== owner)
  const candidates = others.filter((u) => !shared.has(u.id))
  const [picked, setPicked] = useState('')
  const share = useMutation({
    mutationFn: (userId: string) => shares.$post({ param: { projectId }, json: { userId } }),
    onSuccess: () => setPicked(''),
  })
  const unshare = useMutation({
    mutationFn: (userId: string) => shares[':userId'].$delete({ param: { projectId, userId } }),
  })
  if (others.length === 0) return null
  const error = share.error ?? unshare.error

  return (
    <div>
      <SectionLabel>Sharing</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Someone you share this project with gets their own copy of it, with its own workspaces and
        settings, that reads and pushes this repository. Removing them stops their workspaces and
        makes their copy read-only, to them as to everyone else.
      </p>
      <div className="mt-3 space-y-1">
        {others.filter((u) => shared.has(u.id)).map((u) => (
          <div key={u.id} className="flex items-center gap-2 rounded-md bg-bg px-2.5 py-1.5 text-xs">
            <span className="flex-1 truncate text-text">{u.name}</span>
            {u.login !== null && <span className="truncate text-[11px] text-text-faint">{u.login}</span>}
            {!readOnly && (
              <button
                type="button"
                onClick={() => unshare.mutate(u.id)}
                disabled={unshare.isPending}
                aria-label={`Stop sharing with ${u.name}`}
                className="shrink-0 text-text-faint transition hover:text-text disabled:opacity-50"
              >
                <DeleteIcon size={12} />
              </button>
            )}
          </div>
        ))}
        {shared.size === 0 && <p className="text-[11px] text-text-faint">Not shared with anyone.</p>}
      </div>
      {!readOnly && candidates.length > 0 && (
        <div className="mt-3 flex gap-2">
          <select
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            aria-label="Share with"
            className="flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text
              outline-none focus:border-border-strong"
          >
            <option value="">Share with…</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button
            type="button"
            onClick={() => share.mutate(picked)}
            disabled={picked === '' || share.isPending}
            className={BUTTON}
          >
            {share.isPending ? 'Sharing…' : 'Share'}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error.message}</p>}
    </div>
  )
}

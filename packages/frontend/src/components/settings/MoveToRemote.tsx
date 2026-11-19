import { useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitCredentialPicker, remoteKind } from '#components/GitCredentialPicker'
import { moveRepo, previewRepoMove } from '#lib/repoApi'
import { WarningIcon } from '#lib/icons'
import { useSnapshot } from '#lib/useSnapshot'
import { YButton, YInput, YSectionLabel } from '#ui'

/**
 * Move a repo yaac hosts to an empty repository elsewhere
 * (docs/hosted-projects.md "Moving to a git host"). The warning comes from
 * the server's preview, read when the form opens, since the move stops
 * other users' workspaces too. Once it lands, the repo list carries it as
 * no longer hosted (`onMoved`), and this section goes away with the rest of
 * the hosted settings. `name` seeds the new credential's name.
 */
export function MoveToRemote({ repoId, name, onMoved }: { repoId: string; name: string; onMoved: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const remoteUrl = url.trim()
  const preview = useQuery({
    queryKey: ['repo-move', repoId],
    queryFn: () => previewRepoMove(repoId),
    enabled: open,
    staleTime: 0,
  })
  // Without an egress proxy every host is reachable.
  const mediatedEgress = useSnapshot()?.driver !== 'containerless'
  const running = preview.data?.runningWorkspaces ?? 0
  const sharedWith = preview.data?.sharedWith ?? []

  const submit = async (credentialId: string): Promise<void> => {
    await moveRepo(repoId, remoteUrl, credentialId)
    onMoved()
  }

  return (
    <div>
      <YSectionLabel>Move to a git host</YSectionLabel>
      <p className="mt-0.5 text-sm leading-relaxed text-subtle">
        Push every branch and tag to an empty repository elsewhere, such as a new GitHub one, and use it
        from then on instead of yaac&apos;s copy.
      </p>
      {open ? (
        <div className="mt-2 flex flex-col gap-2">
          <div role="note" aria-label="What moving does"
            className="flex gap-2 border-l-2 border-warning bg-warning-soft px-3 py-2 text-sm leading-relaxed text-muted">
            <WarningIcon size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
            <ul className="list-disc space-y-0.5 pl-4">
              <li>
                {preview.isPending ? 'Every running workspace' : `${running} running workspace${running === 1 ? '' : 's'}`} with
                a checkout of this repo stop first, whoever owns them. Their checkouts are kept, and push to the new
                remote once restarted. Nothing can start until the move is done.
              </li>
              {sharedWith.length > 0 && (
                <li>
                  It is shared with {sharedWith.join(', ')}. Sharing ends: each gets a repo of their own for the new
                  remote, and needs a git credential for it before they can start a workspace with it.
                </li>
              )}
              <li>The repository must be empty: create it with no README, license or .gitignore.</li>
              {mediatedEgress && (
                <li>Its host must be in the egress allowlist of every project that links it, so workspaces can reach it.</li>
              )}
              <li>yaac keeps its own copy, read-only, until you have checked the new remote and remove it here.</li>
            </ul>
          </div>
          {preview.error && <p className="text-sm text-danger">{preview.error.message}</p>}
          <YInput
            aria-label="Repository URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
            placeholder="https://github.com/owner/repo.git"
            className="font-mono"
          />
          <GitCredentialPicker
            kind={remoteKind(remoteUrl)}
            projectName={name}
            actionLabel={running > 0 ? `Stop ${running} workspace${running === 1 ? '' : 's'} and move` : 'Move'}
            disabled={remoteUrl === '' || !preview.isSuccess}
            onSubmit={submit}
            onCancel={() => setOpen(false)}
          />
        </div>
      ) : (
        <YButton size="sm" onClick={() => setOpen(true)} className="mt-2">Move…</YButton>
      )}
    </div>
  )
}

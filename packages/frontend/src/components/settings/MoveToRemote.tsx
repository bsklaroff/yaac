import { useState, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitCredentialPicker, INPUT, remoteKind } from '#components/GitCredentialPicker'
import { SectionLabel } from '#components/settings/Field'
import { BUTTON } from '#components/ui/button'
import { api } from '#lib/api'
import { WarningIcon } from '#lib/icons'
import { useSnapshot } from '#lib/useSnapshot'

const move = api.project[':projectId'].move

/**
 * Move a project yaac hosts, and every share of it, to an empty repository
 * elsewhere (docs/hosted-projects.md "Moving to a git host"). The warning
 * comes from the server's preview, read when the form opens, since the move
 * stops other users' workspaces too. Once it lands, the snapshot carries
 * the project as no longer hosted, and this section goes away with the rest
 * of the hosted settings.
 */
export function MoveToRemote({ projectId, name }: { projectId: string; name: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const remoteUrl = url.trim()
  const preview = useQuery({
    queryKey: ['project-move', projectId],
    queryFn: () => move.$get({ param: { projectId } }),
    enabled: open,
    staleTime: 0,
  })
  // Without an egress proxy every host is reachable.
  const mediatedEgress = useSnapshot()?.driver !== 'containerless'
  const running = preview.data?.runningWorkspaces ?? 0
  const sharedWith = preview.data?.sharedWith ?? []

  const submit = async (gitCredentialId: string): Promise<void> => {
    await move.$post({ param: { projectId }, json: { remoteUrl, gitCredentialId } })
  }

  return (
    <div>
      <SectionLabel>Move to a git host</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        Push every branch and tag to an empty repository elsewhere, such as a new GitHub one, and use it
        from then on instead of yaac&apos;s copy.
      </p>
      {open ? (
        <div className="mt-2 flex flex-col gap-2">
          <div role="note" aria-label="What moving does" className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-text-dim">
            <WarningIcon size={14} className="mt-0.5 shrink-0 text-warning" />
            <ul className="list-disc space-y-0.5 pl-4">
              <li>
                {preview.isPending ? 'Every running workspace' : `${running} running workspace${running === 1 ? '' : 's'}`} on
                this project stop first, whoever owns them. Their checkouts are kept, and push to the new
                remote once restarted. Nothing can start until the move is done.
              </li>
              {sharedWith.length > 0 && (
                <li>
                  It is shared with {sharedWith.join(', ')}. Each keeps their copy, but needs a git credential of
                  their own for the new remote before they can start a workspace.
                </li>
              )}
              <li>The repository must be empty: create it with no README, license or .gitignore.</li>
              {mediatedEgress && (
                <li>Its host must be in this project&apos;s egress allowlist, below, so workspaces can reach it.</li>
              )}
              <li>yaac keeps its own copy, read-only, until you have checked the new remote and remove it here.</li>
            </ul>
          </div>
          {preview.error && <p className="text-[11px] text-red-400">{preview.error.message}</p>}
          <input
            aria-label="Repository URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
            placeholder="https://github.com/owner/repo.git"
            className={INPUT}
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
        <button type="button" onClick={() => setOpen(true)} className={`mt-2 ${BUTTON}`}>Move…</button>
      )}
    </div>
  )
}

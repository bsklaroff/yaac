import { useState, type JSX } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '#lib/api'
import { WarningIcon } from '#lib/icons'
import { SectionLabel } from '#components/settings/Field'

type Mode = 'none' | 'host' | 'account'

const CONTROL = 'rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none focus:border-border-strong'

/**
 * The cloud identity a project's workspaces act as (docs/cloud-identity.md):
 * none, this server's own, or a service account it impersonates. Hidden on
 * a server that found no cloud and has nothing set. Only the install owner
 * may change it; choosing the server's own names that identity and warns,
 * since the workspaces then hold everything it may do. `current` comes from
 * the snapshot, which the server pushes again once it changes.
 */
export function CloudIdentity({ projectId, current }: {
  projectId: string
  current: string | null
}): JSX.Element | null {
  const { data: info } = useQuery({
    queryKey: ['cloud-identity'],
    queryFn: async () => await api.server['cloud-identity'].$get(),
  })
  const [mode, setMode] = useState<Mode>(current === null ? 'none' : current === 'host' ? 'host' : 'account')
  const [account, setAccount] = useState(current !== null && current !== 'host' ? current : '')
  const save = useMutation({
    mutationFn: (identity: string | null) => api.project[':projectId']['cloud-identity'].$put({
      param: { projectId },
      json: { identity },
    }),
  })

  if (!info || (!info.provider && current === null)) return null
  const wanted = mode === 'none' ? null : mode === 'host' ? 'host' : account.trim()
  const editable = info.canSet && info.provider !== null

  return (
    <div>
      <SectionLabel>Cloud identity</SectionLabel>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        The Google Cloud identity this project&apos;s workspaces act as, through gcloud and the client libraries.
        The token is swapped in by the egress proxy and never enters the workspace.
        {!info.canSet && ' Only the owner of this install can change it.'}
      </p>
      <div className="mt-2 flex gap-2">
        <select
          aria-label="Cloud identity"
          value={mode}
          disabled={!editable || save.isPending}
          onChange={(e) => setMode(e.target.value as Mode)}
          className={CONTROL}
        >
          <option value="none">None</option>
          <option value="host">This server&apos;s identity</option>
          <option value="account">A service account</option>
        </select>
        {mode === 'account' && (
          <input
            aria-label="Service account email"
            value={account}
            disabled={!editable || save.isPending}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="agents@project.iam.gserviceaccount.com"
            className={`${CONTROL} min-w-0 flex-1 font-mono`}
          />
        )}
        {editable && (
          <button
            type="button"
            disabled={save.isPending || wanted === current || wanted === ''}
            onClick={() => save.mutate(wanted)}
            className="rounded-md bg-surface-3 px-3 py-1 text-xs font-medium text-text transition
              hover:bg-border-strong disabled:opacity-50"
          >
            Save
          </button>
        )}
      </div>
      {mode === 'host' && info.hostIdentity && (
        <div role="note" className="mt-2 flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-text-dim">
          <WarningIcon size={14} className="mt-0.5 shrink-0 text-warning" />
          <div>
            Sessions in this project will run as <code className="text-text">{info.hostIdentity}</code> and
            inherit all of its permissions.
          </div>
        </div>
      )}
      {save.error && <p className="mt-2 text-xs text-red-400">{save.error.message}</p>}
    </div>
  )
}

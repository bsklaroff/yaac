import { useState, type FormEvent, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronIcon, DeleteIcon } from '#lib/icons'
import { api } from '#lib/api'
import { YButton, YCheckbox, YInput, YRowFrame, YSettingRow } from '#ui'
import type { EgressAllowlist as Allowlist } from '@yaac/shared/types'

const ROW = 'min-h-8 font-mono text-md'

function Dot({ allowed }: { allowed: boolean }): JSX.Element {
  return <span className={clsx('size-1.5 shrink-0 rounded-full', allowed ? 'bg-success' : 'bg-danger')} />
}

/**
 * The hosts a project's workspaces may reach through the egress proxy: the
 * install's defaults (collapsed, since there are hundreds), the project's own
 * additions, and a closing row for everything else. Only shown on a server
 * with mediated egress. `readOnly` (a teammate's project) only lists them.
 */
export function EgressAllowlist({ projectId, readOnly = false }: {
  projectId: string
  readOnly?: boolean
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [showDefaults, setShowDefaults] = useState(false)
  const queryClient = useQueryClient()
  const queryKey = ['project-allowlist', projectId]
  const { data, error: loadError } = useQuery({
    queryKey,
    queryFn: async () => await api.project[':projectId'].allowlist.$get({ param: { projectId } }),
    staleTime: 0,
  })

  const save = useMutation({
    mutationFn: (next: Allowlist) =>
      api.project[':projectId'].allowlist.$put({ param: { projectId }, json: next }),
    onSuccess: () => setDraft(''),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!data) return
    save.mutate({ ...data.allowlist, hosts: [...data.allowlist.hosts, draft.trim()] })
  }

  const allowlist = data?.allowlist
  const everything = allowlist?.hosts.includes('*') ?? false
  const label = 'shrink-0 text-sm font-sans'

  return (
    <YSettingRow
      stacked
      label="Egress allowlist"
      hint={<>
        Hosts this project&apos;s workspaces may reach. Exact names or{' '}
        <code className="text-muted">*.example.com</code> or <code className="text-muted">store*.example.com</code> wildcards; <code className="text-muted">*</code>{' '}
        allows everything. Applies to workspaces created after saving.
      </>}
    >
      {data && allowlist && (
        <div className="divide-y divide-line">
          <YButton
            variant="bare"
            onClick={() => setShowDefaults(!showDefaults)}
            aria-expanded={showDefaults}
            className="flex min-h-8 w-full items-center gap-2.5 text-left font-mono text-md hover:bg-hover"
          >
            <Dot allowed={allowlist.defaults} />
            <span className={clsx('flex-1 truncate', allowlist.defaults ? 'text-text' : 'text-subtle')}>
              {data.defaultHosts.length} default hosts
            </span>
            <ChevronIcon size={12} aria-hidden className={clsx('text-subtle transition', showDefaults && 'rotate-90')} />
            <span className={clsx(label, allowlist.defaults ? 'text-subtle' : 'text-danger')}>
              {allowlist.defaults ? 'default' : 'blocked'}
            </span>
          </YButton>
          {showDefaults && (
            <div className="max-h-48 divide-y divide-line overflow-y-auto pl-3">
              {data.defaultHosts.map((h) => (
                <YRowFrame key={h} label={h} className={ROW}>
                  <Dot allowed={allowlist.defaults} />
                  <span className={clsx('flex-1 truncate', allowlist.defaults ? 'text-text' : 'text-subtle')}>{h}</span>
                </YRowFrame>
              ))}
            </div>
          )}

          {allowlist.hosts.map((h) => (
            <YRowFrame
              key={h}
              label={h}
              actionsShown
              actions={!readOnly && (
                <YButton
                  variant="ghost"
                  size="sm"
                  icon={DeleteIcon}
                  onClick={() => save.mutate({ ...allowlist, hosts: allowlist.hosts.filter((x) => x !== h) })}
                  disabled={save.isPending}
                  aria-label={`Remove ${h}`}
                />
              )}
              className={ROW}
            >
              <Dot allowed />
              <span className="flex-1 truncate text-text">{h === '*' ? '* (everything)' : h}</span>
              <span className={clsx(label, 'text-subtle')}>added</span>
            </YRowFrame>
          ))}

          <YRowFrame label="everything else" className={ROW}>
            <Dot allowed={everything} />
            <span className="flex-1 truncate text-subtle">everything else</span>
            <span className={clsx(label, everything ? 'text-subtle' : 'text-danger')}>
              {everything ? 'allowed' : 'blocked'}
            </span>
          </YRowFrame>
        </div>
      )}

      {!readOnly && allowlist && <form onSubmit={submit} className="mt-2 space-y-2">
        <div className="flex gap-2">
          <YInput
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="api.example.com or *.example.com"
            className="flex-1 font-mono"
          />
          <YButton type="submit" disabled={save.isPending || draft.trim() === ''}>
            Add
          </YButton>
        </div>
        <YCheckbox
          checked={allowlist.defaults}
          disabled={save.isPending}
          onCheckedChange={(on) => save.mutate({ ...allowlist, defaults: on })}
        >
          Allow the default hosts (agent APIs, GitHub, package registries)
        </YCheckbox>
      </form>}

      {(save.error ?? loadError) && <p className="mt-2 text-md text-danger">{(save.error ?? loadError)?.message}</p>}
    </YSettingRow>
  )
}

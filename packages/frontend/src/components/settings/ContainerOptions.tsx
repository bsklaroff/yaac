import type { JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '#lib/api'
import { SectionLabel } from '#components/settings/Field'

const project = api.project[':projectId']

/**
 * The on/off settings of a project's workspace pods: the install's npm
 * cache. k8s only. The value comes from the snapshot. `readOnly` (a
 * teammate's project) only shows it.
 */
export function ContainerOptions({ projectId, npmCache, readOnly }: {
  projectId: string
  npmCache: boolean
  readOnly: boolean
}): JSX.Element {
  const npm = useMutation({
    mutationFn: (enabled: boolean) => project['npm-cache'].$put({ param: { projectId }, json: { enabled } }),
  })

  return (
    <div>
      <SectionLabel>Containers</SectionLabel>
      <label className="mt-2 flex items-center gap-1.5 text-[11px] text-text-dim">
        <input
          type="checkbox"
          checked={npmCache}
          disabled={readOnly || npm.isPending}
          onChange={(e) => npm.mutate(e.target.checked)}
        />
        npm cache: fetch packages through the install&apos;s shared cache rather than from npmjs
      </label>
      <p className="mt-1 text-[11px] text-text-faint">Applies to workspaces created after saving.</p>
      {npm.error && <p className="mt-2 text-xs text-red-400">{npm.error.message}</p>}
    </div>
  )
}

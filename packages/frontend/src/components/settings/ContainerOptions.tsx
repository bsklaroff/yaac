import type { JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '#lib/api'
import { SectionLabel } from '#components/settings/Field'

const project = api.project[':projectId']

/**
 * The on/off settings of a project's workspace pods: a container engine of
 * their own (docs/nested-containers.md) and the install's npm cache. k8s
 * only. Values come from the snapshot. `readOnly` (a teammate's project)
 * only shows them.
 */
export function ContainerOptions({ projectId, nestedContainers, npmCache, readOnly }: {
  projectId: string
  nestedContainers: boolean
  npmCache: boolean
  readOnly: boolean
}): JSX.Element {
  const nested = useMutation({
    mutationFn: (enabled: boolean) => project['nested-containers'].$put({ param: { projectId }, json: { enabled } }),
  })
  const npm = useMutation({
    mutationFn: (enabled: boolean) => project['npm-cache'].$put({ param: { projectId }, json: { enabled } }),
  })
  const error = nested.error ?? npm.error

  return (
    <div>
      <SectionLabel>Containers</SectionLabel>
      <label className="mt-2 flex items-center gap-1.5 text-[11px] text-text-dim">
        <input
          type="checkbox"
          checked={nestedContainers}
          disabled={readOnly || nested.isPending}
          onChange={(e) => nested.mutate(e.target.checked)}
        />
        Nested containers: run a container engine in each workspace, so docker build, run and compose work
      </label>
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
      {error && <p className="mt-2 text-xs text-red-400">{error.message}</p>}
    </div>
  )
}

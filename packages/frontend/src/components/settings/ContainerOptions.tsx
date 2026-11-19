import type { JSX } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '#lib/api'
import { YCheckbox, YSettingRow } from '#ui'

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
    <YSettingRow
      label="npm cache"
      hint={<>
        Fetch packages through the install&apos;s shared cache rather than from npmjs. Applies to workspaces
        created after saving.
        {npm.error && <span className="mt-1 block text-md text-danger">{npm.error.message}</span>}
      </>}
    >
      <YCheckbox
        checked={npmCache}
        disabled={readOnly || npm.isPending}
        onCheckedChange={(on) => npm.mutate(on)}
        aria-label="npm cache"
      />
    </YSettingRow>
  )
}

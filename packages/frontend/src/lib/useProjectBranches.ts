import { useEffect } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { api } from '#lib/api'

export interface ProjectBranches {
  /** Remote-tracking branch names, newest-committed first. */
  branches: string[]
  defaultBranch: string
}

const fetchBranches = (slug: string, refresh: boolean): Promise<ProjectBranches> =>
  api.project[':slug'].branches.$get({ param: { slug }, query: refresh ? { refresh: '1' } : {} })

/**
 * A project's branches, cached for every branch picker. The server's local
 * remote-tracking refs answer at once; while `enabled`, a fetch from the
 * remote follows, so a just-pushed branch appears. If that fetch fails the
 * local list stays.
 */
export function useProjectBranches(slug: string, enabled = true): UseQueryResult<ProjectBranches> {
  const queryClient = useQueryClient()
  const on = enabled && slug !== ''
  const query = useQuery({
    queryKey: ['project-branches', slug],
    queryFn: () => fetchBranches(slug, false),
    enabled: on,
  })
  useEffect(() => {
    if (!on) return
    let cancelled = false
    fetchBranches(slug, true).then(
      (fresh) => { if (!cancelled) queryClient.setQueryData(['project-branches', slug], fresh) },
      () => {},
    )
    return () => { cancelled = true }
  }, [on, slug, queryClient])
  return query
}

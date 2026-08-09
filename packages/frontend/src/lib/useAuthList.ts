import { useQuery } from '@tanstack/react-query'
import { getAuthList } from '#lib/settingsApi'
import type { AgentTool, AuthListResult } from '@yaac/shared/types'

/** React Query cache key for the masked credentials list. Mutating a
 *  credential (sign-in/out, git token add) invalidates this key. */
export const AUTH_LIST_KEY = ['auth-list'] as const

/**
 * The tools with a stored credential. While the list is still loading this
 * is the empty set — creation stays blocked until credentials are confirmed,
 * rather than allowed blind.
 */
export function configuredTools(auth: AuthListResult | undefined): Set<AgentTool> {
  return new Set((auth?.toolAuth ?? []).map((t) => t.tool))
}

/**
 * Shared masked-credentials query. Fetched once (the query client never
 * auto-refetches — see main.tsx); consumers that change credentials
 * invalidate AUTH_LIST_KEY, and open-on-demand surfaces (settings, the
 * new-worktree menu) invalidate when shown to pick up CLI-side changes.
 */
export function useAuthList(): AuthListResult | undefined {
  const { data } = useQuery({ queryKey: AUTH_LIST_KEY, queryFn: getAuthList })
  return data
}

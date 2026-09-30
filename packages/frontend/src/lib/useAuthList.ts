import { useQuery } from '@tanstack/react-query'
import { getAuthList } from '#lib/settingsApi'
import type { AgentTool, AuthListResult } from '@yaac/shared/types'

/** React Query key for the masked credentials list. Code that changes a
 *  credential invalidates it. */
export const AUTH_LIST_KEY = ['auth-list'] as const

/**
 * The tools with a stored credential. Empty while the list loads, so
 * workspace creation stays blocked until credentials are confirmed.
 */
export function configuredTools(auth: AuthListResult | undefined): Set<AgentTool> {
  return new Set((auth?.toolAuth ?? []).map((t) => t.tool))
}

/**
 * The masked credentials list. The query client never refetches on its own
 * (see main.tsx), so settings and the new-workspace menu invalidate
 * AUTH_LIST_KEY when shown, to pick up changes made from the CLI.
 */
export function useAuthList(): AuthListResult | undefined {
  const { data } = useQuery({ queryKey: AUTH_LIST_KEY, queryFn: getAuthList })
  return data
}

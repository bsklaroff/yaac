import { useQuery } from '@tanstack/react-query'
import { SNAPSHOT_KEY } from './useEvents'
import type { ServerSnapshot } from '@yaac/shared/types'

/**
 * Read the server snapshot from the React Query cache. `useEvents` fills the
 * cache with setQueryData, so the query stays disabled and `data` is
 * undefined until the first frame arrives over the WebSocket.
 */
export function useSnapshot(): ServerSnapshot | undefined {
  const { data } = useQuery<ServerSnapshot>({
    queryKey: SNAPSHOT_KEY,
    // Never runs, but React Query logs an error without one.
    queryFn: () => Promise.reject(new Error('snapshot is pushed over the events socket')),
    enabled: false,
  })
  return data
}

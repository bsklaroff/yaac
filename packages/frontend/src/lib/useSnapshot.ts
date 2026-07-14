import { useQuery } from '@tanstack/react-query'
import { SNAPSHOT_KEY } from './useEvents'
import type { ServerSnapshot } from '@yaac/shared/types'

/**
 * Read the server snapshot from the React Query cache. There's no
 * queryFn — `useEvents` populates the cache via setQueryData, so the
 * query stays disabled and `data` is undefined until the first frame
 * arrives over the WebSocket.
 */
export function useSnapshot(): ServerSnapshot | undefined {
  const { data } = useQuery<ServerSnapshot>({
    queryKey: SNAPSHOT_KEY,
    // Never runs (enabled: false) — the events socket hydrates the cache
    // via setQueryData. A queryFn must still be present or React Query
    // logs a "no queryFn" error for the observer.
    queryFn: () => Promise.reject(new Error('snapshot is pushed over the events socket')),
    enabled: false,
  })
  return data
}

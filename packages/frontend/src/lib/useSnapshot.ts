import { useUiStore } from '#lib/store'
import type { ServerSnapshot } from '@yaac/shared/types'

/**
 * The server snapshot, as `useEvents` last stored it (`receiveSnapshot`).
 * Undefined until the first frame arrives over the WebSocket.
 */
export function useSnapshot(): ServerSnapshot | undefined {
  return useUiStore((s) => s.snapshot)
}

/** Whether this server runs sites. False until the first snapshot frame, so
 *  a Site tab never flashes on containerless. */
export function useSitesSupported(): boolean {
  return useUiStore((s) => s.snapshot !== undefined && s.snapshot.driver !== 'containerless')
}

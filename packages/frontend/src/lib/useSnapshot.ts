import { useUiStore } from '#lib/store'
import type { ServerSnapshot } from '@yaac/shared/types'

/**
 * The server snapshot, as `useEvents` last stored it (`receiveSnapshot`).
 * Undefined until the first frame arrives over the WebSocket.
 */
export function useSnapshot(): ServerSnapshot | undefined {
  return useUiStore((s) => s.snapshot)
}

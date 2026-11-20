import { useUiStore } from '#lib/store'
import type { ServerSnapshot } from '@yaac/shared/types'

/**
 * The server snapshot, as `useEvents` last stored it (`receiveSnapshot`).
 * Undefined until the first frame arrives over the WebSocket. The caller
 * re-renders on every frame that changes anything, so a component that
 * reads only a few fields takes them with `useSnapshotSelect` instead.
 */
export function useSnapshot(): ServerSnapshot | undefined {
  return useUiStore((s) => s.snapshot)
}

/**
 * What `select` picks out of the snapshot, re-rendering only when that
 * changes. Unchanged parts of the snapshot keep their identity across frames
 * (`receiveSnapshot`), so picking a field or a row is enough; a selector that
 * builds a new array, object or Map each call needs zustand's `useShallow`.
 * A parent's render still renders the caller, so an always-mounted component
 * whose props hold still is wrapped in `memo` to skip the frames its parent
 * re-renders on.
 */
export function useSnapshotSelect<T>(select: (snapshot: ServerSnapshot | undefined) => T): T {
  return useUiStore((s) => select(s.snapshot))
}

/** Whether this server runs sites. False until the first snapshot frame, so
 *  a Site tab never flashes on containerless. */
export function useSitesSupported(): boolean {
  return useSnapshotSelect((s) => s !== undefined && s.driver !== 'containerless')
}

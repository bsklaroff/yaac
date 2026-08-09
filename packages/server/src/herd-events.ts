import { serverLog } from '#log'
import type { HerdEvent } from '@yaac/shared/herd'

/**
 * The channel a herd reports its discoveries on, and the server's end of it.
 *
 * Herd-side code calls `emitHerdEvent` and knows nothing about what happens
 * next; the server registers the sink that writes the row. Today both ends
 * are in one process and the sink is `applyHerdEvent`. When the herd becomes
 * its own process (docs/plans/herd-split.md) the herd's sink writes to the
 * JSON-RPC link instead, and no caller changes.
 *
 * Deliberately a zero-dependency module at the package root, for the same
 * reason as `#notify`: the emitters are spread across the herd's features and
 * none of them should acquire a dependency on the server's tables for a
 * one-line report.
 *
 * `emitHerdEvent` is awaited, and the sink resolves only once the event has
 * been applied. That is what a caller tearing a session down needs — a
 * listing between the emit and the write would show the worktree as neither
 * running nor stopped — and it is why this is a call rather than a
 * fire-and-forget notification. Over a link it stays one: an event whose
 * ordering does not matter can be relaxed to a notification then, per event,
 * on purpose.
 */
export type HerdEventSink = (event: HerdEvent) => Promise<void>

let sink: HerdEventSink | null = null

/** Register the sink every `emitHerdEvent` is delivered to. Replaces any
 *  previous sink (last registration wins). */
export function onHerdEvent(fn: HerdEventSink): void {
  sink = fn
}

/**
 * Report a discovery. Resolves once the sink has applied it.
 *
 * With no sink registered the event is dropped and logged — which is the
 * normal state in a unit test that is not exercising persistence, and a bug
 * anywhere else, so it must not pass silently.
 */
export async function emitHerdEvent(event: HerdEvent): Promise<void> {
  if (!sink) {
    serverLog(`[herd] no sink for ${event.type}; event dropped`)
    return
  }
  await sink(event)
}

/** Test helper: drop the registered sink. */
export function _resetHerdEventsForTests(): void {
  sink = null
}

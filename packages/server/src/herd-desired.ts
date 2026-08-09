import type { DesiredWorkspaces } from '@yaac/shared/herd'

/**
 * What the server says its herd's workspaces *should* be, and the herd's end
 * of that push.
 *
 * The mirror of `#herd-events`, and the one place level-triggered desired
 * state earns its keep. The stale reaper is the only herd code that needs to
 * know what a workspace's absence MEANS: a runtime the server has no record
 * of is a leak to clean up, and a record with no runtime is a create that
 * died. Neither question can be answered from the substrate alone, and
 * neither is a discovery to report upward.
 *
 * A whole set, never a delta — the same discipline the report uses in the
 * other direction, so a herd that reconnects learns the truth in one push
 * rather than replaying what it missed.
 *
 * Nothing has been pushed yet reads as `undefined`, NOT as an empty set, and
 * every consumer must treat it as "say nothing, do nothing". An empty set
 * would condemn every running workspace at once; a herd that has not been
 * told anything must reap nothing.
 */
let desired: DesiredWorkspaces | undefined

/** Server side: publish the current desired set. Replaces the last one. */
export function publishDesiredWorkspaces(next: DesiredWorkspaces): void {
  desired = next
}

/** Herd side: the last published set, or `undefined` if there has been none. */
export function desiredWorkspaces(): DesiredWorkspaces | undefined {
  return desired
}

/** Test helper: forget the published set. */
export function _resetDesiredWorkspacesForTests(): void {
  desired = undefined
}

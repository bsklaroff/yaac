import type { DesiredWorkspaces } from '@yaac/shared/herd'

/**
 * What the server says its herd's workspaces *should* be, and the herd's end
 * of that push.
 *
 * The one place level-triggered desired state earns its keep, and the only
 * thing a herd is TOLD rather than asked. The stale reaper is the only herd
 * code that needs to know what a workspace's absence MEANS: a runtime the
 * server has no record
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

/**
 * Bumped on every publish, so a reader can tell a set published for THIS
 * pass from one left over. A publish that fails leaves the last set in
 * place, which is right for anything that only needs a recent answer and
 * wrong for the reaper: an exemption that is one pass stale is an exemption
 * that can miss a create started since. The generation is how the reaper
 * tells the two apart.
 */
let generation = 0

/** Published through `HerdClient.workspaces.publishDesired` — the server
 *  never reaches for this directly. Replaces the last set. */
export function publishDesiredWorkspaces(next: DesiredWorkspaces): void {
  desired = next
  generation += 1
}

/** How many sets have been published. 0 means none ever has. */
export function desiredWorkspacesGeneration(): number {
  return generation
}

/** Herd side: the last published set, or `undefined` if there has been none. */
export function desiredWorkspaces(): DesiredWorkspaces | undefined {
  return desired
}

/** Test helper: forget the published set. */
export function _resetDesiredWorkspacesForTests(): void {
  desired = undefined
  generation = 0
}

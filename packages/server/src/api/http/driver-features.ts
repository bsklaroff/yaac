import { ServerError } from '@yaac/shared/errors'
import { worktreeDriver } from '#drivers/driver'

/**
 * Refuse a route for a feature this server's substrate does not have.
 *
 * The driver contract says a runtime that lacks a feature answers empty,
 * `null` or a no-op, and that stays true — it is what lets the snapshot
 * compose every feed unconditionally without a containerless server
 * breaking every client's render. This is the other half of that rule, and
 * the distinction is worth stating: a VERB degrades so the whole picture
 * still draws, but a ROUTE is one client asking one question, and handing
 * it a convincing empty answer teaches it the wrong thing. `GET
 * /image/builds` returning `[]` reads as "no builds are running"; on a
 * server that will never build one, the honest answer is that it cannot.
 *
 * 501 rather than 404 (the route exists) or 400 (the caller is not at
 * fault). Callers that render a feature per driver — the webapp reads
 * `snapshot.driver` and hides these outright — never see it; the ones that
 * do are asking something this install cannot answer.
 */

/** The features a route can require, in product vocabulary rather than
 *  substrate vocabulary. */
export type DriverFeature = 'images' | 'egress' | 'portRelay'

const WHY: Record<DriverFeature, string> = {
  images: 'builds no images — its worktrees run on this host, from the checkout itself',
  egress: 'mediates no egress — a worktree reaches whatever the user running the server can',
  portRelay: 'relays no ports — a worktree binds host ports itself, so its listeners are '
    + 'already reachable at their own port',
}

/**
 * Throw unless the registered driver has `feature`.
 *
 * Called at the TOP of a handler, before any id is resolved: what this
 * server can do is not a property of the worktree being asked about, and a
 * 404 for a worktree that happens not to exist would hide the real answer.
 */
export function requireDriverFeature(feature: DriverFeature): void {
  if (worktreeDriver().kind !== 'containerless') return
  throw new ServerError('NOT_SUPPORTED', `This server ${WHY[feature]}.`)
}

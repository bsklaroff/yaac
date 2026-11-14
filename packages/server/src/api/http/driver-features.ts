import { ServerError } from '@yaac/shared/errors'
import { workspaceDriver } from '#drivers/driver'

/**
 * Refuse a route for a feature this server's substrate does not have.
 *
 * A driver verb for a missing feature degrades to empty, `null` or a no-op so
 * the snapshot can compose every feed unconditionally. A route is different:
 * `GET /image/builds` returning `[]` would read as "no builds are running",
 * so the route answers 501 NOT_SUPPORTED instead. The webapp hides these
 * features using `snapshot.driver` and never sees the 501.
 */

/** The features a route can require, in product vocabulary rather than
 *  substrate vocabulary. */
export type DriverFeature = 'images' | 'egress' | 'portRelay' | 'volumes' | 'sites' | 'cacheVolumes' | 'npmCache' | 'repoAccess'

const WHY: Record<DriverFeature, string> = {
  images: 'builds no images — its workspaces run on this host, from the checkout itself',
  egress: 'mediates no egress — a workspace reaches whatever the user running the server can',
  portRelay: 'relays no ports — a workspace binds host ports itself, so its listeners are '
    + 'already reachable at their own port',
  volumes: 'keeps no volumes — they are cluster storage, and its workspaces run on this host',
  sites: 'serves no public sites — it has no sandbox to put between the internet and this host',
  cacheVolumes: 'keeps no cache volumes — a workspace\'s tools keep their caches where they always do on this host',
  npmCache: 'runs no npm cache — its workspaces fetch packages the way this host does',
  repoAccess: 'limits no repo\'s credential — a workspace runs as the user running the server and holds every one',
}

/**
 * Throw unless the registered driver has `feature`. Call it first in a
 * handler, before resolving any id, so a 404 for a missing workspace can't
 * hide the real answer.
 */
export function requireDriverFeature(feature: DriverFeature): void {
  if (workspaceDriver().kind !== 'containerless') return
  throw new ServerError('NOT_SUPPORTED', `This server ${WHY[feature]}.`)
}

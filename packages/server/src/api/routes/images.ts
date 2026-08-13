import { Hono } from 'hono'
import { ServerError } from '@yaac/shared/errors'
import { worktreeDriver } from '#drivers/driver'
import { retryImageBuild } from '#domain/images'
import { requireDriverFeature } from '#http'

/**
 * Image-build registry reads and mutations. The snapshot pushed over `/events`
 * already carries the build metadata; the log route exists because the raw
 * podman output is deliberately kept out of snapshots (it changes at line
 * rate) — the webapp's build overlay polls it only while open.
 *
 * The reads and the dismiss ask the runtime directly, because it is the
 * thing that holds them: a mediator forwarding the call would hide it
 * rather than mediate it. Retry is the exception, and goes through
 * `#domain/images` — it has to hand the runtime something the runtime may
 * not fetch for itself, a reader for each owning project's config.
 *
 * Every route here refuses outright on a runtime that builds no images.
 * The DRIVER still answers empty there — the snapshot composes the feed
 * unconditionally and must keep rendering — but a client asking this route
 * directly is asking about a feature this server does not have, and `[]`
 * would tell it "no builds are running" instead (see `requireDriverFeature`).
 */
export const imageApp = new Hono()
  .get('/builds', (c) => {
    requireDriverFeature('images')
    return c.json(worktreeDriver().listImageBuilds())
  })
  .get('/builds/:id/log', (c) => {
    requireDriverFeature('images')
    const log = worktreeDriver().imageBuildLog(c.req.param('id'))
    if (log === undefined) {
      throw new ServerError('NOT_FOUND', 'no such build')
    }
    return c.json({ log })
  })
  // Dismiss hides a finished row without rebuilding (a failed chain keeps
  // backing off the prewarm sweep until its window lapses).
  .delete('/builds/:id', (c) => {
    requireDriverFeature('images')
    worktreeDriver().dismissImageBuild(c.req.param('id'))
    return c.body(null, 204)
  })
  // Retry forgets the entry and rebuilds now. What that means — which chain
  // re-runs, and what happens to a build no project owns — is the runtime's;
  // the route only decides that an unknown id is a 404.
  .post('/builds/:id/retry', (c) => {
    requireDriverFeature('images')
    if (!retryImageBuild(c.req.param('id'))) {
      throw new ServerError('NOT_FOUND', 'no such build to retry')
    }
    return c.body(null, 202)
  })

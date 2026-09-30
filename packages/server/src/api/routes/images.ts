import { Hono } from 'hono'
import { ServerError } from '@yaac/shared/errors'
import { workspaceDriver } from '#drivers/driver'
import { retryImageBuild } from '#domain/projects'
import { requireDriverFeature } from '#http'

/**
 * Image-build registry routes. The `/events` snapshot carries build metadata;
 * the raw podman log is kept out of it (it changes every line), so the
 * webapp's build overlay polls the log route while open.
 *
 * Reads and dismiss call the driver directly. Retry goes through
 * `#domain/projects`, which hands the driver a reader for each owning
 * project's config.
 *
 * Every route refuses on a runtime that builds no images (see
 * `requireDriverFeature`).
 */
export const imageApp = new Hono()
  .get('/builds', (c) => {
    requireDriverFeature('images')
    return c.json(workspaceDriver().listImageBuilds())
  })
  .get('/builds/:id/log', (c) => {
    requireDriverFeature('images')
    const log = workspaceDriver().imageBuildLog(c.req.param('id'))
    if (log === undefined) {
      throw new ServerError('NOT_FOUND', 'no such build')
    }
    return c.json({ log })
  })
  // Dismiss hides a finished row without rebuilding. A failed chain still
  // backs off the prewarm sweep until its window lapses.
  .delete('/builds/:id', (c) => {
    requireDriverFeature('images')
    workspaceDriver().dismissImageBuild(c.req.param('id'))
    return c.body(null, 204)
  })
  // Retry forgets the entry and rebuilds now; the driver decides what that
  // rebuilds. An unknown id is a 404.
  .post('/builds/:id/retry', (c) => {
    requireDriverFeature('images')
    if (!retryImageBuild(c.req.param('id'))) {
      throw new ServerError('NOT_FOUND', 'no such build to retry')
    }
    return c.body(null, 202)
  })

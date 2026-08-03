import { Hono } from 'hono'
import { ServerError } from '@yaac/shared/errors'
import { dismissImageBuild, getImageBuildLog, listImageBuilds, retryImageBuild } from '#features/images'

/**
 * Image-build registry reads and mutations. The snapshot pushed over `/events`
 * already carries the build metadata; the log route exists because the raw
 * podman output is deliberately kept out of snapshots (it changes at line
 * rate) — the webapp's build overlay polls it only while open.
 */
export const imageApp = new Hono()
  .get('/builds', (c) => c.json(listImageBuilds()))
  .get('/builds/:id/log', (c) => {
    const log = getImageBuildLog(c.req.param('id'))
    if (log === undefined) {
      throw new ServerError('NOT_FOUND', 'no such build')
    }
    return c.json({ log })
  })
  // Dismiss hides a finished row without rebuilding (a failed chain keeps
  // backing off the prewarm sweep until its window lapses).
  .delete('/builds/:id', (c) => {
    dismissImageBuild(c.req.param('id'))
    return c.body(null, 204)
  })
  // Retry forgets the entry and rebuilds now — the owning project's chain, or
  // the proxy sidecar for an infra build with no project.
  .post('/builds/:id/retry', (c) => {
    if (!retryImageBuild(c.req.param('id'))) {
      throw new ServerError('NOT_FOUND', 'no such build to retry')
    }
    return c.body(null, 202)
  })

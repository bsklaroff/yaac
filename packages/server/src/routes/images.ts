import { Hono } from 'hono'
import { ServerError } from '@yaac/shared/errors'
import { herd } from '#herd'

/**
 * Image-build registry reads and mutations. The snapshot pushed over `/events`
 * already carries the build metadata; the log route exists because the raw
 * podman output is deliberately kept out of snapshots (it changes at line
 * rate) — the webapp's build overlay polls it only while open.
 */
export const imageApp = new Hono()
  .get('/builds', async (c) => c.json(await herd().images.listBuilds()))
  .get('/builds/:id/log', async (c) => {
    const log = await herd().images.buildLog(c.req.param('id'))
    if (log === undefined) {
      throw new ServerError('NOT_FOUND', 'no such build')
    }
    return c.json({ log })
  })
  // Dismiss hides a finished row without rebuilding (a failed chain keeps
  // backing off the prewarm sweep until its window lapses).
  .delete('/builds/:id', async (c) => {
    await herd().images.dismissBuild(c.req.param('id'))
    return c.body(null, 204)
  })
  // Retry forgets the entry and rebuilds now — the owning project's chain, or
  // the proxy sidecar for an infra build with no project. Which of the two it
  // is, and how to rebuild either, is the herd's; the route only decides that
  // an unknown id is a 404.
  .post('/builds/:id/retry', async (c) => {
    const { retried } = await herd().images.retryBuild(c.req.param('id'))
    if (!retried) {
      throw new ServerError('NOT_FOUND', 'no such build to retry')
    }
    return c.body(null, 202)
  })

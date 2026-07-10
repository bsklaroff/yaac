import { Hono } from 'hono'
import { dismissImageBuild, getImageBuildLog, listImageBuilds } from '#image-builds'

/**
 * Image-build registry reads. The snapshot pushed over `/events` already
 * carries the build metadata; the log route exists because the raw podman
 * output is deliberately kept out of snapshots (it changes at line rate) —
 * the webapp's build overlay polls it only while open.
 */
export const imageApp = new Hono()
  .get('/builds', (c) => c.json(listImageBuilds()))
  .get('/builds/:id/log', (c) => {
    const log = getImageBuildLog(c.req.param('id'))
    if (log === undefined) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'no such build' } }, 404)
    }
    return c.json({ log })
  })
  .delete('/builds/:id', (c) => {
    dismissImageBuild(c.req.param('id'))
    return c.body(null, 204)
  })

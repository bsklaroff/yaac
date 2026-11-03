import { Hono } from 'hono'
import { z } from 'zod'
import { projectRef, zv } from '#routes/validator'
import { createVolume, deleteVolume, listVolumes, resizeVolume } from '#domain/workspaces'
import { requireDriverFeature } from '#api/http/driver-features'
import type { IdentityEnv } from '#api/http/web-auth'

/**
 * Workspace volumes (docs/workspace-volumes.md): named app data one running
 * workspace at a time mounts. A cluster feature, so each route answers
 * `NOT_SUPPORTED` on a containerless server.
 */
const volumeRef = z.object({ project: projectRef, name: z.string().min(1) })

export const volumeApp = new Hono<IdentityEnv>()
  // Before the project is resolved, so a missing one can't hide the answer.
  .use('*', async (_c, next) => {
    requireDriverFeature('volumes')
    await next()
  })
  .get(
    '/list',
    zv('query', z.object({ project: projectRef })),
    async (c) => c.json(await listVolumes(c.req.valid('query').project)),
  )
  .post(
    '/create',
    zv('json', volumeRef.extend({ size: z.string().min(1).optional() })),
    async (c) => {
      const { project, name, size } = c.req.valid('json')
      await createVolume(c.get('principal'), project, name, size)
      return c.body(null, 204)
    },
  )
  .post(
    '/resize',
    zv('json', volumeRef.extend({ size: z.string().min(1) })),
    async (c) => {
      const { project, name, size } = c.req.valid('json')
      await resizeVolume(c.get('principal'), project, name, size)
      return c.body(null, 204)
    },
  )
  .post(
    '/delete',
    zv('json', volumeRef),
    async (c) => {
      const { project, name } = c.req.valid('json')
      await deleteVolume(c.get('principal'), project, name)
      return c.body(null, 204)
    },
  )

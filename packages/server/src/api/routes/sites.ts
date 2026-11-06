import { Hono } from 'hono'
import { z } from 'zod'
import { projectRef, zv } from '#routes/validator'
import {
  createSite,
  deleteSite,
  deploySite,
  editSite,
  getSiteEdge,
  listProjectSiteEntries,
  showSite,
  startSite,
  stopSite,
} from '#domain/sites'
import { requireDriverFeature } from '#api/http/driver-features'
import type { IdentityEnv } from '#api/http/web-auth'

/**
 * Public sites (docs/public-sites.md): a project's app served on the
 * internet by a release workspace. A cluster feature, so each route answers
 * `NOT_SUPPORTED` on a containerless server.
 */
const siteRef = z.object({ project: projectRef, name: z.string().min(1) })
const port = z.number().int()

export const siteApp = new Hono<IdentityEnv>()
  // Before the project is resolved, so a missing one can't hide the answer.
  .use('*', async (_c, next) => {
    requireDriverFeature('sites')
    await next()
  })
  .get('/edge', async (c) => c.json(await getSiteEdge()))
  .get(
    '/list',
    zv('query', z.object({ project: projectRef })),
    async (c) => c.json(await listProjectSiteEntries(c.req.valid('query').project)),
  )
  .get(
    '/show',
    zv('query', siteRef),
    async (c) => {
      const { project, name } = c.req.valid('query')
      return c.json(await showSite(project, name))
    },
  )
  .post(
    '/create',
    zv('json', siteRef.extend({
      hostname: z.string().min(1),
      port,
      adminPort: port.optional(),
      steps: z.unknown(),
      volume: z.string().min(1).optional(),
      followBranch: z.string().min(1).optional(),
    })),
    async (c) => {
      const { project, ...input } = c.req.valid('json')
      await createSite(c.get('principal'), project, input)
      return c.body(null, 204)
    },
  )
  .post(
    '/edit',
    zv('json', siteRef.extend({
      hostname: z.string().min(1).optional(),
      port: port.optional(),
      adminPort: port.nullable().optional(),
      steps: z.unknown().optional(),
      volume: z.string().min(1).nullable().optional(),
      followBranch: z.string().min(1).nullable().optional(),
    })),
    async (c) => {
      const { project, name, ...input } = c.req.valid('json')
      await editSite(c.get('principal'), project, name, input)
      return c.body(null, 204)
    },
  )
  .post(
    '/delete',
    zv('json', siteRef),
    async (c) => {
      const { project, name } = c.req.valid('json')
      await deleteSite(c.get('principal'), project, name)
      return c.body(null, 204)
    },
  )
  .post(
    '/deploy',
    zv('json', siteRef.extend({
      ref: z.string().min(1).optional(),
      timeoutMinutes: z.number().int().positive().optional(),
    })),
    async (c) => {
      const { project, name, ...opts } = c.req.valid('json')
      return c.json(await deploySite(c.get('principal'), project, name, opts))
    },
  )
  .post(
    '/stop',
    zv('json', siteRef),
    async (c) => {
      const { project, name } = c.req.valid('json')
      await stopSite(c.get('principal'), project, name)
      return c.body(null, 204)
    },
  )
  .post(
    '/start',
    zv('json', siteRef),
    async (c) => {
      const { project, name } = c.req.valid('json')
      return c.json(await startSite(c.get('principal'), project, name))
    },
  )

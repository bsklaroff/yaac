import { Hono } from 'hono'
import { z } from 'zod'
import { projectRef, zv } from '#routes/validator'
import { deployTimeoutMinutesSchema, repoStartSchema } from '@yaac/shared/types'
import {
  createSite,
  deleteSite,
  deploySite,
  editSite,
  getSiteEdge,
  listProjectSiteEntries,
  publishSite,
  showSite,
  startSite,
  stopSite,
  unpublishSite,
} from '#domain/sites'
import { requireDriverFeature } from '#api/http/driver-features'
import type { IdentityEnv } from '#api/http/web-auth'

/**
 * Public sites (docs/public-sites.md): a project's app served on the
 * internet by a release workspace. A cluster feature, so each route answers
 * `NOT_SUPPORTED` on a containerless server.
 */
const siteRef = z.object({ project: projectRef, name: z.string().min(1) })
/** Commits by folder, as a review showed them. */
const shownCommits = z.array(z.object({ dir: z.string().max(255), commit: z.string().min(1).max(64) })).max(100)
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
      port,
      adminPort: port.optional(),
      workflow: z.string().min(1),
      volume: z.string().min(1).optional(),
      // The repos its releases start with, by folder or id, each at a
      // branch or a full commit.
      repos: z.array(repoStartSchema).min(1),
      follow: z.boolean().optional(),
      deployTimeoutMinutes: deployTimeoutMinutesSchema.optional(),
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
      port: port.optional(),
      adminPort: port.nullable().optional(),
      workflow: z.string().min(1).optional(),
      volume: z.string().min(1).nullable().optional(),
      // The site's whole list of repos.
      repos: z.array(repoStartSchema).min(1).optional(),
      follow: z.boolean().optional(),
      deployTimeoutMinutes: deployTimeoutMinutesSchema.optional(),
    })),
    async (c) => {
      const { project, name, ...input } = c.req.valid('json')
      await editSite(c.get('principal'), project, name, input)
      return c.body(null, 204)
    },
  )
  .post(
    '/publish',
    zv('json', siteRef.extend({
      hostname: z.string().min(1),
      // The release the person previewed, by id or prefix, which must be
      // the one serving.
      release: z.string().min(1).optional(),
    })),
    async (c) => {
      const { project, name, ...input } = c.req.valid('json')
      await publishSite(c.get('principal'), project, name, input)
      return c.body(null, 204)
    },
  )
  .post(
    '/unpublish',
    zv('json', siteRef),
    async (c) => {
      const { project, name } = c.req.valid('json')
      await unpublishSite(c.get('principal'), project, name)
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
      // A branch or full commit for a site of one repo; `refs` names one per
      // repo, by folder or id. A repo not named takes its setting.
      ref: z.string().min(1).optional(),
      refs: z.record(z.string().min(1).max(255), z.string().min(1)).optional(),
      timeoutMinutes: deployTimeoutMinutesSchema.optional(),
      // Deploy the site's requested deploy as the person was shown it, its
      // workflow and commits (docs/workflows.md "Approvals").
      approve: z.object({ workflowId: z.string().min(1), commits: shownCommits }).optional(),
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

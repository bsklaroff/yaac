import { Hono } from 'hono'
import { z } from 'zod'
import { projectRef, zv } from '#routes/validator'
import { createWorkflow, deleteWorkflow, editWorkflow, listProjectWorkflows, showWorkflow } from '#domain/projects'
import type { IdentityEnv } from '#api/http/web-auth'

/** Workflows (docs/workflows.md): a project's named step graphs. */
const workflowRef = z.object({ project: projectRef, name: z.string().min(1) })
const secrets = z.array(z.string().min(1))
/** The repos its steps are written for, by folder or id. */
const repos = z.array(z.string().min(1).max(255))

export const workflowApp = new Hono<IdentityEnv>()
  .get(
    '/list',
    zv('query', z.object({ project: projectRef })),
    async (c) => c.json(await listProjectWorkflows(c.req.valid('query').project)),
  )
  .get(
    '/show',
    zv('query', workflowRef),
    async (c) => {
      const { project, name } = c.req.valid('query')
      return c.json(await showWorkflow(project, name))
    },
  )
  .post(
    '/create',
    zv('json', workflowRef.extend({ steps: z.unknown(), secrets: secrets.optional(), repos: repos.optional(), init: z.boolean().optional() })),
    async (c) => {
      const { project, ...input } = c.req.valid('json')
      return c.json(await createWorkflow(c.get('principal'), project, input))
    },
  )
  .post(
    '/edit',
    zv('json', workflowRef.extend({
      steps: z.unknown().optional(),
      secrets: secrets.optional(),
      repos: repos.optional(),
      init: z.boolean().optional(),
    })),
    async (c) => {
      const { project, name, ...input } = c.req.valid('json')
      return c.json(await editWorkflow(c.get('principal'), project, name, input))
    },
  )
  .post(
    '/delete',
    zv('json', workflowRef),
    async (c) => {
      const { project, name } = c.req.valid('json')
      await deleteWorkflow(c.get('principal'), project, name)
      return c.body(null, 204)
    },
  )

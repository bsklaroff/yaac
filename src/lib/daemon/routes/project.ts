import { Hono } from 'hono'
import { listProjects } from '@/lib/project/list'
import { getProjectDetail, resolveProjectConfigWithSource } from '@/lib/project/detail'

export const projectApp = new Hono()
  .get('/list', async (c) => c.json(await listProjects()))
  .get('/:slug', async (c) => c.json(await getProjectDetail(c.req.param('slug'))))
  .get('/:slug/config', async (c) => c.json(await resolveProjectConfigWithSource(c.req.param('slug'))))

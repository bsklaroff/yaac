import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { listProjects } from '@/lib/project/list'
import { getProjectDetail, resolveProjectConfigWithSource } from '@/lib/project/detail'
import { addProject } from '@/lib/project/add'
import { removeProject } from '@/lib/project/remove'
import { writeConfigOverride, removeConfigOverride } from '@/lib/project/config-override'

export const projectApp = new Hono()
  .get('/list', async (c) => c.json(await listProjects()))
  .post(
    '/add',
    zValidator('json', z.object({ remoteUrl: z.string().min(1) })),
    async (c) => {
      const { remoteUrl } = c.req.valid('json')
      return c.json(await addProject(remoteUrl))
    },
  )
  .get('/:slug', async (c) => c.json(await getProjectDetail(c.req.param('slug'))))
  .delete('/:slug', async (c) => {
    await removeProject(c.req.param('slug'))
    return c.body(null, 204)
  })
  .get('/:slug/config', async (c) => c.json(await resolveProjectConfigWithSource(c.req.param('slug'))))
  .put(
    '/:slug/config',
    zValidator('json', z.object({ config: z.unknown() }).refine(
      (b) => b.config !== undefined,
      { message: 'Expected { config } body.', path: ['config'] },
    )),
    async (c) => {
      const { config } = c.req.valid('json')
      const saved = await writeConfigOverride(c.req.param('slug'), config)
      return c.json({ config: saved })
    },
  )
  .delete('/:slug/config-override', async (c) => {
    await removeConfigOverride(c.req.param('slug'))
    return c.body(null, 204)
  })

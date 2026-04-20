import { Hono } from 'hono'
import { listProjects } from '@/lib/project/list'
import { getProjectDetail, resolveProjectConfigWithSource } from '@/lib/project/detail'
import { addProject } from '@/lib/project/add'
import { removeProject } from '@/lib/project/remove'
import { writeConfigOverride, removeConfigOverride } from '@/lib/project/config-override'
import { DaemonError } from '@/lib/daemon/errors'
import { readJsonBody } from '@/lib/daemon/body'

export const projectApp = new Hono()
  .get('/list', async (c) => c.json(await listProjects()))
  .post('/add', async (c) => {
    const body = await readJsonBody(c.req.raw)
    if (typeof body.remoteUrl !== 'string' || body.remoteUrl === '') {
      throw new DaemonError('VALIDATION', 'Expected { remoteUrl: string } body.')
    }
    return c.json(await addProject(body.remoteUrl))
  })
  .get('/:slug', async (c) => c.json(await getProjectDetail(c.req.param('slug'))))
  .delete('/:slug', async (c) => {
    await removeProject(c.req.param('slug'))
    return c.body(null, 204)
  })
  .get('/:slug/config', async (c) => c.json(await resolveProjectConfigWithSource(c.req.param('slug'))))
  .put('/:slug/config', async (c) => {
    const body = await readJsonBody(c.req.raw)
    if (body.config === undefined) {
      throw new DaemonError('VALIDATION', 'Expected { config } body.')
    }
    const saved = await writeConfigOverride(c.req.param('slug'), body.config)
    return c.json({ config: saved })
  })
  .delete('/:slug/config-override', async (c) => {
    await removeConfigOverride(c.req.param('slug'))
    return c.body(null, 204)
  })

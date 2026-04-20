import { Hono } from 'hono'
import { listProjects } from '@/lib/project/list'

export const projectApp = new Hono().get('/list', async (c) => {
  const projects = await listProjects()
  return c.json(projects)
})

import type { Hono } from 'hono'
import { listProjects } from '@/lib/project/list'

export function registerProjectRoutes(app: Hono): void {
  app.get('/project/list', async (c) => {
    const projects = await listProjects()
    return c.json(projects)
  })
}

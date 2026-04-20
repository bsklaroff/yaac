import { Hono } from 'hono'
import { getDefaultTool } from '@/lib/project/preferences'

export const toolApp = new Hono()
  .get('/get', async (c) => c.json({ tool: (await getDefaultTool()) ?? null }))

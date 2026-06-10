import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { getDefaultTool, getTailnetSharing, setDefaultToolChecked, setTailnetSharing } from '@/lib/project/preferences'

export const toolApp = new Hono()
  .get('/get', async (c) => c.json({ tool: (await getDefaultTool()) ?? null }))
  .post(
    '/set',
    zValidator('json', z.object({ tool: z.string() })),
    async (c) => {
      const { tool } = c.req.valid('json')
      const saved = await setDefaultToolChecked(tool)
      return c.json({ tool: saved })
    },
  )
  .get('/tailnet-sharing', async (c) => c.json({ enabled: await getTailnetSharing() }))
  .post(
    '/tailnet-sharing',
    zValidator('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      await setTailnetSharing(c.req.valid('json').enabled)
      return c.json({ enabled: c.req.valid('json').enabled })
    },
  )

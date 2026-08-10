import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { getDefaultTool, setDefaultToolChecked } from '#records'

export const toolApp = new Hono()
  .get('/get', async (c) => c.json({ tool: (await getDefaultTool()) ?? null }))
  .post(
    '/set',
    zv('json', z.object({ tool: z.string() })),
    async (c) => {
      const { tool } = c.req.valid('json')
      const saved = await setDefaultToolChecked(tool)
      return c.json({ tool: saved })
    },
  )

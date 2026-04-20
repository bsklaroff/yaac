import { Hono } from 'hono'
import { getDefaultTool, setDefaultToolChecked } from '@/lib/project/preferences'
import { DaemonError } from '@/lib/daemon/errors'
import { readJsonBody } from '@/lib/daemon/body'

export const toolApp = new Hono()
  .get('/get', async (c) => c.json({ tool: (await getDefaultTool()) ?? null }))
  .post('/set', async (c) => {
    const body = await readJsonBody(c.req.raw)
    if (typeof body.tool !== 'string') {
      throw new DaemonError('VALIDATION', 'Expected { tool: string } body.')
    }
    const saved = await setDefaultToolChecked(body.tool)
    return c.json({ tool: saved })
  })

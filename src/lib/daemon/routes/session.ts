import { Hono } from 'hono'
import { listActiveSessions, listDeletedSessions } from '@/lib/session/list'
import { getSessionDetail, getSessionBlockedHosts, getSessionPrompt } from '@/lib/session/detail'

export const sessionApp = new Hono()
  .get('/list', async (c) => {
    const project = c.req.query('project') || undefined
    const deleted = c.req.query('deleted') === 'true'
    if (deleted) return c.json(await listDeletedSessions(project))
    return c.json(await listActiveSessions(project))
  })
  .get('/:id', async (c) => c.json(await getSessionDetail(c.req.param('id'))))
  .get('/:id/blocked-hosts', async (c) => c.json(await getSessionBlockedHosts(c.req.param('id'))))
  .get('/:id/prompt', async (c) => {
    const prompt = await getSessionPrompt(c.req.param('id'))
    return c.json({ prompt: prompt ?? '' })
  })

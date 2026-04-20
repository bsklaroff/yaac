import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { listActiveSessions, listDeletedSessions } from '@/lib/session/list'
import { getSessionDetail, getSessionBlockedHosts, getSessionPrompt } from '@/lib/session/detail'
import { deleteSession } from '@/lib/session/delete'
import { createSession, type SessionCreateOptions } from '@/commands/session-create'
import { DaemonError } from '@/lib/daemon/errors'

export const sessionApp = new Hono()
  .get(
    '/list',
    zValidator('query', z.object({ project: z.string().optional() })),
    async (c) => {
      const { project } = c.req.valid('query')
      return c.json(await listActiveSessions(project || undefined))
    },
  )
  .get(
    '/list-deleted',
    zValidator('query', z.object({ project: z.string().optional() })),
    async (c) => {
      const { project } = c.req.valid('query')
      return c.json(await listDeletedSessions(project || undefined))
    },
  )
  .post(
    '/create',
    zValidator('json', z.object({
      project: z.string().min(1),
      addDir: z.array(z.string()).optional(),
      addDirRw: z.array(z.string()).optional(),
      tool: z.enum(['claude', 'codex']).optional(),
      gitUser: z.object({ name: z.string(), email: z.string() }).optional(),
      portReservations: z.array(z.object({
        containerPort: z.number(),
        hostPort: z.number(),
      })).optional(),
    })),
    async (c) => {
      const body = c.req.valid('json')
      const opts: SessionCreateOptions = {}
      if (body.addDir) opts.addDir = body.addDir
      if (body.addDirRw) opts.addDirRw = body.addDirRw
      if (body.tool) opts.tool = body.tool
      if (body.gitUser) opts.gitUser = body.gitUser
      if (body.portReservations) opts.portReservations = body.portReservations
      const result = await createSession(body.project, { ...opts, noAttach: true })
      if (!result) throw new DaemonError('INTERNAL', 'session creation returned no result')
      return c.json(result)
    },
  )
  .post(
    '/delete',
    zValidator('json', z.object({ sessionId: z.string().min(1) })),
    async (c) => {
      const { sessionId } = c.req.valid('json')
      const info = await deleteSession(sessionId)
      return c.json(info)
    },
  )
  .get('/:id', async (c) => c.json(await getSessionDetail(c.req.param('id'))))
  .get('/:id/blocked-hosts', async (c) => c.json(await getSessionBlockedHosts(c.req.param('id'))))
  .get('/:id/prompt', async (c) => {
    const prompt = await getSessionPrompt(c.req.param('id'))
    return c.json({ prompt: prompt ?? '' })
  })

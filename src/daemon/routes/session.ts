import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { listActiveSessions, listDeletedSessions } from '@/lib/session/list'
import { getSessionDetail, getSessionBlockedHosts, getSessionPrompt } from '@/lib/session/detail'
import { deleteSession } from '@/lib/session/delete'
import { restartSession } from '@/lib/session/restart'
import { createSession, type SessionCreateOptions } from '@/daemon/session-create'
import { DaemonError, toErrorBody } from '@/daemon/errors'
import { resolveSessionContainer } from '@/daemon/session-resolve'
import { pickNextStreamSession } from '@/daemon/stream-picker'
import { notifySessionListChanged } from '@/daemon/sessions-changed'
import { listSessionTerminals, killShellTerminal } from '@/daemon/terminals'
import { setSessionTitle } from '@/lib/session/titles'

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
    zValidator('query', z.object({
      project: z.string().optional(),
      limit: z.coerce.number().int().positive().optional(),
    })),
    async (c) => {
      const { project, limit } = c.req.valid('query')
      return c.json(await listDeletedSessions(project || undefined, limit))
    },
  )
  .post(
    '/create',
    zValidator('json', z.object({
      project: z.string().min(1),
      addDir: z.array(z.string()).optional(),
      addDirRw: z.array(z.string()).optional(),
      tool: z.enum(['claude', 'codex', 'opencode']).optional(),
      gitUser: z.object({ name: z.string(), email: z.string() }).optional(),
    })),
    (c) => {
      // NDJSON stream of {type:'progress'|'result'|'error'} events so the
      // CLI can render provisioning progress live. Errors thrown inside
      // the stream callback are swallowed by hono; catch and emit them.
      const body = c.req.valid('json')
      c.header('Content-Type', 'application/x-ndjson')
      return stream(c, async (s) => {
        const write = (event: unknown) => s.writeln(JSON.stringify(event))
        const opts: SessionCreateOptions = {
          onProgress: (message) => { void write({ type: 'progress', message }) },
        }
        if (body.addDir) opts.addDir = body.addDir
        if (body.addDirRw) opts.addDirRw = body.addDirRw
        if (body.tool) opts.tool = body.tool
        if (body.gitUser) opts.gitUser = body.gitUser
        try {
          const result = await createSession(body.project, opts)
          if (!result) throw new DaemonError('INTERNAL', 'session creation returned no result')
          await write({ type: 'result', result })
          // Container is up — push a snapshot now so the webapp shows the new
          // session immediately instead of on the next periodic tick.
          notifySessionListChanged()
        } catch (err) {
          const { body: errBody } = toErrorBody(err)
          await write({ type: 'error', error: errBody.error })
        }
      })
    },
  )
  .post(
    '/restart',
    zValidator('json', z.object({
      sessionId: z.string().min(1),
      addDir: z.array(z.string()).optional(),
      addDirRw: z.array(z.string()).optional(),
      gitUser: z.object({ name: z.string(), email: z.string() }).optional(),
    })),
    (c) => {
      const body = c.req.valid('json')
      c.header('Content-Type', 'application/x-ndjson')
      return stream(c, async (s) => {
        const write = (event: unknown) => s.writeln(JSON.stringify(event))
        try {
          const result = await restartSession(body.sessionId, {
            addDir: body.addDir,
            addDirRw: body.addDirRw,
            gitUser: body.gitUser,
            onProgress: (message) => { void write({ type: 'progress', message }) },
          })
          await write({ type: 'result', result })
          notifySessionListChanged()
        } catch (err) {
          const { body: errBody } = toErrorBody(err)
          await write({ type: 'error', error: errBody.error })
        }
      })
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
  .post(
    '/stream/next',
    zValidator('json', z.object({
      project: z.string().optional(),
      tool: z.enum(['claude', 'codex', 'opencode']).optional(),
      visited: z.array(z.string()).default([]),
      lastVisited: z.string().optional(),
      lastProjectSlug: z.string().optional(),
      lastTool: z.enum(['claude', 'codex', 'opencode']).optional(),
      lastOutcome: z.enum(['detached', 'closed_blank', 'closed_prompted', 'none']).default('none'),
    })),
    async (c) => {
      const body = c.req.valid('json')
      const result = await pickNextStreamSession(body)
      return c.json(result)
    },
  )
  .get('/:id/attach-info', async (c) => {
    const resolved = await resolveSessionContainer(c.req.param('id'), { requireRunning: true })
    return c.json({ jobName: resolved.jobName, tmuxSession: 'yaac' as const })
  })
  .get('/:id/shell-info', async (c) => {
    const resolved = await resolveSessionContainer(c.req.param('id'), { requireRunning: true })
    return c.json({ jobName: resolved.jobName })
  })
  .post(
    '/:id/title',
    zValidator('json', z.object({ title: z.string().max(500) })),
    async (c) => {
      // Resolve in any state — renaming a waiting or just-stopped session is
      // fine; the title lives on the host, not in the container.
      const { projectSlug, sessionId } = await resolveSessionContainer(c.req.param('id'))
      await setSessionTitle(projectSlug, sessionId, c.req.valid('json').title)
      // Push a fresh snapshot so the sidebar reflects the rename immediately.
      notifySessionListChanged()
      return c.body(null, 204)
    },
  )
  .get('/:id/terminals', async (c) => {
    const { jobName } = await resolveSessionContainer(c.req.param('id'), { requireRunning: true })
    return c.json(await listSessionTerminals(jobName))
  })
  .post(
    '/:id/terminals/close',
    zValidator('json', z.object({ target: z.string().min(1) })),
    async (c) => {
      const { jobName } = await resolveSessionContainer(c.req.param('id'), { requireRunning: true })
      const { target } = c.req.valid('json')
      try {
        await killShellTerminal(jobName, target)
      } catch (err) {
        throw new DaemonError('VALIDATION', err instanceof Error ? err.message : String(err))
      }
      return c.body(null, 204)
    },
  )
  .get('/:id', async (c) => c.json(await getSessionDetail(c.req.param('id'))))
  .get('/:id/blocked-hosts', async (c) => c.json(await getSessionBlockedHosts(c.req.param('id'))))
  .get('/:id/prompt', async (c) => {
    const prompt = await getSessionPrompt(c.req.param('id'))
    return c.json({ prompt: prompt ?? '' })
  })

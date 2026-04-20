import { Hono } from 'hono'
import { listActiveSessions, listDeletedSessions } from '@/lib/session/list'
import { getSessionDetail, getSessionBlockedHosts, getSessionPrompt } from '@/lib/session/detail'
import { deleteSession } from '@/lib/session/delete'
import { createSession, type SessionCreateOptions } from '@/commands/session-create'
import type { PortMapping } from '@/lib/container/port'
import { DaemonError } from '@/lib/daemon/errors'
import { readJsonBody, readStringArray } from '@/lib/daemon/body'
import type { AgentTool } from '@/types'

export const sessionApp = new Hono()
  .get('/list', async (c) => {
    const project = c.req.query('project') || undefined
    const deleted = c.req.query('deleted') === 'true'
    if (deleted) return c.json(await listDeletedSessions(project))
    return c.json(await listActiveSessions(project))
  })
  .post('/create', async (c) => {
    const body = await readJsonBody(c.req.raw)
    if (typeof body.project !== 'string' || body.project === '') {
      throw new DaemonError('VALIDATION', 'Expected { project: string, ... } body.')
    }
    const opts = buildCreateOptions(body)
    const result = await createSession(body.project, { ...opts, noAttach: true })
    if (!result) {
      throw new DaemonError('INTERNAL', 'session creation returned no result')
    }
    return c.json(result)
  })
  .post('/delete', async (c) => {
    const body = await readJsonBody(c.req.raw)
    if (typeof body.sessionId !== 'string' || body.sessionId === '') {
      throw new DaemonError('VALIDATION', 'Expected { sessionId: string } body.')
    }
    const info = await deleteSession(body.sessionId)
    return c.json(info)
  })
  .get('/:id', async (c) => c.json(await getSessionDetail(c.req.param('id'))))
  .get('/:id/blocked-hosts', async (c) => c.json(await getSessionBlockedHosts(c.req.param('id'))))
  .get('/:id/prompt', async (c) => {
    const prompt = await getSessionPrompt(c.req.param('id'))
    return c.json({ prompt: prompt ?? '' })
  })

function buildCreateOptions(body: Record<string, unknown>): SessionCreateOptions {
  const opts: SessionCreateOptions = {}
  const addDir = readStringArray(body.addDir, 'addDir')
  if (addDir) opts.addDir = addDir
  const addDirRw = readStringArray(body.addDirRw, 'addDirRw')
  if (addDirRw) opts.addDirRw = addDirRw
  if (body.tool !== undefined) {
    if (body.tool !== 'claude' && body.tool !== 'codex') {
      throw new DaemonError(
        'VALIDATION',
        'Invalid tool. Must be one of: claude, codex',
      )
    }
    opts.tool = body.tool as AgentTool
  }
  if (body.gitUser !== undefined) {
    const gu = body.gitUser as { name?: unknown; email?: unknown } | null
    if (!gu || typeof gu !== 'object' || typeof gu.name !== 'string' || typeof gu.email !== 'string') {
      throw new DaemonError('VALIDATION', 'Expected gitUser: { name, email }.')
    }
    opts.gitUser = { name: gu.name, email: gu.email }
  }
  if (body.portReservations !== undefined) {
    if (!Array.isArray(body.portReservations)) {
      throw new DaemonError('VALIDATION', 'Expected portReservations to be an array.')
    }
    const mappings: PortMapping[] = []
    for (const entry of body.portReservations) {
      if (!entry || typeof entry !== 'object') {
        throw new DaemonError('VALIDATION', 'portReservations entries must be objects.')
      }
      const e = entry as { containerPort?: unknown; hostPort?: unknown }
      if (typeof e.containerPort !== 'number' || typeof e.hostPort !== 'number') {
        throw new DaemonError('VALIDATION', 'portReservations entries need containerPort + hostPort numbers.')
      }
      mappings.push({ containerPort: e.containerPort, hostPort: e.hostPort })
    }
    opts.portReservations = mappings
  }
  return opts
}

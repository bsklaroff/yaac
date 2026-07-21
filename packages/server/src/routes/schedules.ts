import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { addSchedule, listSchedules, removeScheduleChecked } from '#features/schedules/schedules'

export const scheduleApp = new Hono()
  .get(
    '/list',
    zv('query', z.object({ project: z.string().optional() })),
    async (c) => {
      const { project } = c.req.valid('query')
      return c.json({ schedules: await listSchedules(project || undefined) })
    },
  )
  .post(
    '/add',
    zv('json', z.object({
      project: z.string().min(1),
      // Cron expression, evaluated in the server's local time.
      spec: z.string().min(1),
      // Initial prompt typed into each fired session's agent pane.
      prompt: z.string().min(1).max(10000),
      tool: z.enum(['claude', 'codex', 'opencode', 'pi']).optional(),
    })),
    async (c) => {
      const body = c.req.valid('json')
      const schedule = await addSchedule({
        projectSlug: body.project,
        spec: body.spec,
        prompt: body.prompt,
        tool: body.tool,
      })
      return c.json({ schedule })
    },
  )
  .post(
    '/remove',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => {
      const { id } = c.req.valid('json')
      await removeScheduleChecked(id)
      return c.json({ ok: true })
    },
  )

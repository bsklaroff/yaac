import { Hono } from 'hono'
import { z } from 'zod'
import { projectRef, zv } from '#routes/validator'
import {
  createRoutine,
  deleteRoutine,
  listRoutineRunPage,
  listRoutines,
  runRoutineNow,
  setRoutinePaused,
  updateRoutine,
} from '#domain/workspaces'
import type { IdentityEnv } from '#api/http/web-auth'
import { ROUTINE_RUNS_PAGE_MAX, routineSettingsSchema } from '@yaac/shared/types'

/**
 * Routines (docs/routines.md): cron-scheduled workspaces. The snapshot
 * carries the routines themselves; these are the writes, which are the
 * project owner's, and a routine's run history, which anyone who can read
 * the project may page through.
 */
export const routineApp = new Hono<IdentityEnv>()
  // Every project's routines: the snapshot's feed, for the CLI.
  .get('/list', async (c) => c.json(await listRoutines()))
  .get(
    '/runs',
    zv('query', z.object({
      id: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(ROUTINE_RUNS_PAGE_MAX).optional(),
      cursor: z.string().optional(),
    })),
    async (c) => {
      const { id, ...opts } = c.req.valid('query')
      return c.json(await listRoutineRunPage(id, opts))
    },
  )
  .post(
    '/create',
    zv('json', routineSettingsSchema.extend({ project: projectRef })),
    async (c) => {
      const { project, ...request } = c.req.valid('json')
      return c.json(await createRoutine(c.get('principal'), project, request, 'user'))
    },
  )
  .post(
    '/update',
    zv('json', routineSettingsSchema.partial().extend({ id: z.string().min(1) })),
    async (c) => {
      const { id, ...patch } = c.req.valid('json')
      return c.json(await updateRoutine(c.get('principal'), id, patch, 'user'))
    },
  )
  .post(
    '/pause',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => c.json(await setRoutinePaused(c.get('principal'), c.req.valid('json').id, true)),
  )
  .post(
    '/resume',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => c.json(await setRoutinePaused(c.get('principal'), c.req.valid('json').id, false)),
  )
  // Start a run now, outside the schedule; it stops at the next tick unless
  // the routine has a timeout of its own.
  .post(
    '/run',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => c.json(await runRoutineNow(c.get('principal'), c.req.valid('json').id)),
  )
  // Running runs keep going until their deadlines.
  .post(
    '/delete',
    zv('json', z.object({ id: z.string().min(1) })),
    async (c) => {
      await deleteRoutine(c.get('principal'), c.req.valid('json').id)
      return c.body(null, 204)
    },
  )

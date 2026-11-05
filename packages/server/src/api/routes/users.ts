import { Hono } from 'hono'
import { zv } from '#routes/validator'
import type { IdentityEnv } from '#api/http/web-auth'
import { z } from 'zod'
import { setUserRole } from '#domain/access'

/** The install's users, as admins manage them (docs/multi-user.md "Roles").
 *  `GET /whoami` is what lists them. */
export const usersApp = new Hono<IdentityEnv>()
  .put(
    '/:userId/role',
    zv('param', z.object({ userId: z.uuid() })),
    zv('json', z.object({ role: z.enum(['admin', 'member']) })),
    async (c) => {
      await setUserRole(c.get('principal'), c.req.valid('param').userId, c.req.valid('json').role)
      return c.json({ ok: true })
    },
  )

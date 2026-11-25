import { Hono } from 'hono'
import { z } from 'zod'
import { PERMISSION_MODES } from '@yaac/shared/types'
import { personOnly, type IdentityEnv } from '#api/http/web-auth'
import { zv } from '#routes/validator'
import { createTokenBinding, deleteTokenBinding, listTokenBindings } from '#domain/access'

const common = {
  label: z.string(),
  expiresInMinutes: z.number().int().positive().optional(),
  permissionMode: z.enum(PERMISSION_MODES as [string, ...string[]]).optional(),
}

/**
 * The caller's token bindings (docs/remote-hosting.md "Token access"), and
 * for an admin anyone's (`?user=` to list, any id to delete). A person's
 * alone: a delegate, a token's included, is refused before anything is
 * read.
 */
export const tokensApp = new Hono<IdentityEnv>()
  .use(personOnly)
  .get(
    '/',
    zv('query', z.object({ user: z.uuid().optional() })),
    async (c) => c.json(await listTokenBindings(c.get('principal'), c.req.valid('query').user)),
  )
  .post(
    '/',
    zv('json', z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('pat'), ...common }),
      z.object({
        kind: z.literal('oidc'),
        ...common,
        issuer: z.string(),
        subject: z.string(),
        claims: z.record(z.string(), z.string()).optional(),
      }),
    ])),
    async (c) => {
      const body = c.req.valid('json') as Parameters<typeof createTokenBinding>[1]
      return c.json(await createTokenBinding(c.get('principal'), body))
    },
  )
  .delete(
    '/:id',
    zv('param', z.object({ id: z.uuid() })),
    async (c) => {
      await deleteTokenBinding(c.get('principal'), c.req.valid('param').id)
      return c.json({ ok: true })
    },
  )

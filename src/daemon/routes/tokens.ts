import { Hono } from 'hono'
import { z } from 'zod'
import { zv } from '@/daemon/routes/validator'
import { DaemonError } from '@/daemon/errors'
import type { TokenStore } from '@/daemon/token-store'

/**
 * Durable-token CRUD, mounted at /tokens — its own base, distinct from
 * /auth (agent credentials + sign-in flows): these are daemon access
 * tokens, not tool credentials. A factory (unlike the module-const route
 * apps) because the store is a buildApp dependency — same DI shape as
 * the web-auth store. The create response is the only place the full
 * token ever leaves the daemon; list returns masked summaries.
 */
export function createTokensApp(tokens: TokenStore) {
  return new Hono()
    .post(
      '/',
      zv('json', z.object({ name: z.string().min(1) })),
      (c) => {
        const entry = tokens.create(c.req.valid('json').name)
        return c.json(entry, 201)
      },
    )
    .get('/', (c) => c.json({ tokens: tokens.list() }))
    .delete('/:name', (c) => {
      const name = c.req.param('name')
      if (!tokens.revoke(name)) {
        throw new DaemonError('NOT_FOUND', `no token named '${name}'`)
      }
      return c.body(null, 204)
    })
}

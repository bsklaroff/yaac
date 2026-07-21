import { Hono } from 'hono'
import { z } from 'zod'
import { zv } from '#routes/validator'
import { ServerError } from '@yaac/shared/errors'
import type { TokenStore } from '#http/token-store'

/**
 * Token CRUD, mounted at /tokens — its own base, distinct from /auth
 * (agent credentials + sign-in flows): these are server access tokens,
 * not tool credentials. A factory (unlike the module-const route apps)
 * because the store is a buildApp dependency.
 *
 * POST mints either a named durable token (a client registering, e.g.
 * `yaac auth token create`) or an auto-named one-time exchange token
 * (`yaac open` bootstrapping a browser) — one endpoint for every way a
 * client enrolls. The create response is the only place the full token
 * ever leaves the server; list returns masked summaries.
 */
const createSchema = z.union([
  z.object({ name: z.string().min(1) }),
  z.object({ kind: z.literal('one-time') }),
])

export function createTokensApp(tokens: TokenStore) {
  return new Hono()
    .post(
      '/',
      zv('json', createSchema),
      (c) => {
        const body = c.req.valid('json')
        const entry = 'name' in body
          ? tokens.create(body.name)
          : tokens.mintExchangeToken()
        return c.json(entry, 201)
      },
    )
    .get('/', (c) => c.json({ tokens: tokens.list() }))
    .delete('/:name', (c) => {
      const name = c.req.param('name')
      if (!tokens.revoke(name)) {
        throw new ServerError('NOT_FOUND', `no token named '${name}'`)
      }
      return c.body(null, 204)
    })
}

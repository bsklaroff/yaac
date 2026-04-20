import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { listAuth } from '@/lib/auth/list'
import { clearAuth } from '@/lib/auth/clear'
import { addToken, removeTokenChecked, replaceTokens } from '@/lib/project/credentials'
import { persistToolAuthPayload } from '@/lib/project/tool-auth'
import { claudeOAuthBundleSchema, codexOAuthBundleSchema } from '@/shared/types'

export const authApp = new Hono()
  .get('/list', async (c) => c.json(await listAuth()))
  .post(
    '/clear',
    zValidator('json', z.object({ service: z.enum(['all', 'claude', 'codex']) })),
    async (c) => {
      const { service } = c.req.valid('json')
      await clearAuth(service)
      return c.body(null, 204)
    },
  )
  .post(
    '/github/tokens',
    zValidator('json', z.object({ pattern: z.string(), token: z.string() })),
    async (c) => {
      const { pattern, token } = c.req.valid('json')
      await addToken(pattern, token)
      return c.body(null, 204)
    },
  )
  .delete('/github/tokens/:pattern', async (c) => {
    const pattern = decodeURIComponent(c.req.param('pattern'))
    await removeTokenChecked(pattern)
    return c.body(null, 204)
  })
  .put(
    '/github/tokens',
    zValidator('json', z.object({
      tokens: z.array(z.object({ pattern: z.string(), token: z.string() })),
    })),
    async (c) => {
      const { tokens } = c.req.valid('json')
      await replaceTokens(tokens)
      return c.body(null, 204)
    },
  )
  .put(
    '/:tool',
    zValidator('param', z.object({ tool: z.enum(['claude', 'codex']) })),
    zValidator('json', z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('api-key'), apiKey: z.string().min(1) }),
      z.object({
        kind: z.literal('oauth'),
        bundle: z.union([claudeOAuthBundleSchema, codexOAuthBundleSchema]),
      }),
    ])),
    async (c) => {
      const { tool } = c.req.valid('param')
      const body = c.req.valid('json')
      await persistToolAuthPayload(tool, body)
      return c.body(null, 204)
    },
  )

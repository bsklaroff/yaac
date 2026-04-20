import { Hono } from 'hono'
import { listAuth } from '@/lib/auth/list'
import { clearAuth, type ClearAuthTarget } from '@/lib/auth/clear'
import { addToken, removeTokenChecked, replaceTokens } from '@/lib/project/credentials'
import { persistToolAuthPayload } from '@/lib/project/tool-auth'
import { DaemonError } from '@/lib/daemon/errors'
import { readJsonBody } from '@/lib/daemon/body'
import type { GithubTokenEntry } from '@/types'

export const authApp = new Hono()
  .get('/list', async (c) => c.json(await listAuth()))
  .post('/clear', async (c) => {
    const body = await readJsonBody(c.req.raw)
    if (body.service !== 'all' && body.service !== 'claude' && body.service !== 'codex') {
      throw new DaemonError(
        'VALIDATION',
        `Invalid service "${String(body.service)}". Must be one of: all, claude, codex`,
      )
    }
    await clearAuth(body.service as ClearAuthTarget)
    return c.body(null, 204)
  })
  .post('/github/tokens', async (c) => {
    const body = await readJsonBody(c.req.raw)
    if (typeof body.pattern !== 'string' || typeof body.token !== 'string') {
      throw new DaemonError('VALIDATION', 'Expected { pattern: string, token: string } body.')
    }
    await addToken(body.pattern, body.token)
    return c.body(null, 204)
  })
  .delete('/github/tokens/:pattern', async (c) => {
    const pattern = decodeURIComponent(c.req.param('pattern'))
    await removeTokenChecked(pattern)
    return c.body(null, 204)
  })
  .put('/github/tokens', async (c) => {
    const body = await readJsonBody(c.req.raw)
    if (!Array.isArray(body.tokens)) {
      throw new DaemonError('VALIDATION', 'Expected { tokens: [...] } body.')
    }
    await replaceTokens(body.tokens as GithubTokenEntry[])
    return c.body(null, 204)
  })
  .put('/:tool', async (c) => {
    const tool = c.req.param('tool')
    if (tool !== 'claude' && tool !== 'codex') {
      throw new DaemonError('VALIDATION', `Unknown tool "${tool}".`)
    }
    const body = await readJsonBody(c.req.raw)
    await persistToolAuthPayload(tool, body)
    return c.body(null, 204)
  })

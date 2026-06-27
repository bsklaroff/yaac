import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { listAuth } from '@/lib/auth/list'
import { clearAuth } from '@/lib/auth/clear'
import { addEntry, removeEntryChecked, replaceEntries } from '@/lib/project/credentials'
import { persistToolAuthPayload } from '@/lib/project/tool-auth'
import { seedFakeClaudeOAuth, seedFakeGithubCredential } from '@/lib/project/fake-auth'
import { proxyClient } from '@/lib/container/proxy-client'
import { claudeOAuthBundleSchema, codexOAuthBundleSchema } from '@/shared/types'

const httpsCredentialSchema = z.object({
  kind: z.literal('https'),
  pattern: z.string(),
  token: z.string().min(1),
})

const sshCredentialSchema = z.object({
  kind: z.literal('ssh'),
  pattern: z.string(),
  privateKeyPath: z.string().min(1),
  knownHostsEntry: z.string().min(1),
})

const credentialSchema = z.discriminatedUnion('kind', [
  httpsCredentialSchema,
  sshCredentialSchema,
])

export const authApp = new Hono()
  .get('/list', async (c) => c.json(await listAuth()))
  .post(
    '/clear',
    zValidator('json', z.object({ service: z.enum(['all', 'claude', 'codex', 'opencode']) })),
    async (c) => {
      const { service } = c.req.valid('json')
      await clearAuth(service)
      return c.body(null, 204)
    },
  )
  .post(
    '/fake',
    zValidator('json', z.object({ kind: z.enum(['claude-oauth', 'github']) })),
    async (c) => {
      const { kind } = c.req.valid('json')
      if (kind === 'claude-oauth') {
        await seedFakeClaudeOAuth()
      } else {
        await seedFakeGithubCredential()
      }
      return c.body(null, 204)
    },
  )
  .post(
    '/git/credentials',
    zValidator('json', credentialSchema),
    async (c) => {
      const entry = c.req.valid('json')
      await addEntry(entry)
      // SSH entries are useless without the proxy's ssh-agent knowing about
      // the key. Sync immediately so a running proxy picks the change up
      // without needing a restart. Failure to sync is non-fatal — the daemon
      // will retry on next ensureRunning().
      if (entry.kind === 'ssh') {
        try {
          await proxyClient.syncSshKeysFromCredentials()
        } catch (err) {
          console.warn(
            '[auth] Saved SSH credential but failed to push to proxy ssh-agent: '
            + (err instanceof Error ? err.message : String(err)),
          )
        }
      }
      return c.body(null, 204)
    },
  )
  .delete('/git/credentials/:pattern', async (c) => {
    const pattern = decodeURIComponent(c.req.param('pattern'))
    await removeEntryChecked(pattern)
    // Removing any entry may leave a stale identity in the agent. Clear-and-
    // reload the agent's full set.
    try {
      await proxyClient.syncSshKeysFromCredentials()
    } catch {
      // non-fatal — daemon will retry on next ensureRunning()
    }
    return c.body(null, 204)
  })
  .put(
    '/git/credentials',
    zValidator('json', z.object({
      credentials: z.array(credentialSchema),
    })),
    async (c) => {
      const { credentials } = c.req.valid('json')
      await replaceEntries(credentials)
      try {
        await proxyClient.syncSshKeysFromCredentials()
      } catch {
        // non-fatal
      }
      return c.body(null, 204)
    },
  )
  .put(
    '/:tool',
    zValidator('param', z.object({ tool: z.enum(['claude', 'codex', 'opencode']) })),
    zValidator('json', z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('api-key'),
        apiKey: z.string().min(1),
        // opencode only — which backend the key authenticates against.
        // Ignored for claude/codex. Defaults to openrouter when absent.
        provider: z.enum(['openrouter', 'neuralwatt']).optional(),
      }),
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

import { Hono } from 'hono'
import { zv } from '@/daemon/routes/validator'
import { z } from 'zod'
import { listAuth } from '@/lib/auth/list'
import { clearAuth } from '@/lib/auth/clear'
import { requestPlanUsageRefresh } from '@/daemon/plan-usage'
import { authAgentHub } from '@/daemon/auth-agent'
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
  // Nudge the daemon-side plan-usage refresh (fired when the webapp's usage
  // popover opens). Throttled in daemon/plan-usage.ts — a nudge within a
  // minute of the last refresh is ignored — and the data itself always
  // arrives via the pushed snapshot, never this response.
  .post('/claude/usage/refresh', async (c) => {
    await requestPlanUsageRefresh()
    return c.body(null, 204)
  })
  .post(
    '/clear',
    zv('json', z.object({ service: z.enum(['all', 'claude', 'codex', 'opencode']) })),
    async (c) => {
      const { service } = c.req.valid('json')
      await clearAuth(service)
      return c.body(null, 204)
    },
  )
  .post(
    '/fake',
    zv('json', z.object({ kind: z.enum(['claude-oauth', 'github']) })),
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
    zv('json', credentialSchema),
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
    zv('json', z.object({
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
  // Whether an auth daemon (the user's-machine login broker) is connected.
  .get('/agent', (c) => c.json({ connected: authAgentHub.connected() }))
  // Web-driven sign-in: relayed to the auth daemon on the user's machine
  // (the browser and the vendors' localhost callbacks live there); clients
  // keep polling these routes, which serve the agent-pushed views.
  .post(
    '/:tool/login/start',
    zv('param', z.object({ tool: z.enum(['claude', 'codex']) })),
    (c) => c.json(authAgentHub.startLogin(c.req.valid('param').tool)),
  )
  .get('/login/:id', (c) => c.json(authAgentHub.getLogin(c.req.param('id'))))
  .post(
    '/login/:id/input',
    // Cap generously pre-trim; the hub enforces the real alphabet/length.
    zv('json', z.object({ text: z.string().min(1).max(1024) })),
    (c) => c.json(authAgentHub.sendLoginInput(c.req.param('id'), c.req.valid('json').text)),
  )
  .post('/login/:id/cancel', (c) => {
    authAgentHub.cancelLogin(c.req.param('id'))
    return c.body(null, 204)
  })
  // Web-driven CLI install: offered when a sign-in fails with cliMissing.
  // Same relay + poll shape as login.
  .post(
    '/:tool/install/start',
    zv('param', z.object({ tool: z.enum(['claude', 'codex']) })),
    (c) => c.json(authAgentHub.startInstall(c.req.valid('param').tool)),
  )
  .get('/install/:id', (c) => c.json(authAgentHub.getInstall(c.req.param('id'))))
  .post('/install/:id/cancel', (c) => {
    authAgentHub.cancelInstall(c.req.param('id'))
    return c.body(null, 204)
  })
  .put(
    '/:tool',
    zv('param', z.object({ tool: z.enum(['claude', 'codex', 'opencode']) })),
    zv('json', z.discriminatedUnion('kind', [
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

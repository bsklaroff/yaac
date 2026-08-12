import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { authAgentHub, clearAuth, listAuth, requestPlanUsageRefresh } from '#domain/auth'
import { addEntry, removeEntryChecked, replaceEntries, seedFakeAuth } from '#domain/projects'
import { proxyClient } from '#runtime/k8s/egress'
import { persistToolAuthPayload } from '@yaac/shared/tool-auth'
import { claudeOAuthBundleSchema, codexOAuthBundleSchema, FAKE_AUTH_KINDS } from '@yaac/shared/types'

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

/** Reload the proxy ssh-agent's identity set, swallowing a failure: the next
 *  `ensureRunning()` reconciles it. */
async function syncSshKeysQuietly(): Promise<void> {
  try {
    await proxyClient.syncSshKeysFromCredentials()
  } catch {
    // non-fatal — the server retries on next ensureRunning()
  }
}

export const authApp = new Hono()
  .get('/list', async (c) => c.json(await listAuth()))
  // Nudge the server-side plan-usage refresh (fired when the webapp's usage
  // popover opens). Throttled in server/plan-usage.ts — a nudge within a
  // minute of the last refresh is ignored — and the data itself always
  // arrives via the pushed snapshot, never this response.
  .post('/claude/usage/refresh', async (c) => {
    await requestPlanUsageRefresh()
    return c.body(null, 204)
  })
  .post(
    '/clear',
    zv('json', z.object({ service: z.enum(['all', 'claude', 'codex', 'opencode', 'pi']) })),
    async (c) => {
      const { service } = c.req.valid('json')
      await clearAuth(service)
      return c.body(null, 204)
    },
  )
  .post(
    '/fake',
    zv('json', z.object({ kinds: z.array(z.enum(FAKE_AUTH_KINDS)).min(1) })),
    async (c) => {
      const { kinds } = c.req.valid('json')
      // De-dupe so `auth fake github github` seeds once; order is irrelevant
      // (each seed is independent).
      for (const kind of new Set(kinds)) {
        await seedFakeAuth(kind)
      }
      return c.body(null, 204)
    },
  )
  .post(
    '/git/credentials',
    zv('json', credentialSchema),
    async (c) => {
      // Credentials are files on disk, and re-syncing the proxy's ssh-agent
      // rides along — a key the agent has not been told about is one no
      // clone can use. Only for ssh: an https token is read straight off
      // disk. The sync is loud but non-fatal; ensureRunning() retries it.
      const entry = c.req.valid('json')
      await addEntry(entry)
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
    await removeEntryChecked(decodeURIComponent(c.req.param('pattern')))
    // Removing any entry may leave a stale identity in the agent.
    // Clear-and-reload its full set.
    await syncSshKeysQuietly()
    return c.body(null, 204)
  })
  .put(
    '/git/credentials',
    zv('json', z.object({
      credentials: z.array(credentialSchema),
    })),
    async (c) => {
      await replaceEntries(c.req.valid('json').credentials)
      await syncSshKeysQuietly()
      return c.body(null, 204)
    },
  )
  // Whether an auth server (the user's-machine login broker) is connected.
  .get('/agent', (c) => c.json({ connected: authAgentHub.connected() }))
  // Web-driven sign-in: relayed to the auth server on the user's machine
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
    zv('param', z.object({ tool: z.enum(['claude', 'codex', 'opencode', 'pi']) })),
    zv('json', z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('api-key'),
        apiKey: z.string().min(1),
        // opencode/pi only — which backend the key authenticates against.
        // Ignored for claude/codex. Required for opencode/pi and validated
        // against that tool's registry: a missing or unknown id is rejected
        // with VALIDATION rather than coerced to a default provider.
        provider: z.string().optional(),
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

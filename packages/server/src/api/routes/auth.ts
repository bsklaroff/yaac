import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { ServerError } from '@yaac/shared/errors'
import {
  authAgentHub,
  clearAuth,
  fanOutToolCredentials,
  listAuth,
  pushCredentialsToRuntime,
  requestPlanUsageRefresh,
  runtimeMediatesEgress,
} from '#domain/auth'
import {
  addHttpsCredential,
  generateSshCredential,
  removeCredential,
  renameCredential,
  replaceCredential,
  seedFakeAuth,
} from '#domain/projects'
import { persistToolAuthPayload } from '@yaac/shared/tool-auth'
import { claudeOAuthBundleSchema, codexOAuthBundleSchema, FAKE_AUTH_KINDS } from '@yaac/shared/types'

/**
 * Push the credential set, and fail the request when the runtime could not
 * take it. For the writes that take a credential AWAY (a delete, a replace
 * — the ways out of a leak): the row is gone either way, so a caller told
 * only "done" would believe the old secret dead while the egress proxy went
 * on injecting it. The next push or server start converges it.
 */
async function requireRuntimeTold(applied: string): Promise<void> {
  const failure = await pushCredentialsToRuntime()
  if (!failure) return
  throw new ServerError(
    'RUNTIME_UNAVAILABLE',
    `${applied}, but the egress proxy could not be updated, so worktrees running right now `
    + `still hold the old one: ${failure.message}. It is dropped when the proxy is next reachable `
    + '(any credential change, or a server restart) — revoke it at the git host meanwhile.',
  )
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
      // A sign-out reaches running worktrees as surely as a sign-in: the
      // runtime is handed the set with the credential gone.
      await pushCredentialsToRuntime()
      return c.body(null, 204)
    },
  )
  .post(
    '/fake',
    zv('json', z.object({ kinds: z.array(z.enum(FAKE_AUTH_KINDS)).min(1) })),
    async (c) => {
      const { kinds } = c.req.valid('json')
      // De-dupe so `auth fake pi-openrouter pi-openrouter` seeds once; order is irrelevant
      // (each seed is independent).
      for (const kind of new Set(kinds)) {
        await seedFakeAuth(kind)
      }
      await pushCredentialsToRuntime()
      return c.body(null, 204)
    },
  )
  // Named git credentials (docs/git-credentials.md). A replace and a delete
  // push; a new credential serves no project until it is assigned
  // (`PUT /project/:slug/git-credential`, which pushes), and a rename
  // changes only a key's comment, which authenticates nothing.
  .post(
    '/git/credentials',
    zv('json', z.object({ name: z.string(), token: z.string().min(1) })),
    async (c) => c.json(await addHttpsCredential(c.req.valid('json'))),
  )
  // Generate an SSH key; the answer is its public half, for the user to
  // register with their git host before a project uses it.
  .post(
    '/git/ssh-keys',
    zv('json', z.object({ name: z.string() })),
    async (c) => c.json(await generateSshCredential(c.req.valid('json'))),
  )
  .patch(
    '/git/credentials/:id',
    zv('param', z.object({ id: z.uuid() })),
    zv('json', z.object({ name: z.string() })),
    async (c) => {
      await renameCredential(c.req.valid('param').id, c.req.valid('json').name)
      return c.body(null, 204)
    },
  )
  // A new secret under the same name and projects: a pasted token, or a
  // newly generated key whose public half is the answer.
  .post(
    '/git/credentials/:id/replace',
    zv('param', z.object({ id: z.uuid() })),
    zv('json', z.object({ token: z.string().optional() })),
    async (c) => {
      const replaced = await replaceCredential(c.req.valid('param').id, c.req.valid('json'))
      await requireRuntimeTold('The credential is replaced')
      return c.json(replaced)
    },
  )
  .delete(
    '/git/credentials/:id',
    zv('param', z.object({ id: z.uuid() })),
    async (c) => {
      await removeCredential(c.req.valid('param').id)
      // The projects that used it lose it now, not at their next restart.
      await requireRuntimeTold('The credential is deleted')
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
      // The host store is only half of a sign-in: every project's tool home
      // holds its own copy, and that is the one an agent reads. What belongs
      // there depends on the runtime (a sentinel a proxy will swap, or the
      // real bundle where nothing would), which is why the fan-out lives
      // here rather than inside the shared persistence call.
      await fanOutToolCredentials(tool, { mediatedEgress: runtimeMediatesEgress() })
      await pushCredentialsToRuntime()
      return c.body(null, 204)
    },
  )

import { Hono } from 'hono'
import { zv } from '#routes/validator'
import type { IdentityEnv } from '#http'
import { z } from 'zod'
import { ServerError } from '@yaac/shared/errors'
import {
  authAgentHub,
  clearAuth,
  listAuth,
  pushCredentialsToRuntime,
  requestPlanUsageRefresh,
  signInTool,
} from '#domain/auth'
import {
  addHttpsCredential,
  generateSshCredential,
  removeCredential,
  renameCredential,
  replaceCredential,
  seedFakeAuth,
} from '#domain/projects'
import { AGENT_TOOLS, FAKE_AUTH_KINDS, toolAuthPayloadSchema } from '@yaac/shared/types'

/**
 * Push the credential set, and fail the request if the runtime could not take
 * it. Used by writes that remove a credential (delete, replace): the row is
 * gone either way, and a plain success would hide that the egress proxy still
 * injects the old secret. The next push or server start fixes it.
 */
async function requireRuntimeTold(applied: string): Promise<void> {
  const failure = await pushCredentialsToRuntime()
  if (!failure) return
  throw new ServerError(
    'RUNTIME_UNAVAILABLE',
    `${applied}, but the egress proxy could not be updated, so workspaces running right now `
    + `still hold the old one: ${failure.message}. It is dropped when the proxy is next reachable `
    + '(any credential change, or a server restart) — revoke it at the git host meanwhile.',
  )
}

/*
 * Every route acts on the caller's own credentials and sign-in flows.
 */
export const authApp = new Hono<IdentityEnv>()
  .get('/list', async (c) => c.json(await listAuth(c.get('principal').userId)))
  // Request a plan-usage refresh when the webapp's usage popover opens.
  // Throttled in domain/auth/plan-usage.ts; the data arrives via the
  // snapshot, not this response.
  .post('/claude/usage/refresh', async (c) => {
    await requestPlanUsageRefresh(c.get('principal').userId)
    return c.body(null, 204)
  })
  .post(
    '/clear',
    zv('json', z.object({ service: z.enum(['all', ...AGENT_TOOLS]) })),
    async (c) => {
      const { service } = c.req.valid('json')
      await clearAuth(c.get('principal').userId, service)
      // Running workspaces lose the credential too.
      await pushCredentialsToRuntime()
      return c.body(null, 204)
    },
  )
  .post(
    '/fake',
    zv('json', z.object({ kinds: z.array(z.enum(FAKE_AUTH_KINDS)).min(1) })),
    async (c) => {
      await seedFakeAuth(c.req.valid('json').kinds, c.get('principal').userId)
      await pushCredentialsToRuntime()
      return c.body(null, 204)
    },
  )
  // Named git credentials (docs/git-credentials.md). Replace and delete push
  // to the runtime. Add and rename don't need to: a new credential serves no
  // project until assigned (`PUT /project/:projectId/git-credential` pushes), and a
  // rename only changes a key's comment.
  .post(
    '/git/credentials',
    zv('json', z.object({ name: z.string(), token: z.string().min(1) })),
    async (c) => c.json(await addHttpsCredential(c.get('principal').userId, c.req.valid('json'))),
  )
  // Generate an SSH key and return its public half for the user to register
  // with their git host.
  .post(
    '/git/ssh-keys',
    zv('json', z.object({ name: z.string() })),
    async (c) => c.json(await generateSshCredential(c.get('principal').userId, c.req.valid('json'))),
  )
  .patch(
    '/git/credentials/:id',
    zv('param', z.object({ id: z.uuid() })),
    zv('json', z.object({ name: z.string() })),
    async (c) => {
      await renameCredential(c.get('principal').userId, c.req.valid('param').id, c.req.valid('json').name)
      return c.body(null, 204)
    },
  )
  // New secret, same name and projects: a pasted token, or a newly generated
  // key whose public half is returned.
  .post(
    '/git/credentials/:id/replace',
    zv('param', z.object({ id: z.uuid() })),
    zv('json', z.object({ token: z.string().optional() })),
    async (c) => {
      const replaced = await replaceCredential(c.get('principal').userId, c.req.valid('param').id, c.req.valid('json'))
      await requireRuntimeTold('The credential is replaced')
      return c.json(replaced)
    },
  )
  .delete(
    '/git/credentials/:id',
    zv('param', z.object({ id: z.uuid() })),
    async (c) => {
      await removeCredential(c.get('principal').userId, c.req.valid('param').id)
      // The projects that used it lose it now, not at their next restart.
      await requireRuntimeTold('The credential is deleted')
      return c.body(null, 204)
    },
  )
  // Whether an auth server (the login broker on the user's machine) is
  // connected.
  .get('/agent', (c) => c.json({ connected: authAgentHub.connected(c.get('principal').userId) }))
  // Web-driven sign-in, relayed to the auth server on the user's machine
  // (where the browser and the vendors' localhost callbacks are). Clients
  // poll these routes for the state the auth server pushes.
  .post(
    '/:tool/login/start',
    zv('param', z.object({ tool: z.enum(['claude', 'codex']) })),
    (c) => c.json(authAgentHub.startLogin(c.get('principal').userId, c.req.valid('param').tool)),
  )
  .get('/login/:id', (c) => c.json(authAgentHub.getLogin(c.get('principal').userId, c.req.param('id'))))
  .post(
    '/login/:id/input',
    // Cap generously pre-trim; the hub enforces the real alphabet/length.
    zv('json', z.object({ text: z.string().min(1).max(1024) })),
    (c) => c.json(authAgentHub.sendLoginInput(c.get('principal').userId, c.req.param('id'), c.req.valid('json').text)),
  )
  .post('/login/:id/cancel', (c) => {
    authAgentHub.cancelLogin(c.get('principal').userId, c.req.param('id'))
    return c.body(null, 204)
  })
  // Web-driven CLI install: offered when a sign-in fails with cliMissing.
  // Same relay + poll shape as login.
  .post(
    '/:tool/install/start',
    zv('param', z.object({ tool: z.enum(['claude', 'codex']) })),
    (c) => c.json(authAgentHub.startInstall(c.get('principal').userId, c.req.valid('param').tool)),
  )
  .get('/install/:id', (c) => c.json(authAgentHub.getInstall(c.get('principal').userId, c.req.param('id'))))
  .post('/install/:id/cancel', (c) => {
    authAgentHub.cancelInstall(c.get('principal').userId, c.req.param('id'))
    return c.body(null, 204)
  })
  .put(
    '/:tool',
    zv('param', z.object({ tool: z.enum(AGENT_TOOLS) })),
    zv('json', toolAuthPayloadSchema),
    async (c) => {
      await signInTool(c.get('principal').userId, c.req.valid('param').tool, c.req.valid('json'))
      return c.body(null, 204)
    },
  )

import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { personOnly, type IdentityEnv } from '#api/http/web-auth'
import { z } from 'zod'
import { ServerError } from '@yaac/shared/errors'
import {
  addEndpoint,
  addHttpsCredential,
  authAgentHub,
  cancelToolLogin,
  clearAuth,
  discoverEndpointModels,
  generateSshCredential,
  getToolLogin,
  listAuth,
  pushCredentialsToRuntime,
  removeCredential,
  removeEndpoint,
  renameCredential,
  replaceCredential,
  requestPlanUsageRefresh,
  seedFakeAuth,
  signInTool,
  startToolLogin,
  submitToolLoginCode,
  updateEndpoint,
} from '#domain/auth'
import { listRepoSummaries, probeRepoPushAccess } from '#domain/repos'
import {
  AGENT_TOOLS,
  FAKE_AUTH_KINDS,
  LOGIN_CALLBACKS,
  LOGIN_TOOLS,
  customEndpointCreateSchema,
  customEndpointPatchSchema,
  endpointDiscoverSchema,
  toolAuthPayloadSchema,
} from '@yaac/shared/types'
import { personId } from '#domain/access'

/**
 * Push the credential set, and fail the request if the runtime could not take
 * it. Used by writes that remove a credential (delete, replace): the row is
 * gone either way, and a plain success would hide that the egress proxy still
 * injects the old secret. The next push or server start fixes it.
 */
async function requireRuntimeTold(applied: string, revoke = 'revoke it at the git host meanwhile'): Promise<void> {
  const failure = await pushCredentialsToRuntime()
  if (!failure) return
  throw new ServerError(
    'RUNTIME_UNAVAILABLE',
    `${applied}, but the egress proxy could not be updated, so workspaces running right now `
    + `still hold the old one: ${failure.message}. It is dropped when the proxy is next reachable `
    + `(any credential change, or a server restart) — ${revoke}.`,
  )
}

const ENDPOINT_REVOKE = 'revoke the old key at the endpoint meanwhile if it leaked'

/*
 * Every route acts on the caller's own credentials and sign-in flows.
 */
export const authApp = new Hono<IdentityEnv>()
  .use(personOnly)
  .get('/list', async (c) => c.json(await listAuth(personId(c.get('principal')))))
  // Request a plan-usage refresh when the webapp's usage popover opens.
  // Throttled in domain/auth/plan-usage.ts; the data arrives via the
  // snapshot, not this response.
  .post('/claude/usage/refresh', async (c) => {
    await requestPlanUsageRefresh(personId(c.get('principal')))
    return c.body(null, 204)
  })
  .post(
    '/clear',
    zv('json', z.object({ service: z.enum(['all', ...AGENT_TOOLS]) })),
    async (c) => {
      const { service } = c.req.valid('json')
      await clearAuth(personId(c.get('principal')), service)
      // Running workspaces lose the credential too.
      await pushCredentialsToRuntime()
      return c.body(null, 204)
    },
  )
  .post(
    '/fake',
    zv('json', z.object({ kinds: z.array(z.enum(FAKE_AUTH_KINDS)).min(1) })),
    async (c) => {
      await seedFakeAuth(c.req.valid('json').kinds, personId(c.get('principal')))
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
    async (c) => c.json(await addHttpsCredential(personId(c.get('principal')), c.req.valid('json'))),
  )
  // Generate an SSH key and return its public half for the user to register
  // with their git host.
  .post(
    '/git/ssh-keys',
    zv('json', z.object({ name: z.string() })),
    async (c) => c.json(await generateSshCredential(personId(c.get('principal')), c.req.valid('json'))),
  )
  .patch(
    '/git/credentials/:id',
    zv('param', z.object({ id: z.uuid() })),
    zv('json', z.object({ name: z.string() })),
    async (c) => {
      await renameCredential(personId(c.get('principal')), c.req.valid('param').id, c.req.valid('json').name)
      return c.body(null, 204)
    },
  )
  // New secret, same name and projects: a pasted token, or a newly generated
  // key whose public half is returned. Each repo it serves is probed again.
  .post(
    '/git/credentials/:id/replace',
    zv('param', z.object({ id: z.uuid() })),
    zv('json', z.object({ token: z.string().optional() })),
    async (c) => {
      const replaced = await replaceCredential(personId(c.get('principal')), c.req.valid('param').id, c.req.valid('json'))
      await requireRuntimeTold('The credential is replaced')
      // Whether the new secret can push to each repo it serves
      // (docs/repo-forks.md "Push access").
      await probeRepoPushAccess((await listRepoSummaries()).filter((r) => r.gitCredential?.id === replaced.id).map((r) => r.id))
      return c.json(replaced)
    },
  )
  .delete(
    '/git/credentials/:id',
    zv('param', z.object({ id: z.uuid() })),
    async (c) => {
      await removeCredential(personId(c.get('principal')), c.req.valid('param').id)
      // The projects that used it lose it now, not at their next restart.
      await requireRuntimeTold('The credential is deleted')
      return c.body(null, 204)
    },
  )
  // Whether the caller's desktop auth daemon is connected.
  .get('/agent', (c) => c.json({ connected: authAgentHub.connected(personId(c.get('principal'))) }))
  // Claude and Codex sign-in, run here as an OAuth grant
  // (docs/tool-sign-in.md). Clients poll the flow until it ends.
  .post(
    '/:tool/login/start',
    zv('param', z.object({ tool: z.enum(LOGIN_TOOLS) })),
    zv('json', z.object({ callback: z.enum(LOGIN_CALLBACKS).optional() })),
    async (c) => c.json(await startToolLogin(personId(c.get('principal')), c.req.valid('param').tool, c.req.valid('json').callback)),
  )
  .get('/login/:id', (c) => c.json(getToolLogin(personId(c.get('principal')), c.req.param('id'))))
  .post(
    '/login/:id/input',
    zv('json', z.object({ text: z.string().min(1).max(2048) })),
    async (c) => c.json(await submitToolLoginCode(personId(c.get('principal')), c.req.param('id'), c.req.valid('json').text)),
  )
  .post('/login/:id/cancel', (c) => {
    cancelToolLogin(personId(c.get('principal')), c.req.param('id'))
    return c.body(null, 204)
  })
  // The caller's custom endpoints (docs/custom-endpoints.md).
  .post(
    '/endpoints',
    zv('json', customEndpointCreateSchema),
    async (c) => c.json(await addEndpoint(personId(c.get('principal')), c.req.valid('json'))),
  )
  .post(
    '/endpoints/discover',
    zv('json', endpointDiscoverSchema),
    async (c) => c.json(await discoverEndpointModels(personId(c.get('principal')), c.req.valid('json'))),
  )
  .patch(
    '/endpoints/:id',
    zv('param', z.object({ id: z.uuid() })),
    zv('json', customEndpointPatchSchema),
    async (c) => {
      await updateEndpoint(personId(c.get('principal')), c.req.valid('param').id, c.req.valid('json'))
      // A new URL or key moves where the proxy swaps it in.
      await requireRuntimeTold('The endpoint is updated', ENDPOINT_REVOKE)
      return c.body(null, 204)
    },
  )
  .delete(
    '/endpoints/:id',
    zv('param', z.object({ id: z.uuid() })),
    async (c) => {
      await removeEndpoint(personId(c.get('principal')), c.req.valid('param').id)
      await requireRuntimeTold('The endpoint is deleted', ENDPOINT_REVOKE)
      return c.body(null, 204)
    },
  )
  .put(
    '/:tool',
    zv('param', z.object({ tool: z.enum(AGENT_TOOLS) })),
    zv('json', toolAuthPayloadSchema),
    async (c) => {
      await signInTool(personId(c.get('principal')), c.req.valid('param').tool, c.req.valid('json'))
      return c.body(null, 204)
    },
  )

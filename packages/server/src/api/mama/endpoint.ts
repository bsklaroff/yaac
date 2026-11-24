/**
 * The endpoints a workspace calls, mounted beside the API under
 * `/api/workspace` by the composition root: `yaac-mama` and the remote of a
 * project the server hosts (docs/hosted-projects.md). Both ways in share
 * these; they differ only in how the caller is identified. Neither changes
 * with the routes behind it, so a workspace started before an upgrade keeps
 * working.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { createApiClient, type FetchLike } from '@yaac/shared/api-core'
import { ServerError } from '@yaac/shared/errors'
import { MAX_PROMPT_BYTES, type Delegate } from '@yaac/shared/types'
import { findWorkspaceByMamaToken, findWorkspaceRow, type WorkspaceRow } from '#db'
import { MAX_ICON_BYTES } from '#domain/projects'
import { serveHostedRepo } from '#domain/repos'
import { callingWorkspace } from '#domain/workspaces'
import { workspaceDriver } from '#drivers/driver'
import type { IdentityEnv } from '#api/http/web-auth'
import { jsonBodyLimit, zv } from '#routes/validator'
import { mamaCaller, runMamaCommand } from './commands'

/** How a command reaches the API's routes as `delegate`: in memory,
 *  through `delegateApp`. */
export type MamaDispatch = (delegate: Delegate) => FetchLike

/** Finds the row of the calling workspace a `yaac-mama` or hosted-git
 *  request is answered for. */
type IdentifyCaller = (bearer: string, header: (name: string) => string | undefined)
  => Promise<WorkspaceRow | undefined>

/**
 * The largest yaac-mama request, checked before it is parsed: the larger of
 * a prompt of `MAX_PROMPT_BYTES` (at most that many UTF-16 units, each at
 * most 6 bytes of JSON as a `\uXXXX` escape) and `icon set`'s image of
 * `MAX_ICON_BYTES` as base64, plus room for the command and its args. What
 * the body may hold is each command's, or its route's, to check.
 */
export const MAMA_BODY_LIMIT = Math.max(MAX_PROMPT_BYTES * 6, Math.ceil(MAX_ICON_BYTES / 3) * 4) + 64 * 1024

/**
 * `yaac-mama` runs its command as the delegate the calling workspace acts
 * as (`callingWorkspace`), through `dispatch` (`runMamaCommand`, which
 * holds the command allowlist), and the request log names that delegate.
 * Answers are JSON, except a file (`fetch`'s git bundle, `history`'s
 * transcripts, database or one file, a step's log from `logs`, the
 * project's icon from `icon-get`), sent as the body with the workspace it
 * is about, when there is one, in `x-yaac-workspace-id` (and a
 * conversation in `x-yaac-conversation-id`).
 */
function mamaRoute(identifyCaller: IdentifyCaller, dispatch: MamaDispatch) {
  const callerOf = async (c: Context): Promise<WorkspaceRow> => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    const caller = await identifyCaller(bearer, (name) => c.req.header(name))
    if (!caller) throw new ServerError('UNAUTHENTICATED', 'unknown or revoked yaac-mama credential')
    // A site's release runs code that faces the internet, so it may not act
    // on yaac at all (docs/public-sites.md); the proxy refuses it too.
    if (caller.siteId !== undefined) throw new ServerError('FORBIDDEN', 'a public site\'s release may not call yaac')
    return caller
  }
  const hostedGit = (pathInfo: string) => async (c: Context): Promise<Response> => {
    const caller = await callerOf(c)
    const repoId = (c.req.param('repo') ?? '').replace(/\.git$/, '')
    return serveHostedRepo(repoId, c.req.raw, pathInfo, { kind: 'workspace', projectId: caller.projectId })
  }
  return new Hono<IdentityEnv>().post(
    '/mama',
    jsonBodyLimit(MAMA_BODY_LIMIT, 'the yaac-mama request is too large'),
    zv('json', z.object({
      command: z.string().min(1).max(32),
      args: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      /** The calling agent's session (`YAAC_SESSION_ID`), when it has one. */
      session: z.string().max(64).optional(),
    })),
    async (c) => {
      const { command, args, body, session } = c.req.valid('json')
      const delegate = await callingWorkspace(await callerOf(c), session)
      c.set('principal', delegate)
      const caller = mamaCaller(delegate, createApiClient('http://yaac-mama', dispatch(delegate)))
      const outcome = await runMamaCommand(caller, { command, args: args ?? {}, body: body ?? '' })
      if (!outcome.ok) return c.json({ error: outcome.error }, 422)
      if ('output' in outcome) return c.json({ output: outcome.output })
      return c.body(outcome.body, 200, {
        'content-type': outcome.contentType,
        ...(outcome.workspaceId !== undefined ? { 'x-yaac-workspace-id': outcome.workspaceId } : {}),
        ...(outcome.conversationId !== undefined ? { 'x-yaac-conversation-id': outcome.conversationId } : {}),
      })
    },
  )
    .get('/git/:repo/info/refs', hostedGit('/info/refs'))
    .post('/git/:repo/git-upload-pack', hostedGit('/git-upload-pack'))
    .post('/git/:repo/git-receive-pack', hostedGit('/git-receive-pack'))
}

/**
 * Containerless workspaces call the API directly, identified by the bearer
 * token minted at create (their gitconfig sends it to a hosted remote), so
 * a request cannot claim to be another workspace.
 * This sits on top of the normal identity gate, which sees a loopback caller.
 * k8s workspaces get no token, which would put a server credential inside
 * the sandbox; their calls arrive through `mamaRelayApp`.
 */
export function mamaApp(dispatch: MamaDispatch) {
  return mamaRoute(async (bearer) => {
  if (workspaceDriver().kind !== 'containerless') {
    throw new ServerError(
      'NOT_SUPPORTED',
      'This server runs workspaces in containers, whose yaac-mama calls the egress '
      + 'proxy relays to a listener of their own.',
    )
  }
  return findWorkspaceByMamaToken(bearer)
  }, dispatch)
}

/**
 * The endpoint as the egress proxy relays it for a k8s workspace pod, on the
 * driver's own listener (`WorkspaceDriver.mamaRelay`). The proxy names the
 * caller it resolved from the pod's source IP in `x-yaac-workspace-id` and
 * proves it is the proxy with `authenticate`.
 */
export function mamaRelayApp(authenticate: (bearer: string) => Promise<boolean>, dispatch: MamaDispatch) {
  return mamaRoute(async (bearer, header) =>
    await authenticate(bearer) ? findWorkspaceRow(header('x-yaac-workspace-id') ?? '') : undefined, dispatch)
}


import { Hono } from 'hono'
import type { Context } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import {
  assignRepoCredential,
  getRepoBranches,
  ownRepo,
  listRepoSummaries,
  removeKeptHostedRepo,
  serveHostedRepo,
  setDefaultBranch,
  setDefaultBranchGuard,
  shareRepo,
} from '#domain/repos'
import { deleteRepo, moveRepoToRemote, previewRepoDelete, previewRepoMove, unshareRepo } from '#domain/workspaces'
import { pushCredentialsToRuntime } from '#domain/auth'
import { systemPrincipal } from '#domain/access'
import type { IdentityEnv } from '#api/http/web-auth'

/*
 * A user's git repos (docs/project-repos.md): the listing, each repo's
 * credential, sharing, hosted remote and its settings, the move to a git
 * host, and delete. A repo is named by its id, which clients take from the
 * project summary's `repos` or from the listing; which repos a project
 * links is `#routes/projects`.
 */

async function serveUserGit(c: Context<IdentityEnv>, pathInfo: string): Promise<Response> {
  return serveHostedRepo(c.req.param('repoId') ?? '', c.req.raw, pathInfo, { kind: 'user', principal: c.get('principal') })
}

const shareBody = z.object({ userId: z.uuid() })

export const repoApp = new Hono<IdentityEnv>()
  // Every repo, any user's, as every listing answers; Settings → Repos shows
  // the caller's own and the ones shared with them.
  .get('/list', async (c) => c.json(await listRepoSummaries()))
  // Assign the repo its git credential. For an SSH key, returns the host key
  // that was trusted so the user can compare it.
  .put(
    '/:repoId/git-credential',
    zv('json', z.object({ credentialId: z.uuid() })),
    async (c) => {
      const result = await assignRepoCredential(c.get('principal'), c.req.param('repoId'), c.req.valid('json').credentialId)
      await pushCredentialsToRuntime()
      return c.json(result)
    },
  )
  // A hosted repo's default branch and its guard (docs/hosted-projects.md).
  .put(
    '/:repoId/default-branch',
    zv('json', z.object({ branch: z.string().min(1) })),
    async (c) => {
      await setDefaultBranch(c.get('principal'), c.req.param('repoId'), c.req.valid('json').branch)
      return c.body(null, 204)
    },
  )
  .put(
    '/:repoId/default-branch-guard',
    zv('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      await setDefaultBranchGuard(c.get('principal'), c.req.param('repoId'), c.req.valid('json').enabled)
      return c.body(null, 204)
    },
  )
  // Branch data for the new-workspace picker: local remote-tracking refs
  // (instant), or freshly fetched with ?refresh=1.
  .get(
    '/:repoId/branches',
    zv('query', z.object({ refresh: z.string().optional() })),
    async (c) => {
      // Any user may read; this only answers an unknown repo as missing.
      const { id } = await ownRepo(systemPrincipal, c.req.param('repoId'))
      return c.json(await getRepoBranches(id, { refresh: c.req.valid('query').refresh === '1' }))
    },
  )
  // A hosted repo's remote, for the user's own git: `git clone
  // <origin>/api/repo/<id>/git`. Workspaces reach it through their own
  // route (#routes/workspaces).
  .get('/:repoId/git/info/refs', async (c) => serveUserGit(c, '/info/refs'))
  .post('/:repoId/git/git-upload-pack', async (c) => serveUserGit(c, '/git-upload-pack'))
  .post('/:repoId/git/git-receive-pack', async (c) => serveUserGit(c, '/git-receive-pack'))
  // Share a hosted repo with another user, or end their share
  // (docs/hosted-projects.md "Sharing").
  .post('/:repoId/share', zv('json', shareBody), async (c) => {
    await shareRepo(c.get('principal'), c.req.param('repoId'), c.req.valid('json').userId)
    return c.body(null, 204)
  })
  .post('/:repoId/unshare', zv('json', shareBody), async (c) => {
    await unshareRepo(c.get('principal'), c.req.param('repoId'), c.req.valid('json').userId)
    return c.body(null, 204)
  })
  // Move a hosted repo to an empty remote elsewhere (docs/hosted-projects.md
  // "Moving to a git host"). The GET says what the move would stop and hand
  // over, which clients warn with before the POST.
  .get('/:repoId/move-preview', async (c) => c.json(await previewRepoMove(c.get('principal'), c.req.param('repoId'))))
  .post(
    '/:repoId/move',
    zv('json', z.object({ remoteUrl: z.string().min(1), credentialId: z.uuid() })),
    async (c) => {
      const { remoteUrl, credentialId } = c.req.valid('json')
      return c.json(await moveRepoToRemote(c.get('principal'), c.req.param('repoId'), remoteUrl, credentialId))
    },
  )
  // The repository yaac kept when the repo moved, removed once its owner has
  // checked the new remote.
  .delete('/:repoId/kept-hosted-repo', async (c) => {
    await removeKeptHostedRepo(c.get('principal'), c.req.param('repoId'))
    return c.body(null, 204)
  })
  // Delete a repo (docs/hosted-projects.md "Deleting a repo"). The GET says
  // what the delete would reach, which clients confirm with; the DELETE
  // answers the workspaces whose checkouts keep its main clone on disk.
  .get('/:repoId/delete-preview', async (c) => c.json(await previewRepoDelete(c.get('principal'), c.req.param('repoId'))))
  .delete('/:repoId', async (c) => {
    const result = await deleteRepo(c.get('principal'), c.req.param('repoId'))
    await pushCredentialsToRuntime()
    return c.json(result)
  })

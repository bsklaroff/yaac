import { Hono } from 'hono'
import type { Context } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import {
  assignRepoCredential,
  getRepoBranches,
  ownRepo,
  listRepoSummaries,
  probeRepoPushAccess,
  removeKeptHostedRepo,
  serveHostedRepo,
  setDefaultBranch,
  setDefaultBranchGuard,
  setRepoReadOnly,
  setRepoUpstream,
  setUpstreamRebase,
  shareRepo,
} from '#domain/repos'
import {
  deleteRepo,
  moveRepoToRemote,
  moveRepoToUpstream,
  moveRepoToYaac,
  previewRepoDelete,
  previewRepoHost,
  previewRepoMove,
  previewUpstreamMove,
  unshareRepo,
} from '#domain/workspaces'
import { allowRepoHostWhereLinked } from '#domain/projects'
import { pushCredentialsToRuntime } from '#domain/auth'
import { systemPrincipal } from '#domain/access'
import type { IdentityEnv } from '#api/http/web-auth'

/*
 * A user's git repos (docs/project-repos.md): the listing, each repo's
 * credential, sharing, hosted remote and its settings, read-only and
 * upstream settings (docs/repo-forks.md), the moves between yaac and git
 * hosts, and delete. A repo is named by its id, which clients take from the
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
  // Probe now whether the repo's credential can push, as "Check again"
  // does (docs/repo-forks.md "Push access").
  .post('/:repoId/push-access', async (c) => {
    const { id } = await ownRepo(c.get('principal'), c.req.param('repoId'))
    // At most one probe of the network per repo every 10 seconds.
    return c.json({ pushAccess: (await probeRepoPushAccess([id], { unlessWithinMs: 10_000 })).get(id) ?? null })
  })
  // Whether no workspace pushes to the repo, in any project
  // (docs/repo-forks.md "Read-only repos"); the egress proxy enforces it.
  .put(
    '/:repoId/read-only',
    zv('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      await setRepoReadOnly(c.get('principal'), c.req.param('repoId'), c.req.valid('json').enabled)
      await pushCredentialsToRuntime()
      return c.body(null, 204)
    },
  )
  // The repo a fork's history comes from (docs/repo-forks.md): one of the
  // owner's repos, or a remote with an optional credential. Answers its id,
  // the host key trusted for a fresh ssh credential, and the host added to
  // the allowlists of the projects linking the fork.
  .put(
    '/:repoId/upstream',
    zv('json', z.union([
      z.object({ repoId: z.uuid() }),
      z.object({ remoteUrl: z.string().min(1), credentialId: z.uuid().optional() }),
    ])),
    async (c) => {
      const repoId = c.req.param('repoId')
      const { upstream, knownHostsEntry } = await setRepoUpstream(c.get('principal'), repoId, c.req.valid('json'))
      const allowedHost = await allowRepoHostWhereLinked(repoId)
      await pushCredentialsToRuntime()
      return c.json({ upstreamRepoId: upstream?.id ?? null, knownHostsEntry, allowedHost })
    },
  )
  .delete('/:repoId/upstream', async (c) => {
    await setRepoUpstream(c.get('principal'), c.req.param('repoId'), null)
    await pushCredentialsToRuntime()
    return c.body(null, 204)
  })
  // Whether a hosted fork's guard lets a rebase onto the upstream through
  // (docs/repo-forks.md "Catching up with the upstream").
  .put(
    '/:repoId/upstream-rebase',
    zv('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      await setUpstreamRebase(c.get('principal'), c.req.param('repoId'), c.req.valid('json').enabled)
      return c.body(null, 204)
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
  // With `?target=upstream`, a fork's move back onto its upstream, which
  // also answers every branch of either remote (docs/repo-forks.md "Moving
  // back to the upstream").
  .get(
    '/:repoId/move-preview',
    zv('query', z.object({ target: z.literal('upstream').optional() })),
    async (c) => c.json(c.req.valid('query').target === 'upstream'
      ? await previewUpstreamMove(c.get('principal'), c.req.param('repoId'))
      : await previewRepoMove(c.get('principal'), c.req.param('repoId'))),
  )
  .post(
    '/:repoId/move',
    zv('json', z.object({ remoteUrl: z.string().min(1), credentialId: z.uuid() })),
    async (c) => {
      const { remoteUrl, credentialId } = c.req.valid('json')
      return c.json(await moveRepoToRemote(c.get('principal'), c.req.param('repoId'), remoteUrl, credentialId))
    },
  )
  .post(
    '/:repoId/move-upstream',
    zv('json', z.object({
      push: z.array(z.object({ branch: z.string().min(1), as: z.string().min(1).optional() })),
      leave: z.array(z.string().min(1)),
    })),
    async (c) => c.json(await moveRepoToUpstream(c.get('principal'), c.req.param('repoId'), c.req.valid('json'))),
  )
  // Move a repo on a git host onto yaac, which makes the remote it leaves
  // its upstream (docs/repo-forks.md "Moving a repo to yaac"). The GET says
  // which workspaces it would stop.
  .get('/:repoId/host-preview', async (c) => c.json(await previewRepoHost(c.get('principal'), c.req.param('repoId'))))
  .post('/:repoId/host', async (c) => {
    await moveRepoToYaac(c.get('principal'), c.req.param('repoId'))
    return c.body(null, 204)
  })
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

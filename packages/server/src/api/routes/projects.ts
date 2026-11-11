import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { zv } from '#routes/validator'
import { z } from 'zod'
import {
  addProject,
  addProjectRepo,
  cacheVolumesSchema,
  createHostedProject,
  getProjectAllowlist,
  getProjectDetail,
  listProjectEnv,
  listProjectRunSecrets,
  listProjects,
  MAX_ICON_BYTES,
  portForwardsSchema,
  readProjectDockerfile,
  readProjectIcon,
  registerStagedProject,
  removeProjectEnvVar,
  removeProjectIcon,
  removeProjectRepo,
  reorderProjectRepos,
  removeRunSecret,
  setProjectAllowlist,
  setProjectEnvVar,
  setRunSecret,
  writeProjectDockerfile,
  pushProjectSecrets,
  resolveProjectId,
  setInitWorkflows,
  setKeptIgnoredPaths,
  setProjectIcon,
  setScratchDirs,
  scratchDirSettingsPatchSchema,
  updateProjectConfig,
  updateProjectRepoLink,
} from '#domain/projects'
import { previewWorkspaceRetention, removeProject, setWorkspaceRetention } from '#domain/workspaces'
import { pushCredentialsToRuntime } from '#domain/auth'
import { serveHostedRepo } from '#domain/repos'
import { setProjectOrder } from '#db'
import { getProjectSkills, getSkillDetail } from '#domain/skills'
import { projectBuildDir } from '#lib/build-dirs'
import { DEFAULT_ALLOWED_HOSTS, missingCriticalHosts } from '@yaac/shared/allowed-hosts'
import { ServerError } from '@yaac/shared/errors'
import { MAX_PROJECT_REPOS } from '@yaac/shared/types'
import { buildFilesApp } from '#routes/build-files'
import { authorizeProject } from '#domain/access'
import { requireDriverFeature } from '#api/http/driver-features'
import type { IdentityEnv } from '#api/http/web-auth'

/**
 * Send a project's changed secrets to running workspaces, which resolve
 * injections per request and so pick up edits without a restart. The row is
 * written either way, so a failure is reported rather than swallowed: a
 * silent failed delete would leave the proxy injecting the old value. The
 * next server start fixes it.
 */
async function syncRunningWorkspaces(projectId: string, applied: string): Promise<void> {
  try {
    await pushProjectSecrets(projectId)
  } catch (err) {
    throw new ServerError(
      'RUNTIME_UNAVAILABLE',
      `${applied}, but the egress proxy could not be updated, so workspaces `
      + 'running right now still use the previous value: '
      + `${err instanceof Error ? err.message : String(err)}. `
      + 'New workspaces are unaffected, and running ones catch up when the '
      + 'proxy is reachable again.',
    )
  }
}

/** A stopped-workspace retention, in days; a century is plenty. */
const RETENTION_DAYS = z.number().int().min(1).max(36_500)

async function serveLegacyGit(c: Context<IdentityEnv>, pathInfo: string): Promise<Response> {
  return serveHostedRepo(c.req.param('projectId') ?? '', c.req.raw, pathInfo, { kind: 'user', principal: c.get('principal') })
}

export const projectApp = new Hono<IdentityEnv>()
  .get('/list', async (c) => c.json(await listProjects()))
  // The caller's own projects, in the order their project list shows them.
  .put(
    '/order',
    zv('json', z.object({ projectIds: z.array(z.uuid()) })),
    async (c) => {
      await setProjectOrder(c.get('principal').userId, c.req.valid('json').projectIds)
      return c.body(null, 204)
    },
  )
  // A project around one git repo, cloned with the named credential unless
  // its owner has it. Answers the project, with the host key trusted for an
  // ssh clone and the repo's host if it was added to the project's egress
  // allowlist.
  .post(
    '/add',
    zv('json', z.object({
      remoteUrl: z.string().min(1),
      /** The credential to clone with and assign. */
      gitCredentialId: z.uuid(),
    })),
    async (c) => {
      const { remoteUrl, gitCredentialId } = c.req.valid('json')
      const result = await addProject(remoteUrl, gitCredentialId, c.get('principal').userId)
      await pushCredentialsToRuntime()
      return c.json(result)
    },
  )
  // A project with one empty repo whose remote the server hosts
  // (docs/hosted-projects.md).
  .post(
    '/create',
    zv('json', z.object({ name: z.string().min(1).max(200) })),
    async (c) => c.json(await createHostedProject(c.req.valid('json').name, c.get('principal').userId)),
  )
  // Record a project whose repo's main clone is already staged in the data
  // dir under the project's id, without cloning. Tests use this to add a
  // local repo.
  .post(
    '/register',
    zv('json', z.object({ id: z.uuid(), name: z.string().min(1), remoteUrl: z.string().min(1) })),
    async (c) => {
      const { id, name, remoteUrl } = c.req.valid('json')
      return c.json(await registerStagedProject(id, name, remoteUrl, c.get('principal').userId))
    },
  )
  .get('/:projectId', async (c) => c.json(await getProjectDetail(await resolveProjectId(c.req.param('projectId')))))
  // The repos the project links (docs/project-repos.md): link one by its
  // remote and a credential, by the id of a repo its owner may use, or as a
  // new repo yaac hosts, under `dir` (by default the repo's name). Answers
  // the link, with the host key trusted for a fresh ssh clone and the
  // repo's host if it was added to the project's egress allowlist.
  .post(
    '/:projectId/repo',
    zv('json', z.intersection(
      z.union([
        z.object({ remoteUrl: z.string().min(1), credentialId: z.uuid() }),
        z.object({ repoId: z.uuid() }),
        z.object({ hosted: z.literal(true) }),
      ]),
      z.object({ dir: z.string().min(1).max(100).optional() }),
    )),
    async (c) => {
      const { dir, ...what } = c.req.valid('json')
      const linked = await addProjectRepo(c.get('principal'), await resolveProjectId(c.req.param('projectId')), what, dir)
      await pushCredentialsToRuntime()
      return c.json(linked)
    },
  )
  // Where a hosted project's remote was served while a project had one
  // repo: a clone made then still names it. The id is a repo's (every repo
  // from then carries its project's id) or a former share's project
  // (docs/legacy-compat-shims.md "Hosted URLs naming a project").
  .get('/:projectId/git/info/refs', async (c) => serveLegacyGit(c, '/info/refs'))
  .post('/:projectId/git/git-upload-pack', async (c) => serveLegacyGit(c, '/git-upload-pack'))
  .post('/:projectId/git/git-receive-pack', async (c) => serveLegacyGit(c, '/git-receive-pack'))
  // The order the project lists its repos in, each named by folder or id.
  .put(
    '/:projectId/repo-order',
    zv('json', z.object({ repos: z.array(z.string().min(1)).max(MAX_PROJECT_REPOS) })),
    async (c) => {
      await reorderProjectRepos(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.valid('json').repos)
      return c.body(null, 204)
    },
  )
  // One link, named by its folder or the repo's id: the folder its checkout
  // takes in workspaces created from now on. Unlinking deletes neither the
  // repo nor any checkout of it.
  .patch(
    '/:projectId/repo/:repo',
    zv('json', z.object({ dir: z.string().min(1).max(100) })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      await updateProjectRepoLink(c.get('principal'), projectId, c.req.param('repo'), c.req.valid('json'))
      return c.body(null, 204)
    },
  )
  // Whether the project may only read a repo, and whether the repo's token
  // may be its workspaces' `GH_TOKEN` (docs/project-repos.md "Read-only
  // repos"). The egress proxy enforces both, so they reach running
  // workspaces at once, and a server without one has neither.
  .put(
    '/:projectId/repo/:repo/read-only',
    zv('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      requireDriverFeature('repoAccess')
      const projectId = await resolveProjectId(c.req.param('projectId'))
      await updateProjectRepoLink(c.get('principal'), projectId, c.req.param('repo'), { readOnly: c.req.valid('json').enabled })
      await pushCredentialsToRuntime()
      return c.body(null, 204)
    },
  )
  .put(
    '/:projectId/repo/:repo/gh-token',
    zv('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      requireDriverFeature('repoAccess')
      const projectId = await resolveProjectId(c.req.param('projectId'))
      await updateProjectRepoLink(c.get('principal'), projectId, c.req.param('repo'), { ghToken: c.req.valid('json').enabled })
      await pushCredentialsToRuntime()
      return c.body(null, 204)
    },
  )
  .delete('/:projectId/repo/:repo', async (c) => {
    await removeProjectRepo(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.param('repo'))
    await pushCredentialsToRuntime()
    return c.body(null, 204)
  })
  // The gitignored paths a stop keeps. The current list is in the project
  // summary.
  .put(
    '/:projectId/kept-ignored-paths',
    zv('json', z.object({ paths: z.array(z.string()) })),
    async (c) => {
      const paths = await setKeptIgnoredPaths(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.valid('json').paths)
      return c.json({ paths })
    },
  )
  // The picture the project's chip shows instead of its initial. The
  // webapp's URL carries the snapshot's `iconHash` as `v`; only a `v` naming
  // the bytes served lets the browser keep them, since a client with a stale
  // hash would otherwise cache the new picture under the old one's URL.
  .get('/:projectId/icon', async (c) => {
    const { bytes, mimeType, hash } = await readProjectIcon(await resolveProjectId(c.req.param('projectId')))
    c.header('Content-Type', mimeType)
    c.header('Cache-Control', c.req.query('v') === hash ? 'private, max-age=31536000, immutable' : 'no-cache')
    c.header('X-Content-Type-Options', 'nosniff')
    return c.body(new Uint8Array(bytes))
  })
  // Takes the image's raw bytes.
  .put(
    '/:projectId/icon',
    bodyLimit({
      maxSize: MAX_ICON_BYTES,
      onError: () => { throw new ServerError('TOO_LARGE', 'the icon is over the 512 KB limit') },
    }),
    async (c) => {
      await setProjectIcon(c.get('principal'), await resolveProjectId(c.req.param('projectId')), new Uint8Array(await c.req.arrayBuffer()))
      return c.body(null, 204)
    },
  )
  .delete('/:projectId/icon', async (c) => {
    await removeProjectIcon(c.get('principal'), await resolveProjectId(c.req.param('projectId')))
    return c.body(null, 204)
  })
  // Which named workflows are the project's init workflows, which every
  // workspace that brings no graph of its own and has their repos starts
  // (docs/workflows.md "Init workflows"): exactly the names given.
  .put(
    '/:projectId/init-workflows',
    zv('json', z.object({ workflows: z.array(z.string().min(1)) })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      return c.json(await setInitWorkflows(c.get('principal'), projectId, c.req.valid('json').workflows))
    },
  )
  // Which dirs live with a workspace's runtime rather than its checkout, with
  // their caps, and which of them git tracks without the user wanting a
  // warning. Either may be left out to keep it; both are answered as stored.
  .put(
    '/:projectId/scratch-dirs',
    zv('json', scratchDirSettingsPatchSchema),
    async (c) => {
      return c.json(await setScratchDirs(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.valid('json')))
    },
  )
  // Stopped-workspace auto-delete. The GET counts what a retention of `days`
  // would delete right away, and the cutoff it counted by, which clients
  // show before they confirm the PUT. The PUT deletes no workspace stopped
  // after that cutoff, so the count is an upper bound, and answers what it
  // deleted and what it kept for later.
  .get(
    '/:projectId/workspace-auto-delete',
    zv('query', z.object({ days: z.coerce.number().pipe(RETENTION_DAYS) })),
    async (c) => {
      const { expired, before } = await previewWorkspaceRetention(await resolveProjectId(c.req.param('projectId')), c.req.valid('query').days)
      return c.json({ expired, before: before.toISOString() })
    },
  )
  .put(
    '/:projectId/workspace-auto-delete',
    zv('json', z.object({ days: RETENTION_DAYS.nullable(), before: z.iso.datetime().optional() })),
    async (c) => {
      const { days, before } = c.req.valid('json')
      const projectId = await resolveProjectId(c.req.param('projectId'))
      return c.json(await setWorkspaceRetention(c.get('principal'), projectId, days, before === undefined ? undefined : new Date(before)))
    },
  )
  .delete('/:projectId', async (c) => {
    await removeProject(c.get('principal'), await resolveProjectId(c.req.param('projectId')))
    return c.body(null, 204)
  })
  // The settings workspaces launch with besides their checkout
  // (docs/project-config.md), one route each. Each answers them all as
  // stored; the current values are in the project summary.
  .put(
    '/:projectId/port-forwards',
    zv('json', z.object({ ports: portForwardsSchema })),
    async (c) => c.json(await updateProjectConfig(
      c.get('principal'), await resolveProjectId(c.req.param('projectId')), { portForwards: c.req.valid('json').ports },
    )),
  )
  .put(
    '/:projectId/cache-volumes',
    zv('json', z.object({ volumes: cacheVolumesSchema })),
    async (c) => {
      requireDriverFeature('cacheVolumes')
      return c.json(await updateProjectConfig(
        c.get('principal'), await resolveProjectId(c.req.param('projectId')), { cacheVolumes: c.req.valid('json').volumes },
      ))
    },
  )
  .put(
    '/:projectId/nested-containers',
    zv('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      requireDriverFeature('nestedContainers')
      return c.json(await updateProjectConfig(
        c.get('principal'), await resolveProjectId(c.req.param('projectId')), { nestedContainers: c.req.valid('json').enabled },
      ))
    },
  )
  .put(
    '/:projectId/npm-cache',
    zv('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      requireDriverFeature('npmCache')
      return c.json(await updateProjectConfig(
        c.get('principal'), await resolveProjectId(c.req.param('projectId')), { npmCache: c.req.valid('json').enabled },
      ))
    },
  )
  // The project's environment: variables its workspaces launch with, and
  // secrets the egress proxy injects. Secret values are write-only: set by
  // PUT, never returned by GET.
  .get('/:projectId/env', async (c) => c.json({ vars: await listProjectEnv(await resolveProjectId(c.req.param('projectId'))) }))
  .put(
    '/:projectId/env',
    zv('json', z.object({
      name: z.string().min(1),
      // Optional so a secret's rule can be edited without resending the
      // value; omitting it is refused for a secret with no stored value.
      value: z.string().optional(),
      secret: z.boolean().optional(),
      rule: z.unknown().optional(),
    })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      const saved = await setProjectEnvVar(c.get('principal'), projectId, c.req.valid('json'))
      await syncRunningWorkspaces(projectId, `${saved.name} was saved`)
      return c.json({ var: saved })
    },
  )
  .delete('/:projectId/env/:id', async (c) => {
    const projectId = await resolveProjectId(c.req.param('projectId'))
    await removeProjectEnvVar(c.get('principal'), projectId, c.req.param('id'))
    await syncRunningWorkspaces(projectId, 'the variable was removed')
    return c.body(null, 204)
  })
  // Values only the workflow revisions naming them get, as they are
  // (docs/project-config.md "Run secrets").
  .get('/:projectId/run-secrets', async (c) =>
    c.json({ secrets: await listProjectRunSecrets(await resolveProjectId(c.req.param('projectId'))) }))
  .put(
    '/:projectId/run-secrets',
    zv('json', z.object({ name: z.string().min(1), value: z.string() })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      return c.json({ secret: await setRunSecret(c.get('principal'), projectId, c.req.valid('json')) })
    },
  )
  .delete('/:projectId/run-secrets/:id', async (c) => {
    const projectId = await resolveProjectId(c.req.param('projectId'))
    await removeRunSecret(c.get('principal'), projectId, c.req.param('id'))
    return c.body(null, 204)
  })
  // The project's egress allowlist, with the install's defaults so a client
  // can list them. Applies to workspaces created afterwards. The PUT also
  // answers which hosts agents need that the new list leaves out, for the
  // client to warn about.
  .get('/:projectId/allowlist', async (c) => {
    requireDriverFeature('egress')
    const allowlist = await getProjectAllowlist(await resolveProjectId(c.req.param('projectId')))
    return c.json({ allowlist, defaultHosts: DEFAULT_ALLOWED_HOSTS })
  })
  .put(
    '/:projectId/allowlist',
    zv('json', z.object({ hosts: z.array(z.string()), defaults: z.boolean() })),
    async (c) => {
      requireDriverFeature('egress')
      const projectId = await resolveProjectId(c.req.param('projectId'))
      const allowlist = await setProjectAllowlist(c.get('principal'), projectId, c.req.valid('json'))
      return c.json({ allowlist, leavesOut: missingCriticalHosts(allowlist) })
    },
  )
  // Every SKILL.md the project's agents can use, each naming the agents that
  // load it. Read on the host, so no running workspace is needed.
  .get(
    '/:projectId/skills',
    zv('query', z.object({
      // The repo (its folder or id; default: the project's first) and its
      // origin branch (default: the remote's default branch) to read repo
      // skills and repo plugin settings from. Host tiers ignore both.
      repo: z.string().optional(),
      branch: z.string().optional(),
    })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      return c.json(await getProjectSkills(projectId, c.req.valid('query')))
    },
  )
  // The full SKILL.md for one skill, fetched on demand when a row is picked.
  .get(
    '/:projectId/skills/body',
    zv('query', z.object({
      id: z.string().min(1),
      repo: z.string().optional(),
      branch: z.string().optional(),
    })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      const { id, ...query } = c.req.valid('query')
      return c.json(await getSkillDetail(projectId, id, query))
    },
  )
  // Support files next to Dockerfile.yaac in the project's build dir: its
  // build context, which feeds the image tag.
  .route('/:projectId/build-files', buildFilesApp(async (c, level) => {
    // The generic Context can't see the mount path's :projectId, so param()
    // is string | undefined here; the mount guarantees it exists.
    const projectId = await resolveProjectId(c.req.param('projectId') ?? '')
    if (level === 'owner') await authorizeProject(c.get('principal'), projectId)
    return projectBuildDir(projectId)
  }))
  // The project's image layer. Both check the driver feature before the
  // project (see `requireDriverFeature`).
  .get('/:projectId/dockerfile', async (c) => {
    requireDriverFeature('images')
    return c.json({ content: await readProjectDockerfile(await resolveProjectId(c.req.param('projectId'))) })
  })
  .put(
    '/:projectId/dockerfile',
    zv('json', z.object({ content: z.string() })),
    async (c) => {
      requireDriverFeature('images')
      const projectId = await resolveProjectId(c.req.param('projectId'))
      const { content } = c.req.valid('json')
      await writeProjectDockerfile(c.get('principal'), projectId, content)
      return c.json({ content })
    },
  )

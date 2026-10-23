import { Hono } from 'hono'
import type { Context } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import {
  addProject,
  assignProjectCredential,
  createHostedProject,
  getProjectAllowlist,
  getProjectBranches,
  getProjectDetail,
  listProjectEnv,
  listProjects,
  readProjectConfigRaw,
  readProjectDockerfile,
  registerStagedProject,
  removeProjectConfig,
  removeProjectEnvVar,
  resolveProjectConfigWithSource,
  setProjectAllowlist,
  setProjectEnvVar,
  writeProjectConfig,
  writeProjectDockerfile,
  pushProjectSecrets,
  resolveProjectId,
  serveHostedRepo,
  setDefaultBranchGuard,
  shareProject,
} from '#domain/projects'
import { previewWorkspaceRetention, removeProject, setWorkspaceRetention, unshareProject } from '#domain/workspaces'
import { pushCredentialsToRuntime } from '#domain/auth'
import { getProjectSkills, getSkillDetail } from '#domain/skills'
import { projectBuildDir } from '#lib/build-dirs'
import { DEFAULT_ALLOWED_HOSTS } from '#lib/allowed-hosts'
import { ServerError } from '@yaac/shared/errors'
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

async function serveUserGit(c: Context<IdentityEnv>, pathInfo: string): Promise<Response> {
  const projectId = await resolveProjectId(c.req.param('projectId') ?? '')
  return serveHostedRepo(projectId, c.req.raw, pathInfo, { kind: 'user', principal: c.get('principal') })
}

/** A stopped-workspace retention, in days; a century is plenty. */
const RETENTION_DAYS = z.number().int().min(1).max(36_500)

export const projectApp = new Hono<IdentityEnv>()
  .get('/list', async (c) => c.json(await listProjects()))
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
  // An empty project whose remote the server hosts (docs/hosted-projects.md).
  .post(
    '/create',
    zv('json', z.object({ name: z.string().min(1).max(200) })),
    async (c) => c.json(await createHostedProject(c.req.valid('json').name, c.get('principal').userId)),
  )
  // Record a project whose checkout is already staged in the data dir,
  // without cloning. Tests use this to add a local repo.
  .post(
    '/register',
    zv('json', z.object({ id: z.uuid(), name: z.string().min(1), remoteUrl: z.string().min(1) })),
    async (c) => {
      const { id, name, remoteUrl } = c.req.valid('json')
      return c.json(await registerStagedProject(id, name, remoteUrl, c.get('principal').userId))
    },
  )
  .get('/:projectId', async (c) => c.json(await getProjectDetail(await resolveProjectId(c.req.param('projectId')))))
  // Assign the project its git credential. For an SSH key, returns the host
  // key that was trusted so the user can compare it.
  .put(
    '/:projectId/git-credential',
    zv('json', z.object({ credentialId: z.uuid() })),
    async (c) => {
      const result = await assignProjectCredential(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.valid('json').credentialId)
      await pushCredentialsToRuntime()
      return c.json(result)
    },
  )
  // A hosted project's default-branch guard (docs/hosted-projects.md).
  .put(
    '/:projectId/default-branch-guard',
    zv('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      await setDefaultBranchGuard(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.valid('json').enabled)
      return c.body(null, 204)
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
  // A hosted project's remote, for the user's own git: `git clone
  // <origin>/api/project/<id>/git`. Workspaces reach it through their own
  // route (#routes/workspaces).
  .get('/:projectId/git/info/refs', async (c) => serveUserGit(c, '/info/refs'))
  .post('/:projectId/git/git-upload-pack', async (c) => serveUserGit(c, '/git-upload-pack'))
  .post('/:projectId/git/git-receive-pack', async (c) => serveUserGit(c, '/git-receive-pack'))
  // Share a hosted project with another user, or remove their share
  // (docs/hosted-projects.md "Sharing").
  .post(
    '/:projectId/shares',
    zv('json', z.object({ userId: z.uuid() })),
    async (c) => c.json(await shareProject(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.valid('json').userId)),
  )
  .delete('/:projectId/shares/:userId', async (c) => {
    await unshareProject(c.get('principal'), await resolveProjectId(c.req.param('projectId')), c.req.param('userId'))
    return c.body(null, 204)
  })
  .delete('/:projectId', async (c) => {
    await removeProject(c.get('principal'), await resolveProjectId(c.req.param('projectId')))
    return c.body(null, 204)
  })
  .get('/:projectId/config', async (c) => c.json(await resolveProjectConfigWithSource(await resolveProjectId(c.req.param('projectId')))))
  // Raw text for the CLI's $EDITOR flow: unlike the parsed GET above it
  // returns malformed content verbatim so it can be repaired.
  .get('/:projectId/config/raw', async (c) =>
    c.json({ content: await readProjectConfigRaw(await resolveProjectId(c.req.param('projectId'))) }))
  .put(
    '/:projectId/config',
    zv('json', z.object({ config: z.unknown() }).refine(
      (b) => b.config !== undefined,
      { message: 'Expected { config } body.', path: ['config'] },
    )),
    async (c) => {
      const { config } = c.req.valid('json')
      const saved = await writeProjectConfig(c.get('principal'), await resolveProjectId(c.req.param('projectId')), config)
      return c.json({ config: saved })
    },
  )
  .delete('/:projectId/config', async (c) => {
    await removeProjectConfig(c.get('principal'), await resolveProjectId(c.req.param('projectId')))
    return c.body(null, 204)
  })
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
  // The project's egress allowlist, with the install's defaults so a client
  // can list them. Applies to workspaces created afterwards.
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
      return c.json({ allowlist: await setProjectAllowlist(c.get('principal'), projectId, c.req.valid('json')) })
    },
  )
  // Branch data for the new-workspace picker: local remote-tracking refs
  // (instant), or freshly fetched with ?refresh=1.
  .get(
    '/:projectId/branches',
    zv('query', z.object({ refresh: z.string().optional() })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      const refresh = c.req.valid('query').refresh === '1'
      return c.json(await getProjectBranches(projectId, { refresh }))
    },
  )
  // Every SKILL.md the project's agents can use, each naming the agents that
  // load it. Read on the host, so no running workspace is needed.
  .get(
    '/:projectId/skills',
    zv('query', z.object({
      // Origin branch to read repo skills and repo plugin settings from
      // (default: the remote's default branch). Host tiers ignore it.
      branch: z.string().optional(),
    })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      return c.json(await getProjectSkills(projectId, c.req.valid('query').branch))
    },
  )
  // The full SKILL.md for one skill, fetched on demand when a row is picked.
  .get(
    '/:projectId/skills/body',
    zv('query', z.object({
      id: z.string().min(1),
      branch: z.string().optional(),
    })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      const { id, branch } = c.req.valid('query')
      return c.json(await getSkillDetail(projectId, id, branch))
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

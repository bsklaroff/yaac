import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import {
  addProject,
  assignProjectCredential,
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
  setProjectEnvVar,
  writeProjectConfig,
  writeProjectDockerfile,
  resolveProjectEnv,
  resolveProjectId,
} from '#domain/projects'
import { removeProject } from '#domain/workspaces'
import { pushCredentialsToRuntime } from '#domain/auth'
import { getProjectSkills, getSkillDetail } from '#domain/skills'
import { projectBuildDir } from '#lib/build-dirs'
import { ServerError } from '@yaac/shared/errors'
import { buildFilesApp } from '#routes/build-files'
import { requireDriverFeature, type IdentityEnv } from '#http'
import { workspaceDriver } from '#drivers/driver'

/**
 * Send a project's changed secrets to running workspaces, which resolve
 * injections per request and so pick up edits without a restart. The row is
 * written either way, so a failure is reported rather than swallowed: a
 * silent failed delete would leave the proxy injecting the old value. The
 * next server start fixes it.
 */
async function syncRunningWorkspaces(projectId: string, applied: string): Promise<void> {
  try {
    const { secrets } = await resolveProjectEnv(projectId)
    await workspaceDriver().syncProjectSecrets(
      projectId,
      Object.fromEntries(Object.entries(secrets).map(([name, { value }]) => [name, value])),
    )
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
      const result = await assignProjectCredential(await resolveProjectId(c.req.param('projectId')), c.req.valid('json').credentialId)
      await pushCredentialsToRuntime()
      return c.json(result)
    },
  )
  .delete('/:projectId', async (c) => {
    await removeProject(await resolveProjectId(c.req.param('projectId')))
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
      const saved = await writeProjectConfig(await resolveProjectId(c.req.param('projectId')), config)
      return c.json({ config: saved })
    },
  )
  .delete('/:projectId/config', async (c) => {
    await removeProjectConfig(await resolveProjectId(c.req.param('projectId')))
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
      const saved = await setProjectEnvVar(projectId, c.req.valid('json'))
      await syncRunningWorkspaces(projectId, `${saved.name} was saved`)
      return c.json({ var: saved })
    },
  )
  .delete('/:projectId/env/:id', async (c) => {
    const projectId = await resolveProjectId(c.req.param('projectId'))
    await removeProjectEnvVar(projectId, c.req.param('id'))
    await syncRunningWorkspaces(projectId, 'the variable was removed')
    return c.body(null, 204)
  })
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
  // Personal, plugin and project SKILL.md files the given tool (default
  // claude) can use. Read on the host, so no running workspace is needed.
  .get(
    '/:projectId/skills',
    zv('query', z.object({
      tool: z.enum(['claude', 'codex', 'opencode', 'pi']).optional(),
      // Origin branch to read repo skills and repo plugin settings from
      // (default: the remote's default branch). Host tiers ignore it.
      branch: z.string().optional(),
    })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      const { tool, branch } = c.req.valid('query')
      return c.json(await getProjectSkills(tool ?? 'claude', projectId, branch))
    },
  )
  // The full SKILL.md for one skill, fetched on demand when a row is expanded.
  .get(
    '/:projectId/skills/body',
    zv('query', z.object({
      id: z.string().min(1),
      tool: z.enum(['claude', 'codex', 'opencode', 'pi']).optional(),
      branch: z.string().optional(),
    })),
    async (c) => {
      const projectId = await resolveProjectId(c.req.param('projectId'))
      const { id, tool, branch } = c.req.valid('query')
      return c.json(await getSkillDetail(tool ?? 'claude', projectId, id, branch))
    },
  )
  // Support files next to Dockerfile.yaac in the project's build dir: its
  // build context, which feeds the image tag.
  .route('/:projectId/build-files', buildFilesApp(async (c) => {
    // The generic Context can't see the mount path's :projectId, so param()
    // is string | undefined here; the mount guarantees it exists.
    return projectBuildDir(await resolveProjectId(c.req.param('projectId') ?? ''))
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
      await writeProjectDockerfile(projectId, content)
      return c.json({ content })
    },
  )

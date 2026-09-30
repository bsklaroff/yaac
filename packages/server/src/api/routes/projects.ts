import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import {
  addProject,
  assertProjectExists,
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
} from '#domain/projects'
import { removeProject } from '#domain/workspaces'
import { pushCredentialsToRuntime } from '#domain/auth'
import { getProjectSkills, getSkillDetail } from '#domain/skills'
import { projectBuildDir } from '#lib/build-dirs'
import { ServerError } from '@yaac/shared/errors'
import { buildFilesApp } from '#routes/build-files'
import { requireDriverFeature } from '#http'
import { workspaceDriver } from '#drivers/driver'

/**
 * Send a project's changed secrets to running workspaces, which resolve
 * injections per request and so pick up edits without a restart. The row is
 * written either way, so a failure is reported rather than swallowed: a
 * silent failed delete would leave the proxy injecting the old value. The
 * next server start fixes it.
 */
async function syncRunningWorkspaces(slug: string, applied: string): Promise<void> {
  try {
    const { secrets } = await resolveProjectEnv(slug)
    await workspaceDriver().syncProjectSecrets(
      slug,
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

export const projectApp = new Hono()
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
      const result = await addProject(remoteUrl, gitCredentialId)
      await pushCredentialsToRuntime()
      return c.json(result)
    },
  )
  // Record a project whose checkout is already staged in the data dir,
  // without cloning. Tests use this to add a local repo.
  .post(
    '/register',
    zv('json', z.object({ slug: z.string().min(1), remoteUrl: z.string().min(1) })),
    async (c) => {
      const { slug, remoteUrl } = c.req.valid('json')
      return c.json(await registerStagedProject(slug, remoteUrl))
    },
  )
  .get('/:slug', async (c) => c.json(await getProjectDetail(c.req.param('slug'))))
  .get('/:slug/exists', async (c) => {
    await assertProjectExists(c.req.param('slug'))
    return c.body(null, 204)
  })
  // Assign the project its git credential. For an SSH key, returns the host
  // key that was trusted so the user can compare it.
  .put(
    '/:slug/git-credential',
    zv('json', z.object({ credentialId: z.uuid() })),
    async (c) => {
      const result = await assignProjectCredential(c.req.param('slug'), c.req.valid('json').credentialId)
      await pushCredentialsToRuntime()
      return c.json(result)
    },
  )
  .delete('/:slug', async (c) => {
    await removeProject(c.req.param('slug'))
    return c.body(null, 204)
  })
  .get('/:slug/config', async (c) => c.json(await resolveProjectConfigWithSource(c.req.param('slug'))))
  // Raw text for the CLI's $EDITOR flow: unlike the parsed GET above it
  // returns malformed content verbatim so it can be repaired.
  .get('/:slug/config/raw', async (c) =>
    c.json({ content: await readProjectConfigRaw(c.req.param('slug')) }))
  .put(
    '/:slug/config',
    zv('json', z.object({ config: z.unknown() }).refine(
      (b) => b.config !== undefined,
      { message: 'Expected { config } body.', path: ['config'] },
    )),
    async (c) => {
      const { config } = c.req.valid('json')
      const saved = await writeProjectConfig(c.req.param('slug'), config)
      return c.json({ config: saved })
    },
  )
  .delete('/:slug/config', async (c) => {
    await removeProjectConfig(c.req.param('slug'))
    return c.body(null, 204)
  })
  // The project's environment: variables its workspaces launch with, and
  // secrets the egress proxy injects. Secret values are write-only: set by
  // PUT, never returned by GET.
  .get('/:slug/env', async (c) => c.json({ vars: await listProjectEnv(c.req.param('slug')) }))
  .put(
    '/:slug/env',
    zv('json', z.object({
      name: z.string().min(1),
      // Optional so a secret's rule can be edited without resending the
      // value; omitting it is refused for a secret with no stored value.
      value: z.string().optional(),
      secret: z.boolean().optional(),
      rule: z.unknown().optional(),
    })),
    async (c) => {
      const slug = c.req.param('slug')
      const saved = await setProjectEnvVar(slug, c.req.valid('json'))
      await syncRunningWorkspaces(slug, `${saved.name} was saved`)
      return c.json({ var: saved })
    },
  )
  .delete('/:slug/env/:id', async (c) => {
    const slug = c.req.param('slug')
    await removeProjectEnvVar(slug, c.req.param('id'))
    await syncRunningWorkspaces(slug, 'the variable was removed')
    return c.body(null, 204)
  })
  // Branch data for the new-workspace picker: local remote-tracking refs
  // (instant), or freshly fetched with ?refresh=1.
  .get(
    '/:slug/branches',
    zv('query', z.object({ refresh: z.string().optional() })),
    async (c) => {
      const slug = c.req.param('slug')
      // Check the row first so an unknown slug 404s instead of probing a
      // missing repo dir.
      await assertProjectExists(slug)
      const refresh = c.req.valid('query').refresh === '1'
      return c.json(await getProjectBranches(slug, { refresh }))
    },
  )
  // Personal, plugin and project SKILL.md files the given tool (default
  // claude) can use. Read on the host, so no running workspace is needed.
  .get(
    '/:slug/skills',
    zv('query', z.object({
      tool: z.enum(['claude', 'codex', 'opencode', 'pi']).optional(),
      // Origin branch to read repo skills and repo plugin settings from
      // (default: the remote's default branch). Host tiers ignore it.
      branch: z.string().optional(),
    })),
    async (c) => {
      const slug = c.req.param('slug')
      await assertProjectExists(slug)
      const { tool, branch } = c.req.valid('query')
      return c.json(await getProjectSkills(tool ?? 'claude', slug, branch))
    },
  )
  // The full SKILL.md for one skill, fetched on demand when a row is expanded.
  .get(
    '/:slug/skills/body',
    zv('query', z.object({
      id: z.string().min(1),
      tool: z.enum(['claude', 'codex', 'opencode', 'pi']).optional(),
      branch: z.string().optional(),
    })),
    async (c) => {
      const slug = c.req.param('slug')
      await assertProjectExists(slug)
      const { id, tool, branch } = c.req.valid('query')
      return c.json(await getSkillDetail(tool ?? 'claude', slug, id, branch))
    },
  )
  // Support files next to Dockerfile.yaac in the project's build dir: its
  // build context, which feeds the image tag.
  .route('/:slug/build-files', buildFilesApp(async (c) => {
    // The generic Context can't see the mount path's :slug, so param() is
    // string | undefined here; the mount guarantees it exists.
    const slug = c.req.param('slug') ?? ''
    await assertProjectExists(slug)
    return projectBuildDir(slug)
  }))
  // The project's image layer. Both check the driver feature before the
  // project (see `requireDriverFeature`).
  .get('/:slug/dockerfile', async (c) => {
    requireDriverFeature('images')
    await assertProjectExists(c.req.param('slug'))
    return c.json({ content: await readProjectDockerfile(c.req.param('slug')) })
  })
  .put(
    '/:slug/dockerfile',
    zv('json', z.object({ content: z.string() })),
    async (c) => {
      requireDriverFeature('images')
      await assertProjectExists(c.req.param('slug'))
      const { content } = c.req.valid('json')
      await writeProjectDockerfile(c.req.param('slug'), content)
      return c.json({ content })
    },
  )

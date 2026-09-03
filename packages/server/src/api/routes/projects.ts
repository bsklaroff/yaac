import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import {
  addProject,
  assertProjectExists,
  getProjectBranches,
  getProjectDetail,
  listProjectEnv,
  listProjects,
  readProjectConfigRaw,
  readProjectDockerfile,
  removeProjectConfig,
  removeProjectEnvVar,
  resolveProjectConfigWithSource,
  setProjectEnvVar,
  setProjectReferenceBranch,
  writeProjectConfig,
  writeProjectDockerfile,
} from '#domain/projects'
import { removeProject } from '#domain/worktrees'
import { getProjectSkills, getSkillDetail } from '#domain/skills'
import { projectBuildDir } from '#lib/build-dirs'
import { remoteBranchExists } from '#domain/git'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { buildFilesApp } from '#routes/build-files'
import { requireDriverFeature } from '#http'
import { worktreeDriver } from '#drivers/driver'

/**
 * Deliver a project's changed secrets to whatever is running now.
 *
 * A live worktree resolves an injection per request, so an edit reaches it
 * without a restart — but only if the runtime is told. A failure here is
 * reported rather than swallowed, and the message says what DID happen,
 * because the two halves diverge: the row is written either way, so a caller
 * told nothing would read a failed delete as "the credential is gone" while
 * the egress path went on injecting it.
 *
 * The reconcile step heals this on its own tick; what the caller needs is to
 * know it has not happened yet.
 */
async function syncRunningWorktrees(slug: string, applied: string): Promise<void> {
  try {
    await worktreeDriver().syncProxySecrets(slug)
  } catch (err) {
    throw new ServerError(
      'RUNTIME_UNAVAILABLE',
      `${applied}, but the egress proxy could not be updated, so worktrees `
      + 'running right now still use the previous value: '
      + `${err instanceof Error ? err.message : String(err)}. `
      + 'New worktrees are unaffected, and running ones catch up when the '
      + 'proxy is reachable again.',
    )
  }
}

export const projectApp = new Hono()
  .get('/list', async (c) => c.json(await listProjects()))
  .post(
    '/add',
    zv('json', z.object({ remoteUrl: z.string().min(1) })),
    async (c) => {
      const { remoteUrl } = c.req.valid('json')
      return c.json(await addProject(remoteUrl))
    },
  )
  .get('/:slug', async (c) => c.json(await getProjectDetail(c.req.param('slug'))))
  .get('/:slug/exists', async (c) => {
    await assertProjectExists(c.req.param('slug'))
    return c.body(null, 204)
  })
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
  // The project's environment: the variables its worktrees launch with, and
  // the secrets the egress proxy injects. A secret's value is write-only —
  // it goes in through the PUT and never comes back out of the GET.
  .get('/:slug/env', async (c) => c.json({ vars: await listProjectEnv(c.req.param('slug')) }))
  .put(
    '/:slug/env',
    zv('json', z.object({
      name: z.string().min(1),
      // Optional so a secret's rule can be edited without the secret
      // travelling again; the domain refuses it for a secret that has none.
      value: z.string().optional(),
      secret: z.boolean().optional(),
      rule: z.unknown().optional(),
    })),
    async (c) => {
      const slug = c.req.param('slug')
      const saved = await setProjectEnvVar(slug, c.req.valid('json'))
      await syncRunningWorktrees(slug, `${saved.name} was saved`)
      return c.json({ var: saved })
    },
  )
  .delete('/:slug/env/:id', async (c) => {
    const slug = c.req.param('slug')
    await removeProjectEnvVar(slug, c.req.param('id'))
    await syncRunningWorktrees(slug, 'the variable was removed')
    return c.body(null, 204)
  })
  // Branch data for the new-worktree picker: local remote-tracking refs
  // (instant), or freshly fetched with ?refresh=1.
  .get(
    '/:slug/branches',
    zv('query', z.object({ refresh: z.string().optional() })),
    async (c) => {
      const slug = c.req.param('slug')
      // Existence is a row question, answered before the clone is touched —
      // an unknown slug must 404, not probe a repo dir that isn't there.
      await assertProjectExists(slug)
      const refresh = c.req.valid('query').refresh === '1'
      return c.json(await getProjectBranches(slug, { refresh }))
    },
  )
  // Set (or clear, with null) the project's default reference branch —
  // the picker's "set as default". Existence-checked against the local
  // remote-tracking refs so a typo'd default fails here, not at the next
  // worktree create.
  .put(
    '/:slug/reference-branch',
    zv('json', z.object({ branch: z.string().min(1).nullable() })),
    async (c) => {
      const slug = c.req.param('slug')
      const { branch } = c.req.valid('json')
      // Unknown project must surface as NOT_FOUND, not a bogus "branch not
      // found" from probing a repo dir that isn't there.
      await assertProjectExists(slug)
      if (branch !== null && !(await remoteBranchExists(repoDir(slug), branch))) {
        throw new ServerError('VALIDATION', `branch "${branch}" not found on origin.`)
      }
      const config = await setProjectReferenceBranch(slug, branch)
      return c.json({ referenceBranch: config.referenceBranch ?? null })
    },
  )
  // Personal + plugin + project SKILL.md files a project's agent can use, for
  // the given tool (default claude). A pure host-side read of each agent's
  // explicit skill dirs, so it needs no running worktree.
  .get(
    '/:slug/skills',
    zv('query', z.object({
      tool: z.enum(['claude', 'codex', 'opencode', 'pi']).optional(),
      // The origin branch project (repo) skills + repo-side plugin settings are
      // read from (default: the remote's default branch). Host tiers ignore it.
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
  // Support files living next to Dockerfile.yaac in the project's build
  // dir — its whole build context (COPY-able, part of the image tag).
  .route('/:slug/build-files', buildFilesApp(async (c) => {
    // The generic Context can't see the mount path's :slug, so param() is
    // string | undefined here; the mount guarantees it exists.
    const slug = c.req.param('slug') ?? ''
    await assertProjectExists(slug)
    return projectBuildDir(slug)
  }))
  // The project's image layer. Both refuse on a runtime that builds no
  // images, BEFORE the project check: what this server can build is not a
  // property of the project being asked about, and a 404 for a slug that
  // happens not to exist would hide the real answer.
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

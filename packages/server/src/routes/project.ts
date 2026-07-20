import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { listProjects } from '#lib/project/list'
import { getProjectDetail, resolveProjectConfigWithSource, assertProjectExists } from '#lib/project/detail'
import { addProject } from '#lib/project/add'
import { removeProject } from '#lib/project/remove'
import { writeProjectConfig, removeProjectConfig, readProjectConfigRaw, setProjectReferenceBranch } from '#lib/project/local-config'
import { getProjectBranches } from '#lib/project/branches'
import { getProjectSkills, getSkillDetail } from '#lib/skills/discover'
import { remoteBranchExists } from '#lib/git'
import { repoDir } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { readProjectDockerfile, writeProjectDockerfile } from '#lib/project/dockerfile'
import { resolveProjectBuildDir } from '#lib/project/build-dirs'
import { buildFilesApp } from '#routes/build-files'
import { rebuildProjectImage, pushImageShared } from '#lib/container/build-coordinator'
import { toErrorBody } from '#errors'
import { testEnv } from '@yaac/shared/env'

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
  // Branch data for the new-session picker: local remote-tracking refs
  // (instant), or freshly fetched with ?refresh=1.
  .get(
    '/:slug/branches',
    zv('query', z.object({ refresh: z.string().optional() })),
    async (c) => {
      const refresh = c.req.valid('query').refresh === '1'
      return c.json(await getProjectBranches(c.req.param('slug'), { refresh }))
    },
  )
  // Set (or clear, with null) the project's default reference branch —
  // the picker's "set as default". Existence-checked against the local
  // remote-tracking refs so a typo'd default fails here, not at the next
  // session create.
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
  // explicit skill dirs, so it needs no running session.
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
    return resolveProjectBuildDir(slug)
  }))
  .get('/:slug/dockerfile', async (c) =>
    c.json({ content: await readProjectDockerfile(c.req.param('slug')) }))
  .put(
    '/:slug/dockerfile',
    zv('json', z.object({ content: z.string() })),
    async (c) => {
      const { content } = c.req.valid('json')
      await writeProjectDockerfile(c.req.param('slug'), content)
      return c.json({ content })
    },
  )
  .post('/:slug/rebuild', (c) => {
    // Stream the rebuild logs as NDJSON {progress|result|error} events so
    // `yaac project rebuild` can mirror `podman build --no-cache` output
    // live (it can take minutes when the upstream Claude/codex installers
    // download fresh tarballs).
    const slug = c.req.param('slug')
    c.header('Content-Type', 'application/x-ndjson')
    return stream(c, async (s) => {
      const write = (event: unknown) => s.writeln(JSON.stringify(event))
      try {
        // Resolve project first (throws NOT_FOUND if missing).
        await getProjectDetail(slug)
        const finalTag = await rebuildProjectImage(slug, {
          imagePrefix: testEnv.imagePrefix,
          onLog: (line) => { void write({ type: 'progress', message: line }) },
        })
        // New sessions pull from the in-cluster registry, so the rebuilt
        // image is invisible until it's pushed there.
        await write({ type: 'progress', message: 'Pushing rebuilt image to the local registry...' })
        // force: the rebuild changed image bytes under an unchanged
        // content-hash tag, so the has-tag no-op would skip the real push.
        await pushImageShared(finalTag, { projectSlug: slug, reason: 'rebuild' }, { force: true })
        await write({ type: 'result', result: { projectSlug: slug, finalTag } })
      } catch (err) {
        const { body: errBody } = toErrorBody(err)
        await write({ type: 'error', error: errBody.error })
      }
    })
  })

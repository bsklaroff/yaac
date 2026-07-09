import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { zv } from '@/daemon/routes/validator'
import { z } from 'zod'
import { listProjects } from '@/lib/project/list'
import { getProjectDetail, resolveProjectConfigWithSource, assertProjectExists } from '@/lib/project/detail'
import { addProject } from '@/lib/project/add'
import { removeProject } from '@/lib/project/remove'
import { writeProjectConfig, removeProjectConfig } from '@/lib/project/local-config'
import { readProjectDockerfile, writeProjectDockerfile } from '@/lib/project/dockerfile'
import { rebuildProjectImage, pushImageShared } from '@/lib/container/build-coordinator'
import { toErrorBody } from '@/daemon/errors'
import { testEnv } from '@/shared/env'

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

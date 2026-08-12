import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { readUserDockerfile, writeUserDockerfile } from '#domain/projects'
import { resolveUserBuildDir } from '#lib/build-dirs'
import { buildFilesApp } from '#routes/build-files'

/**
 * Global (non-project-scoped) editable config: the user Dockerfile
 * (`~/.yaac/build/Dockerfile.user`), which layers on top of every project
 * image, and the support files sharing its build dir (its whole build
 * context).
 */
export const configApp = new Hono()
  .get('/user-dockerfile', async (c) => c.json({ content: await readUserDockerfile() }))
  .put(
    '/user-dockerfile',
    zv('json', z.object({ content: z.string() })),
    async (c) => {
      const { content } = c.req.valid('json')
      await writeUserDockerfile(content)
      return c.json({ content })
    },
  )
  .route('/user-build-files', buildFilesApp(() => resolveUserBuildDir()))

import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { readUserDockerfile, writeUserDockerfile } from '#lib/project/dockerfile'

/**
 * Global (non-project-scoped) editable config. Currently just the user
 * Dockerfile (`~/.yaac/Dockerfile.user`), which layers on top of every
 * project image.
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

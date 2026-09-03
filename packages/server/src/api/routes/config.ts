import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { readUserDockerfile, writeUserDockerfile } from '#domain/projects'
import { userBuildDir } from '#lib/build-dirs'
import { buildFilesApp } from '#routes/build-files'
import { requireDriverFeature } from '#http'
import { getGitIdentity, setGitIdentity } from '#db'
import { ServerError } from '@yaac/shared/errors'

/**
 * Global (non-project-scoped) editable config: the git identity this
 * server's worktrees commit under, the user Dockerfile
 * (`~/.yaac/build/Dockerfile.user`), which layers on top of every project
 * image, and the support files sharing its build dir (its whole build
 * context).
 */
export const configApp = new Hono()
  // The git identity. Not gated on a driver feature: every substrate makes
  // commits, and this is the setting that replaced reading one off the
  // server's host — which a client on another machine cannot write.
  .get('/git-identity', async (c) => c.json({ identity: await getGitIdentity() }))
  .put(
    '/git-identity',
    zv('json', z.object({
      name: z.string().min(1),
      email: z.string().min(1),
    })),
    async (c) => {
      const { name, email } = c.req.valid('json')
      const identity = { name: name.trim(), email: email.trim() }
      if (!identity.name || !identity.email) {
        throw new ServerError('VALIDATION', 'Both a name and an email address are required.')
      }
      if (!identity.email.includes('@')) {
        throw new ServerError('VALIDATION', `"${identity.email}" is not an email address.`)
      }
      await setGitIdentity(identity)
      return c.json({ identity })
    },
  )
  // Both refuse on a runtime that builds no images — the file would be
  // an editable layer over an image that is never built.
  .get('/user-dockerfile', async (c) => {
    requireDriverFeature('images')
    return c.json({ content: await readUserDockerfile() })
  })
  .put(
    '/user-dockerfile',
    zv('json', z.object({ content: z.string() })),
    async (c) => {
      requireDriverFeature('images')
      const { content } = c.req.valid('json')
      await writeUserDockerfile(content)
      return c.json({ content })
    },
  )
  .route('/user-build-files', buildFilesApp(() => Promise.resolve(userBuildDir())))

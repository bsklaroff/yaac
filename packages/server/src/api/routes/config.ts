import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { readUserDockerfile, writeUserDockerfile } from '#domain/projects'
import { userBuildDir } from '#lib/build-dirs'
import { buildFilesApp } from '#routes/build-files'
import { requireDriverFeature, type IdentityEnv } from '#http'
import { getGitIdentity, getTimeZone, setGitIdentity, setTimeZone } from '#db'
import { ServerError } from '@yaac/shared/errors'

/**
 * A zone name `Intl` knows. The charset check keeps it to IANA names, since
 * `Intl` also takes offsets like `+05:00`, and the value lands in `TZ`.
 */
function isTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]+$/.test(timeZone)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * The caller's own (not project-scoped) editable config: the git identity
 * their workspaces commit under, the time zone they run in, and their
 * Dockerfile.user, layered on every project image they own, with the other
 * files in its build context.
 */
export const configApp = new Hono<IdentityEnv>()
  // Not gated on a driver feature: every substrate makes commits. Stored in
  // the server so a client on another machine can set it.
  .get('/git-identity', async (c) => c.json({ identity: await getGitIdentity(c.get('principal').userId) }))
  .put(
    '/git-identity',
    // Capped and free of control characters, since both values land in a
    // workspace's `.gitconfig` and in env vars.
    zv('json', z.object({
      name: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]*$/),
      email: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]*$/),
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
      await setGitIdentity(c.get('principal').userId, identity)
      return c.json({ identity })
    },
  )
  .get('/time-zone', async (c) => c.json(await getTimeZone(c.get('principal').userId)))
  // `pinned` absent is a device report, which a zone the user chose in
  // settings outranks; present, it is that choice (`false` returns the zone
  // to following devices).
  .put(
    '/time-zone',
    zv('json', z.object({
      timeZone: z.string().max(64).refine(isTimeZone, 'not an IANA time zone'),
      pinned: z.boolean().optional(),
    })),
    async (c) => {
      const { timeZone, pinned } = c.req.valid('json')
      const owner = c.get('principal').userId
      if (pinned !== undefined || !(await getTimeZone(owner)).pinned) {
        await setTimeZone(owner, timeZone, pinned ?? false)
      }
      return c.json(await getTimeZone(owner))
    },
  )
  // Both refuse on a runtime that builds no images.
  .get('/user-dockerfile', async (c) => {
    requireDriverFeature('images')
    return c.json({ content: await readUserDockerfile(c.get('principal').userId) })
  })
  .put(
    '/user-dockerfile',
    zv('json', z.object({ content: z.string() })),
    async (c) => {
      requireDriverFeature('images')
      const { content } = c.req.valid('json')
      await writeUserDockerfile(c.get('principal').userId, content)
      return c.json({ content })
    },
  )
  .route('/user-build-files', buildFilesApp((c) => Promise.resolve(userBuildDir(c.get('principal').userId))))

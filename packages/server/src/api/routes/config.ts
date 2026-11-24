import { Hono } from 'hono'
import { zv } from '#routes/validator'
import { z } from 'zod'
import { personOnly, type IdentityEnv } from '#api/http/web-auth'
import { getGitIdentity, getTimeZone, setGitIdentity, setTimeZone } from '#db'
import { ServerError } from '@yaac/shared/errors'
import { isTimeZone } from '@yaac/shared/schedule'
import { personId } from '#domain/access'

/**
 * The caller's own (not project-scoped) editable config: the git identity
 * their workspaces commit under and the time zone they run in. Their
 * Dockerfile.user is an image (`/image/user`).
 */
export const configApp = new Hono<IdentityEnv>()
  .use(personOnly)
  // Not gated on a driver feature: every substrate makes commits. Stored in
  // the server so a client on another machine can set it.
  .get('/git-identity', async (c) => c.json({ identity: await getGitIdentity(personId(c.get('principal'))) }))
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
      await setGitIdentity(personId(c.get('principal')), identity)
      return c.json({ identity })
    },
  )
  .get('/time-zone', async (c) => c.json(await getTimeZone(personId(c.get('principal')))))
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
      const owner = personId(c.get('principal'))
      if (pinned !== undefined || !(await getTimeZone(owner)).pinned) {
        await setTimeZone(owner, timeZone, pinned ?? false)
      }
      return c.json(await getTimeZone(owner))
    },
  )

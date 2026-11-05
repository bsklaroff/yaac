import fs from 'node:fs/promises'
import { createAdaptorServer, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import { listAdmins } from '#db'
import { replaceAdmins } from '#domain/access'
import { toErrorBody } from '#api/http/errors'
import { zv } from '#routes/validator'
import { adminSocketPath, ensureInstallTmpDir } from '@yaac/shared/paths'

/**
 * The admin socket (docs/multi-user.md "Roles"): a Unix socket in the
 * install's private tmp dir, through which `--admin` reads and replaces the
 * install's admins. The HTTP API cannot carry this, since a `tailnet` server
 * admits only callers through `tailscale serve`. Reaching the socket takes
 * the server's OS user, or `kubectl exec` into its pod, so it checks no
 * caller.
 */
function adminSocketApp() {
  return new Hono()
    .get('/admins', async (c) => c.json(await listAdmins()))
    .put(
      '/admins',
      zv('json', z.object({ logins: z.array(z.string().trim().min(1)), expected: z.array(z.string()) })),
      async (c) => {
        const { logins, expected } = c.req.valid('json')
        return c.json(await replaceAdmins([...new Set(logins)], expected))
      },
    )
    .onError((err, c) => {
      const { status, body } = toErrorBody(err)
      return c.json(body, status as 400 | 404 | 409 | 500)
    })
}

/** Listen on the admin socket, replacing one a dead server left. */
export async function listenAdminSocket(): Promise<ServerType> {
  await ensureInstallTmpDir()
  const socket = adminSocketPath()
  await fs.rm(socket, { force: true })
  const server = createAdaptorServer({ fetch: adminSocketApp().fetch })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => resolve())
  })
  return server
}

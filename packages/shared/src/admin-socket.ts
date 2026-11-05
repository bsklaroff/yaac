import http from 'node:http'
import { confirmDefault } from '#confirm'
import { adminSocketPath } from '#paths'
import type { AdminEntry } from '#types'

/**
 * The client side of the server's admin socket (docs/multi-user.md
 * "Roles"), through which `--admin` replaces an install's admins: over the
 * socket in the data dir for a host server, and through `kubectl exec`
 * into the pod for a cluster's.
 */

/** One request to the admin socket's `/admins`, however it is reached. */
export type AdminSocketRequest = (method: 'GET' | 'PUT', body?: unknown) => Promise<{ status: number; body: unknown }>

/** The host server's admin socket, in this data dir. */
export const hostAdminSocket: AdminSocketRequest = (method, body) => new Promise((resolve, reject) => {
  const req = http.request(
    { socketPath: adminSocketPath(), path: '/admins', method, headers: { 'content-type': 'application/json' } },
    (res) => {
      let raw = ''
      res.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as unknown })
        } catch (err) {
          reject(err)
        }
      })
    },
  )
  req.on('error', (err) => reject(new Error(`the server's admin socket did not answer (${err.message}); see its log`)))
  req.end(body === undefined ? undefined : JSON.stringify(body))
})

const shown = (a: AdminEntry): string => a.login ?? a.name

/**
 * Make exactly `logins` the install's admins. When that revokes anyone it
 * says who and asks first; with no terminal to ask on it refuses unless
 * `yes`. The write names the admins it was confirmed against, so if they
 * changed meanwhile it reads them and asks again. Logs the admins it leaves,
 * marking any not yet signed in, which shows a mistyped login.
 */
export async function applyAdmins(
  request: AdminSocketRequest,
  logins: readonly string[],
  opts: { yes?: boolean; log: (line: string) => void },
): Promise<void> {
  for (;;) {
    const current = expectOk<AdminEntry[]>(await request('GET'))
    const revoked = current.filter((a) => a.login === null || !logins.includes(a.login)).map(shown)
    if (revoked.length > 0 && !opts.yes) {
      const who = revoked.join(', ')
      if (!process.stdin.isTTY) throw new Error(`--admin would revoke admin from ${who}; re-run with --yes to accept that.`)
      if (!await confirmDefault(`This revokes admin from: ${who}. Continue?`)) throw new Error('Left the admins unchanged.')
    }
    const res = await request('PUT', { logins, expected: current.map((a) => a.login ?? '') })
    if (res.status === 409) {
      opts.log('the admins changed since they were read; reading them again')
      continue
    }
    for (const a of expectOk<AdminEntry[]>(res)) {
      opts.log(`admin: ${shown(a)}${a.signedIn ? '' : ' (has not signed in yet)'}`)
    }
    return
  }
}

function expectOk<T>(res: { status: number; body: unknown }): T {
  if (res.status === 200) return res.body as T
  const message = (res.body as { error?: { message?: string } } | null)?.error?.message
  throw new Error(`the server's admin socket refused: ${message ?? `HTTP ${String(res.status)}`}`)
}

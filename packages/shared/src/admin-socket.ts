import http from 'node:http'
import { confirmDefault } from '#confirm'
import { adminSocketPath, ensureInstallTmpDir } from '#paths'
import type { AdminEntry } from '#types'

/**
 * The client side of the server's admin socket (docs/multi-user.md
 * "Roles"), through which `--admin` replaces an install's admins: over the
 * socket in the install tmp dir for a host server, and through `kubectl exec`
 * into the pod for a cluster's.
 */

/** One request to the admin socket's `/admins`, however it is reached. */
export type AdminSocketRequest = (method: 'GET' | 'PUT', body?: unknown) => Promise<{ status: number; body: unknown }>

/** The host server's admin socket, refused unless its dir is private, since
 *  another user's socket there would see and answer `--admin`. */
export const hostAdminSocket: AdminSocketRequest = async (method, body) => {
  await ensureInstallTmpDir()
  return new Promise((resolve, reject) => {
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
}

const shown = (a: AdminEntry): string => a.login ?? a.name

/** The install's admins, as the socket answers them. */
export async function readAdmins(request: AdminSocketRequest): Promise<AdminEntry[]> {
  return expectOk<AdminEntry[]>(await request('GET'))
}

/**
 * Check making exactly `logins` the admins in place of `current`. When that
 * revokes anyone it says who and asks first; with no terminal to ask on it
 * refuses unless `yes`. A refusal throws.
 */
export async function confirmRevocations(
  current: readonly AdminEntry[],
  logins: readonly string[],
  yes: boolean | undefined,
): Promise<void> {
  const revoked = current.filter((a) => a.login === null || !logins.includes(a.login)).map(shown)
  if (revoked.length === 0 || yes) return
  const who = revoked.join(', ')
  if (!process.stdin.isTTY) throw new Error(`--admin would revoke admin from ${who}; re-run with --yes to accept that.`)
  if (!await confirmDefault(`This revokes admin from: ${who}. Continue?`)) throw new Error('Left the admins unchanged.')
}

const loginsOf = (admins: readonly AdminEntry[]): string[] => admins.map((a) => a.login ?? '')
const sameAdmins = (a: readonly AdminEntry[], b: readonly AdminEntry[]): boolean =>
  loginsOf(a).sort().join('\n') === loginsOf(b).sort().join('\n')

/**
 * Make exactly `logins` the install's admins, first checking whom that
 * revokes with `confirmRevocations`. A caller that already checked, against
 * the admins in `confirmed`, is not asked again while the admins are still
 * those. The write names the admins it was confirmed against, so if they
 * changed meanwhile it reads them and asks again. Logs the admins it leaves,
 * marking any not yet signed in, which shows a mistyped login.
 */
export async function applyAdmins(
  request: AdminSocketRequest,
  logins: readonly string[],
  opts: { yes?: boolean; log: (line: string) => void; confirmed?: readonly AdminEntry[] },
): Promise<void> {
  let confirmed = opts.confirmed
  for (;;) {
    const current = await readAdmins(request)
    if (!confirmed || !sameAdmins(confirmed, current)) await confirmRevocations(current, logins, opts.yes)
    confirmed = current
    const res = await request('PUT', { logins, expected: loginsOf(current) })
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

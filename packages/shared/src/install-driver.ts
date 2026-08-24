import fs from 'node:fs/promises'
import { serverLocalPath } from '#paths'
import type { DriverKind } from '#types'

/**
 * Which substrate this data dir runs, as recorded by the last server start.
 *
 * SERVER-LOCAL, beside the lock: the choice belongs to this install, not to
 * a project, and it is not something a worktree's state should carry.
 *
 * Here rather than in the server because the answer decides what a CLIENT
 * should do about a server it cannot reach — a containerless install can be
 * started (`yaac server start`), while a k8s one has to be converged (`yaac
 * cluster install`), and spawning a host process against a k8s data dir is
 * precisely the wrong move. The desktop shell asks this, and it may import
 * nothing but `@yaac/shared`.
 */
export async function recordedDriver(): Promise<DriverKind | undefined> {
  try {
    const raw = (await fs.readFile(serverLocalPath('driver'), 'utf8')).trim()
    return raw === 'k8s' || raw === 'containerless' ? raw : undefined
  } catch {
    return undefined
  }
}

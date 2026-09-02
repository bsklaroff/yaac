import fs from 'node:fs/promises'
import { clientLocalPath, serverLocalPath } from '#paths'
import type { DriverKind } from '#types'

/**
 * Which substrate this data dir runs, as recorded by whichever side stood
 * the server up.
 *
 * CLIENT-LOCAL: the choice belongs to this install, not to a project, and
 * it is not something a worktree's state should carry — and the only
 * process that has to ACT on it is a client, which is why it may not live
 * where a k8s server (a pod) would be the one holding it.
 *
 * Here rather than in the server because the answer decides what a CLIENT
 * should do about a server it cannot reach — a containerless install can be
 * started (`yaac server start`), while a k8s one has to be converged (`yaac
 * cluster install`), and spawning a host process against a k8s data dir is
 * precisely the wrong move. The desktop shell asks this, and it may import
 * nothing but `@yaac/shared`.
 */
export async function recordedDriver(): Promise<DriverKind | undefined> {
  return await recordedDriverAt(clientLocalPath('driver'))
    // Where it lived when every tier was one directory — see
    // docs/legacy-compat-shims.md.
    ?? await recordedDriverAt(serverLocalPath('driver'))
}

async function recordedDriverAt(filePath: string): Promise<DriverKind | undefined> {
  try {
    const raw = (await fs.readFile(filePath, 'utf8')).trim()
    return raw === 'k8s' || raw === 'containerless' ? raw : undefined
  } catch {
    return undefined
  }
}

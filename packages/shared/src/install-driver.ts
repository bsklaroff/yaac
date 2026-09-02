import { readLegacyDriverRecord, readServerConfig } from '#server-config'
import type { DriverKind } from '#types'

/**
 * Which substrate this data dir runs, as recorded by whichever side stood
 * the server up (`registerServer` in `#server-config`, called by `yaac
 * server start` and by `yaac cluster install`).
 *
 * CLIENT-LOCAL: the choice belongs to this install, not to a project, and
 * it is not something a worktree's state should carry — and the only
 * process that has to ACT on it is a client, which is why it may not live
 * where a k8s server (a pod) would be the one holding it.
 *
 * Recorded rather than derived because the answer decides what a CLIENT
 * should do about a server it cannot reach — a containerless install can be
 * started (`yaac server start`), while a k8s one has to be converged (`yaac
 * cluster install`), and spawning a host process against a k8s data dir is
 * precisely the wrong move. The desktop shell asks this, and it may import
 * nothing but `@yaac/shared`.
 */
export async function recordedDriver(): Promise<DriverKind | undefined> {
  return (await readServerConfig())?.driver
    // Its own file, before it moved into `server.json`. Any write of
    // `server.json` folds it in, so this answers only until the next one —
    // see docs/legacy-compat-shims.md.
    ?? await readLegacyDriverRecord()
}

import { workspaceDriver } from '#drivers/driver'
import { getProjectRow } from '#db'
import { shellEscape } from '#lib/shell'

/**
 * Checkout-relative mount points (scratch dirs and cache volumes under
 * the checkout). `git clean` must skip them: removing a mount point fails
 * with EBUSY.
 */
function workspaceMountPaths(cacheVolumes: Record<string, string>, modules: string[], workspaceDir: string): string[] {
  const prefix = `${workspaceDir}/`
  const underWorkspace = (p: string): string | null =>
    p.startsWith(prefix) ? p.slice(prefix.length) : null
  return [
    ...modules,
    ...Object.values(cacheVolumes).map(underWorkspace),
  ].filter((p): p is string => p !== null && p.length > 0)
}

/**
 * Move one of a spare's checkouts, at `checkoutDir` as the workspace sees
 * it, to another branch, or to a newer tip of its own:
 * at claim time, or in the background when its base moves
 * (`./prewarm-reconcile`). The caller resolves the SHA (`origin/<branch>` as
 * fetched into the main clone, whose objects the checkout borrows) and
 * checks the branch first; on a throw it must reap the spare. The caller
 * must have awaited `awaitAgentTransport`. Each command is idempotent, so
 * retries are safe. A spare runs no session, so nothing else needs moving.
 */
export async function rebranchSpare(
  spare: { jobName: string; workspaceId: string; projectId: string },
  checkoutDir: string,
  branch: string,
  sha: string,
): Promise<void> {
  const runtime = workspaceDriver()
  const wd = checkoutDir
  // Move `agent/<id>` to the SHA and remove untracked files. `clean -fd` not
  // `-x`, which would empty mounted module and cache dirs. reset+clean walks
  // the whole checkout, so allow longer than the default.
  const row = await getProjectRow(spare.projectId)
  const modules = row?.scratchDirs.dirs.map((d) => d.path) ?? []
  const cleanExcludes = workspaceMountPaths(row?.cacheVolumes ?? {}, modules, wd)
    .map((p) => ` -e '${shellEscape(p)}'`)
    .join('')
  await runtime.exec(spare.jobName, `sh -c "git -C ${wd} reset --hard ${sha} `
    + `&& git -C ${wd} clean -fd${cleanExcludes}"`, { timeout: 120_000 })
  // Set the clone's `origin/<branch>` to the SHA (its origin refs may be
  // older) and make it `agent/<id>`'s upstream.
  await runtime.exec(spare.jobName, `git -C ${wd} update-ref 'refs/remotes/origin/${shellEscape(branch)}' ${sha}`
    + ` && git -C ${wd} branch --set-upstream-to 'origin/${shellEscape(branch)}'`)
}

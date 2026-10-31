import { workspaceDriver } from '#drivers/driver'
import { resolveProjectConfig } from '#domain/projects'
import { getProjectRow } from '#db'
import { shellEscape } from '#lib/shell'
import { resolveInitWindows, initWindowCommand, tmuxCmd } from '#runtime/agents'
import type { YaacConfig } from '@yaac/shared/types'

/**
 * Checkout-relative mount points (scratch dirs and cache volumes under
 * the checkout). `git clean` must skip them: removing a mount point fails
 * with EBUSY.
 */
function workspaceMountPaths(config: YaacConfig, modules: string[], workspaceDir: string): string[] {
  const prefix = `${workspaceDir}/`
  const underWorkspace = (p: string): string | null =>
    p.startsWith(prefix) ? p.slice(prefix.length) : null
  return [
    ...modules,
    ...Object.values(config.cacheVolumes ?? {}).map(underWorkspace),
  ].filter((p): p is string => p !== null && p.length > 0)
}

/**
 * Move a spare's checkout to another branch, or to a newer tip of its own:
 * at claim time, or in the background when its base moves
 * (`./prewarm-reconcile`). The caller resolves the SHA (`origin/<branch>` as
 * fetched into the main clone, whose objects the checkout borrows) and
 * checks the branch first; on a throw it must reap the spare. The caller
 * must have awaited `awaitAgentTransport`. Each command is idempotent, so
 * retries are safe. A spare runs no session, so nothing else needs moving.
 */
export async function rebranchSpare(
  spare: { jobName: string; workspaceId: string; projectId: string },
  branch: string,
  sha: string,
): Promise<void> {
  const config: YaacConfig = await resolveProjectConfig(spare.projectId) ?? {}
  const runtime = workspaceDriver()
  const paths = runtime.workspacePaths(spare.jobName)
  const TMUX = tmuxCmd(paths)
  const wd = paths.workspaceDir
  // Move `agent/<id>` to the SHA and remove untracked files. `clean -fd` not
  // `-x`, which would empty mounted module and cache dirs. reset+clean walks
  // the whole checkout, so allow longer than the default.
  const modules = (await getProjectRow(spare.projectId))?.scratchDirs.dirs.map((d) => d.path) ?? []
  const cleanExcludes = workspaceMountPaths(config, modules, wd)
    .map((p) => ` -e '${shellEscape(p)}'`)
    .join('')
  await runtime.exec(spare.jobName, `sh -c "git -C ${wd} reset --hard ${sha} `
    + `&& git -C ${wd} clean -fd${cleanExcludes}"`, { timeout: 120_000 })
  // Set the clone's `origin/<branch>` to the SHA (its origin refs may be
  // older) and make it `agent/<id>`'s upstream.
  await runtime.exec(spare.jobName, `git -C ${wd} update-ref 'refs/remotes/origin/${shellEscape(branch)}' ${sha}`
    + ` && git -C ${wd} branch --set-upstream-to 'origin/${shellEscape(branch)}'`)
  for (const win of resolveInitWindows(config)) {
    // Kill and recreate in one exec, so a retry is idempotent. tmux allows
    // duplicate names, so separate execs could leave two copies running.
    // The kill tolerates a missing window (hidePane windows exit).
    await runtime.exec(spare.jobName, `${TMUX} kill-window -t yaac:${win.name} 2>/dev/null; ${initWindowCommand(win, paths)}`)
  }
}

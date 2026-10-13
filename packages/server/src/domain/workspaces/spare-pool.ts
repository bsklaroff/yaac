import { workspaceDriver } from '#drivers/driver'
import { resolveProjectConfig, resolveEphemeralModulesPaths } from '#domain/projects'
import { loadToolAuthEntry } from '#domain/auth'
import { getProjectRow } from '#db'
import { shellEscape } from '#lib/shell'
import {
  agentDriver,
  agentWindowName,
  resolveInitWindows,
  verifyAgentWindowAlive,
  initWindowCommand,
  tmuxCmd,
} from '#runtime/agents'
import type { WorkspacePaths } from '#drivers/contract'
import type { CreateSetup } from './create'
import type { AgentTool, YaacConfig } from '@yaac/shared/types'
import type { PiProvider } from '@yaac/shared/tool-providers'

/**
 * Command that respawns a spare's agent window with `agent`, as a fresh
 * conversation under the spare's id, built by the mode's agent driver as a
 * create would.
 */
function respawnAgentExec(
  workspaceId: string,
  agent: CreateSetup,
  piProvider: PiProvider | undefined,
  paths: WorkspacePaths,
): string {
  const windowName = agentWindowName(agent.tool, 0)
  return `${tmuxCmd(paths)} respawn-window -k -t yaac:${windowName} '${agentDriver(agent.mode).launchCmd({
    tool: agent.tool,
    agentSessionId: workspaceId,
    resume: false,
    windowName,
    paths,
    permissionMode: agent.permissionMode,
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
    ...(piProvider !== undefined ? { piProvider } : {}),
  })}'`
}

/** The project owner's stored pi provider for a pi launch; undefined for
 *  other tools. */
async function piProviderFor(projectId: string, tool: AgentTool): Promise<PiProvider | undefined> {
  if (tool !== 'pi') return undefined
  const owner = (await getProjectRow(projectId))?.owner
  return owner === undefined ? undefined : (await loadToolAuthEntry(owner, 'pi'))?.piProvider
}

/**
 * Replace a spare's booted agent with a different tool, model or permission
 * mode (same agent mode). Spares are provisioned for every tool, so this
 * only renames and respawns the agent window and checks it survived; the
 * claim handles the egress registration and `claimSpare`. On a throw the
 * caller must reap the spare. The caller must have awaited
 * `awaitAgentTransport`.
 */
export async function retoolSpare(
  spare: { jobName: string; workspaceId: string; projectId: string; tool: string },
  agent: CreateSetup,
): Promise<void> {
  const { tool } = agent
  const runtime = workspaceDriver()
  const paths = runtime.workspacePaths(spare.jobName)
  const TMUX = tmuxCmd(paths)
  // Idempotent (succeeds if the window already has the new name), so
  // transport retries are safe. A real failure still exits nonzero.
  await runtime.exec(
    spare.jobName,
    `${TMUX} rename-window -t yaac:${spare.tool} ${tool}`
    + ` || ${TMUX} list-windows -t =yaac -F '#{window_name}' | grep -qxF ${tool}`,
  )
  await runtime.exec(
    spare.jobName,
    respawnAgentExec(spare.workspaceId, agent, await piProviderFor(spare.projectId, tool), paths),
  )
  await verifyAgentWindowAlive(spare.jobName, [tool])
}

/**
 * Checkout-relative mount points (ephemeral modules and cache volumes under
 * the checkout). `git clean` must skip them: removing a mount point fails
 * with EBUSY.
 */
function workspaceMountPaths(config: YaacConfig, workspaceDir: string): string[] {
  const prefix = `${workspaceDir}/`
  const underWorkspace = (p: string): string | null =>
    p.startsWith(prefix) ? p.slice(prefix.length) : null
  return [
    ...resolveEphemeralModulesPaths(config),
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
 * retries are safe.
 *
 * `respawn` is the agent to restart on the new checkout (it has no
 * conversation yet, so nothing is lost), or null when a retool follows.
 */
export async function rebranchSpare(
  spare: { jobName: string; workspaceId: string; projectId: string; tool: string },
  branch: string,
  sha: string,
  respawn: CreateSetup | null,
): Promise<void> {
  const config: YaacConfig = await resolveProjectConfig(spare.projectId) ?? {}
  const runtime = workspaceDriver()
  const paths = runtime.workspacePaths(spare.jobName)
  const TMUX = tmuxCmd(paths)
  const wd = paths.workspaceDir
  // Move `agent/<id>` to the SHA and remove untracked files. `clean -fd` not
  // `-x`, which would empty mounted module and cache dirs. reset+clean walks
  // the whole checkout, so allow longer than the default.
  const cleanExcludes = workspaceMountPaths(config, wd)
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
  if (respawn !== null) {
    await runtime.exec(spare.jobName, respawnAgentExec(
      spare.workspaceId, respawn, await piProviderFor(spare.projectId, respawn.tool), paths,
    ))
    await verifyAgentWindowAlive(spare.jobName, [respawn.tool])
  }
}

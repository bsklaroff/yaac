import { workspaceDriver } from '#drivers/driver'
import { resolveProjectConfig, resolveEphemeralModulesPaths } from '#domain/projects'
import { loadToolAuthEntry } from '@yaac/shared/tool-auth'
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
import type { AgentMode, AgentTool, PermissionMode, YaacConfig } from '@yaac/shared/types'
import type { PiProvider } from '@yaac/shared/tool-providers'

/** The agent a spare's window runs, and how it is launched. */
export interface SpareAgent {
  tool: AgentTool
  model?: string
  permissionMode: PermissionMode
  mode: AgentMode
}

/**
 * Command that respawns a spare's agent window with `agent`, as a fresh
 * conversation under the spare's id, built by the mode's agent driver as a
 * create would.
 */
function respawnAgentExec(
  workspaceId: string,
  agent: SpareAgent,
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
    ...(piProvider !== undefined ? { piProvider } : {}),
  })}'`
}

/** The stored pi provider for a pi launch; undefined for other tools. */
async function piProviderFor(tool: AgentTool): Promise<PiProvider | undefined> {
  return tool === 'pi' ? (await loadToolAuthEntry('pi'))?.piProvider : undefined
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
  spare: { jobName: string; workspaceId: string; tool: string },
  agent: SpareAgent,
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
    respawnAgentExec(spare.workspaceId, agent, await piProviderFor(tool), paths),
  )
  await verifyAgentWindowAlive(spare.jobName, [tool])
}

/** Commands that move a spare's checkout to another branch or commit,
 *  built by `buildRebranchPrep` and run by `rebranchSpare`. */
export interface RebranchPrepCommands {
  /** Moves `agent/<id>` to the SHA and removes untracked files. `clean -fd`
   *  not `-x`, which would empty mounted module and cache dirs. */
  resetExec: string
  /** Sets the clone's `origin/<branch>` to the SHA (its origin refs may be
   *  older) and makes it `agent/<id>`'s upstream. */
  upstreamExec: string
  /** Recreate every init window, then respawn the agent if requested
   *  (it has no conversation yet, so nothing is lost). */
  windowExecs: string[]
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

export function buildRebranchPrep(params: {
  branch: string
  /** `origin/<branch>` as fetched into the main clone, whose objects the
   *  checkout borrows. */
  sha: string
  config: YaacConfig
  workspaceId: string
  /** The agent to respawn, or null when a retool follows. */
  respawn: SpareAgent | null
  /** pi only: the provider for the respawn. */
  piProvider?: PiProvider
  paths: WorkspacePaths
}): RebranchPrepCommands {
  const { branch, sha, config, workspaceId, respawn, piProvider, paths } = params
  const TMUX = tmuxCmd(paths)
  const wd = paths.workspaceDir
  const windowExecs: string[] = []
  for (const win of resolveInitWindows(config)) {
    // Kill and recreate in one exec, so a retry is idempotent. tmux allows
    // duplicate names, so separate execs could leave two copies running.
    // The kill tolerates a missing window (hidePane windows exit).
    windowExecs.push(
      `${TMUX} kill-window -t yaac:${win.name} 2>/dev/null; ${initWindowCommand(win, paths)}`,
    )
  }
  if (respawn) windowExecs.push(respawnAgentExec(workspaceId, respawn, piProvider, paths))
  const cleanExcludes = workspaceMountPaths(config, wd)
    .map((p) => ` -e '${shellEscape(p)}'`)
    .join('')
  return {
    resetExec: `sh -c "git -C ${wd} reset --hard ${sha} `
      + `&& git -C ${wd} clean -fd${cleanExcludes}"`,
    upstreamExec: `git -C ${wd} update-ref 'refs/remotes/origin/${shellEscape(branch)}' ${sha}`
      + ` && git -C ${wd} branch --set-upstream-to 'origin/${shellEscape(branch)}'`,
    windowExecs,
  }
}

/**
 * Move a spare's checkout to another branch, or to a newer tip of its own,
 * at claim time. The caller resolves the SHA and checks the branch first; on
 * a throw it must reap the spare. The caller must have awaited
 * `awaitAgentTransport`. Each command is idempotent, so retries are safe.
 */
export async function rebranchSpare(
  spare: { jobName: string; workspaceId: string; projectId: string; tool: string },
  branch: string,
  sha: string,
  respawn: SpareAgent | null,
): Promise<void> {
  const config: YaacConfig = await resolveProjectConfig(spare.projectId) ?? {}
  const prep = buildRebranchPrep({
    branch,
    sha,
    config,
    workspaceId: spare.workspaceId,
    respawn,
    piProvider: respawn !== null ? await piProviderFor(respawn.tool) : undefined,
    paths: workspaceDriver().workspacePaths(spare.jobName),
  })
  // reset+clean walks the whole checkout, so allow longer than the default.
  const runtime = workspaceDriver()
  await runtime.exec(spare.jobName, prep.resetExec, { timeout: 120_000 })
  await runtime.exec(spare.jobName, prep.upstreamExec)
  for (const cmd of prep.windowExecs) await runtime.exec(spare.jobName, cmd)
  if (respawn !== null) await verifyAgentWindowAlive(spare.jobName, [respawn.tool])
}

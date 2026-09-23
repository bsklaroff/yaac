import { worktreeDriver } from '#drivers/driver'
import { projectRemoteUrl, resolveProjectConfig, resolveEphemeralModulesPaths, resolveProjectEnv } from '#domain/projects'
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
import { withUpstreamConfigLock } from './create'
import type { WorkspacePaths } from '#drivers/contract'
import type { AgentMode, AgentTool, PermissionMode, YaacConfig } from '@yaac/shared/types'
import type { PiProvider } from '@yaac/shared/tool-providers'

/** What a spare's agent window runs: which agent, launched how. */
export interface SpareAgent {
  tool: AgentTool
  model?: string
  permissionMode: PermissionMode
  mode: AgentMode
}

/**
 * The exec that replaces a spare's agent window with `agent`, launched fresh
 * under the spare's own id — the one command a spare's agent is ever
 * respawned with, whether a claim retools it or a re-branch restarts it. Built
 * by the mode's own driver, so an `acp` spare respawns acpd on the right
 * adapter exactly as a create would have launched it.
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

/** The stored pi provider, which a pi launch needs to name its key's host;
 *  undefined for every other tool. */
async function piProviderFor(tool: AgentTool): Promise<PiProvider | undefined> {
  return tool === 'pi' ? (await loadToolAuthEntry('pi'))?.piProvider : undefined
}

/**
 * Swap a prewarmed spare's booted agent for the one a claim asked for — a
 * different tool, model or posture, in the mode the spare was warmed in.
 * Spares are provisioned tool-agnostically (mounts, env placeholders, and
 * per-tool config cover every tool), so only three things are keyed to the
 * booted tool: the proxy registration (drives credential injection), the
 * agent tmux window's name, and the process running in it. Re-registers the
 * workspace, then renames + respawns the agent window and verifies the
 * respawned agent survived. What the workspace DECLARES flips later, in the
 * claim's own commit (`claimSpare`). Throws on failure — the caller must
 * treat the spare as tainted (registration, window name, and what it
 * declares may disagree) and reap it.
 *
 * The in-pod commands ride the runtime's transport, so the caller must have
 * gated on `awaitAgentTransport` (the claim path does, before its first
 * mutation).
 */
export async function retoolSpare(
  spare: { jobName: string; workspaceId: string; projectSlug: string; tool: string },
  agent: SpareAgent,
): Promise<void> {
  const { tool } = agent
  const config: YaacConfig = await resolveProjectConfig(spare.projectSlug) ?? {}
  const remoteUrl = await projectRemoteUrl(spare.projectSlug)
  const runtime = worktreeDriver()
  const paths = runtime.workspacePaths(spare.jobName)
  const TMUX = tmuxCmd(paths)
  await runtime.registerWorkspace({
    workspaceId: spare.workspaceId,
    projectSlug: spare.projectSlug,
    tool,
    config,
    remoteUrl,
    proxySecretRules: Object.fromEntries(
      Object.entries((await resolveProjectEnv(spare.projectSlug)).secrets)
        .map(([name, { rule }]) => [name, rule]),
    ),
  })
  // Written to tolerate having already run, so the dial retries stay on:
  // by the time a claim gets here any throw reaps the spare, and a blip on
  // the shared port-forward is far likelier than the rename failing for
  // real. The fallback passes only when the window already carries the new
  // name — a genuine failure still exits nonzero, with tmux's own stderr
  // (deliberately not silenced) explaining it.
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

/** The in-pod commands that re-point a prewarmed spare's worktree at a
 *  different reference branch. Assembled by `buildRebranchPrep` (pure, so
 *  the command set is unit-testable) and executed by `rebranchSpare`. */
export interface RebranchPrepCommands {
  /** Moves `agent/<id>` to the resolved SHA and drops non-ignored strays.
   *  Deliberately `clean -fd`, not `-x`: ephemeral-modules mounts
   *  (node_modules) and cache volumes are live mount points whose contents
   *  a `-x` clean would empty; ignored build artifacts that survive are
   *  regenerated by the respawned init windows. */
  resetExec: string
  /** Rewrites `branch.agent/<id>.merge` in the shared /repo/.git/config —
   *  must run under `withUpstreamConfigLock`. */
  upstreamExec: string
  /** Kill + re-create every init window (they ran against the old
   *  checkout), then respawn the agent window when requested — the spare's
   *  booted agent read the old checkout at startup and holds no
   *  conversation yet, so a respawn loses nothing. */
  windowExecs: string[]
}

/**
 * Workspace-relative paths that are live mount points inside the pod —
 * ephemeral-modules redirects (`/workspace/node_modules` by default), plus
 * any cacheVolumes targeting a path under /workspace. `git clean` must skip
 * them: in a repo that doesn't gitignore them they're untracked directories,
 * and removing a mount point fails (EBUSY), which would taint every
 * re-branch.
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
  /** Resolved `refs/remotes/origin/<branch>` SHA. The reset uses the SHA,
   *  not the ref name: host-fetch writes reach pods through the virtiofs
   *  cache with a possible seconds-stale window for replaced files
   *  (packed-refs), while new object files are new dentries and safe. */
  sha: string
  config: YaacConfig
  worktreeId: string
  /** The agent to respawn — the one the spare already runs — or null when a
   *  retool follows (its own respawn supersedes this one). */
  respawn: SpareAgent | null
  /** pi only — provider for the respawn's `pi --model` (see buildAgentCmd). */
  piProvider?: PiProvider
  /** Where this workspace's things are, in its own world — the commands
   *  below are all addressed inside it. */
  paths: WorkspacePaths
}): RebranchPrepCommands {
  const { branch, sha, config, worktreeId, respawn, piProvider, paths } = params
  const TMUX = tmuxCmd(paths)
  const wd = paths.workspaceDir
  const windowExecs: string[] = []
  for (const win of resolveInitWindows(config)) {
    // Kill and re-create in ONE exec, so re-running the pair is a no-op.
    // Split across two execs it is not: tmux allows duplicate window
    // names, so a `new-window` that ran but whose reply was lost leaves a
    // second window of the same name behind, racing two copies of the init
    // command over one worktree (two concurrent `pnpm install`s), and a
    // later kill-window removes only one of them. Paired, a re-run kills
    // whatever the lost attempt created before making its own. The kill
    // tolerates a missing window — hidePane windows are gone once their
    // command finishes — and `;` keeps its status out of the result.
    windowExecs.push(
      `${TMUX} kill-window -t yaac:${win.name} 2>/dev/null; ${initWindowCommand(win, paths)}`,
    )
  }
  if (respawn) windowExecs.push(respawnAgentExec(worktreeId, respawn, piProvider, paths))
  const cleanExcludes = workspaceMountPaths(config, wd)
    .map((p) => ` -e '${shellEscape(p)}'`)
    .join('')
  return {
    resetExec: `sh -c "git -C ${wd} reset --hard ${sha} `
      + `&& git -C ${wd} clean -fd${cleanExcludes}"`,
    upstreamExec: `git -C ${wd} branch --set-upstream-to 'origin/${shellEscape(branch)}'`,
    windowExecs,
  }
}

/**
 * Re-point a prewarmed spare's baked worktree at a different reference
 * branch at claim time — the branch analogue of `retoolSpare`, so any spare
 * serves any branch. The caller resolves the SHA (host-side, post-fetch) and
 * validates the branch exists BEFORE calling; from the first exec on, a
 * failure means the spare is tainted (worktree, upstream, and windows may
 * disagree) and the caller must reap it.
 *
 * Like `retoolSpare`, the in-pod commands ride the runtime's transport, so
 * the caller must have gated on `awaitAgentTransport` first. Each is written
 * to be a no-op when re-run (see `buildRebranchPrep`), so they keep the
 * default retries.
 */
export async function rebranchSpare(
  spare: { jobName: string; workspaceId: string; projectSlug: string; tool: string },
  branch: string,
  sha: string,
  respawn: SpareAgent | null,
): Promise<void> {
  const config: YaacConfig = await resolveProjectConfig(spare.projectSlug) ?? {}
  const prep = buildRebranchPrep({
    branch,
    sha,
    config,
    worktreeId: spare.workspaceId,
    respawn,
    piProvider: respawn !== null ? await piProviderFor(respawn.tool) : undefined,
    paths: worktreeDriver().workspacePaths(spare.jobName),
  })
  // The reset+clean walks the whole worktree, so it gets a wider deadline
  // than the runtime's 30s default. Only the run phase widens — the
  // transport caps its own dial separately — and a read timeout past that
  // is not retried, so a still-running git can't be raced by a second one
  // over the same index.lock.
  const runtime = worktreeDriver()
  await runtime.exec(spare.jobName, prep.resetExec, { timeout: 120_000 })
  await withUpstreamConfigLock(spare.projectSlug, async () => {
    await runtime.exec(spare.jobName, prep.upstreamExec)
  })
  for (const cmd of prep.windowExecs) await runtime.exec(spare.jobName, cmd)
  if (respawn !== null) await verifyAgentWindowAlive(spare.jobName, [respawn.tool])
}

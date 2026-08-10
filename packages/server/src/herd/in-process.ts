import {
  countProjectWorkspaces,
  countWorkspaces,
  createWorktree,
  findWorkspace,
  listWorkspaces,
  getWorktreeChanges,
  observeWorkspaces,
  stopWorktree,
  teardownForRestart,
  tryClaimPrewarmed,
  purgeProjectBytes,
  worktreeForkFallback,
} from '#features/worktrees'
import { getVclusterStatus } from '#features/cluster'
import { allowWorktreeHost, readBlockedHosts, proxyClient } from '#features/egress'
import { dismissWorktreePort, forwardWorktreePort } from '#features/forwarders'
import {
  attachAcp,
  getAgentSessionFirstMessage,
  sessionTranscriptPath,
  transcriptLastActiveMs,
  typeInitialPrompt,
} from '#features/agents'
import { attachPty, createShellWindow, killWindowTerminal, listWorktreeTerminals } from '#features/terminals'
import { pushImageShared, rebuildProjectImage, retryImageBuild } from '#features/images'
import { dismissImageBuild, getImageBuildLog, listImageBuilds } from '#features/image-engine'
import {
  addEntry,
  deleteBuildFile,
  getProjectBranches,
  listBuildFiles,
  readBuildFile,
  readProjectConfigRaw,
  readProjectDockerfile,
  readGitAuthFailures,
  readUserDockerfile,
  removeEntryChecked,
  removeProjectConfig,
  renameBuildFile,
  replaceEntries,
  resolveProjectBuildDir,
  resolveUserBuildDir,
  seedFakeAuth,
  setProjectReferenceBranch,
  writeBuildFile,
  writeProjectConfig,
  writeProjectDockerfile,
  writeUserDockerfile,
} from '#features/projects'
import { remoteBranchExists } from '#platform/git'
import { repoDir } from '@yaac/shared/project-paths'
import { publishDesiredWorkspaces } from '#herd-desired'
import { serverLog } from '#log'
import { createLifecycle } from './lifecycle'
import { runHerdPass } from './reconcile'
import type { HerdClient } from './contract'

/**
 * The herd that runs inside this process — the ONE module under
 * `packages/server/src` allowed to import the herd's features, which is what
 * the `SERVER_SRC` lint zone in eslint.config.js enforces
 * (docs/plans/layered-server.md).
 *
 * Every method is the thinnest possible translation between the contract's
 * vocabulary and today's functions, and that thinness is load-bearing rather
 * than tidiness: this is the file the RPC client REPLACES, so any behavior
 * left here silently vanishes at the swap. Substrate behavior belongs in a
 * feature, which moves with the herd (`#features/worktrees/locate.ts` is
 * where the resolve/count logic went for exactly this reason); server policy
 * belongs above the boundary (spawn went to `ServerLink.spawnRequested`, the
 * in-flight set to `DesiredWorkspaces`).
 *
 * Two side effects deliberately stay here, because both compose two features
 * in the one direction that would otherwise cycle: an infra image retry kicks
 * the proxy rebuild (`#features/egress` sits above `#features/images`), and a
 * credential write re-syncs the proxy's ssh-agent (`#features/projects` sits
 * below it). Each has to be re-established herd-side at step 17.
 */
export function createInProcessHerd(): HerdClient {
  return {
    lifecycle: createLifecycle(runHerdPass),

    workspaces: {
      create: (projectSlug, opts) => createWorktree(projectSlug, opts),

      claimPrewarmed: ({ projectSlug, tool, gitUser, onProgress, branch, model }) =>
        tryClaimPrewarmed(projectSlug, tool, gitUser, onProgress ?? (() => {}), branch, model),

      stop: (idOrName) => stopWorktree(idOrName),

      teardownForRestart: (target) => teardownForRestart(target),

      observe: (projectFilter) => observeWorkspaces(projectFilter),

      publishDesired: (desired) => Promise.resolve(publishDesiredWorkspaces(desired)),

      find: (idOrName, opts) => findWorkspace(idOrName, opts),

      list: (projectSlug) => listWorkspaces(projectSlug),

      counts: () => countWorkspaces(),

      count: (projectSlug) => countProjectWorkspaces(projectSlug),

      changes: (jobName, base, defaultBase) => getWorktreeChanges(jobName, base, defaultBase),

      worktreeForkFallback: (projectSlug, workspaceId) =>
        worktreeForkFallback(projectSlug, workspaceId),

      vclusterStatus: (workspaceId) => getVclusterStatus(workspaceId),

      blockedHosts: (workspaceId) => readBlockedHosts(workspaceId),
    },

    agents: {
      typeInitialPrompt: (jobName, tool, prompt) => typeInitialPrompt(jobName, tool, prompt),
      firstMessage: (tool, transcriptPath, jobName) =>
        getAgentSessionFirstMessage(tool, transcriptPath, jobName),
      transcriptPath: (projectSlug, workspaceId, tool) =>
        sessionTranscriptPath(projectSlug, workspaceId, tool),
      transcriptLastActiveMs: (path) => transcriptLastActiveMs(path),
      attachAcp: (projectSlug, workspaceId, agentSessionId, socket) =>
        attachAcp(projectSlug, workspaceId, agentSessionId, socket),
    },

    terminals: {
      list: (jobName) => listWorktreeTerminals(jobName),
      createShell: (jobName) => createShellWindow(jobName),
      kill: (jobName, target) => killWindowTerminal(jobName, target),
      attachPty: (jobName, socket, query) => attachPty(jobName, socket, query),
    },

    ports: {
      forward: ({ workspaceId, projectSlug, jobName }, containerPort, opts) =>
        forwardWorktreePort({ worktreeId: workspaceId, projectSlug, jobName }, containerPort, opts),
      dismiss: (workspaceId, containerPort) =>
        Promise.resolve(dismissWorktreePort(workspaceId, containerPort)),
    },

    hosts: {
      allow: ({ workspaceId, projectSlug }, host, opts) =>
        allowWorktreeHost({ worktreeId: workspaceId, projectSlug }, host, opts),
    },

    images: {
      listBuilds: () => Promise.resolve(listImageBuilds()),
      buildLog: (id) => Promise.resolve(getImageBuildLog(id)),
      dismissBuild: (id) => {
        dismissImageBuild(id)
        return Promise.resolve()
      },
      retryBuild: (id) => {
        const outcome = retryImageBuild(id)
        if (outcome.retried && outcome.infra) {
          // An infra build has no owning project to rebuild through, and
          // re-running ensureRunning rebuilds the sidecar image when its tag
          // is missing — which is what a failed build left behind. Detached:
          // the caller gets its 202 either way.
          void proxyClient.ensureRunning().catch((err: unknown) =>
            serverLog(`[image-retry] proxy: ${String(err)}`))
        }
        return Promise.resolve(outcome)
      },
      rebuildProject: (projectSlug, opts) => rebuildProjectImage(projectSlug, opts),
      pushShared: (tag, ctx, opts) => pushImageShared(tag, ctx, opts),
    },

    projects: {
      branches: (slug, opts) => getProjectBranches(slug, opts ?? {}),
      readConfigRaw: (slug) => readProjectConfigRaw(slug),
      writeConfig: (slug, config) => writeProjectConfig(slug, config),
      removeConfig: (slug) => removeProjectConfig(slug),
      setReferenceBranch: (slug, branch) => setProjectReferenceBranch(slug, branch),
      remoteBranchExists: (slug, branch) => remoteBranchExists(repoDir(slug), branch),
      readProjectDockerfile: (slug) => readProjectDockerfile(slug),
      writeProjectDockerfile: (slug, content) => writeProjectDockerfile(slug, content),
      readUserDockerfile: () => readUserDockerfile(),
      writeUserDockerfile: (content) => writeUserDockerfile(content),
      projectBuildDir: (slug) => resolveProjectBuildDir(slug),
      userBuildDir: () => resolveUserBuildDir(),
      listBuildFiles: (root) => listBuildFiles(root),
      readBuildFile: (root, rel) => readBuildFile(root, rel),
      writeBuildFile: (root, rel, data) => writeBuildFile(root, rel, data),
      deleteBuildFile: (root, rel) => deleteBuildFile(root, rel),
      renameBuildFile: (root, from, to) => renameBuildFile(root, from, to),
      gitAuthFailures: (slug) => readGitAuthFailures(slug),
      purge: (slug) => purgeProjectBytes(slug),
    },

    credentials: {
      add: async (entry) => {
        await addEntry(entry)
        // An SSH entry is useless without the proxy's ssh-agent knowing about
        // the key, so sync immediately and a running proxy picks the change
        // up without a restart. Non-fatal: the next ensureRunning() retries.
        // Only for ssh — an https token is read straight off disk.
        if (entry.kind === 'ssh') {
          try {
            await proxyClient.syncSshKeysFromCredentials()
          } catch (err) {
            console.warn(
              '[auth] Saved SSH credential but failed to push to proxy ssh-agent: '
              + (err instanceof Error ? err.message : String(err)),
            )
          }
        }
      },
      removeChecked: async (pattern) => {
        await removeEntryChecked(pattern)
        // Removing any entry may leave a stale identity in the agent.
        // Clear-and-reload its full set.
        await syncSshKeysQuietly()
      },
      replace: async (entries) => {
        await replaceEntries(entries)
        await syncSshKeysQuietly()
      },
      seedFakeAuth: (kind) => seedFakeAuth(kind),
    },
  }
}

/** Reload the proxy ssh-agent's identity set, swallowing a failure: the next
 *  `ensureRunning()` reconciles it. */
async function syncSshKeysQuietly(): Promise<void> {
  try {
    await proxyClient.syncSshKeysFromCredentials()
  } catch {
    // non-fatal — the server retries on next ensureRunning()
  }
}

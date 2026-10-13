import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { projectDir, repoDir, claudeDir } from '@yaac/shared/project-paths'
import { cloneRepo } from '@yaac/server/domain/git'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/install/podman'
import { deleteObjects, k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { installId } from '@yaac/server/drivers/k8s/substrate/install-id'
import { LABEL_WORKSPACE_ID } from '@yaac/server/drivers/k8s/substrate/pods'
import { LABEL_INSTALL_ID } from '@yaac/server/drivers/k8s/substrate/storage-constants'
import { PROXY_APP_NAME, PROXY_PORT } from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import type { ProxyClientConfig } from '@yaac/server/drivers/k8s/egress/proxy-client'
import { registerTestProject, type SpawnedServer } from '@yaac/test-utils/api'
import { startKubectlForward, type KubectlForward } from '@yaac/test-utils/kubectl-forward'
import { kubectl } from '@yaac/test-utils/kubectl'

/*
 * The root test tiers' helpers that reach into the server or the cluster.
 * The server-free ones (scratch dirs, test repos) are in @yaac/test-utils.
 */

const execFileAsync = promisify(execFile)

/**
 * Proxy sidecar config for e2e tests, using the prebuilt test image.
 *
 * The real server reaches the proxy's control API through its Service. These
 * tests run on the host, so `controlOrigin` is a `kubectl port-forward`,
 * started lazily because the proxy Deployment doesn't exist until
 * `ensureRunning` applies it.
 */
export const TEST_PROXY_CONFIG: ProxyClientConfig = {
  image: 'yaac-test-proxy',
  controlOrigin: () => testProxyControlOrigin(),
}

let proxyControlForward: Promise<KubectlForward> | null = null

/** The port-forwarded proxy control origin (see TEST_PROXY_CONFIG). */
async function testProxyControlOrigin(): Promise<string> {
  proxyControlForward ??= startKubectlForward({
    namespace: k8sNamespace(),
    target: `deployment/${PROXY_APP_NAME}`,
    remotePort: PROXY_PORT,
  })
  return (await proxyControlForward).origin
}

/**
 * Run a command inside a workspace Job's pod
 * (`kubectl exec -n <ns> job/<jobName> -- <args>`). No shell quoting needed.
 */
export async function execInJob(
  jobName: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return kubectl(['exec', '-n', k8sNamespace(), `job/${jobName}`, '--', ...args], opts)
}

/**
 * Delete every workspace Job/pod this test's install created (selected by
 * its install id label, since tests in a file share a namespace) and
 * wait, with a bound, for them to go.
 *
 * Waiting here keeps a slow pod teardown from eating into the next file's
 * setup budget, since e2e files run one at a time. The bound keeps a wedged
 * pod from hanging the suite.
 */
export async function cleanupWorkspaceJobs(timeoutMs = 120_000): Promise<void> {
  const selector = `${LABEL_INSTALL_ID}=${installId()},${LABEL_WORKSPACE_ID}`
  try {
    // Delete without waiting, then wait for them all, so terminations
    // overlap. The selector keeps the proxy pod, which has the same
    // install id, out.
    await deleteObjects('batch/v1', 'Job', { namespace: k8sNamespace(), labelSelector: selector })
    await deleteObjects('v1', 'Pod', { namespace: k8sNamespace(), labelSelector: selector })
  } catch {
    return // cluster unreachable — nothing to clean, and nothing to wait for
  }

  // A pod still there at the bound is left; the cluster finishes it.
  await execFileAsync('kubectl', [
    'wait', '--for=delete', 'pods', '-n', k8sNamespace(), '-l', selector,
    `--timeout=${String(Math.ceil(timeoutMs / 1000))}s`,
  ]).catch(() => {})
}

let _podmanAlive = false

/**
 * Throw if podman is not available, so tests fail rather than silently
 * pass. Only success is cached.
 */
export async function requirePodman(): Promise<void> {
  if (_podmanAlive) return
  ensureRootfulPodmanHost()
  try {
    // `podman info` checks the engine is actually reachable.
    await execFileAsync('podman', ['info', '--format', 'json'])
    _podmanAlive = true
  } catch {
    throw new Error('Podman is not available. Start it with: podman machine start')
  }
}

/**
 * Add a local test repo as a project on `server`, named after the repo's
 * directory: clone it into the data dir, then register it, skipping the URL
 * checks `project add` does. Returns the project's id.
 *
 * `remoteUrl` is what the project row records. It defaults to a
 * GitHub-shaped URL for the name, which nothing dials under
 * YAAC_E2E_SKIP_FETCH. `headers` name the caller who owns it
 * (`asTailnet`), the built-in user by default.
 */
export async function addTestProject(
  server: SpawnedServer,
  localRepoPath: string,
  opts: { remoteUrl?: string; headers?: Record<string, string> } = {},
): Promise<string> {
  const name = path.basename(localRepoPath)
  const projectId = crypto.randomUUID()
  await fs.mkdir(projectDir(projectId), { recursive: true })
  await cloneRepo(localRepoPath, repoDir(projectId), null)
  await fs.mkdir(claudeDir(projectId), { recursive: true })
  await registerTestProject(server, projectId, name, opts.remoteUrl ?? `https://github.com/test-org/${name}.git`, opts.headers)
  return projectId
}

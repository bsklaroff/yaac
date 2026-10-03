import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
// Test infrastructure: re-exported below so tests can ASSERT against the
// install root. Not a storage path — tests that write pick a tier helper.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { setDataDir, getDataDir, clientLocalRoot, ensureDataDir, projectDir, repoDir, claudeDir } from '@yaac/shared/project-paths'
import { cloneRepo } from '@yaac/server/domain/git'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/container/runtime'
import { dataDirHash, deleteObjects, k8sNamespace } from '@yaac/server/drivers/k8s/substrate/api'
import { LABEL_DATA_DIR_HASH, LABEL_WORKSPACE_ID } from '@yaac/server/drivers/k8s/substrate/pods'
import type { SpawnedServer } from '#cli'
import { registerTestProject } from '#api'
import { PROXY_APP_NAME, PROXY_PORT } from '@yaac/server/drivers/k8s/substrate/proxy-constants'
import type { ProxyClientConfig } from '@yaac/server/drivers/k8s/egress/proxy-client'
import { startKubectlForward, type KubectlForward } from '#kubectl-forward'
import { e2eMkdtemp, removeScratchTree, testTmpBase } from '#tmp'
import { git } from '#git'
import { kubectl } from '#kubectl'

const execFileAsync = promisify(execFile)

/**
 * Prefix for all container images built during e2e tests, keeping them
 * apart from the application's images.
 */
export const TEST_IMAGE_PREFIX = 'yaac-test'

/**
 * `key=value` label on every podman container a suite starts on the host
 * engine, naming this rig's scratch base (`testTmpBase()`). The global
 * setup's leaked-container sweep selects on it, so rigs sharing an engine
 * don't sweep each other's containers. Each rig needs its own
 * `YAAC_DATA_DIR` for this to hold.
 */
export function testContainerOwnerLabel(): string {
  return `yaac.test.owner=${testTmpBase()}`
}

/**
 * Unique suffix per test file (vitest re-imports this module in each file's
 * process), avoiding k8s name collisions between files and runs.
 */
const TEST_RUN_ID = crypto.randomBytes(4).toString('hex')

/**
 * Per-file k8s namespace holding every object a test file creates. Tests
 * within a file share it and are kept apart by the data-dir-hash label
 * (see cleanupWorkspaceJobs). test/global-setup.ts sweeps leaked ones.
 */
export const TEST_NAMESPACE = `yaac-test-${TEST_RUN_ID}`


/**
 * Point this process's k8s helpers at the test namespace, the one a server
 * spawned with `createYaacTestEnv().env` uses. Returns a restore function.
 */
export function useTestNamespace(): () => void {
  const prev = process.env.YAAC_K8S_NAMESPACE
  process.env.YAAC_K8S_NAMESPACE = TEST_NAMESPACE
  return () => {
    if (prev === undefined) delete process.env.YAAC_K8S_NAMESPACE
    else process.env.YAAC_K8S_NAMESPACE = prev
  }
}

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
 * Delete every workspace Job/pod this test's data dir created (selected by
 * the data-dir-hash label, since tests in a file share a namespace) and
 * wait, with a bound, for them to go.
 *
 * Waiting here keeps a slow pod teardown from eating into the next file's
 * setup budget, since e2e files run one at a time. The bound keeps a wedged
 * pod from hanging the suite.
 */
export async function cleanupWorkspaceJobs(timeoutMs = 120_000): Promise<void> {
  const selector = `${LABEL_DATA_DIR_HASH}=${dataDirHash()},${LABEL_WORKSPACE_ID}`
  try {
    // Delete without waiting, then wait for them all, so terminations
    // overlap. The selector keeps the proxy pod, which has the same
    // data-dir-hash, out.
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

/**
 * Create a temp data dir under testTmpBase() and make it the yaac data dir.
 * Returns the path for cleanup.
 */
export async function createTempDataDir(): Promise<string> {
  const dir = await e2eMkdtemp('yaac-test-')
  setDataDir(dir)
  await ensureDataDir()
  // The client-local root sits beside the data dir, so mkdtemp doesn't
  // create it.
  await fs.mkdir(clientLocalRoot(), { recursive: true })
  return dir
}

/**
 * Remove a temp data dir and the client-local root beside it.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  const stuck = [...await removeScratchTree(dir), ...await removeScratchTree(`${dir}-client`)]
  if (stuck.length > 0) {
    console.warn(
      `[yaac-test] left ${stuck.length} root-owned path(s) behind under ${dir}; `
      + `clearing them needs root:\n  ${stuck.join('\n  ')}`,
    )
  }
}

/** Create a local git repo with a single commit. */
export async function createTestRepo(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await git(dir, ['init'])
  await git(dir, ['config', 'user.email', 'test@test.com'])
  await git(dir, ['config', 'user.name', 'Test'])

  await fs.writeFile(path.join(dir, 'README.md'), '# Test repo\n')

  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'initial commit'])

  return dir
}

/**
 * Whether podman is available, via `podman info` (which checks the engine
 * is actually reachable).
 */
export async function podmanAvailable(): Promise<boolean> {
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
    return true
  } catch {
    return false
  }
}

let _podmanAlive = false

/**
 * Throw if podman is not available, so tests fail rather than silently
 * pass. Only success is cached.
 */
export async function requirePodman(): Promise<void> {
  if (_podmanAlive) return
  ensureRootfulPodmanHost()
  if (await podmanAvailable()) { _podmanAlive = true; return }
  throw new Error('Podman is not available. Start it with: podman machine start')
}

/**
 * Whether a k8s cluster is reachable (`kubectl version` with a short
 * timeout).
 */
export async function clusterAvailable(): Promise<boolean> {
  try {
    await execFileAsync('kubectl', ['version', '--output', 'json'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

let _clusterAlive = false

/**
 * Throw if no k8s cluster is reachable, so tests fail with a clear message
 * instead of timing out in their first cluster call.
 */
export async function requireCluster(): Promise<void> {
  if (_clusterAlive) return
  if (await clusterAvailable()) { _clusterAlive = true; return }
  throw new Error(
    'Kubernetes cluster is not reachable. yaac e2e tests need kubectl '
    + 'pointed at a local cluster — run "yaac cluster check" for setup '
    + 'instructions.',
  )
}

/**
 * Add a local test repo as a project on `server`: clone it into the data
 * dir, then register it, skipping the URL checks `project add` does.
 *
 * `remoteUrl` is what the project row records. It defaults to a
 * GitHub-shaped URL for the slug, which nothing dials under
 * YAAC_E2E_SKIP_FETCH.
 */
export async function addTestProject(
  server: SpawnedServer,
  localRepoPath: string,
  opts: { remoteUrl?: string } = {},
): Promise<void> {
  const slug = path.basename(localRepoPath)
  await fs.mkdir(projectDir(slug), { recursive: true })
  await cloneRepo(localRepoPath, repoDir(slug), null)
  await fs.mkdir(claudeDir(slug), { recursive: true })
  await registerTestProject(server, slug, opts.remoteUrl ?? `https://github.com/test-org/${slug}.git`)
}

/** The current yaac data dir (for assertions). */
export { getDataDir }

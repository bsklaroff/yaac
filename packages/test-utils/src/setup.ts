import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import simpleGit from 'simple-git'
// Test infrastructure: re-exported below so tests can ASSERT against the
// install root. Not a storage path — tests that write pick a tier helper.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { setDataDir, getDataDir, projectDir, repoDir, claudeDir } from '@yaac/shared/project-paths'
import { cloneRepo } from '@yaac/server/domain/git'
import { ensureRootfulPodmanHost } from '@yaac/server/drivers/k8s/container/runtime'
import {
  dataDirHash,
  k8sNamespace,
  kubectlWithRetry,
  type KubectlExecOptions,
} from '@yaac/server/drivers/k8s/substrate/kubectl'
import { LABEL_DATA_DIR_HASH, LABEL_WORKTREE_ID } from '@yaac/server/drivers/k8s/substrate/pods'
import type { ProjectMeta } from '@yaac/shared/types'
import type { ProxyClientConfig } from '@yaac/server/drivers/k8s/egress/proxy-client'
import { e2eMkdtemp, removeScratchTree } from '#tmp'

const execFileAsync = promisify(execFile)

/**
 * Prefix used for all container images built during e2e tests.
 * Keeps test images separate from images used by the running application.
 */
export const TEST_IMAGE_PREFIX = 'yaac-test'

/**
 * Unique suffix per test FILE: vitest isolates each file in its own forked
 * process, so this module is re-imported (and these bytes redrawn) per
 * file. Avoids kubernetes object name collisions between files and
 * between concurrent test runs.
 */
export const TEST_RUN_ID = crypto.randomBytes(4).toString('hex')

/**
 * Per-file kubernetes namespace (see TEST_RUN_ID for granularity). Every
 * yaac object a test file creates (worktree Jobs, the proxy
 * Deployment/Service, mock-remote pods) lands in this namespace, isolating
 * it from other files and from a real server's `yaac` namespace. Tests
 * WITHIN a file share it — their isolation comes from per-test data dirs
 * plus the data-dir-hash label (see cleanupWorktreeJobs). Leaked namespaces
 * are swept by test/global-setup.ts teardown.
 */
export const TEST_NAMESPACE = `yaac-test-${TEST_RUN_ID}`


/**
 * Point the current test process at the per-run test namespace, so that
 * src helpers (listWorktreePods, containerExec, ProxyClient, ...) target
 * the same namespace a server spawned with `createYaacTestEnv().env`
 * uses. Returns a restore function.
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
 * Proxy sidecar config for e2e tests. Uses the pre-built test image;
 * namespace isolation comes from `YAAC_K8S_NAMESPACE` (see
 * `TEST_NAMESPACE` / `useTestNamespace`), not from the config.
 */
export const TEST_PROXY_CONFIG: ProxyClientConfig = {
  image: 'yaac-test-proxy',
}

/**
 * Run a command inside a worktree Job's pod:
 * `kubectl exec -n <ns> job/<jobName> -- <args>`. The k8s replacement for
 * the podman-era `podmanRetry(['exec', <container>, ...])` test helper.
 * argv is passed straight through execFile, so no shell quoting is needed.
 */
export async function execInJob(
  jobName: string,
  args: string[],
  opts: KubectlExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return kubectlWithRetry(
    ['exec', '-n', k8sNamespace(), `job/${jobName}`, '--', ...args],
    opts,
  )
}

/**
 * Delete every worktree Job/pod this test's data dir created in the active
 * namespace, and wait for them to actually go away. The data-dir-hash
 * scoping matters within a file: sequential tests share TEST_NAMESPACE, so
 * the label keeps them out of each other's queries (listWorktreePods, the
 * server's stale-worktree reconciler) and out of this delete. The k8s analog
 * of the podman-era `podman rm -f $(podman ps -a --filter
 * label=yaac.data-dir=<dir>)`.
 *
 * The wait is the point. e2e files run one at a time, so returning while
 * pods are still terminating just moves the teardown cost onto the next
 * file's setup — and a worktree pod is not cheap to stop (a gVisor sandbox
 * running podman-in-pod). That is how a file that takes ~80s on its own
 * takes >300s straight after a worktree-heavy one and blows a hook budget
 * that is plenty when it runs alone. Paying the drain here, where nothing
 * is racing a timeout, turns a variable cost into a fixed one.
 *
 * Bounded rather than unbounded: a wedged pod (a stuck finalizer, a node
 * that stopped reaping) must not hang the whole suite, and by the time the
 * budget is gone the next file's own namespace scoping is the backstop.
 */
export async function cleanupWorktreeJobs(timeoutMs = 120_000): Promise<void> {
  const selector = `${LABEL_DATA_DIR_HASH}=${dataDirHash()},${LABEL_WORKTREE_ID}`
  try {
    // Issue the deletes without waiting, then poll: `kubectl delete --wait`
    // blocks per object, so a file with several worktrees would serialize
    // their terminations instead of overlapping them.
    await kubectlWithRetry([
      'delete', 'jobs,pods',
      '-n', k8sNamespace(),
      // The worktree-id term keeps this scoped to worktree Jobs/pods: the
      // test server's proxy pod carries the same data-dir-hash (install
      // identity) but is Deployment-managed, not ours to sweep.
      '-l', selector,
      '--ignore-not-found', '--wait=false',
    ])
  } catch {
    return // cluster unreachable — nothing to clean, and nothing to wait for
  }

  const deadline = Date.now() + timeoutMs
  for (;;) {
    let remaining: number
    try {
      const { stdout } = await kubectlWithRetry([
        'get', 'pods', '-n', k8sNamespace(), '-l', selector,
        '-o', 'name',
      ])
      remaining = stdout.split('\n').filter((line) => line.trim().length > 0).length
    } catch {
      return // cluster went away mid-drain; the pods are not our problem now
    }
    if (remaining === 0) return
    if (Date.now() > deadline) return
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

/**
 * Creates a temporary data dir and sets it as the yaac data dir.
 * Returns the path for cleanup.
 *
 * NOTE: lives under testTmpBase(), which is the OS tmpdir for a hermetic
 * unit run and `<ambient data dir>/e2e-tmp` for api/e2e. Worktree pods
 * hostPath-mount paths under the data dir, so the api/e2e base has to be
 * node-visible — that is why it hangs off the data dir, whose visibility
 * `yaac cluster check` proves on every setup.
 */
export async function createTempDataDir(): Promise<string> {
  const dir = await e2eMkdtemp('yaac-test-')
  await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
  setDataDir(dir)
  return dir
}

/**
 * Removes a temp data dir.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  const stuck = await removeScratchTree(dir)
  if (stuck.length > 0) {
    console.warn(
      `[yaac-test] left ${stuck.length} root-owned path(s) behind under ${dir}; `
      + `clearing them needs root:\n  ${stuck.join('\n  ')}`,
    )
  }
}

/**
 * Creates a local git repo with a single commit for testing.
 */
export async function createTestRepo(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const git = simpleGit(dir)
  await git.init()
  await git.addConfig('user.email', 'test@test.com')
  await git.addConfig('user.name', 'Test')

  await fs.writeFile(path.join(dir, 'README.md'), '# Test repo\n')

  await git.add('.')
  await git.commit('initial commit')

  return dir
}

/**
 * Check if podman (the image build engine) is available and running.
 * Uses `podman info` on all platforms to verify the server is actually
 * reachable (not just that a machine is listed as running).
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
 * Throws if podman is not available. Use in beforeAll/test bodies
 * so tests fail loudly instead of silently passing.
 *
 * Only a prior success is cached — failures always re-probe. No revive:
 * every engine yaac talks to is managed elsewhere (macOS machine, host
 * systemd socket, or the worktree-create-started in-pod engine).
 */
export async function requirePodman(): Promise<void> {
  if (_podmanAlive) return
  ensureRootfulPodmanHost()
  if (await podmanAvailable()) { _podmanAlive = true; return }
  throw new Error('Podman is not available. Start it with: podman machine start')
}

/**
 * Check if a kubernetes cluster (the worktree runtime) is reachable —
 * `kubectl version` round-trips to the API server with a short timeout.
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
 * Throws if no kubernetes cluster is reachable. Use in beforeAll of every
 * e2e test that creates worktrees or proxies so they fail with a pointed
 * message instead of timing out deep inside kubectl retries.
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
 * Add a local test repo as a yaac project, bypassing URL validation and
 * token resolution (which only apply to real GitHub URLs).
 */
export async function addTestProject(localRepoPath: string): Promise<void> {
  const slug = path.basename(localRepoPath)
  const dir = projectDir(slug)
  await fs.mkdir(dir, { recursive: true })
  await cloneRepo(localRepoPath, repoDir(slug), null)
  await fs.mkdir(claudeDir(slug), { recursive: true })

  const meta: ProjectMeta = {
    slug,
    remoteUrl: localRepoPath,
    addedAt: new Date().toISOString(),
  }
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(meta, null, 2) + '\n')
}

/**
 * Get the current yaac data dir (for assertions).
 */
export { getDataDir }

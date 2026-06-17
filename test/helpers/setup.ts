import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import simpleGit from 'simple-git'
import { setDataDir, getDataDir, projectDir, repoDir, claudeDir } from '@/lib/project/paths'
import { cloneRepo } from '@/lib/git'
import { ensurePodmanSocket, getSocketPath } from '@/lib/container/runtime'
import {
  dataDirHash,
  k8sNamespace,
  kubectlWithRetry,
  type KubectlExecOptions,
} from '@/lib/k8s/kubectl'
import { LABEL_DATA_DIR_HASH } from '@/lib/k8s/pods'
import type { ProjectMeta } from '@/shared/types'
import type { ProxyClientConfig } from '@/lib/container/proxy-client'
import { e2eMkdtemp } from '@test/helpers/tmp'

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
 * yaac object a test file creates (session Jobs, the proxy
 * Deployment/Service, mock-remote pods) lands in this namespace, isolating
 * it from other files and from a real daemon's `yaac` namespace. Tests
 * WITHIN a file share it — their isolation comes from per-test data dirs
 * plus the data-dir-hash label (see cleanupSessionJobs). Leaked namespaces
 * are swept by test/global-setup.ts teardown.
 */
export const TEST_NAMESPACE = `yaac-test-${TEST_RUN_ID}`

/**
 * True when the e2e suite runs inside a nested yaac session. Several
 * capabilities simply don't exist in a vcluster-backed inner session and
 * cannot be exercised from in here, so the tests that depend on them are
 * `skipIf`'d on this flag:
 *  - the inner Cilium transparent-egress redirect (enforced host-side for a
 *    nested session — `yaac cluster check` reports `egress: skipped`);
 *  - vcluster-in-vcluster (`createSession` refuses it outright);
 *  - the podman `kind` network and `system service` lifecycle (the inner
 *    podman has neither).
 */
export const IS_NESTED_YAAC = process.env.YAAC_NESTED === '1'

/**
 * Point the current test process at the per-run test namespace, so that
 * src helpers (listSessionPods, containerExec, ProxyClient, ...) target
 * the same namespace a daemon spawned with `createYaacTestEnv().env`
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
  requirePrebuilt: true,
}

/**
 * Run a command inside a session Job's pod:
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
 * Remove a session Job (and its pod) by name, swallowing errors if it's
 * already gone or the cluster is unreachable.
 */
export async function removeSessionJob(jobName: string): Promise<void> {
  try {
    await kubectlWithRetry([
      'delete', 'job', jobName,
      '-n', k8sNamespace(),
      '--ignore-not-found', '--wait=false',
    ])
  } catch {
    // already gone / cluster unreachable — best-effort cleanup
  }
}

/**
 * Delete every session Job/pod this test's data dir created in the active
 * namespace. The data-dir-hash scoping matters within a file: sequential
 * tests share TEST_NAMESPACE, and `--wait=false` means a prior test's
 * pods may still be terminating when the next test starts — the label
 * keeps them out of each other's queries (listSessionPods, the daemon's
 * stale-session reconciler) and out of this delete. The k8s analog of the
 * podman-era `podman rm -f $(podman ps -a --filter
 * label=yaac.data-dir=<dir>)`.
 */
export async function cleanupSessionJobs(): Promise<void> {
  try {
    await kubectlWithRetry([
      'delete', 'jobs,pods',
      '-n', k8sNamespace(),
      '-l', `${LABEL_DATA_DIR_HASH}=${dataDirHash()}`,
      '--ignore-not-found', '--wait=false',
    ])
  } catch {
    // cluster unreachable — nothing to clean
  }
}

/**
 * Creates a temporary data dir and sets it as the yaac data dir.
 * Returns the path for cleanup.
 *
 * NOTE: lives under e2eTmpBase() (os.tmpdir() on a host, the node-shared
 * data dir inside a nested yaac). Session pods hostPath-mount paths under
 * the data dir, so e2e runs against kind need the node to see the host's
 * temp dir (set TMPDIR to a home-dir path or add a kind extraMounts entry
 * for it). `yaac cluster check` verifies the data-dir mount wiring.
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
  await fs.rm(dir, { recursive: true, force: true })
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
 * Remove all yaac test containers left behind in the podman store (the
 * build engine). Session workloads run as kubernetes Jobs now, but
 * interrupted older runs / stray build helpers may still leave podman
 * containers carrying the test label.
 */
export async function cleanupContainers(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('podman', [
      'ps', '-a', '--filter', 'label=yaac.test=true',
      '--format', '{{.ID}}',
    ])
    const ids = stdout.trim().split('\n').filter(Boolean)
    if (ids.length > 0) {
      await execFileAsync('podman', ['rm', '-f', ...ids])
    }
  } catch {
    // podman not available or no containers
  }
}

/**
 * Check if podman (the image build engine) is available and running.
 * Uses `podman info` on all platforms to verify the daemon is actually
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
 * Only a prior success is cached — failures always re-probe and try to
 * revive a dead `podman system service` before giving up. This prevents
 * one flaky test that takes out the shared socket from cascading to
 * every later test in the same worker.
 */
export async function requirePodman(): Promise<void> {
  if (_podmanAlive) return
  if (await podmanAvailable()) { _podmanAlive = true; return }
  const socketPath = getSocketPath()
  if (socketPath) {
    try {
      await ensurePodmanSocket(socketPath, { timeoutMs: 5_000 })
    } catch { /* fall through to the second probe */ }
    if (await podmanAvailable()) { _podmanAlive = true; return }
  }
  throw new Error('Podman is not available. Start it with: podman machine start')
}

/**
 * Check if a kubernetes cluster (the session runtime) is reachable —
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
 * e2e test that creates sessions or proxies so they fail with a pointed
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

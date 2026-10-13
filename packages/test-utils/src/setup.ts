import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
// Test infrastructure: re-exported below so tests can ASSERT against the
// install root. Not a storage path — tests that write pick a tier helper.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { setDataDir, getDataDir, clientLocalRoot, ensureDataDir } from '@yaac/shared/project-paths'
import { e2eMkdtemp, removeScratchTree, testTmpBase } from '#tmp'
import { git } from '#git'

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
 * within a file share it and are kept apart by their install ids (see
 * cleanupWorkspaceJobs). test/global-setup.ts sweeps leaked ones.
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

let _clusterAlive = false

/**
 * Throw if no k8s cluster is reachable, so tests fail with a clear message
 * instead of timing out in their first cluster call.
 */
export async function requireCluster(): Promise<void> {
  if (_clusterAlive) return
  try {
    await execFileAsync('kubectl', ['version', '--output', 'json'], { timeout: 10_000 })
    _clusterAlive = true
    return
  } catch { /* reported below */ }
  throw new Error(
    'Kubernetes cluster is not reachable. yaac e2e tests need kubectl '
    + 'pointed at a local cluster — run "yaac cluster check" for setup '
    + 'instructions.',
  )
}

/** The current yaac data dir (for assertions). */
export { getDataDir }

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import simpleGit from 'simple-git'
import { setDataDir, getDataDir, projectDir, repoDir, claudeDir } from '@/lib/paths'
import { cloneRepo } from '@/lib/git'
import type { ProjectMeta } from '@/types'
import type { ProxyClientConfig } from '@/lib/proxy-client'

const execFileAsync = promisify(execFile)

/**
 * Prefix used for all container images built during e2e tests.
 * Keeps test images separate from images used by the running application.
 */
export const TEST_IMAGE_PREFIX = 'yaac-test'

/**
 * Unique suffix per test worker to avoid container/network name collisions
 * when multiple test runs execute concurrently.
 */
export const TEST_RUN_ID = crypto.randomBytes(4).toString('hex')

/**
 * Proxy sidecar config for e2e tests.
 * Uses separate container/image/network/port to avoid interfering with the app's proxy.
 * Container and network names include a random suffix so concurrent runs don't collide.
 */
export const TEST_PROXY_CONFIG: Omit<ProxyClientConfig, 'authSecret'> = {
  image: 'yaac-test-proxy',
  containerName: `yaac-test-proxy-${TEST_RUN_ID}`,
  hostPort: '19256',
  network: `yaac-test-sessions-${TEST_RUN_ID}`,
  requirePrebuilt: true,
}

/**
 * Creates a temporary data dir and sets it as the yaac data dir.
 * Returns the path for cleanup.
 */
export async function createTempDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-test-'))
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
 * Optionally includes yaac-config.json and Dockerfile.yaac.
 */
export async function createTestRepo(
  dir: string,
  options?: {
    yaacConfig?: Record<string, unknown>
    dockerfileDev?: string
  },
): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const git = simpleGit(dir)
  await git.init()
  await git.addConfig('user.email', 'test@test.com')
  await git.addConfig('user.name', 'Test')

  await fs.writeFile(path.join(dir, 'README.md'), '# Test repo\n')

  if (options?.yaacConfig) {
    await fs.writeFile(
      path.join(dir, 'yaac-config.json'),
      JSON.stringify(options.yaacConfig, null, 2) + '\n',
    )
  }

  if (options?.dockerfileDev) {
    await fs.writeFile(path.join(dir, 'Dockerfile.yaac'), options.dockerfileDev)
  }

  await git.add('.')
  await git.commit('initial commit')

  return dir
}

/**
 * Remove all yaac test containers.
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
 * Remove the yaac test network.
 */
export async function cleanupNetwork(networkName = 'yaac-test-sessions'): Promise<void> {
  try {
    await execFileAsync('podman', ['network', 'rm', networkName])
  } catch {
    // doesn't exist
  }
}

/**
 * Check if podman is available and running.
 * Uses `podman info` on all platforms to verify the daemon is actually reachable
 * (not just that a machine is listed as running).
 */
export async function podmanAvailable(): Promise<boolean> {
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
    return true
  } catch {
    return false
  }
}

let _podmanChecked: boolean | undefined

/**
 * Throws if podman is not available. Use in beforeAll/test bodies
 * so tests fail loudly instead of silently passing.
 * Result is cached for the lifetime of the worker.
 */
export async function requirePodman(): Promise<void> {
  if (_podmanChecked === undefined) {
    _podmanChecked = await podmanAvailable()
  }
  if (!_podmanChecked) {
    throw new Error('Podman is not available. Start it with: podman machine start')
  }
}

/**
 * Add a local test repo as a yaac project, bypassing URL validation and
 * token resolution (which only apply to real GitHub URLs).
 */
export async function addTestProject(localRepoPath: string): Promise<void> {
  const slug = path.basename(localRepoPath)
  const dir = projectDir(slug)
  await fs.mkdir(dir, { recursive: true })
  await cloneRepo(localRepoPath, repoDir(slug))
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

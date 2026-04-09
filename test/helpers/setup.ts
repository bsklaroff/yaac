import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import simpleGit from 'simple-git'
import { setDataDir, getDataDir } from '@/lib/paths'

const execFileAsync = promisify(execFile)

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
 * Optionally includes yaac-config.json, Dockerfile.yaac, and yaac-setup.sh.
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
 */
export async function podmanAvailable(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('podman', ['machine', 'list', '--format', 'json'])
      const machines = JSON.parse(stdout) as Array<{ Running: boolean }>
      return machines.some((m) => m.Running)
    } else {
      await execFileAsync('podman', ['info', '--format', 'json'])
      return true
    }
  } catch {
    return false
  }
}

/**
 * Get the current yaac data dir (for assertions).
 */
export { getDataDir }

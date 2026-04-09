import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCKERFILES_DIR = path.resolve(__dirname, '..', 'dockerfiles')

/**
 * Pre-build the yaac-test-base image before test workers start so that
 * parallel e2e tests don't all try to build it simultaneously.
 */
export async function setup(): Promise<void> {
  // Skip when podman is unavailable — tests that need it will fail on their own
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
  } catch {
    return
  }

  const baseName = 'yaac-test-base'
  const dockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const content = await fs.readFile(dockerfile, 'utf8')
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)

  // Check if the image already exists with the correct content hash
  try {
    const { stdout } = await execFileAsync('podman', [
      'image', 'inspect', '--format',
      '{{index .Config.Labels "yaac.content-hash"}}', baseName,
    ])
    if (stdout.trim() === hash) {
      // Image is current — freeze the hash so workers fail fast if the
      // Dockerfile changes mid-run instead of triggering a rebuild.
      process.env.YAAC_FROZEN_BASE_HASH = `${baseName}:${hash}`
      return
    }
  } catch {
    // image doesn't exist yet
  }

  console.log('Pre-building yaac-test-base image for test suite...')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('podman', [
      'build', '-t', baseName,
      '-f', dockerfile,
      '--label', `yaac.content-hash=${hash}`,
      DOCKERFILES_DIR,
    ], { stdio: 'inherit', timeout: 600_000 })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`podman build exited with code ${code}`))
    })
    child.on('error', reject)
  })

  // Also pre-build the nestable layer for nested-container tests
  const nestName = 'yaac-test-base-nestable'
  const nestDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
  const nestContent = await fs.readFile(nestDockerfile, 'utf8')
  const nestHash = crypto.createHash('sha256').update(nestContent).digest('hex').slice(0, 16)

  let nestNeedsBuild = true
  try {
    const { stdout } = await execFileAsync('podman', [
      'image', 'inspect', '--format',
      '{{index .Config.Labels "yaac.content-hash"}}', nestName,
    ])
    if (stdout.trim() === nestHash) nestNeedsBuild = false
  } catch {
    // image doesn't exist
  }

  if (nestNeedsBuild) {
    console.log('Pre-building yaac-test-base-nestable image for test suite...')
    await new Promise<void>((resolve, reject) => {
      const child = spawn('podman', [
        'build', '-t', nestName,
        '-f', nestDockerfile,
        '--build-arg', `BASE_IMAGE=${baseName}`,
        '--label', `yaac.content-hash=${nestHash}`,
        DOCKERFILES_DIR,
      ], { stdio: 'inherit', timeout: 600_000 })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`podman build exited with code ${code}`))
      })
      child.on('error', reject)
    })
  }

  // Freeze the hash so workers fail fast if the Dockerfile changes mid-run
  process.env.YAAC_FROZEN_BASE_HASH = `${baseName}:${hash}`
}

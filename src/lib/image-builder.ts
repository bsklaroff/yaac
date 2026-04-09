import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DOCKERFILES_DIR, getDataDir, configOverrideDir } from '@/lib/paths'

const execFileAsync = promisify(execFile)

export async function fileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8')
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

async function imageExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('podman', ['image', 'inspect', name])
    return true
  } catch {
    return false
  }
}

async function getImageLabel(name: string, label: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('podman', [
      'image', 'inspect', '--format', `{{index .Config.Labels "${label}"}}`, name,
    ])
    const val = stdout.trim()
    return val && val !== '<no value>' ? val : null
  } catch {
    return null
  }
}

async function buildImage(imageName: string, dockerfile: string, context: string, hash: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('podman', [
      'build',
      '-t', imageName,
      '-f', dockerfile,
      '--label', `yaac.content-hash=${hash}`,
      context,
    ], { stdio: 'inherit', timeout: 600_000 })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`podman build exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

async function tagImage(source: string, target: string): Promise<void> {
  await execFileAsync('podman', ['tag', source, target])
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Ensures the full image chain is built for a project.
 *
 * Layer 1: yaac-base (from Dockerfile.default, or replaced by ~/.yaac/Dockerfile.yaac)
 * Layer 2: yaac-user-<slug> (optional: from ~/.yaac/Dockerfile.user, builds on top)
 *
 * Returns the final image name to use for containers.
 *
 * @param imagePrefix - Override for image name prefix. Used by tests to
 *   build isolated images that don't interfere with the running application.
 * @param requirePrebuilt - When true, throw instead of building if the base
 *   image is missing or stale. Used by e2e tests so parallel workers fail
 *   fast instead of racing to build the same image.
 */
export async function ensureImage(projectSlug: string, imagePrefix?: string, requirePrebuilt = false): Promise<string> {
  const prefix = imagePrefix ?? 'yaac'
  const baseName = `${prefix}-base`

  // Layer 1: <prefix>-base (config-override/Dockerfile.yaac > Dockerfile.default)
  const overrideDockerfile = path.join(configOverrideDir(projectSlug), 'Dockerfile.yaac')
  const yaacDockerfile = await fileExists(overrideDockerfile) ? overrideDockerfile : null
  const baseDockerfile = yaacDockerfile ?? path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const baseContext = yaacDockerfile ? path.dirname(yaacDockerfile) : DOCKERFILES_DIR
  const baseHash = await fileHash(baseDockerfile)
  const existingBaseHash = await getImageLabel(baseName, 'yaac.content-hash')
  if (!await imageExists(baseName) || existingBaseHash !== baseHash) {
    if (requirePrebuilt) {
      throw new Error(
        `Base image ${baseName} is missing or stale. ` +
        'Restart the test run so the global setup can rebuild it.',
      )
    }
    console.log(yaacDockerfile
      ? `Building ${baseName} image from Dockerfile.yaac...`
      : `Building ${baseName} image...`)
    await buildImage(baseName, baseDockerfile, baseContext, baseHash)
  }

  // Layer 2: <prefix>-user (optional Dockerfile.user in ~/.yaac)
  // Tag current image so Dockerfile.user can use a stable FROM reference
  const currentTag = `${prefix}-current`
  await tagImage(baseName, currentTag)
  const userDockerfile = path.join(getDataDir(), 'Dockerfile.user')
  const finalImageName = `${prefix}-user-${projectSlug}`

  if (await fileExists(userDockerfile)) {
    const userHash = await fileHash(userDockerfile)
    const existingUserHash = await getImageLabel(finalImageName, 'yaac.content-hash')
    if (!await imageExists(finalImageName) || existingUserHash !== userHash) {
      console.log(`Building ${prefix}-user image...`)
      await buildImage(finalImageName, userDockerfile, getDataDir(), userHash)
    }
  } else {
    await tagImage(baseName, finalImageName)
  }

  return finalImageName
}

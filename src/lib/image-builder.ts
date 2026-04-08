import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DOCKERFILES_DIR, getDataDir, repoDir } from '@/lib/paths'

const execFileAsync = promisify(execFile)

async function fileHash(filePath: string): Promise<string> {
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

/**
 * Ensures the full image chain is built for a project: base → user → project.
 * Returns the final image name to use for containers.
 */
export async function ensureImage(projectSlug: string): Promise<string> {
  // Layer 1: yaac-base
  const baseDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.base')
  const baseHash = await fileHash(baseDockerfile)
  const existingBaseHash = await getImageLabel('yaac-base', 'yaac.content-hash')
  if (!await imageExists('yaac-base') || existingBaseHash !== baseHash) {
    console.log('Building yaac-base image...')
    await buildImage('yaac-base', baseDockerfile, DOCKERFILES_DIR, baseHash)
  }

  // Layer 2: yaac-user (optional Dockerfile.user in ~/.yaac)
  const userDockerfile = path.join(getDataDir(), 'Dockerfile.user')
  let userExists = false
  try {
    await fs.access(userDockerfile)
    userExists = true
  } catch {
    // no user dockerfile
  }

  if (userExists) {
    const userHash = await fileHash(userDockerfile)
    const existingUserHash = await getImageLabel('yaac-user', 'yaac.content-hash')
    if (!await imageExists('yaac-user') || existingUserHash !== userHash) {
      console.log('Building yaac-user image...')
      await buildImage('yaac-user', userDockerfile, getDataDir(), userHash)
    }
  } else {
    await tagImage('yaac-base', 'yaac-user')
  }

  // Layer 3: yaac-project-<slug> (optional Dockerfile.dev in project repo)
  const projectDockerfile = path.join(repoDir(projectSlug), 'Dockerfile.dev')
  const finalImageName = `yaac-project-${projectSlug}`
  let projectDockerfileExists = false
  try {
    await fs.access(projectDockerfile)
    projectDockerfileExists = true
  } catch {
    // no project dockerfile
  }

  if (projectDockerfileExists) {
    const projHash = await fileHash(projectDockerfile)
    const existingProjHash = await getImageLabel(finalImageName, 'yaac.content-hash')
    if (!await imageExists(finalImageName) || existingProjHash !== projHash) {
      console.log(`Building ${finalImageName} image...`)
      await buildImage(finalImageName, projectDockerfile, repoDir(projectSlug), projHash)
    }
  } else {
    await tagImage('yaac-user', finalImageName)
  }

  return finalImageName
}

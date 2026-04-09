import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DOCKERFILES_DIR, getDataDir, repoDir, configOverrideDir } from '@/lib/paths'
import { resolveProjectConfig } from '@/lib/config'

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
 * Commits a running container as a cached image.
 */
async function commitContainer(containerName: string, imageName: string, hash: string): Promise<void> {
  await execFileAsync('podman', [
    'commit',
    '--change', `LABEL yaac.content-hash=${hash}`,
    '--change', 'ENTRYPOINT ["sleep", "infinity"]',
    containerName,
    imageName,
  ])
}

/**
 * Runs yaac-setup.sh inside a temporary container and commits the result as a cached image.
 * Returns the cached image name.
 */
export async function ensureSetupImage(
  projectSlug: string,
  baseImageName: string,
  setupScriptPath: string,
  cacheVolumes: Record<string, string> = {},
): Promise<string> {
  const setupImageName = `yaac-setup-${projectSlug}`
  const baseHash = await getImageLabel(baseImageName, 'yaac.content-hash') ?? 'unknown'
  const scriptHash = await fileHash(setupScriptPath)
  const combinedHash = crypto.createHash('sha256')
    .update(baseHash)
    .update(scriptHash)
    .digest('hex')
    .slice(0, 16)

  const existingHash = await getImageLabel(setupImageName, 'yaac.content-hash')
  if (await imageExists(setupImageName) && existingHash === combinedHash) {
    return setupImageName
  }

  console.log(`Running yaac-setup.sh for ${projectSlug}...`)
  const tmpContainer = `yaac-setup-tmp-${projectSlug}-${Date.now()}`
  const repoPath = repoDir(projectSlug)

  const volumeArgs: string[] = []
  for (const [key, containerPath] of Object.entries(cacheVolumes)) {
    volumeArgs.push('-v', `yaac-cache-${projectSlug}-${key}:${containerPath}:Z`)
  }

  // Create and start a temporary container with the repo mounted.
  // The setup script is bind-mounted into /workspace so it runs from inside
  // the workspace regardless of whether it comes from the repo or a local override.
  await execFileAsync('podman', [
    'run', '--name', tmpContainer,
    '-v', `${repoPath}:/workspace:Z`,
    '-v', `${setupScriptPath}:/workspace/yaac-setup.sh:ro,Z`,
    ...volumeArgs,
    '-w', '/workspace',
    '--entrypoint', '/bin/bash',
    baseImageName,
    '/workspace/yaac-setup.sh',
  ], { timeout: 600_000 })

  // Commit the container as the setup image
  await commitContainer(tmpContainer, setupImageName, combinedHash)

  // Clean up the temporary container
  await execFileAsync('podman', ['rm', tmpContainer])

  return setupImageName
}

/**
 * Ensures the full image chain is built for a project.
 *
 * Layer 1: yaac-default (from Dockerfile.default, or replaced by ~/.yaac/Dockerfile.yaac)
 * Layer 2: yaac-setup-<slug> (optional: runs yaac-setup.sh from project repo, cached)
 * Layer 3: yaac-user-<slug> (optional: from ~/.yaac/Dockerfile.user, builds on top)
 *
 * Returns the final image name to use for containers.
 */
export async function ensureImage(projectSlug: string): Promise<string> {
  // Layer 1: yaac-default (or replaced by ~/.yaac/Dockerfile.yaac)
  const yaacDockerfile = path.join(getDataDir(), 'Dockerfile.yaac')
  const hasYaacDockerfile = await fileExists(yaacDockerfile)

  const baseDockerfile = hasYaacDockerfile
    ? yaacDockerfile
    : path.join(DOCKERFILES_DIR, 'Dockerfile.default')
  const baseContext = hasYaacDockerfile ? getDataDir() : DOCKERFILES_DIR
  const baseHash = await fileHash(baseDockerfile)
  const existingBaseHash = await getImageLabel('yaac-default', 'yaac.content-hash')
  if (!await imageExists('yaac-default') || existingBaseHash !== baseHash) {
    console.log(hasYaacDockerfile
      ? 'Building yaac-default image from Dockerfile.yaac...'
      : 'Building yaac-default image...')
    await buildImage('yaac-default', baseDockerfile, baseContext, baseHash)
  }

  // Layer 2: yaac-setup-<slug> (optional yaac-setup.sh, local override or from repo)
  const overrideScript = path.join(configOverrideDir(projectSlug), 'yaac-setup.sh')
  const repoScript = path.join(repoDir(projectSlug), 'yaac-setup.sh')
  const setupScript = await fileExists(overrideScript) ? overrideScript : repoScript
  const hasSetupScript = await fileExists(setupScript)
  let currentImageName = 'yaac-default'

  if (hasSetupScript) {
    const config = await resolveProjectConfig(projectSlug) ?? {}
    currentImageName = await ensureSetupImage(projectSlug, 'yaac-default', setupScript, config.cacheVolumes ?? {})
  }

  // Layer 3: yaac-user (optional Dockerfile.user in ~/.yaac)
  // Tag current image so Dockerfile.user can use a stable FROM reference
  await tagImage(currentImageName, 'yaac-current')
  const userDockerfile = path.join(getDataDir(), 'Dockerfile.user')
  const finalImageName = `yaac-user-${projectSlug}`

  if (await fileExists(userDockerfile)) {
    const userHash = await fileHash(userDockerfile)
    const existingUserHash = await getImageLabel(finalImageName, 'yaac.content-hash')
    if (!await imageExists(finalImageName) || existingUserHash !== userHash) {
      console.log('Building yaac-user image...')
      await buildImage(finalImageName, userDockerfile, getDataDir(), userHash)
    }
  } else {
    await tagImage(currentImageName, finalImageName)
  }

  return finalImageName
}

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DOCKERFILES_DIR, getDataDir, configOverrideDir, repoDir } from '@/lib/paths'
import { getDefaultBranch } from '@/lib/git'

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

async function buildImage(imageName: string, dockerfile: string, context: string, hash: string, buildArgs?: Record<string, string>): Promise<void> {
  const args = [
    'build',
    '-t', imageName,
    '-f', dockerfile,
    '--label', `yaac.content-hash=${hash}`,
  ]
  for (const [key, value] of Object.entries(buildArgs ?? {})) {
    args.push('--build-arg', `${key}=${value}`)
  }
  args.push(context)

  await new Promise<void>((resolve, reject) => {
    const child = spawn('podman', args, { stdio: 'inherit', timeout: 600_000 })
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

async function readFileFromRef(repoPath: string, ref: string, filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], { cwd: repoPath })
    return stdout
  } catch {
    return null
  }
}

/**
 * Ensures the full image chain is built for a project.
 *
 * Layer 1: yaac-base (from Dockerfile.default, or replaced by ~/.yaac/Dockerfile.yaac)
 * Layer 1.5 (optional): yaac-base-nestable (from Dockerfile.nestable, when nestedContainers is true)
 * Layer 2: yaac-user-<slug> (optional: from ~/.yaac/Dockerfile.user, builds on top)
 *
 * Returns the final image name to use for containers.
 *
 * @param imagePrefix - Override for image name prefix. Used by tests to
 *   build isolated images that don't interfere with the running application.
 * @param requirePrebuilt - When true, throw instead of building if the base
 *   image is missing or stale. Used by e2e tests so parallel workers fail
 *   fast instead of racing to build the same image.
 * @param nestedContainers - When true, build the nestable layer (podman-in-podman support).
 */
export async function ensureImage(projectSlug: string, imagePrefix?: string, requirePrebuilt = false, nestedContainers = false): Promise<string> {
  const prefix = imagePrefix ?? 'yaac'
  const baseName = `${prefix}-base`

  // Layer 1: <prefix>-base
  // Priority: config-override/Dockerfile.yaac > repo Dockerfile.yaac (from remote ref) > Dockerfile.default
  const overrideDockerfile = path.join(configOverrideDir(projectSlug), 'Dockerfile.yaac')
  let yaacDockerfile: string | null = null
  let tmpDockerfileDir: string | null = null

  if (await fileExists(overrideDockerfile)) {
    yaacDockerfile = overrideDockerfile
  } else {
    try {
      const repo = repoDir(projectSlug)
      const defaultBranch = await getDefaultBranch(repo)
      const content = await readFileFromRef(repo, `origin/${defaultBranch}`, 'Dockerfile.yaac')
      if (content) {
        tmpDockerfileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaac-dockerfile-'))
        yaacDockerfile = path.join(tmpDockerfileDir, 'Dockerfile.yaac')
        await fs.writeFile(yaacDockerfile, content)
      }
    } catch {
      // git not available — fall through to default
    }
  }

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

  // Layer 1.5 (optional): <prefix>-base-nestable (podman-in-podman support)
  // Skipped when Dockerfile.yaac overrides the base — the custom Dockerfile is
  // responsible for including nested-container support itself.
  let effectiveBase = baseName
  if (nestedContainers && !yaacDockerfile) {
    const nestName = `${prefix}-base-nestable`
    const nestDockerfile = path.join(DOCKERFILES_DIR, 'Dockerfile.nestable')
    const nestContentHash = await fileHash(nestDockerfile)
    const nestHash = crypto.createHash('sha256').update(`${baseHash}:${nestContentHash}`).digest('hex').slice(0, 16)
    const existingNestHash = await getImageLabel(nestName, 'yaac.content-hash')
    if (!await imageExists(nestName) || existingNestHash !== nestHash) {
      if (requirePrebuilt) {
        throw new Error(
          `Nestable image ${nestName} is missing or stale. ` +
          'Restart the test run so the global setup can rebuild it.',
        )
      }
      console.log(`Building ${nestName} image (nested containers)...`)
      await buildImage(nestName, nestDockerfile, DOCKERFILES_DIR, nestHash, { BASE_IMAGE: baseName })
    }
    effectiveBase = nestName
  }

  // Layer 2: <prefix>-user (optional Dockerfile.user in ~/.yaac)
  // Tag current image so Dockerfile.user can use a stable FROM reference
  const currentTag = `${prefix}-current`
  await tagImage(effectiveBase, currentTag)
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
    await tagImage(effectiveBase, finalImageName)
  }

  if (tmpDockerfileDir) {
    await fs.rm(tmpDockerfileDir, { recursive: true, force: true })
  }

  return finalImageName
}

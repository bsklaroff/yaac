import fs from 'node:fs/promises'
import path from 'node:path'
import { isLayered } from '#platform/build-context'
import {
  PROJECT_DOCKERFILE,
  USER_DOCKERFILE,
  resolveProjectBuildDir,
  resolveUserBuildDir,
} from './build-dirs'
import { ServerError } from '@yaac/shared/errors'

/** Per-project layered/standalone Dockerfile (config/build/Dockerfile.yaac). */
async function projectDockerfilePath(slug: string): Promise<string> {
  return path.join(await resolveProjectBuildDir(slug), PROJECT_DOCKERFILE)
}

/** Global user Dockerfile applied as the top layer of every project image. */
async function userDockerfilePath(): Promise<string> {
  return path.join(await resolveUserBuildDir(), USER_DOCKERFILE)
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Read the per-project Dockerfile.yaac. Returns '' when the project has
 * none — the image then builds from the bundled base stack.
 */
export async function readProjectDockerfile(slug: string): Promise<string> {
  return readFileOrEmpty(await projectDockerfilePath(slug))
}

/**
 * Write (or clear) the per-project Dockerfile.yaac. Whitespace-only
 * content removes the file so the project reverts to the bundled base.
 * The image only changes on the next `yaac project rebuild`.
 */
export async function writeProjectDockerfile(slug: string, content: string): Promise<void> {
  const filePath = await projectDockerfilePath(slug)
  if (content.trim().length === 0) {
    await fs.rm(filePath, { force: true })
    return
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

/** Read the global user Dockerfile. Returns '' when unset. */
export async function readUserDockerfile(): Promise<string> {
  return readFileOrEmpty(await userDockerfilePath())
}

/**
 * Write (or clear) the global user Dockerfile. Whitespace-only content
 * removes the file. A non-empty user Dockerfile always builds atop the
 * resolved project image, so it must be layered (`ARG BASE_IMAGE` +
 * `FROM ${BASE_IMAGE}`) — reject a standalone one at the edge, matching
 * the build-time check in the image builder.
 */
export async function writeUserDockerfile(content: string): Promise<void> {
  const filePath = await userDockerfilePath()
  if (content.trim().length === 0) {
    await fs.rm(filePath, { force: true })
    return
  }
  if (!isLayered(content)) {
    throw new ServerError(
      'VALIDATION',
      'Dockerfile.user must use `ARG BASE_IMAGE` and `FROM ${BASE_IMAGE}` '
      + 'so it layers on the project image',
    )
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

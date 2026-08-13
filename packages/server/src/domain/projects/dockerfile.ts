import fs from 'node:fs/promises'
import path from 'node:path'
import { isLayered } from '#lib/build-context'
import {
  PROJECT_DOCKERFILE,
  USER_DOCKERFILE,
  projectBuildDir,
  userBuildDir,
} from '#lib/build-dirs'
import { ServerError } from '@yaac/shared/errors'

/** Per-project layered/standalone Dockerfile (config/build/Dockerfile.yaac). */
function projectDockerfilePath(slug: string): string {
  return path.join(projectBuildDir(slug), PROJECT_DOCKERFILE)
}

/** Global user Dockerfile applied as the top layer of every project image. */
function userDockerfilePath(): string {
  return path.join(userBuildDir(), USER_DOCKERFILE)
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
  return readFileOrEmpty(projectDockerfilePath(slug))
}

/**
 * Write (or clear) the per-project Dockerfile.yaac. Whitespace-only
 * content removes the file so the project reverts to the bundled base.
 * The image changes on the next worktree created for the project: the
 * edit moves the layer's content hash, so its chain rebuilds.
 */
export async function writeProjectDockerfile(slug: string, content: string): Promise<void> {
  const filePath = projectDockerfilePath(slug)
  if (content.trim().length === 0) {
    await fs.rm(filePath, { force: true })
    return
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

/** Read the global user Dockerfile. Returns '' when unset. */
export async function readUserDockerfile(): Promise<string> {
  return readFileOrEmpty(userDockerfilePath())
}

/**
 * Write (or clear) the global user Dockerfile. Whitespace-only content
 * removes the file. A non-empty user Dockerfile always builds atop the
 * resolved project image, so it must be layered (`ARG BASE_IMAGE` +
 * `FROM ${BASE_IMAGE}`) — reject a standalone one at the edge, matching
 * the build-time check in the image builder.
 */
export async function writeUserDockerfile(content: string): Promise<void> {
  const filePath = userDockerfilePath()
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

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
import { authorizeProject, type Actor } from '#domain/access'

/** Per-project layered/standalone Dockerfile (config/build/Dockerfile.yaac). */
function projectDockerfilePath(projectId: string): string {
  return path.join(projectBuildDir(projectId), PROJECT_DOCKERFILE)
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
export async function readProjectDockerfile(projectId: string): Promise<string> {
  return readFileOrEmpty(projectDockerfilePath(projectId))
}

/**
 * Write the per-project Dockerfile.yaac; whitespace-only content removes it
 * (reverting to the bundled base). The next workspace create rebuilds, since
 * the layer's content hash changes.
 */
export async function writeProjectDockerfile(principal: Actor, projectId: string, content: string): Promise<void> {
  await authorizeProject(principal, projectId)
  const filePath = projectDockerfilePath(projectId)
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
 * Write the global user Dockerfile; whitespace-only content removes it. It
 * always builds on top of the project image, so it must be layered (`ARG
 * BASE_IMAGE` + `FROM ${BASE_IMAGE}`), as the image builder also checks.
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

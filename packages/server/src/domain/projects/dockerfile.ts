import fs from 'node:fs/promises'
import path from 'node:path'
import { isLayered } from '#lib/build-context'
import {
  PROJECT_DOCKERFILE,
  USER_DOCKERFILE,
  projectBuildDir,
  userBuildDir,
} from '#lib/build-dirs'
import { serverLocalPath } from '@yaac/shared/project-paths'
import { ServerError } from '@yaac/shared/errors'
import { authorizeProject, type Actor } from '#domain/access'
import { BUILT_IN_USER_ID } from '#db'
import { serverLog } from '#log'

/** Per-project layered/standalone Dockerfile (config/build/Dockerfile.yaac). */
function projectDockerfilePath(projectId: string): string {
  return path.join(projectBuildDir(projectId), PROJECT_DOCKERFILE)
}

/** A user's Dockerfile, the top layer of every project image they own. */
function userDockerfilePath(userId: string): string {
  return path.join(userBuildDir(userId), USER_DOCKERFILE)
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

/** Read a user's Dockerfile.user. Returns '' when unset. */
export async function readUserDockerfile(userId: string): Promise<string> {
  return readFileOrEmpty(userDockerfilePath(userId))
}

/**
 * Write a user's Dockerfile.user; whitespace-only content removes it. It
 * always builds on top of the project image, so it must be layered (`ARG
 * BASE_IMAGE` + `FROM ${BASE_IMAGE}`), as the image builder also checks.
 */
export async function writeUserDockerfile(userId: string, content: string): Promise<void> {
  const filePath = userDockerfilePath(userId)
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

/**
 * Give the install-wide `server-local/build/` of a single-user install to
 * the built-in user, whose projects it built (docs/legacy-compat-shims.md
 * "Moving the user build dir to the built-in user"). Run on every start,
 * before the server admits requests; a no-op once moved.
 */
export async function moveLegacyUserBuildDir(): Promise<void> {
  const legacy = serverLocalPath('build')
  const target = userBuildDir(BUILT_IN_USER_ID)
  if (!await exists(legacy)) return
  if (await exists(target)) {
    serverLog(`[server] both ${legacy} and ${target} exist; ${target} is used, `
      + `and ${legacy} is stale and can be deleted`)
    return
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rename(legacy, target)
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false)
}

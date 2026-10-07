import path from 'node:path'
import { projectConfigDir, serverLocalPath } from '@yaac/shared/project-paths'

/**
 * Where image build contexts live and what their Dockerfiles are called.
 * Used by the build engine, the Dockerfile readers and writers, and the
 * build-files routes, which sit on both sides of the domain/runtime line.
 */

/** Basename of the per-project Dockerfile inside its build dir. */
export const PROJECT_DOCKERFILE = 'Dockerfile.yaac'
/** Basename of a user's Dockerfile inside their build dir. */
export const USER_DOCKERFILE = 'Dockerfile.user'

/**
 * Per-project image build dir (`config/build/`): the build context for
 * Dockerfile.yaac, which lives inside it next to any user-managed support
 * files. Everything in this dir ships to the build; nothing outside it
 * does.
 */
export function projectBuildDir(projectId: string): string {
  return path.join(projectConfigDir(projectId), 'build')
}

/**
 * One user's image build dir: the build context for their Dockerfile.user,
 * which tops the image of every project they own. Same containment rule as
 * `projectBuildDir`. Server-local; no pod mounts it.
 */
export function userBuildDir(userId: string): string {
  return serverLocalPath('users', userId, 'build')
}

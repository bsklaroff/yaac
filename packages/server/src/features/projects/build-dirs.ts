import fs from 'node:fs/promises'
import path from 'node:path'
import { projectConfigDir, serverLocalPath } from '@yaac/shared/project-paths'

/** Basename of the per-project Dockerfile inside its build dir. */
export const PROJECT_DOCKERFILE = 'Dockerfile.yaac'
/** Basename of the global user Dockerfile inside its build dir. */
export const USER_DOCKERFILE = 'Dockerfile.user'

/**
 * Per-project image build dir (`config/build/`): the build context for
 * Dockerfile.yaac, which lives inside it next to any user-managed support
 * files. Everything in this dir ships to the build; nothing outside it
 * does.
 */
export function projectBuildDir(slug: string): string {
  return path.join(projectConfigDir(slug), 'build')
}

/**
 * Global user image build dir (`~/.yaac/build/`): the build context for
 * Dockerfile.user, same containment rule as `projectBuildDir`.
 * SERVER-LOCAL: a build context the server hands to the build engine; no
 * pod ever mounts it.
 */
export function userBuildDir(): string {
  return serverLocalPath('build')
}

/**
 * Move a pre-build-dir Dockerfile into its build dir. No-op when there is
 * no legacy file or the target already exists (then the legacy file is
 * left alone — nothing reads the old path anymore, and deleting a file
 * the user may have re-created there is worse than ignoring it).
 */
async function migrateLegacyDockerfile(legacy: string, target: string): Promise<void> {
  try {
    await fs.access(legacy)
  } catch {
    return
  }
  try {
    await fs.access(target)
    return
  } catch {
    // target absent — migrate
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rename(legacy, target)
}

/**
 * Resolve the project's build dir, first migrating a legacy
 * `config/Dockerfile.yaac` into it. Every reader/writer of the project
 * Dockerfile or its build files goes through this, so the move happens on
 * first touch with no startup hook.
 */
export async function resolveProjectBuildDir(slug: string): Promise<string> {
  const dir = projectBuildDir(slug)
  await migrateLegacyDockerfile(
    path.join(projectConfigDir(slug), PROJECT_DOCKERFILE),
    path.join(dir, PROJECT_DOCKERFILE),
  )
  return dir
}

/**
 * Resolve the global user build dir, first migrating a legacy
 * `~/.yaac/Dockerfile.user` into it.
 */
export async function resolveUserBuildDir(): Promise<string> {
  const dir = userBuildDir()
  await migrateLegacyDockerfile(
    serverLocalPath(USER_DOCKERFILE),
    path.join(dir, USER_DOCKERFILE),
  )
  return dir
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { projectConfigDir, serverLocalPath } from '@yaac/shared/project-paths'

/**
 * Where an image build context lives, and what the Dockerfile in it is
 * called — the vocabulary shared by everyone who touches one: the build
 * engine that ships the context to podman, the readers and writers of the
 * Dockerfile, and the routes that let a user edit the support files beside
 * it.
 *
 * In `#lib` because those callers sit on both sides of the domain/runtime
 * line and none of them owns the answer (`#lib/build-context`, the file
 * walk that reads one of these dirs, is here for the same reason). The
 * `resolve*` pair carries a migrate-on-first-touch of the pre-build-dir
 * layout, which is why every reader goes through it rather than composing
 * the path itself — the migration has no startup hook and no other home.
 */

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
 *
 * Concurrency-safe by absorbing the loss rather than by locking. Two first
 * touches can both pass the checks above — the prewarm sweep and a rebuild
 * route are independent callers — and the loser's `rename` then fails with
 * the legacy file already gone. That is indistinguishable from the outcome
 * it wanted, so it is swallowed once the target is confirmed present.
 * Anything else rethrows: a genuinely failed migration must not read as a
 * successful one, or the next build silently uses no Dockerfile.
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
  try {
    await fs.rename(legacy, target)
  } catch (err) {
    try {
      await fs.access(target)
    } catch {
      throw err
    }
  }
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

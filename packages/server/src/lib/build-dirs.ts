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
 * walk that reads one of these dirs, is here for the same reason).
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

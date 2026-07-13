import { rpc, unwrap, expectOk } from './rpc'
import type { YaacConfig } from '@yaac/shared/types'

/** Clone a git repo as a new project. Throws ApiError (e.g. AUTH_REQUIRED). */
export async function addProject(remoteUrl: string): Promise<{ slug: string }> {
  const { project } = await unwrap(rpc.project.add.$post({ json: { remoteUrl } }))
  return project
}

/** Remove a project (and its sessions/worktrees). */
export async function removeProject(slug: string): Promise<void> {
  await expectOk(rpc.project[':slug'].$delete({ param: { slug } }))
}

/** Read the per-project yaac-config.json overlay (null when unset). */
export async function getProjectConfig(slug: string): Promise<YaacConfig | null> {
  const { config } = await unwrap(rpc.project[':slug'].config.$get({ param: { slug } }))
  return config
}

/** Write the per-project yaac-config.json overlay. Validated server-side;
 *  throws ApiError with the parser message on malformed config. */
export async function saveProjectConfig(slug: string, config: unknown): Promise<YaacConfig> {
  const saved = await unwrap(rpc.project[':slug'].config.$put({ param: { slug }, json: { config } }))
  return saved.config
}

/** Read the per-project Dockerfile.yaac ('' when the project has none). */
export async function getProjectDockerfile(slug: string): Promise<string> {
  const { content } = await unwrap(rpc.project[':slug'].dockerfile.$get({ param: { slug } }))
  return content
}

/** Write (or clear, when empty) the per-project Dockerfile.yaac. Takes
 *  effect on the next `yaac project rebuild`. */
export async function saveProjectDockerfile(slug: string, content: string): Promise<void> {
  await expectOk(rpc.project[':slug'].dockerfile.$put({ param: { slug }, json: { content } }))
}

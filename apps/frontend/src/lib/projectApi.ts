import { rpc } from './rpc'
import type { YaacConfig } from '@yaac/shared/types'

/** Clone a git repo as a new project. Throws ServerError (e.g. AUTH_REQUIRED). */
export async function addProject(remoteUrl: string): Promise<{ slug: string }> {
  const { project } = await rpc.project.add.$post({ json: { remoteUrl } }).then((r) => r.json())
  return project
}

/** Remove a project (and its sessions/worktrees). */
export async function removeProject(slug: string): Promise<void> {
  await rpc.project[':slug'].$delete({ param: { slug } })
}

/** Read the per-project yaac-config.json overlay (null when unset). */
export async function getProjectConfig(slug: string): Promise<YaacConfig | null> {
  const { config } = await rpc.project[':slug'].config.$get({ param: { slug } }).then((r) => r.json())
  return config
}

/** Write the per-project yaac-config.json overlay. Validated server-side;
 *  throws ServerError with the parser message on malformed config. */
export async function saveProjectConfig(slug: string, config: unknown): Promise<YaacConfig> {
  const saved = await rpc.project[':slug'].config.$put({ param: { slug }, json: { config } }).then((r) => r.json())
  return saved.config
}

/** Read the per-project Dockerfile.yaac ('' when the project has none). */
export async function getProjectDockerfile(slug: string): Promise<string> {
  const { content } = await rpc.project[':slug'].dockerfile.$get({ param: { slug } }).then((r) => r.json())
  return content
}

/** Write (or clear, when empty) the per-project Dockerfile.yaac. Takes
 *  effect on the next `yaac project rebuild`. */
export async function saveProjectDockerfile(slug: string, content: string): Promise<void> {
  await rpc.project[':slug'].dockerfile.$put({ param: { slug }, json: { content } })
}

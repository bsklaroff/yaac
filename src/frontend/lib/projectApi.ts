import { api } from './apiClient'
import type { YaacConfig } from '@/shared/types'

/** Clone a git repo as a new project. Throws ApiError (e.g. AUTH_REQUIRED). */
export async function addProject(remoteUrl: string): Promise<{ slug: string }> {
  const res = await api.post<{ project: { slug: string } }>('/project/add', { remoteUrl })
  return res.project
}

/** Remove a project (and its sessions/worktrees). */
export async function removeProject(slug: string): Promise<void> {
  await api.del(`/project/${encodeURIComponent(slug)}`)
}

/** Read the per-project yaac-config.json overlay (null when unset). */
export async function getProjectConfig(slug: string): Promise<YaacConfig | null> {
  const res = await api.get<{ config: YaacConfig | null }>(`/project/${encodeURIComponent(slug)}/config`)
  return res.config
}

/** Write the per-project yaac-config.json overlay. Validated server-side;
 *  throws ApiError with the parser message on malformed config. */
export async function saveProjectConfig(slug: string, config: unknown): Promise<YaacConfig> {
  const res = await api.put<{ config: YaacConfig }>(`/project/${encodeURIComponent(slug)}/config`, { config })
  return res.config
}

/** Read the per-project Dockerfile.yaac ('' when the project has none). */
export async function getProjectDockerfile(slug: string): Promise<string> {
  const res = await api.get<{ content: string }>(`/project/${encodeURIComponent(slug)}/dockerfile`)
  return res.content
}

/** Write (or clear, when empty) the per-project Dockerfile.yaac. Takes
 *  effect on the next `yaac project rebuild`. */
export async function saveProjectDockerfile(slug: string, content: string): Promise<void> {
  await api.put(`/project/${encodeURIComponent(slug)}/dockerfile`, { content })
}

import { api } from './apiClient'

/** Clone a git repo as a new project. Throws ApiError (e.g. AUTH_REQUIRED). */
export async function addProject(remoteUrl: string): Promise<{ slug: string }> {
  const res = await api.post<{ project: { slug: string } }>('/project/add', { remoteUrl })
  return res.project
}

/** Remove a project (and its sessions/worktrees). */
export async function removeProject(slug: string): Promise<void> {
  await api.del(`/project/${encodeURIComponent(slug)}`)
}

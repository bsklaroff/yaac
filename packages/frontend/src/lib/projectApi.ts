import { api } from './api'
import type { ProjectEnvVar, SecretProxyRule, YaacConfig } from '@yaac/shared/types'

/** Clone a git repo as a new project using the given git credential.
 *  `knownHostsEntry` is the host key trusted when cloning over SSH. */
export async function addProject(
  remoteUrl: string,
  gitCredentialId: string,
): Promise<{ slug: string; knownHostsEntry: string | null }> {
  const { project, knownHostsEntry } = await api.project.add.$post({ json: { remoteUrl, gitCredentialId } })
  return { slug: project.slug, knownHostsEntry }
}

/** Set the project's git credential. Returns the host key trusted for an
 *  SSH key, else null. */
export async function setProjectGitCredential(slug: string, credentialId: string): Promise<string | null> {
  const { knownHostsEntry } = await api.project[':slug']['git-credential'].$put({
    param: { slug },
    json: { credentialId },
  })
  return knownHostsEntry
}

/** Remove a project (and its workspaces). */
export async function removeProject(slug: string): Promise<void> {
  await api.project[':slug'].$delete({ param: { slug } })
}

/** Read the per-project yaac-config.json overlay (null when unset). */
export async function getProjectConfig(slug: string): Promise<YaacConfig | null> {
  const { config } = await api.project[':slug'].config.$get({ param: { slug } })
  return config
}

/** Write the per-project yaac-config.json overlay. Throws a ServerError with
 *  the parser's message if the server rejects it. */
export async function saveProjectConfig(slug: string, config: unknown): Promise<YaacConfig> {
  const saved = await api.project[':slug'].config.$put({ param: { slug }, json: { config } })
  return saved.config
}

/** Read a project's environment variables. Secrets report only whether a
 *  value is stored. */
export async function getProjectEnv(slug: string): Promise<ProjectEnvVar[]> {
  const { vars } = await api.project[':slug'].env.$get({ param: { slug } })
  return vars
}

/**
 * Create or replace one variable. Omit `value` to keep a secret's stored
 * value while editing its rule; the server refuses this if none is stored.
 */
export async function setProjectEnvVar(slug: string, input: {
  name: string
  value?: string
  secret: boolean
  rule?: SecretProxyRule
}): Promise<ProjectEnvVar> {
  const saved = await api.project[':slug'].env.$put({ param: { slug }, json: input })
  return saved.var
}

export async function deleteProjectEnvVar(slug: string, id: string): Promise<void> {
  await api.project[':slug'].env[':id'].$delete({ param: { slug, id } })
}

export interface ProjectBranches {
  /** Remote-tracking branch names, newest-committed first. */
  branches: string[]
  defaultBranch: string
}

/** React Query key for a project's branch list, shared by every branch
 *  picker. */
export function projectBranchesKey(slug: string): readonly [string, string] {
  return ['project-branches', slug] as const
}

/**
 * A project's branches. Without `refresh` the server reads its local
 * remote-tracking refs; with it, it fetches from the remote first so a
 * just-pushed branch appears.
 */
export async function getProjectBranches(slug: string, opts: { refresh?: boolean } = {}): Promise<ProjectBranches> {
  return await api.project[':slug'].branches.$get({
    param: { slug },
    query: opts.refresh ? { refresh: '1' } : {},
  })
}

/** Read the per-project Dockerfile.yaac ('' when the project has none). */
export async function getProjectDockerfile(slug: string): Promise<string> {
  const { content } = await api.project[':slug'].dockerfile.$get({ param: { slug } })
  return content
}

/** Write the per-project Dockerfile.yaac (empty clears it). Applies to the
 *  project's next new workspace. */
export async function saveProjectDockerfile(slug: string, content: string): Promise<void> {
  await api.project[':slug'].dockerfile.$put({ param: { slug }, json: { content } })
}

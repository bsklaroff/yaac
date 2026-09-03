import { api } from './api'
import type { ProjectEnvVar, SecretProxyRule, YaacConfig } from '@yaac/shared/types'

/** Clone a git repo as a new project. Throws ServerError (e.g. AUTH_REQUIRED). */
export async function addProject(remoteUrl: string): Promise<{ slug: string }> {
  const { project } = await api.project.add.$post({ json: { remoteUrl } })
  return project
}

/** Remove a project (and its worktrees/worktrees). */
export async function removeProject(slug: string): Promise<void> {
  await api.project[':slug'].$delete({ param: { slug } })
}

/** Read the per-project yaac-config.json overlay (null when unset). */
export async function getProjectConfig(slug: string): Promise<YaacConfig | null> {
  const { config } = await api.project[':slug'].config.$get({ param: { slug } })
  return config
}

/** Write the per-project yaac-config.json overlay. Validated server-side;
 *  throws ServerError with the parser message on malformed config. */
export async function saveProjectConfig(slug: string, config: unknown): Promise<YaacConfig> {
  const saved = await api.project[':slug'].config.$put({ param: { slug }, json: { config } })
  return saved.config
}

/** Read a project's environment: plain variables with their values, secrets
 *  with only the fact that a value is stored. */
export async function getProjectEnv(slug: string): Promise<ProjectEnvVar[]> {
  const { vars } = await api.project[':slug'].env.$get({ param: { slug } })
  return vars
}

/**
 * Create or replace one variable. Omit `value` for a secret whose rule is
 * being edited but whose value should stay as it is — the server refuses it
 * for a secret that has none yet.
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
  referenceBranch: string | null
}

/** React Query key for a project's branch list — shared by every branch picker
 *  (new-worktree popover, Changes-view base picker) so they hit one cache. */
export function projectBranchesKey(slug: string): readonly [string, string] {
  return ['project-branches', slug] as const
}

/**
 * Branch data for the new-worktree picker. Without `refresh` this reads the
 * local remote-tracking refs (instant); with it the server fetches from the
 * remote first so a just-pushed branch appears.
 */
export async function getProjectBranches(slug: string, opts: { refresh?: boolean } = {}): Promise<ProjectBranches> {
  return await api.project[':slug'].branches.$get({
    param: { slug },
    query: opts.refresh ? { refresh: '1' } : {},
  })
}

/** Set (or clear, with null) the project's default reference branch. */
export async function setProjectReferenceBranch(slug: string, branch: string | null): Promise<string | null> {
  const { referenceBranch } = await api.project[':slug']['reference-branch'].$put({
    param: { slug },
    json: { branch },
  })
  return referenceBranch
}

/** Read the per-project Dockerfile.yaac ('' when the project has none). */
export async function getProjectDockerfile(slug: string): Promise<string> {
  const { content } = await api.project[':slug'].dockerfile.$get({ param: { slug } })
  return content
}

/** Write (or clear, when empty) the per-project Dockerfile.yaac. Takes
 *  effect on the next worktree created for the project. */
export async function saveProjectDockerfile(slug: string, content: string): Promise<void> {
  await api.project[':slug'].dockerfile.$put({ param: { slug }, json: { content } })
}

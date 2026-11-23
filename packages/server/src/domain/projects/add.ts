import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { ensureDataDir, projectDir, claudeDir } from '@yaac/shared/project-paths'
import {
  addRepo,
  canUseRepo,
  createHostedRepo,
  ensureMainClone,
  registerStagedRepo,
  setRepoUpstream,
  suggestUpstream,
  validateGitRemoteUrl,
  type AddRepoOptions,
  type UpstreamTarget,
} from '#domain/repos'
import { getProjectRow, getRepo, getToolCredential, linkProjectRepo, recordProject, type RepoRow } from '#db'
import {
  writeProjectClaudePlaceholder,
  writeProjectCodexPlaceholder,
} from '@yaac/shared/tool-auth'
import { ServerError } from '@yaac/shared/errors'
import type { ProjectMeta } from '@yaac/shared/types'
import { projectNameFor } from '@yaac/shared/project-name'
import { allowRepoHost } from './allowlist'
import { repoName } from './repos'
import { systemPrincipal } from '#domain/access'
import { trackProjectAdd } from './adding'

export interface AddProjectResult {
  project: ProjectMeta
  /** The repo the project links. */
  repoId: string
  /** The host key trusted for an SSH credential, for the user to compare
   *  against what the host publishes. */
  knownHostsEntry: string | null
  /** The repo's host, when the project's allowlist left it out and so it
   *  was added there. */
  allowedHost: string | null
  /** The repo GitHub says the remote is a fork of, offered as its upstream
   *  (docs/repo-forks.md "Remote forks"). */
  suggestedUpstream?: string
}

/** What a project is added around: a remote, taken as `addRepo` takes it
 *  and optionally given an upstream, or a repo its owner may already use. */
export type ProjectSource =
  | { remoteUrl: string; upstream?: UpstreamTarget } & AddRepoOptions
  | { repoId: string }

/**
 * Add a yaac project owned by `owner` around one git repo: the repo they
 * already have for a remote, a fresh clone of it (`addRepo`,
 * docs/git-credentials.md), or a repo they name by id, with its host added
 * to the allowlist when the defaults leave it out. Listed as an add in
 * flight until it settles (`trackProjectAdd`), under `projectId` when the
 * client picks it to follow the add before the request answers. User-facing
 * failures throw `ServerError`.
 */
export async function addProject(source: ProjectSource, owner: string, projectId?: string): Promise<AddProjectResult> {
  const named = 'repoId' in source ? await getRepo(source.repoId) : undefined
  if ('repoId' in source && (named === undefined || !await canUseRepo(owner, named))) {
    throw new ServerError('NOT_FOUND', `repo ${source.repoId} not found`)
  }
  const remoteUrl = named?.remoteUrl ?? ('remoteUrl' in source ? source.remoteUrl : '')
  const name = named !== undefined ? await repoName(named) : projectNameFor(validateGitRemoteUrl(remoteUrl).path)
  if (!name) throw new ServerError('VALIDATION', `no project name can be derived from "${remoteUrl}"`)
  const id = projectId ?? crypto.randomUUID()
  const entry = {
    id, owner, name, remoteUrl, hosted: named?.hosted ?? false,
    ...('credentialId' in source && source.credentialId !== undefined ? { gitCredentialId: source.credentialId } : {}),
  }
  return trackProjectAdd(entry, projectId !== undefined, async (onProgress) => {
    let repo: RepoRow
    let knownHostsEntry: string | null = null
    if (named !== undefined) {
      await ensureMainClone(named, onProgress)
      repo = named
    } else if ('remoteUrl' in source) {
      ({ repo, knownHostsEntry } = await addRepo(owner, source.remoteUrl, source, onProgress))
      if (source.upstream !== undefined) await setRepoUpstream(systemPrincipal, repo.id, source.upstream)
      repo = await getRepo(repo.id) ?? repo
    } else {
      throw new ServerError('VALIDATION', 'name a remote or a repo')
    }
    const project = await setUpProject(id, name, owner, repo.id)
    const suggestedUpstream = 'remoteUrl' in source ? await suggestUpstream(repo) : undefined
    return {
      project,
      repoId: repo.id,
      knownHostsEntry,
      allowedHost: await allowRepoHost(project.id, repo),
      ...(suggestedUpstream !== undefined ? { suggestedUpstream } : {}),
    }
  })
}

/**
 * Create a project with one empty repo whose remote the server hosts
 * (docs/hosted-projects.md), listed as an add in flight like `addProject`.
 */
export async function createHostedProject(
  rawName: string,
  owner: string,
  projectId?: string,
): Promise<ProjectMeta> {
  const name = projectNameFor(rawName.trim())
  if (!name) throw new ServerError('VALIDATION', `"${rawName}" is not a usable project name`)
  const id = projectId ?? crypto.randomUUID()
  return trackProjectAdd({ id, owner, name, remoteUrl: '', hosted: true }, projectId !== undefined, async () => {
    const repo = await createHostedRepo(owner)
    return setUpProject(id, name, owner, repo.id)
  })
}

/**
 * What every way of adding a project shares: the project dir, the
 * tool-auth placeholders, the row, and its link to its first repo under a
 * folder named for the project. A failure removes the project dir, since
 * files without a row couldn't be listed, removed or re-added; the repo
 * stays among its owner's.
 */
async function setUpProject(projectId: string, name: string, owner: string, repoId: string): Promise<ProjectMeta> {
  await ensureDataDir()
  const dir = projectDir(projectId)
  await fs.mkdir(dir, { recursive: true })
  try {
    const meta: ProjectMeta = { id: projectId, name, addedAt: new Date().toISOString() }
    await fs.mkdir(claudeDir(projectId), { recursive: true })

    const claudeCreds = await getToolCredential(owner, 'claude')
    if (claudeCreds?.kind === 'oauth') {
      await writeProjectClaudePlaceholder(projectId, claudeCreds.claudeAiOauth)
    }

    const codexCreds = await getToolCredential(owner, 'codex')
    if (codexCreds?.kind === 'oauth') {
      await writeProjectCodexPlaceholder(projectId, codexCreds.codexOauth)
    }

    await recordProject(meta, owner)
    await linkProjectRepo(projectId, repoId, name)
    return meta
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true })
    throw err
  }
}

/**
 * Record a project whose repo's main clone is already staged in the data
 * dir under `id`, without cloning; test suites use this for local repos.
 * The repo takes the project's id. Refuses a remote `project add` would
 * reject, a missing staged clone, and an id already recorded.
 */
export async function registerStagedProject(
  id: string,
  name: string,
  remoteUrl: string,
  owner: string,
): Promise<ProjectMeta> {
  if (await getProjectRow(id)) {
    throw new ServerError('CONFLICT', `Project ${id} already exists`)
  }
  await registerStagedRepo(id, remoteUrl, owner)
  return setUpProject(id, name, owner, id)
}

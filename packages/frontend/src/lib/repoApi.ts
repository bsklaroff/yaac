import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { api } from '#lib/api'
import { AUTH_LIST_KEY } from '#lib/useAuthList'
import { useSnapshot } from '#lib/useSnapshot'
import type { RepoHolder, RepoSummary } from '@yaac/shared/types'

/*
 * Every call the webapp makes about a repo (docs/project-repos.md): the
 * repos themselves under `/repo`, and a project's links to them under
 * `/project/:projectId/repo`. Kept in one module so the views share one
 * cache of the repo list and its branch lists.
 */

const repo = api.repo[':repoId']
const projectRepo = api.project[':projectId'].repo

/** React Query key of the repo list. */
export const REPOS_KEY = ['repos'] as const

/**
 * Every repo, any user's: the snapshot carries only the ones a project
 * links. Read again whenever the snapshot's links or credentials change,
 * and after each change made here.
 */
export function useRepos(): RepoSummary[] | undefined {
  const queryClient = useQueryClient()
  const linked = (useSnapshot()?.projects ?? [])
    .flatMap((p) => p.repos.map((r) => `${p.id}/${r.id}/${r.gitCredential?.id ?? ''}/${r.remoteUrl}`)).join(' ')
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: REPOS_KEY }) }, [queryClient, linked])
  return useQuery({ queryKey: REPOS_KEY, queryFn: () => api.repo.list.$get() }).data
}

/** Read the repo list, and the credential list that names each one's
 *  repos, again. */
export async function refreshRepos(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: REPOS_KEY }),
    queryClient.invalidateQueries({ queryKey: AUTH_LIST_KEY }),
  ])
}

export interface RepoBranches {
  /** Remote-tracking branch names, newest-committed first. */
  branches: string[]
  defaultBranch: string
}

export const repoBranchesKey = (repoId: string): unknown[] => ['repo-branches', repoId]

export const fetchRepoBranches = (repoId: string, refresh: boolean): Promise<RepoBranches> =>
  repo.branches.$get({ param: { repoId }, query: refresh ? { refresh: '1' } : {} })

/**
 * A repo's branches, cached for every branch picker. The server's local
 * remote-tracking refs answer at once; while `enabled`, a fetch from the
 * remote follows, so a just-pushed branch appears. If that fetch fails the
 * local list stays.
 */
export function useRepoBranches(repoId: string, enabled = true): UseQueryResult<RepoBranches> {
  const on = enabled && repoId !== ''
  useBranchRefresh(on ? [repoId] : [])
  return useQuery({ queryKey: repoBranchesKey(repoId), queryFn: () => fetchRepoBranches(repoId, false), enabled: on })
}

/** Fetch each repo's branches from its remote once per mount, replacing
 *  the cached local list as each answer lands. */
export function useBranchRefresh(repoIds: string[]): void {
  const queryClient = useQueryClient()
  const ids = repoIds.join(' ')
  useEffect(() => {
    let cancelled = false
    for (const repoId of ids === '' ? [] : ids.split(' ')) {
      fetchRepoBranches(repoId, true).then(
        (fresh) => { if (!cancelled) queryClient.setQueryData(repoBranchesKey(repoId), fresh) },
        () => {},
      )
    }
    return () => { cancelled = true }
  }, [ids, queryClient])
}

/** Assign a repo one of its owner's git credentials. Answers the host key
 *  trusted for an ssh key. */
export async function assignRepoCredential(repoId: string, credentialId: string): Promise<string | null> {
  const { knownHostsEntry } = await repo['git-credential'].$put({ param: { repoId }, json: { credentialId } })
  return knownHostsEntry
}

export const setRepoDefaultBranch = (repoId: string, branch: string): Promise<unknown> =>
  repo['default-branch'].$put({ param: { repoId }, json: { branch } })

export const setRepoDefaultBranchGuard = (repoId: string, enabled: boolean): Promise<unknown> =>
  repo['default-branch-guard'].$put({ param: { repoId }, json: { enabled } })

export const shareRepo = (repoId: string, userId: string): Promise<unknown> =>
  repo.share.$post({ param: { repoId }, json: { userId } })

export const unshareRepo = (repoId: string, userId: string): Promise<unknown> =>
  repo.unshare.$post({ param: { repoId }, json: { userId } })

/** What moving a hosted repo to a git host stops and hands over. */
export const previewRepoMove = (repoId: string): Promise<{ runningWorkspaces: number; sharedWith: string[] }> =>
  repo['move-preview'].$get({ param: { repoId } })

export const moveRepo = (repoId: string, remoteUrl: string, credentialId: string): Promise<unknown> =>
  repo.move.$post({ param: { repoId }, json: { remoteUrl, credentialId } })

export const removeKeptHostedRepo = (repoId: string): Promise<unknown> =>
  repo['kept-hosted-repo'].$delete({ param: { repoId } })

/** What deleting a repo reaches: the projects it is unlinked from and the
 *  workspaces that hold a checkout of it. */
export const previewRepoDelete = (repoId: string): Promise<{
  projects: Array<{ id: string; name: string; owner: string }>
  heldBy: RepoHolder[]
}> => repo['delete-preview'].$get({ param: { repoId } })

/** Delete a repo. Answers the workspaces still holding a checkout of it,
 *  which keep its main clone on disk until they are deleted. */
export const deleteRepo = (repoId: string): Promise<{ heldBy: RepoHolder[] }> =>
  repo.$delete({ param: { repoId } })

/** What a link is made to (`RepoToLink` on the server). */
export type RepoToLink = { remoteUrl: string; credentialId: string } | { repoId: string } | { hosted: true }

/** Link a repo into a project, under `dir` if given. */
export const addProjectRepo = (
  projectId: string,
  what: RepoToLink,
  dir?: string,
): Promise<{ repoId: string; dir: string; knownHostsEntry: string | null }> =>
  projectRepo.$post({ param: { projectId }, json: { ...what, ...(dir !== undefined ? { dir } : {}) } })

export const removeProjectRepo = (projectId: string, repoId: string): Promise<unknown> =>
  projectRepo[':repo'].$delete({ param: { projectId, repo: repoId } })

/** Rename the folder a link's checkout takes in workspaces created from
 *  now on. */
export const renameProjectRepo = (projectId: string, repoId: string, dir: string): Promise<unknown> =>
  projectRepo[':repo'].$patch({ param: { projectId, repo: repoId }, json: { dir } })

/** Set one of a link's two flags, which only a server with an egress proxy
 *  has (docs/project-repos.md "Read-only repos"). */
export const setProjectRepoFlag = (
  projectId: string,
  repoId: string,
  flag: 'read-only' | 'gh-token',
  enabled: boolean,
): Promise<unknown> => projectRepo[':repo'][flag].$put({ param: { projectId, repo: repoId }, json: { enabled } })

export const setProjectRepoOrder = (projectId: string, repos: string[]): Promise<unknown> =>
  api.project[':projectId']['repo-order'].$put({ param: { projectId }, json: { repos } })

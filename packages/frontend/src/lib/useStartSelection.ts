import { useQueries } from '@tanstack/react-query'
import { FULL_COMMIT_PATTERN } from '@yaac/shared/steps'
import type { ProjectRepo, ProjectSummary, RepoSelection, RepoStart } from '@yaac/shared/types'
import { fetchRepoBranches, repoBranchesKey, useBranchRefresh } from '#lib/repoApi'
import { startPoint } from '#lib/steps'
import type { NewWorkspaceForm } from '#lib/newWorkspace'

/** One of the project's repos as the new-workspace pane shows it. */
export interface RepoRow {
  repo: ProjectRepo
  included: boolean
  /** The branch, or full commit id, its field shows and a submit sends;
   *  `''` until one is known. */
  branch: string
  /** What is being typed into its field, a search rather than a pick;
   *  null while nothing is. */
  query: string | null
  /** A full commit id typed there, which is a start point of its own. */
  typedCommit?: string
  /** Origin's branches, once listed, and its default. */
  branches?: string[]
  defaultBranch?: string
  /** The branch list could not be read. */
  failed: boolean
}

/** What a new workspace starts with, as the pane's fields resolve it. */
export interface StartSelection {
  rows: RepoRow[]
  included: RepoRow[]
  /** Whether the checkouts sit in folders of their own: always with
   *  several repos, by choice with one. */
  nested: boolean
  /** Where the agent starts: an included repo's id, or `.` for the
   *  workspace root. */
  cwd: string
  /** The selection as a create, queue, routine or draft request names it. */
  request: { repos: RepoStart[]; nested?: boolean; cwd: string }
  /** An included repo with no git credential, which no workspace can start
   *  with. */
  needsCredential?: ProjectRepo
  /** Why the selection cannot be sent, or null. An entry that is stored
   *  (`stores`) keeps concrete branches, so each repo needs one. */
  blocked: (stores: boolean) => string | null
}

/**
 * Resolve the new-workspace pane's repo fields (docs/project-repos.md
 * "Remembered create settings"). Each is the form's pick, else the parent's
 * when Start names one (`seed`), else what the project last used.
 *
 * An untouched branch is the parent's, else the last one a create named for
 * the repo if origin still has it, else origin's default. The last-used
 * branch can't be submitted until the branch list confirms it; if the list
 * fails, it is dropped and the server picks origin's default.
 */
export function useStartSelection(
  project: ProjectSummary | undefined,
  form: Pick<NewWorkspaceForm, 'repos' | 'nested' | 'cwd'>,
  seed: RepoSelection | undefined,
  queries: Record<string, string>,
): StartSelection {
  const repos = project?.repos ?? []
  const seeded = (id: string): RepoStart | undefined => seed?.repos.find((r) => r.repo === id)
  const isIncluded = (r: ProjectRepo): boolean =>
    form.repos?.[r.id]?.included ?? (seed !== undefined ? seeded(r.id) !== undefined : r.lastIncluded)
  const lists = useQueries({
    queries: repos.map((r) => ({
      queryKey: repoBranchesKey(r.id),
      queryFn: () => fetchRepoBranches(r.id, false),
      enabled: isIncluded(r),
    })),
  })
  useBranchRefresh(repos.filter(isIncluded).map((r) => r.id))

  const unverified = new Set<string>()
  const rows = repos.map((repo, i): RepoRow => {
    const { data, isError: failed } = lists[i]
    const picked = form.repos?.[repo.id]?.branch
    const parent = seeded(repo.id)
    const fromParent = parent?.branch ?? parent?.commit
    const last = repo.lastBranch !== undefined && !failed
      && (data === undefined || data.branches.includes(repo.lastBranch))
      ? repo.lastBranch
      : undefined
    const query = queries[repo.id] ?? null
    const typedCommit = query !== null && FULL_COMMIT_PATTERN.test(query.trim()) ? query.trim() : undefined
    if (data === undefined && last !== undefined && picked === undefined && fromParent === undefined) unverified.add(repo.id)
    return {
      repo,
      included: isIncluded(repo),
      branch: typedCommit ?? picked ?? fromParent ?? last ?? data?.defaultBranch ?? '',
      query,
      ...(typedCommit !== undefined ? { typedCommit } : {}),
      ...(data !== undefined ? { branches: data.branches, defaultBranch: data.defaultBranch } : {}),
      failed,
    }
  })
  const included = rows.filter((r) => r.included)
  const nested = included.length > 1
    || (included.length === 1 && (form.nested ?? seed?.nested ?? project?.lastNested ?? false))
  const wanted = form.cwd ?? seed?.cwd ?? project?.lastCwd
  const lone = included.length === 1 ? included[0].repo.id : '.'
  // Without folders the root is the lone repo's checkout, or holds none.
  const cwd = !nested ? lone
    : wanted !== undefined && (wanted === '.' || included.some((r) => r.repo.id === wanted)) ? wanted
    : lone
  const needsCredential = included.find((r) => !r.repo.hosted && r.repo.gitCredential === null)?.repo
  return {
    rows,
    included,
    nested,
    cwd,
    request: {
      repos: included.map((r) => ({ repo: r.repo.id, ...startPoint(r.branch) })),
      ...(included.length === 1 ? { nested } : {}),
      cwd,
    },
    ...(needsCredential !== undefined ? { needsCredential } : {}),
    blocked: (stores) => (
      included.some((r) => r.query !== null && r.typedCommit === undefined) ? 'Pick a branch from the list, or give a full commit id'
        : included.some((r) => unverified.has(r.repo.id)) ? 'Loading branches…'
        : stores && included.some((r) => r.branch === '') ? 'Pick a branch'
        : null
    ),
  }
}

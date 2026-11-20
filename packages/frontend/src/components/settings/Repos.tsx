import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitCredentialPicker, remoteKind, remoteProjectName, TrustedHostKey } from '#components/GitCredentialPicker'
import { HostedRemote } from '#components/settings/HostedRemote'
import { KeptHostedRepo } from '#components/settings/KeptHostedRepo'
import { MoveToRemote } from '#components/settings/MoveToRemote'
import { SettingsPageTitle } from '#components/settings/SettingsPage'
import { DeleteIcon } from '#lib/icons'
import {
  assignRepoCredential, deleteRepo, previewRepoDelete, refreshRepos, shareRepo, unshareRepo, useRepos,
} from '#lib/repoApi'
import { useUiStore } from '#lib/store'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { useTeammateView, useViewedUserId, useWhoami } from '#lib/viewer'
import type { RepoSummary } from '@yaac/shared/types'
import { cn, YBadge, YButton, YConfirm, YRowFrame, YSection, YSectionLabel, YSelect } from '#ui'

/** A repo as a row or a dialog names it: its remote's last path segment, or
 *  for one yaac hosts the folder a project links it under. */
export function repoName(repo: RepoSummary, dir?: string): string {
  return (repo.hosted ? undefined : remoteProjectName(repo.remoteUrl)) || dir || `repo ${repo.id.slice(0, 8)}`
}

/**
 * Settings → Repos (docs/project-repos.md): every repo the viewed user
 * owns, since a repo outlives the projects that link it, and the ones
 * shared with them. Repos no project links come first, as nothing else
 * shows them; then the linked ones; then repos others shared; and last the
 * repos deleted while workspaces still hold a checkout, each with what
 * holds it. A row carries the repo's credential, its hosted settings and
 * sharing, and Delete. A teammate's are shown read-only.
 *
 * `settingsFocusRepo`, set by links elsewhere, scrolls that repo's row into
 * view, open.
 */
export function ReposSettings(): JSX.Element {
  const repos = useRepos()
  const viewed = useViewedUserId()
  const readOnly = useTeammateView()
  // Read once: after an assignment the row must not reopen itself.
  const [focus] = useState(useUiStore.getState().settingsFocusRepo)
  const live = (repos ?? []).filter((r) => r.deleted === undefined)
  const own = live.filter((r) => r.owner === viewed)
  const groups: { label: string; hint?: string; repos: RepoSummary[] }[] = [
    {
      label: 'Not linked to any project',
      hint: 'Link one from a project\'s settings, or delete it.',
      repos: own.filter((r) => r.projects.length === 0),
    },
    { label: 'Linked', repos: own.filter((r) => r.projects.length > 0) },
    {
      label: 'Shared with you',
      hint: 'Hosted by yaac for their owner, who lets you link them into your projects.',
      repos: live.filter((r) => viewed !== undefined && r.sharedWith.includes(viewed)),
    },
    {
      label: 'Deleted',
      hint: 'Workspaces that hold a checkout borrow a repo\'s objects, so yaac keeps them on disk until those '
        + 'workspaces are deleted. Then the repo is gone for good.',
      repos: (repos ?? []).filter((r) => r.deleted !== undefined && r.owner === viewed),
    },
  ]

  return (
    <>
      <SettingsPageTitle title="Repos">
        A repo is one git remote as you reach it, with the credential that authenticates to it. Projects link
        repos, and removing a project or unlinking a repo leaves the repo here.
      </SettingsPageTitle>
      {repos !== undefined && groups.every((g) => g.repos.length === 0) && (
        <p className="text-md text-subtle">No repos yet. Adding a project adds its repo.</p>
      )}
      {groups.filter((g) => g.repos.length > 0).map((g) => (
        <YSection key={g.label} title={g.label} description={g.hint}>
          <div className="divide-y divide-line border-y border-line text-md">
            {g.repos.map((r) => (
              <RepoRow key={r.id} repo={r} readOnly={readOnly || r.owner !== viewed} focused={focus === r.id} />
            ))}
          </div>
        </YSection>
      ))}
    </>
  )
}

/**
 * One repo: its remote, the projects that link it and its credential, and
 * under "Manage" everything its owner can change. One with no credential
 * cannot be used by a workspace, so it stands out with its picker open.
 */
function RepoRow({ repo, readOnly, focused }: { repo: RepoSummary; readOnly: boolean; focused: boolean }): JSX.Element {
  const queryClient = useQueryClient()
  const users = useWhoami()?.users ?? []
  const refresh = (): void => { void refreshRepos(queryClient) }
  const missing = !repo.hosted && repo.gitCredential === null && repo.deleted === undefined
  const [open, setOpen] = useState(focused)
  // A link to a repo's credential opens straight onto its picker.
  const [changing, setChanging] = useState(focused)
  // The host key an assignment made here trusted.
  const [trusted, setTrusted] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'center' })
  }, [focused])
  const dir = useSnapshotSelect((s) => s?.projects.flatMap((p) => p.repos).find((r) => r.id === repo.id)?.dir)
  const name = repoName(repo, dir)
  const owner = users.find((u) => u.id === repo.owner)?.name
  const assign = async (credentialId: string): Promise<void> => {
    setTrusted(await assignRepoCredential(repo.id, credentialId))
    setChanging(false)
    refresh()
  }

  return (
    <div
      ref={ref}
      data-repo={repo.id}
      className={cn(
        'flex flex-col gap-1.5 px-1 py-2.5',
        missing && !readOnly && 'border-l-2 border-l-warning pl-2',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <YBadge>{repo.hosted ? 'Hosted by yaac' : remoteKind(repo.remoteUrl).toUpperCase()}</YBadge>
        <span title={repo.hosted ? name : repo.remoteUrl} className="min-w-0 truncate font-mono text-text">
          {repo.hosted ? name : repo.remoteUrl}
        </span>
        {readOnly && owner !== undefined && <span className="shrink-0 text-sm text-subtle">owned by {owner}</span>}
        {missing && !readOnly && <span className="shrink-0 text-sm text-warning">no git credential</span>}
        {repo.deleted === undefined && !readOnly && (
          <YButton variant="secondary" size="sm" onClick={() => setOpen((o) => !o)} className="ml-auto">
            {open ? 'Close' : 'Manage'}
          </YButton>
        )}
      </div>
      <p className="truncate text-sm text-subtle">
        {repo.projects.length === 0
          ? 'No project links it.'
          : `Linked by ${repo.projects.map((p) => p.name).join(', ')}.`}
        {repo.gitCredential !== null && ` Credential: ${repo.gitCredential.name}.`}
      </p>
      {repo.deleted !== undefined && <Holders repo={repo} />}
      {trusted !== null && <TrustedHostKey entry={trusted} />}
      {missing && !readOnly && (
        <GitCredentialPicker kind={remoteKind(repo.remoteUrl)} projectName={name} actionLabel="Assign" onSubmit={assign} />
      )}
      {open && repo.deleted === undefined && !readOnly && (
        <div className="flex flex-col gap-4 border-t border-line pt-3">
          {!repo.hosted && !missing && (
            <Part label="Git credential">
              {changing ? (
                <GitCredentialPicker
                  kind={remoteKind(repo.remoteUrl)}
                  projectName={name}
                  exclude={repo.gitCredential?.id}
                  actionLabel="Assign"
                  onSubmit={assign}
                  onCancel={() => setChanging(false)}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-text">{repo.gitCredential?.name}</span>
                  <YButton variant="secondary" size="sm" onClick={() => setChanging(true)}>Change</YButton>
                </div>
              )}
            </Part>
          )}
          {repo.hosted && (
            <Part label="Git repository">
              <HostedRemote
                repoId={repo.id}
                name={name}
                guardDefaultBranch={repo.guardDefaultBranch}
                readOnly={false}
                onChanged={refresh}
              />
            </Part>
          )}
          {repo.hosted && <RepoSharing repo={repo} onChanged={refresh} />}
          {repo.hosted && <MoveToRemote repoId={repo.id} name={name} onMoved={refresh} />}
          {repo.keepsHostedRepo === true && (
            <KeptHostedRepo repoId={repo.id} remoteUrl={repo.remoteUrl} readOnly={false} onRemoved={refresh} />
          )}
          <DeleteRepo repo={repo} name={name} onDeleted={refresh} />
        </div>
      )}
    </div>
  )
}

/** A titled part of a repo's Manage area. */
function Part({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <YSectionLabel>{label}</YSectionLabel>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

/** The workspaces still holding a checkout of a deleted repo. */
function Holders({ repo }: { repo: RepoSummary }): JSX.Element {
  const users = useWhoami()?.users ?? []
  const holders = repo.deleted?.heldBy ?? []
  return (
    <ul className="space-y-0.5 text-sm text-muted">
      {holders.map((h) => (
        <li key={h.workspaceId} className="truncate">
          Workspace <span className="font-mono">{h.workspaceId.slice(0, 8)}</span> in {h.projectName}
          {h.owner !== repo.owner && ` (${users.find((u) => u.id === h.owner)?.name ?? 'another user'}'s)`}
        </li>
      ))}
      {holders.length === 0 && <li>No workspace holds it any more; it is being removed.</li>}
    </ul>
  )
}

/**
 * Whom a repo hosted by yaac is shared with (docs/hosted-projects.md
 * "Sharing"): each such user may link it into their own projects, and reads
 * and pushes the same repository. Only the owner shares or ends a share.
 */
function RepoSharing({ repo, onChanged }: { repo: RepoSummary; onChanged: () => void }): JSX.Element | null {
  const users = useWhoami()?.users ?? []
  const shared = new Set(repo.sharedWith)
  const others = users.filter((u) => u.id !== repo.owner)
  const candidates = others.filter((u) => !shared.has(u.id))
  const [picked, setPicked] = useState('')
  const share = useMutation({
    mutationFn: (userId: string) => shareRepo(repo.id, userId),
    onSuccess: () => { setPicked(''); onChanged() },
  })
  const unshare = useMutation({ mutationFn: (userId: string) => unshareRepo(repo.id, userId), onSuccess: onChanged })
  if (others.length === 0) return null
  const error = share.error ?? unshare.error

  return (
    <div>
      <YSectionLabel>Sharing</YSectionLabel>
      <p className="mt-0.5 text-sm leading-relaxed text-subtle">
        Someone you share this repo with can link it into their own projects, and reads and pushes this
        repository. Ending a share stops their workspaces that hold a checkout of it; their projects and
        checkouts stay, and work again if you share it again.
      </p>
      <div className="mt-2 divide-y divide-line">
        {others.filter((u) => shared.has(u.id)).map((u) => (
          <YRowFrame
            key={u.id}
            label={u.name}
            actionsShown
            actions={(
              <YButton
                variant="ghost"
                size="sm"
                icon={DeleteIcon}
                onClick={() => unshare.mutate(u.id)}
                disabled={unshare.isPending}
                aria-label={`Stop sharing with ${u.name}`}
              />
            )}
            className="min-h-8 text-md"
          >
            <span className="flex-1 truncate text-text">{u.name}</span>
            {u.login !== null && <span className="truncate text-sm text-subtle">{u.login}</span>}
          </YRowFrame>
        ))}
        {shared.size === 0 && <p className="text-sm text-subtle">Not shared with anyone.</p>}
      </div>
      {candidates.length > 0 && (
        <div className="mt-3 flex gap-2">
          <YSelect value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Share with" className="flex-1">
            <option value="">Share with…</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </YSelect>
          <YButton onClick={() => share.mutate(picked)} disabled={picked === '' || share.isPending}>
            {share.isPending ? 'Sharing…' : 'Share'}
          </YButton>
        </div>
      )}
      {error && <p className="mt-2 text-md text-danger">{error.message}</p>}
    </div>
  )
}

/**
 * Delete a repo, behind a confirmation that counts what it reaches, read
 * when the dialog opens. It unlinks the repo from every project and ends
 * its shares; one yaac hosts loses its repository, the only copy of its
 * code. No workspace is deleted.
 */
function DeleteRepo({ repo, name, onDeleted }: { repo: RepoSummary; name: string; onDeleted: () => void }): JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const preview = useQuery({
    queryKey: ['repo-delete', repo.id],
    queryFn: () => previewRepoDelete(repo.id),
    enabled: confirm,
    staleTime: 0,
  })
  const remove = useMutation({
    mutationFn: () => deleteRepo(repo.id),
    onSuccess: () => { setConfirm(false); onDeleted() },
  })
  const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`
  const reached = preview.data
  return (
    <div>
      <YSectionLabel>Delete</YSectionLabel>
      <p className="mt-0.5 text-sm leading-relaxed text-subtle">
        Unlinks the repo from every project and removes it from yaac. Workspaces keep their checkouts.
      </p>
      <YButton variant="danger" size="sm" onClick={() => { remove.reset(); setConfirm(true) }} className="mt-2">
        Delete repo…
      </YButton>
      <YConfirm
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${name}?`}
        description={(reached === undefined
          ? 'It is unlinked from every project that links it, other users\' included, and its sharing ends. '
          : `It is unlinked from ${count(reached.projects.length, 'project')}, other users' included, and its sharing ends. `)
          + (repo.hosted
            ? 'yaac deletes its repository, which is the only copy of its code: clone it first to keep it. '
            : '')
          + (reached === undefined || reached.heldBy.length > 0
            ? `No workspace is deleted: ${reached === undefined ? 'any' : `the ${count(reached.heldBy.length, 'workspace')}`} `
              + 'holding a checkout of it keep their files and commits, with no remote to fetch from or push to, '
              + 'and yaac keeps the repo\'s objects on disk until those workspaces are deleted. '
            : '')
          + 'This can\'t be undone.'}
        confirmText={repo.hosted ? name : repo.remoteUrl}
        busy={remove.isPending || preview.isPending}
        {...(remove.error || preview.error ? { error: (remove.error ?? preview.error)?.message } : {})}
        onConfirm={() => remove.mutate()}
      />
    </div>
  )
}

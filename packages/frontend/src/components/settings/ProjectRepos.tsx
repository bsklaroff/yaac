import { useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AllowlistAddNotice, GitCredentialPicker, remoteKind, remoteProjectName, TrustedHostKey,
} from '#components/GitCredentialPicker'
import { repoName } from '#components/settings/Repos'
import { PushRefusedWarning, UpstreamSuggestion } from '#components/settings/RepoForks'
import { api } from '#lib/api'
import { PrevMatchIcon as MoveUpIcon, NextMatchIcon as MoveDownIcon } from '#lib/icons'
import {
  addProjectRepo, refreshRepos, removeProjectRepo, renameProjectRepo, setProjectRepoFlag, setProjectRepoOrder, useRepos,
  type RepoToLink,
} from '#lib/repoApi'
import { useUiStore } from '#lib/store'
import { useInlineEdit } from '#lib/useInlineRename'
import { useSnapshotSelect } from '#lib/useSnapshot'
import { isGitHubHost } from '@yaac/shared/credentials'
import { needsGitCredential, parseGitRemote } from '@yaac/shared/git-remote'
import { REPO_DIR_RE, type ProjectRepo, type ProjectSummary } from '@yaac/shared/types'
import { YButton, YCheckbox, YInput, YSectionLabel, YSelect, YSettingRow } from '#ui'

/** Whether a repo's token can be `GH_TOKEN` at all: an https remote on
 *  GitHub. */
function isGithubHttps(remoteUrl: string): boolean {
  try {
    const { scheme, host } = parseGitRemote(remoteUrl)
    return scheme === 'https' && isGitHubHost(host)
  } catch {
    return false
  }
}

/**
 * The repos a project links (docs/project-repos.md): each one's folder
 * name, its place in the order (which the create screen, the checkout
 * switcher and Home's project card follow), and under an egress proxy whether this
 * project may only read it and whether its token may be `GH_TOKEN`. A repo
 * is linked by cloning a URL, by picking one the owner has or was shared,
 * or by creating one yaac hosts. Unlinking leaves the repo in
 * Settings → Repos and every workspace's checkout of it in place.
 *
 * The two flags are hidden on a server that runs workspaces on the host: a
 * workspace there holds every credential, so they could promise nothing.
 */
export function ProjectRepos({ project, readOnly }: { project: ProjectSummary; readOnly: boolean }): JSX.Element {
  const queryClient = useQueryClient()
  const mediatedEgress = useSnapshotSelect((s) => s?.driver) !== 'containerless'
  const openSettings = useUiStore((s) => s.openSettings)
  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => refreshRepos(queryClient),
  })
  const order = project.repos.map((r) => r.id)
  const move = (i: number, by: number): void => {
    const next = [...order]
    next.splice(i + by, 0, ...next.splice(i, 1))
    change.mutate(() => setProjectRepoOrder(project.id, next))
  }

  return (
    <YSettingRow
      stacked
      label="Repos"
      hint={'The git repos a workspace of this project can start with. Each create picks which; one sits at the '
        + 'workspace root or in its folder, several each in their folder.'}
    >
      <div className="divide-y divide-line text-md">
        {project.repos.map((r, i) => (
          <div key={r.id} data-repo={r.id} className="flex flex-col gap-1.5 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <RepoDir
                dir={r.dir}
                taken={project.repos.filter((o) => o.id !== r.id).map((o) => o.dir)}
                readOnly={readOnly}
                onRename={(dir) => change.mutate(() => renameProjectRepo(project.id, r.id, dir))}
              />
              <span title={r.remoteUrl} className="min-w-0 flex-1 truncate font-mono text-sm text-subtle">
                {r.hosted ? 'hosted by yaac' : r.remoteUrl}
              </span>
              {needsGitCredential({ ...r, readOnly: r.repoReadOnly }) && r.gitCredential === null
                && <span className="shrink-0 text-sm text-warning">no git credential</span>}
              {r.repoReadOnly && <span className="shrink-0 text-sm text-subtle">read-only</span>}
              {r.upstream !== undefined && (
                <span title={r.upstream.remoteUrl} className="shrink-0 truncate text-sm text-subtle">
                  fork of {remoteProjectName(r.upstream.remoteUrl) || 'its upstream'}
                </span>
              )}
              {!readOnly && (
                <span className="flex shrink-0 items-center">
                  {/* Reordering needs a second repo. An arrow with nowhere to go
                      leaves a gap, so the arrows line up down the list. */}
                  {project.repos.length > 1 && <>
                    {i === 0 ? <span aria-hidden className="size-6" /> : (
                      <YButton variant="ghost" size="sm" icon={MoveUpIcon} disabled={change.isPending}
                        onClick={() => move(i, -1)} aria-label={`Move ${r.dir} up`} title="Move up" />
                    )}
                    {i === project.repos.length - 1 ? <span aria-hidden className="size-6" /> : (
                      <YButton variant="ghost" size="sm" icon={MoveDownIcon} disabled={change.isPending}
                        onClick={() => move(i, 1)} aria-label={`Move ${r.dir} down`} title="Move down" />
                    )}
                  </>}
                  <YButton variant="secondary" size="sm" onClick={() => openSettings('repos', undefined, r.id)}>
                    Manage repo
                  </YButton>
                  <YButton
                    variant="danger"
                    size="sm"
                    disabled={change.isPending}
                    onClick={() => change.mutate(() => removeProjectRepo(project.id, r.id))}
                    title="Unlink it from this project. The repo and every workspace's checkout of it stay."
                  >
                    Unlink
                  </YButton>
                </span>
              )}
            </div>
            {r.pushRefused === true && <PushRefusedWarning repoId={r.id} remoteUrl={r.remoteUrl} owned={!readOnly && r.owner === project.owner} />}
            {!readOnly && <UpstreamSuggestion repoId={r.id} />}
            {mediatedEgress && <LinkFlags project={project} repo={r} readOnly={readOnly || change.isPending}
              onChange={(flag, enabled) => change.mutate(() => setProjectRepoFlag(project.id, r.id, flag, enabled))} />}
          </div>
        ))}
      </div>
      {project.repos.length === 0 && (
        <p className="text-md text-subtle">No repos: its workspaces start with an empty directory.</p>
      )}
      {change.error && <p className="mt-2 text-sm text-danger">{change.error.message}</p>}
      {!readOnly && <AddRepo project={project} />}
    </YSettingRow>
  )
}

/** A link's folder name, renamed in place. Existing workspaces keep the
 *  folder their checkout was created under. */
function RepoDir({ dir, taken, readOnly, onRename }: {
  dir: string
  taken: string[]
  readOnly: boolean
  onRename: (dir: string) => void
}): JSX.Element {
  const rename = useInlineEdit(dir, (next) => {
    if (next !== '' && next !== dir && REPO_DIR_RE.test(next) && !taken.includes(next)) onRename(next)
  })
  if (rename.editing) {
    return (
      <YInput
        ref={rename.inputRef}
        aria-label="Folder name"
        defaultValue={rename.seed}
        maxLength={100}
        onKeyDown={rename.handleKeyDown}
        onBlur={rename.handleBlur}
        className="h-6 w-32 shrink-0 px-1.5 font-mono"
      />
    )
  }
  return (
    <YButton
      variant="bare"
      onClick={rename.start}
      disabled={readOnly}
      title="The folder its checkout takes when a workspace nests its repos. Click to rename."
      className="shrink-0 truncate font-mono font-medium text-text enabled:hover:underline disabled:opacity-100"
    >
      {dir}/
    </YButton>
  )
}

/**
 * The two settings of a link that the egress proxy enforces. A read-only
 * repo's token is never `GH_TOKEN`, whatever the other setting says: the
 * GitHub API cannot be held to reads, so its box is off while read-only is
 * on, keeping what it was set to for when read-only is turned off again.
 */
function LinkFlags({ project, repo, readOnly, onChange }: {
  project: ProjectSummary
  repo: ProjectRepo
  readOnly: boolean
  onChange: (flag: 'read-only' | 'gh-token', enabled: boolean) => void
}): JSX.Element {
  const github = isGithubHttps(repo.remoteUrl)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
      <YCheckbox
        checked={repo.readOnly}
        disabled={readOnly}
        onCheckedChange={(on) => onChange('read-only', on)}
        title={`Workspaces of ${project.name} can fetch it but not push to it`}
        className="text-sm"
      >
        Read-only in this project
      </YCheckbox>
      {github && (
        <YCheckbox
          checked={repo.ghToken && !repo.readOnly}
          disabled={readOnly || repo.readOnly}
          onCheckedChange={(on) => onChange('gh-token', on)}
          className="text-sm"
        >
          Use its token as GH_TOKEN
          {repo.readOnly && <span>(off while read-only: through the GitHub API the token could write the repo)</span>}
        </YCheckbox>
      )}
    </div>
  )
}

const NEW_URL = 'url'
const NEW_HOSTED = 'hosted'

/** The button that opens the add-repo form, and the host key the last ssh
 *  clone it made trusted. */
function AddRepo({ project }: { project: ProjectSummary }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [trusted, setTrusted] = useState<string | null>(null)
  if (open) {
    return <AddRepoForm project={project} onCancel={() => setOpen(false)} onAdded={(hostKey) => { setTrusted(hostKey); setOpen(false) }} />
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      {trusted !== null && <TrustedHostKey entry={trusted} />}
      <YButton size="sm" onClick={() => setOpen(true)} className="self-start">Add repo…</YButton>
    </div>
  )
}

/** Link another repo: clone a URL, pick one of the owner's repos or one
 *  shared with them, or create one yaac hosts; under a folder name, which
 *  defaults to the repo's name. */
function AddRepoForm({ project, onCancel, onAdded }: {
  project: ProjectSummary
  onCancel: () => void
  /** With the host key a fresh ssh clone trusted, if any. */
  onAdded: (knownHostsEntry: string | null) => void
}): JSX.Element {
  const queryClient = useQueryClient()
  const [what, setWhat] = useState(NEW_URL)
  const [url, setUrl] = useState('')
  const [dir, setDir] = useState('')
  const linked = new Set(project.repos.map((r) => r.id))
  const offered = (useRepos() ?? []).filter((r) => r.deleted === undefined && !linked.has(r.id)
    && (r.owner === project.owner || r.sharedWith.includes(project.owner)))
  const remoteUrl = url.trim()
  const folder = dir.trim()
  const badDir = folder !== '' && (!REPO_DIR_RE.test(folder) || project.repos.some((r) => r.dir === folder))
  // Shares its key with Settings → Egress allowlist, so that list shows a
  // host the add allowed.
  const allowlistKey = ['project-allowlist', project.id]
  const mediatedEgress = useSnapshotSelect((s) => s?.driver) !== 'containerless'
  const allowlist = useQuery({
    queryKey: allowlistKey,
    queryFn: async () => await api.project[':projectId'].allowlist.$get({ param: { projectId: project.id } }),
    enabled: mediatedEgress,
  }).data?.allowlist
  const picked = offered.find((r) => r.id === what)
  const link = useMutation({
    mutationFn: (to: RepoToLink) => addProjectRepo(project.id, to, folder === '' ? undefined : folder),
    onSuccess: async ({ knownHostsEntry, repoId, suggestedUpstream }) => {
      onAdded(knownHostsEntry)
      if (suggestedUpstream !== undefined) useUiStore.getState().suggestUpstream(repoId, suggestedUpstream)
      await Promise.all([refreshRepos(queryClient), queryClient.invalidateQueries({ queryKey: allowlistKey })])
    },
  })

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3 text-md">
      <YSectionLabel>Add repo</YSectionLabel>
      <YSelect aria-label="Repo to add" value={what} onChange={(e) => setWhat(e.target.value)}>
        <option value={NEW_URL}>Clone a repository…</option>
        {offered.map((r) => (
          <option key={r.id} value={r.id}>
            {r.hosted ? `${repoName(r)} (hosted by yaac)` : r.remoteUrl}{r.owner !== project.owner ? ' (shared with you)' : ''}
          </option>
        ))}
        <option value={NEW_HOSTED}>New repo hosted by yaac</option>
      </YSelect>
      {what === NEW_URL && (
        <YInput
          aria-label="Repository URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
          placeholder="https://github.com/owner/repo.git"
          className="font-mono"
        />
      )}
      <YInput
        aria-label="Folder name"
        value={dir}
        onChange={(e) => setDir(e.target.value)}
        placeholder={`folder name (default: ${what === NEW_URL ? remoteProjectName(remoteUrl) || 'the repo\'s name' : 'the repo\'s name'})`}
        className="font-mono"
      />
      <AllowlistAddNotice
        remoteUrl={what === NEW_URL ? remoteUrl : picked?.hosted === false ? picked.remoteUrl : ''}
        allowlist={allowlist}
      />
      {badDir && (
        <p className="text-sm text-danger">
          A folder name is letters, digits, &quot;.&quot;, &quot;_&quot; and &quot;-&quot;, and no other repo of this project has it.
        </p>
      )}
      {what === NEW_URL ? (
        <GitCredentialPicker
          kind={remoteKind(remoteUrl)}
          projectName={remoteProjectName(remoteUrl)}
          actionLabel="Add"
          disabled={remoteUrl === '' || badDir}
          onSubmit={async (credentialId) => { await link.mutateAsync({ remoteUrl, credentialId }) }}
          onCancel={onCancel}
        />
      ) : (
        <div className="flex items-center gap-2">
          <YButton
            variant="primary"
            size="sm"
            disabled={badDir || link.isPending}
            onClick={() => link.mutate(what === NEW_HOSTED ? { hosted: true } : { repoId: what })}
          >
            {link.isPending ? 'Adding…' : 'Add'}
          </YButton>
          <YButton variant="ghost" size="sm" onClick={onCancel}>Cancel</YButton>
          {link.error && <span className="text-sm text-danger">{link.error.message}</span>}
        </div>
      )}
    </div>
  )
}

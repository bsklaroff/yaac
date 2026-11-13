import { useState, type JSX } from 'react'
import clsx from 'clsx'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AllowlistAddNotice, GitCredentialPicker, INPUT, remoteKind, remoteProjectName, TrustedHostKey,
} from '#components/GitCredentialPicker'
import { SectionLabel } from '#components/settings/Field'
import { repoName } from '#components/settings/Repos'
import { BUTTON, TEXT_BUTTON } from '#components/ui/button'
import { api } from '#lib/api'
import {
  addProjectRepo, refreshRepos, removeProjectRepo, renameProjectRepo, setProjectRepoFlag, setProjectRepoOrder, useRepos,
  type RepoToLink,
} from '#lib/repoApi'
import { useUiStore } from '#lib/store'
import { useInlineEdit } from '#lib/useInlineRename'
import { useSnapshot } from '#lib/useSnapshot'
import { isGitHubHost } from '@yaac/shared/credentials'
import { parseGitRemote } from '@yaac/shared/git-remote'
import { REPO_DIR_RE, type ProjectRepo, type ProjectSummary } from '@yaac/shared/types'

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
 * name, its place in the order, and under an egress proxy whether this
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
  const mediatedEgress = useSnapshot()?.driver !== 'containerless'
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
    <div>
      <div className="text-xs font-medium text-text">Repos</div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-text-faint">
        The git repos a workspace of this project can start with. Each create picks which; one sits at the
        workspace root or in its folder, several each in their folder.
      </p>
      <div className="mt-2 space-y-2 text-xs">
        {project.repos.map((r, i) => (
          <div key={r.id} data-repo={r.id} className="flex flex-col gap-1.5 rounded-md bg-bg px-2.5 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <RepoDir
                dir={r.dir}
                taken={project.repos.filter((o) => o.id !== r.id).map((o) => o.dir)}
                readOnly={readOnly}
                onRename={(dir) => change.mutate(() => renameProjectRepo(project.id, r.id, dir))}
              />
              <span title={r.remoteUrl} className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-faint">
                {r.hosted ? 'hosted by yaac' : r.remoteUrl}
              </span>
              {!r.hosted && r.gitCredential === null && <span className="shrink-0 text-[11px] text-amber-400">no git credential</span>}
              {!readOnly && (
                <span className="flex shrink-0 items-center">
                  <button type="button" disabled={i === 0 || change.isPending} onClick={() => move(i, -1)}
                    aria-label={`Move ${r.dir} up`} className={TEXT_BUTTON}>↑</button>
                  <button type="button" disabled={i === project.repos.length - 1 || change.isPending} onClick={() => move(i, 1)}
                    aria-label={`Move ${r.dir} down`} className={TEXT_BUTTON}>↓</button>
                  <button type="button" onClick={() => openSettings('repos', undefined, r.id)} className={TEXT_BUTTON}>
                    Manage repo
                  </button>
                  <button
                    type="button"
                    disabled={change.isPending}
                    onClick={() => change.mutate(() => removeProjectRepo(project.id, r.id))}
                    title="Unlink it from this project. The repo and every workspace's checkout of it stay."
                    className={TEXT_BUTTON}
                  >
                    Unlink
                  </button>
                </span>
              )}
            </div>
            {mediatedEgress && <LinkFlags project={project} repo={r} readOnly={readOnly || change.isPending}
              onChange={(flag, enabled) => change.mutate(() => setProjectRepoFlag(project.id, r.id, flag, enabled))} />}
          </div>
        ))}
        {project.repos.length === 0 && (
          <p className="text-[11px] text-text-faint">No repos: its workspaces start with an empty directory.</p>
        )}
      </div>
      {change.error && <p className="mt-2 text-[11px] text-red-400">{change.error.message}</p>}
      {!readOnly && <AddRepo project={project} />}
    </div>
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
      <input
        ref={rename.inputRef}
        aria-label="Folder name"
        defaultValue={rename.seed}
        maxLength={100}
        onKeyDown={rename.handleKeyDown}
        onBlur={rename.handleBlur}
        className="w-32 shrink-0 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs text-text
          outline-none focus:border-border-strong"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={rename.start}
      disabled={readOnly}
      title="The folder its checkout takes when a workspace nests its repos. Click to rename."
      className="shrink-0 truncate font-mono font-medium text-text"
    >
      {dir}/
    </button>
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-dim">
      <label className="flex items-center gap-1.5" title={`Workspaces of ${project.name} can fetch it but not push to it`}>
        <input
          type="checkbox"
          checked={repo.readOnly}
          disabled={readOnly}
          onChange={(e) => onChange('read-only', e.target.checked)}
        />
        Read-only in this project
      </label>
      {github && (
        <label className={clsx('flex items-center gap-1.5', repo.readOnly && 'text-text-faint')}>
          <input
            type="checkbox"
            checked={repo.ghToken && !repo.readOnly}
            disabled={readOnly || repo.readOnly}
            onChange={(e) => onChange('gh-token', e.target.checked)}
          />
          Use its token as GH_TOKEN
          {repo.readOnly && <span>(off while read-only: through the GitHub API the token could write the repo)</span>}
        </label>
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
      <button type="button" onClick={() => setOpen(true)} className={BUTTON}>Add repo…</button>
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
  const mediatedEgress = useSnapshot()?.driver !== 'containerless'
  const allowlist = useQuery({
    queryKey: allowlistKey,
    queryFn: async () => await api.project[':projectId'].allowlist.$get({ param: { projectId: project.id } }),
    enabled: mediatedEgress,
  }).data?.allowlist
  const picked = offered.find((r) => r.id === what)
  const link = useMutation({
    mutationFn: (to: RepoToLink) => addProjectRepo(project.id, to, folder === '' ? undefined : folder),
    onSuccess: async ({ knownHostsEntry }) => {
      onAdded(knownHostsEntry)
      await Promise.all([refreshRepos(queryClient), queryClient.invalidateQueries({ queryKey: allowlistKey })])
    },
  })

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-hairline-soft p-2.5 text-xs">
      <SectionLabel>Add repo</SectionLabel>
      <select
        aria-label="Repo to add"
        value={what}
        onChange={(e) => setWhat(e.target.value)}
        className="rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text outline-none"
      >
        <option value={NEW_URL}>Clone a repository…</option>
        {offered.map((r) => (
          <option key={r.id} value={r.id}>
            {r.hosted ? `${repoName(r)} (hosted by yaac)` : r.remoteUrl}{r.owner !== project.owner ? ' (shared with you)' : ''}
          </option>
        ))}
        <option value={NEW_HOSTED}>New repo hosted by yaac</option>
      </select>
      {what === NEW_URL && (
        <input
          aria-label="Repository URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
          placeholder="https://github.com/owner/repo.git"
          className={INPUT}
        />
      )}
      <input
        aria-label="Folder name"
        value={dir}
        onChange={(e) => setDir(e.target.value)}
        placeholder={`folder name (default: ${what === NEW_URL ? remoteProjectName(remoteUrl) || 'the repo\'s name' : 'the repo\'s name'})`}
        className={INPUT}
      />
      <AllowlistAddNotice
        remoteUrl={what === NEW_URL ? remoteUrl : picked?.hosted === false ? picked.remoteUrl : ''}
        allowlist={allowlist}
      />
      {badDir && (
        <p className="text-[11px] text-red-400">
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
          <button
            type="button"
            disabled={badDir || link.isPending}
            onClick={() => link.mutate(what === NEW_HOSTED ? { hosted: true } : { repoId: what })}
            className={BUTTON}
          >
            {link.isPending ? 'Adding…' : 'Add'}
          </button>
          <button type="button" onClick={onCancel} className={TEXT_BUTTON}>Cancel</button>
          {link.error && <span className="text-[11px] text-red-400">{link.error.message}</span>}
        </div>
      )}
    </div>
  )
}
